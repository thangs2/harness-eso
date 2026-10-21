import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compareContractFiles } from '../packages/harness-cli/src/check-contract-cmd.mjs';

function writeSpec(dir, name, spec) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(spec));
    return file;
}

test('the CLI comparison reads two files and reports breaking changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-contract-'));
    const before = writeSpec(dir, 'before.json', {
        paths: { '/approvals': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } } } },
    });
    const after = writeSpec(dir, 'after.json', { paths: { '/approvals': { get: { responses: {} } } } });

    const report = compareContractFiles(before, after);
    assert.equal(report.checked, 1);
    assert.deepEqual(report.breaking.map((b) => b.kind), ['response-removed']);
});
