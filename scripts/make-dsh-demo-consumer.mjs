#!/usr/bin/env node
/**
 * Make a throwaway consumer that demonstrates both gate paths, for a live check inside DSH.
 *
 * Why a script and not a hand-made fixture: the demo must be reproducible on any machine and must not
 * touch a real project. It writes only into `--out` (default `/tmp/eso-dsh-demo`) and prints the exact
 * prompts to send.
 *
 * The fixture declares:
 *   - a `locked` directory, so writing there is denied outright;
 *   - a `gated` file, so an unapproved write is denied with a reason;
 *   - one `eso.checks.migration` file with `drop table`, so the prompt gate refuses the next step and
 *     leaves a record in the product-state trail.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * @param {{ out?: string, projectId?: string }} [options]
 * @returns {{ root: string, files: string[], prompts: string[] }}
 */
export function makeDemoConsumer(options = {}) {
    const root = path.resolve(options.out || path.join(os.tmpdir(), 'eso-dsh-demo'));
    const projectId = options.projectId || 'eso-demo';

    if (fs.existsSync(root) && fs.readdirSync(root).length) {
        throw new Error(`${root} is not empty — pass --out with a fresh directory`);
    }

    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });

    const files = {};
    files['harness.config.json'] = JSON.stringify({ version: 1, project: { id: projectId } }, null, 4);
    files['.harness/decision-policy.json'] = JSON.stringify(
        {
            version: 1,
            jev: { mode: 'off' },
            eso: {
                enabled: true,
                mode: 'hint',
                enforceWrites: 'fail_closed',
                checks: { migration: { files: ['db/migrations/001_drop.sql'] } },
            },
            paths: { locked: ['secrets/'], gated: ['AGENTS.md'], ask: [], sot: [] },
        },
        null,
        4,
    );
    files['db/migrations/001_drop.sql'] = 'drop table orders;\n';
    files['AGENTS.md'] = '# Demo workspace\n\nThis file is in the gated tier.\n';
    files['README.md'] = [
        '# ESO demo consumer',
        '',
        'Open this folder as a workspace in DeepSeek Harness and send one of the prompts below.',
        'The plugin is a profile plugin: it acts here because this directory declares itself.',
        '',
        'Prompts:',
        '1. "append a line to AGENTS.md"      → denied (gated, no consent)',
        '2. "write secrets/probe.txt"          → denied (locked)',
        '3. "summarise README.md"              → allowed (read-only)',
        '',
    ].join('\n');

    for (const [rel, content] of Object.entries(files)) {
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
    }

    return {
        root,
        files: Object.keys(files),
        prompts: [
            'append a line to AGENTS.md',
            'write secrets/probe.txt with the word probe',
            'summarise README.md',
        ],
    };
}

if (import.meta.main) {
    const outIndex = process.argv.indexOf('--out');
    const out = outIndex > -1 ? process.argv[outIndex + 1] : undefined;
    const result = makeDemoConsumer({ out });
    console.log(`demo consumer → ${result.root}`);
    for (const file of result.files) console.log(`  ${file}`);
    console.log('\nOpen this folder as a DSH workspace, then send:');
    for (const prompt of result.prompts) console.log(`  - ${prompt}`);
    console.log('\nThen inspect the trail:');
    console.log(`  cat ${path.join(os.homedir(), '.harness', 'eso-blockers.jsonl')}`);
}
