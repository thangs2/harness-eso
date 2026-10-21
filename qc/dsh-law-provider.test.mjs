import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDshSkillsLaw } from '../packages/harness-host-dsh/src/law-provider.mjs';

function workspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dsh-law-'));
    fs.mkdirSync(path.join(root, '.agents', 'skills', 'tenancy'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'AGENTS.md'),
        '# Rules\n\nTenant isolation is mandatory.\nEvery query must filter tenant_id.\n',
    );
    fs.writeFileSync(
        path.join(root, '.agents', 'skills', 'tenancy', 'SKILL.md'),
        '# Tenancy skill\n\ntenant_id is required on every table.\nTenant isolation is reviewed in QC.\n',
    );
    return root;
}

test('the provider returns local law evidence with file and line provenance', async () => {
    const provider = createDshSkillsLaw({ root: workspace() });
    const out = await provider.fetch('tenant isolation');

    assert.equal(provider.capability, 'native');
    assert.ok(provider.ceiling < 1, 'skills are not a normative corpus');
    assert.ok(out.snippets.length >= 1);
    const first = out.snippets[0];
    assert.equal(first.kind, 'law');
    assert.match(first.text.toLowerCase(), /tenant/);
    assert.equal(first.provenance.kind, 'file');
    assert.ok(first.provenance.file.endsWith('AGENTS.md') || first.provenance.file.includes('SKILL.md'));
    assert.ok(first.provenance.line >= 1);
});

test('the file with more hits ranks first', async () => {
    const provider = createDshSkillsLaw({ root: workspace() });
    const out = await provider.fetch('tenant_id');
    assert.match(out.snippets[0].text, /tenant_id/);
});

test('an empty query does not scan, and a miss returns nothing', async () => {
    const provider = createDshSkillsLaw({ root: workspace() });
    assert.deepEqual((await provider.fetch('   ')).snippets, []);
    assert.deepEqual((await provider.fetch('kubernetes ingress')).snippets, []);
});

test('maxSnippets bounds the result', async () => {
    const provider = createDshSkillsLaw({ root: workspace(), maxSnippets: 1 });
    const out = await provider.fetch('tenant isolation');
    assert.equal(out.snippets.length, 1);
});

test('a missing root is unhealthy instead of throwing', async () => {
    const provider = createDshSkillsLaw({ root: path.join(os.tmpdir(), 'harness-dsh-law-missing') });
    assert.equal(provider.healthCheck(), false);
    assert.deepEqual((await provider.fetch('tenant')).snippets, []);
});
