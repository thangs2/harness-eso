/**
 * Workspace → AgentMemory target resolution.
 *
 * These cases mirror the real config dialects on this machine: x79/baplatform
 * use `agentmemory`, FinESO uses `agentmemory-mcp`, every repo carries the same
 * URL under `.cursor/mcp.json` and `.agents/mcp_config.json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    credentialNameFor,
    isLoopbackUrl,
    labelFor,
    normalizeUrl,
    resolveSecret,
    resolveTarget,
} from '../src/tenant.mjs';
import { makeWorkspace, removeWorkspace } from './helpers.mjs';

test('normalizeUrl accepts the shapes the repos use', () => {
    assert.equal(normalizeUrl('http://localhost:3211'), 'http://localhost:3211');
    assert.equal(normalizeUrl('http://localhost:3211/'), 'http://localhost:3211');
    assert.equal(normalizeUrl('localhost:3211'), 'http://localhost:3211');
    assert.equal(normalizeUrl(' http://localhost:3211/// '), 'http://localhost:3211');
    assert.equal(normalizeUrl('https://memory.example.com/agentmemory'), 'https://memory.example.com/agentmemory');
    assert.equal(normalizeUrl('  '), null);
    assert.equal(normalizeUrl(null), null);
    assert.equal(normalizeUrl(3211), null);
});

test('normalizeUrl rejects what the MCP shim itself rejects', () => {
    // The shim's own baseUrl() rejects credentials, query and fragment; spawning
    // it with one of these would start a process that fails on the first call.
    assert.equal(normalizeUrl('ftp://localhost:3211'), null);
    assert.equal(normalizeUrl('http://user:pass@localhost:3211'), null);
    assert.equal(normalizeUrl('http://localhost:3211/?token=x'), null);
    assert.equal(normalizeUrl('http://localhost:3211/#frag'), null);
});

test('loopback detection and labels never include the secret', () => {
    assert.equal(isLoopbackUrl('http://localhost:3211'), true);
    assert.equal(isLoopbackUrl('http://127.0.0.1:3211'), true);
    assert.equal(isLoopbackUrl('https://memory.example.com'), false);
    assert.equal(labelFor('http://localhost:3211'), 'localhost:3211');
    assert.equal(labelFor('https://memory.example.com/agentmemory'), 'memory.example.com/agentmemory');
});

test('credential names are derived only for hosted endpoints', () => {
    // A loopback store keeps its secret next to its data / in ~/.agentmemory;
    // deriving a DSH store key there only produces a misleading diagnostic.
    assert.equal(credentialNameFor('http://localhost:3211'), null);
    assert.equal(credentialNameFor('https://memory.example.com'), 'AGENTMEMORY_SECRET_MEMORY_EXAMPLE_COM');
    assert.equal(credentialNameFor('https://memory.example.com', 'MY_REF'), 'MY_REF');
});

test('.dsh/agentmemory.json wins and is parsed into the internal target', () => {
    const root = makeWorkspace({
        '.dsh/agentmemory.json': {
            url: 'http://localhost:3211',
            viewerUrl: 'http://localhost:3213/',
            credential: 'AGENTMEMORY_SECRET_BA',
            agentScope: 'isolated',
            env: {
                AGENTMEMORY_ENV_FILE: '/tmp/baplatform.env',
                AGENTMEMORY_FORCE_PROXY: '0',
                UNRELATED: 'x',
            },
        },
        '.cursor/mcp.json': {
            mcpServers: {
                agentmemory: { command: 'npx', env: { AGENTMEMORY_URL: 'http://localhost:9999' } },
            },
        },
    });
    try {
        const target = resolveTarget(root);
        assert.ok(target);
        assert.equal(target.url, 'http://localhost:3211');
        assert.equal(target.viewerUrl, 'http://localhost:3213');
        assert.equal(target.secretRef, 'AGENTMEMORY_SECRET_BA');
        assert.equal(target.agentScope, 'isolated');
        assert.equal(target.label, 'localhost:3211');
        assert.match(target.source, /\.dsh\/agentmemory\.json$/);
        // Only AGENTMEMORY_* pass through, and the plugin's invariants are not
        // negotiable from a repo file.
        assert.deepEqual(target.extraEnv, { AGENTMEMORY_ENV_FILE: '/tmp/baplatform.env' });
    } finally {
        removeWorkspace(root);
    }
});

test('.cursor/mcp.json entry named agentmemory-mcp is parsed (FinESO dialect)', () => {
    const root = makeWorkspace({
        '.cursor/mcp.json': {
            mcpServers: {
                'agentmemory-mcp': {
                    command: '/opt/homebrew/bin/npx',
                    args: ['-y', '--offline', '@agentmemory/mcp'],
                    env: {
                        AGENTMEMORY_URL: 'http://localhost:3311',
                        AGENTMEMORY_VIEWER_URL: 'http://localhost:3313',
                        AGENTMEMORY_SECRET: 'repo-inline-secret',
                        AGENTMEMORY_CREDENTIAL_MODE: 'explicit',
                        AGENTMEMORY_AGENT_SCOPE: 'shared',
                    },
                },
            },
        },
    });
    try {
        const target = resolveTarget(root);
        assert.ok(target);
        assert.equal(target.url, 'http://localhost:3311');
        assert.equal(target.viewerUrl, 'http://localhost:3313');
        assert.equal(target.inlineSecret, 'repo-inline-secret');
        assert.equal(target.credentialMode, 'explicit');
        assert.equal(target.agentScope, 'shared');
        // command/args from the repo are ignored on purpose: the plugin spawns
        // its own configured shim, never a repo-authored command.
        assert.match(target.source, /\.cursor\/mcp\.json$/);
    } finally {
        removeWorkspace(root);
    }
});

test('an MCP entry with a different name is found by its AGENTMEMORY_URL', () => {
    const root = makeWorkspace({
        '.cursor/mcp.json': {
            mcpServers: {
                'memory-box': { command: 'npx', env: { AGENTMEMORY_URL: 'http://localhost:3411' } },
            },
        },
    });
    try {
        const target = resolveTarget(root);
        assert.ok(target);
        assert.equal(target.url, 'http://localhost:3411');
    } finally {
        removeWorkspace(root);
    }
});

test('.agents/mcp_config.json is read when there is no .cursor config', () => {
    const root = makeWorkspace({
        '.agents/mcp_config.json': {
            mcpServers: {
                agentmemory: { command: 'npx', env: { AGENTMEMORY_URL: 'http://localhost:3511' } },
            },
        },
    });
    try {
        const target = resolveTarget(root);
        assert.ok(target);
        assert.equal(target.url, 'http://localhost:3511');
        assert.match(target.source, /\.agents\/mcp_config\.json$/);
    } finally {
        removeWorkspace(root);
    }
});

test('precedence inside one directory: .dsh → .cursor → .agents', () => {
    const root = makeWorkspace({
        '.agents/mcp_config.json': { mcpServers: { agentmemory: { env: { AGENTMEMORY_URL: 'http://localhost:3633' } } } },
        '.cursor/mcp.json': { mcpServers: { agentmemory: { env: { AGENTMEMORY_URL: 'http://localhost:3622' } } } },
    });
    try {
        assert.equal(resolveTarget(root).url, 'http://localhost:3622');
        const withDsh = makeWorkspace({
            '.dsh/agentmemory.json': { url: 'http://localhost:3611' },
            '.cursor/mcp.json': { mcpServers: { agentmemory: { env: { AGENTMEMORY_URL: 'http://localhost:3622' } } } },
        });
        try {
            assert.equal(resolveTarget(withDsh).url, 'http://localhost:3611');
        } finally {
            removeWorkspace(withDsh);
        }
    } finally {
        removeWorkspace(root);
    }
});

test('a monorepo root config serves its packages (walk up to 6 levels)', () => {
    const root = makeWorkspace({
        '.cursor/mcp.json': { mcpServers: { agentmemory: { env: { AGENTMEMORY_URL: 'http://localhost:3711' } } } },
    });
    const nested = join(root, 'apps', 'web', 'src', 'feature');
    mkdirSync(nested, { recursive: true });
    try {
        // feature → src → web → apps → root: four parent hops.
        const target = resolveTarget(nested);
        assert.ok(target);
        assert.equal(target.url, 'http://localhost:3711');
    } finally {
        removeWorkspace(root);
    }
});

test('no config anywhere in the chain → null (register nothing)', () => {
    const root = makeWorkspace({});
    try {
        assert.equal(resolveTarget(root), null);
        assert.equal(resolveTarget(root, { globalDefault: { url: 'not a url' } }), null);
    } finally {
        removeWorkspace(root);
    }
});

test('the profile-wide default is the last resort', () => {
    const root = makeWorkspace({});
    try {
        const target = resolveTarget(root, { globalDefault: { url: 'http://localhost:3811', viewerUrl: 'http://localhost:3813' } });
        assert.ok(target);
        assert.equal(target.url, 'http://localhost:3811');
        assert.equal(target.source, 'profile');
    } finally {
        removeWorkspace(root);
    }
});

test('a broken config stops resolution instead of inheriting another repo\'s server', () => {
    // The dangerous alternative: skip the broken file and walk up to a parent
    // directory's server, which may belong to a *different* repo. Silently
    // writing memories there is the failure this plugin exists to prevent, so a
    // broken explicit config is reported, not skipped.
    const parent = makeWorkspace({
        '.cursor/mcp.json': { mcpServers: { agentmemory: { env: { AGENTMEMORY_URL: 'http://localhost:3911' } } } },
    });
    const child = join(parent, 'packages', 'app');
    mkdirSync(join(child, '.dsh'), { recursive: true });
    writeFileSync(join(child, '.dsh', 'agentmemory.json'), '{ this is not json');
    try {
        const resolved = resolveTarget(child);
        assert.ok(resolved.broken);
        assert.match(resolved.broken.path, /\.dsh\/agentmemory\.json$/);
        assert.match(resolved.broken.message, /JSON/i);
        assert.equal(resolved.url, undefined);
    } finally {
        removeWorkspace(parent);
    }
});

test('a missing config file is not a broken config', () => {
    const root = makeWorkspace({ '.cursor/mcp.json': { mcpServers: {} } });
    try {
        assert.equal(resolveTarget(root), null);
    } finally {
        removeWorkspace(root);
    }
});

test('resolveSecret: DSH store → repo inline → environment → none', async () => {
    const target = { secretRef: 'REF_ONE', inlineSecret: null, source: 'test' };
    const fromStore = await resolveSecret({ credentials: { resolve: async () => ({ value: 'store-secret', source: 'file' }) } }, target);
    assert.equal(fromStore.secret, 'store-secret');
    assert.match(fromStore.from, /^credentials:REF_ONE/);

    const inlineTarget = { ...target, inlineSecret: 'inline-secret' };
    const fromInline = await resolveSecret({}, inlineTarget);
    assert.equal(fromInline.secret, 'inline-secret');

    const previous = process.env.AGENTMEMORY_SECRET;
    process.env.AGENTMEMORY_SECRET = 'env-secret';
    try {
        const fromEnv = await resolveSecret({}, { ...target, secretRef: null, inlineSecret: null });
        assert.equal(fromEnv.secret, 'env-secret');
        assert.equal(fromEnv.from, 'environment');
    } finally {
        if (previous === undefined) delete process.env.AGENTMEMORY_SECRET;
        else process.env.AGENTMEMORY_SECRET = previous;
    }

    const none = await resolveSecret({}, { secretRef: null, inlineSecret: null });
    assert.equal(none.secret, null);
    assert.equal(none.from, null);
});
