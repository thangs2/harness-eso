import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkMigrationPaths } from '../packages/harness-cli/src/check-migration-cmd.mjs';

test('the CLI reads migration files and reports destructive DDL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-migration-'));
    const file = path.join(dir, '001.sql');
    fs.writeFileSync(file, 'ALTER TABLE orders DROP COLUMN status;');

    const report = checkMigrationPaths([file]);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].kind, 'drop-column');
    assert.equal(report.findings[0].file, file);
});
