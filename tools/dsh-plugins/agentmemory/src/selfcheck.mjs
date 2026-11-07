#!/usr/bin/env node
/**
 * Live smoke check for `@local/agentmemory-mcp-plugin`, outside the Harness.
 *
 * It exercises the same code the plugin runs at `agent/created` — resolve the
 * server from the workspace, resolve the secret, probe `/agentmemory/livez`,
 * handshake, list tools, call one — so a failure here is the failure the plugin
 * would hit, with a readable message instead of a silent "no memory tools
 * appeared".
 *
 *   node src/selfcheck.mjs                 # workspace = cwd
 *   node src/selfcheck.mjs /path/to/repo   # explicit workspace
 *   node src/selfcheck.mjs /path/to/repo "query terms"
 *
 * Exit code 0 means the server, handshake, tool list and a read-only tool call
 * all work; 1 means they did not. The secret is never printed.
 *
 * The spawn command mirrors the plugin's `cordis.patch.yml` row (`npx -y
 * --offline @agentmemory/mcp`); override with AGENTMEMORY_SELFCHECK_COMMAND and
 * AGENTMEMORY_SELFCHECK_ARGS for a host without a warm npm cache.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import { StdioMcpClient, resultText } from './mcp-stdio-client.mjs';
import { probeLivez } from './livez.mjs';
import { DEFAULT_SERVER, buildServerEnv } from './plugin.mjs';
import { resolveSecret, resolveTarget } from './tenant.mjs';

/**
 * Minimal reader for the parts of `$DSH_HOME/.credentials.yaml` this script needs.
 *
 * Inside the Harness the store is reached through `ctx.credentials.resolve`; this
 * is a `refs:` mapping on disk, so a dev script can read it without a YAML
 * dependency. Values are never echoed, only their presence.
 */
function credentialStoreLookup(ref) {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    const path = join(home, '.credentials.yaml');
    let text;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return { path, value: null };
    }
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^refs:\s*$/.test(line)) {
            inRefs = true;
            continue;
        }
        if (!inRefs) continue;
        if (/^\S/.test(line)) break; // a new top-level key ends the block
        const match = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
        if (!match || match[1] !== ref) continue;
        const value = match[2].trim().replace(/^['"]|['"]$/g, '');
        return { path, value: value || null };
    }
    return { path, value: null };
}

/** The plugin context surface that secret resolution actually touches. */
function contextShim() {
    return {
        credentials: {
            async resolve(ref) {
                const hit = credentialStoreLookup(ref);
                return hit.value ? { value: hit.value, source: hit.path } : undefined;
            },
        },
    };
}

function serverFromEnvironment() {
    const command = process.env.AGENTMEMORY_SELFCHECK_COMMAND || DEFAULT_SERVER.command;
    const rawArgs = process.env.AGENTMEMORY_SELFCHECK_ARGS;
    // Mirror the cordis row: the repos already use `--offline` on this machine.
    const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : ['-y', '--offline', '@agentmemory/mcp'];
    return { command, args };
}

async function main() {
    const workspace = resolvePath(process.argv[2] ?? process.cwd());
    const query = process.argv[3] ?? 'agentmemory';
    console.log(`workspace:  ${workspace}`);

    const target = resolveTarget(workspace);
    if (target?.broken) {
        console.error(`FAIL: cannot parse AgentMemory config ${target.broken.path} — ${target.broken.message}.`);
        process.exitCode = 1;
        return;
    }
    if (!target) {
        console.error(
            'FAIL: no AgentMemory config found here or in a parent directory.\n' +
                '      Add .dsh/agentmemory.json, or an "agentmemory"/"agentmemory-mcp" entry\n' +
                '      in .cursor/mcp.json or .agents/mcp_config.json.',
        );
        process.exitCode = 1;
        return;
    }
    console.log(`url:        ${target.url}`);
    console.log(`viewer:     ${target.viewerUrl ?? '(not configured)'}`);
    console.log(`config:     ${target.source}`);
    console.log(`credential: ${target.secretRef ?? '(none derived)'}`);

    const { secret, from, reason } = await resolveSecret(contextShim(), target);
    console.log(`secret:     ${secret ? `resolved from ${from} (not printed)` : `none${reason ? ` (${reason})` : ''}`}`);

    const probe = await probeLivez(target.url, { secret, timeoutMs: 2_000 });
    if (!probe.ok) {
        console.error(
            `FAIL: no AgentMemory server answering at ${target.url} (${probe.reason ?? probe.status ?? 'no response'}).\n` +
                '      The plugin registers no tools in this repo until the server answers;\n' +
                '      check `docker ps` for the repo-specific agentmemory container.',
        );
        process.exitCode = 1;
        return;
    }
    console.log(`livez:      ok${probe.body?.service ? ` (${probe.body.service})` : ''}`);

    const { command, args } = serverFromEnvironment();
    const client = new StdioMcpClient({
        command,
        args,
        env: buildServerEnv(target, secret),
        cwd: workspace,
        name: `agentmemory:${target.label}`,
        timeoutMs: 120_000,
    });

    try {
        await client.connect();
    } catch (error) {
        const tail = client.stderrTail;
        console.error(`FAIL: handshake failed — ${error.message}${tail ? `\n      server stderr: ${tail.split('\n').slice(-3).join(' | ')}` : ''}`);
        process.exitCode = 1;
        return;
    }

    console.log(`server:     ${client.serverInfo?.name ?? '?'} ${client.serverInfo?.version ?? ''}`.trimEnd());
    console.log(`protocol:   ${client.protocolVersion}`);
    console.log(`tools:      ${client.tools.length} — ${client.tools.map((tool) => tool.name).join(', ')}`);

    if (!client.tools.some((tool) => tool.name === 'memory_smart_search')) {
        console.error('FAIL: memory_smart_search is missing; the tool surface is not the expected one.');
        process.exitCode = 1;
        await client.close();
        return;
    }

    try {
        const result = await client.callTool('memory_smart_search', { query, limit: 1 });
        const text = resultText(result);
        if (result?.isError) {
            console.error(`FAIL: memory_smart_search returned an error — ${text.slice(0, 300)}`);
            process.exitCode = 1;
            return;
        }
        console.log(`search:     "${query}" → ${text.length} bytes; ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
        console.log('PASS: livez, handshake, tool list and a read-only memory search all work.');
        if (target.viewerUrl) console.log(`viewer:     ${target.viewerUrl}`);
    } catch (error) {
        console.error(`FAIL: tools/call failed — ${error.message}`);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

await main();
