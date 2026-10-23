import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDshSkillsLaw } from '../packages/harness-host-dsh/src/law-provider.mjs';

function workspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-law-'));
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'isolation'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'AGENTS.md'),
        '# Rules\n\nIsolation is mandatory.\nEvery query must filter caller_id.\n',
    );
    fs.writeFileSync(
        path.join(root, '.agents', 'skills', 'isolation', 'SKILL.md'),
        '# Isolation skill\n\ncaller_id is required on every table.\nIsolation is reviewed in QC.\n',
    );
    return root;
}

test('the provider returns local law evidence with file and line provenance', async () => {
    const provider = createDshSkillsLaw({ root: workspace() });
    const out = await provider.fetch('project isolation');

    assert.equal(provider.capability, 'native');
    assert.ok(provider.ceiling < 1, 'skills are not a normative corpus');
    assert.ok(out.snippets.length >= 1);
    const first = out.snippets[0];
    assert.equal(first.kind, 'law');
    assert.match(first.text.toLowerCase(), /caller_id/);
    assert.equal(first.provenance.kind, 'file');
    assert.ok(first.provenance.file.endsWith('AGENTS.md') || first.provenance.file.includes('SKILL.md'));
    assert.ok(first.provenance.line >= 1);
});

test('the file with more hits ranks first', async () => {
    const provider = createDshSkillsLaw({ root: workspace() });
    const out = await provider.fetch('caller_id');
    assert.match(out.snippets[0].text, /caller_id/);
});

test('an empty query does not scan, and a miss returns nothing', async () => {
    const provider = createDshSkillsLaw({ root: workspace() });
    assert.deepEqual((await provider.fetch('   ')).snippets, []);
    assert.deepEqual((await provider.fetch('kubernetes ingress')).snippets, []);
});

test('maxSnippets bounds the result', async () => {
    const provider = createDshSkillsLaw({ root: workspace(), maxSnippets: 1 });
    const out = await provider.fetch('project isolation');
    assert.equal(out.snippets.length, 1);
});

test('a missing root is unhealthy instead of throwing', async () => {
    const provider = createDshSkillsLaw({ root: path.join(os.tmpdir(), 'harness-dsh-law-missing') });
    assert.equal(provider.healthCheck(), false);
    assert.deepEqual((await provider.fetch('project')).snippets, []);
});
