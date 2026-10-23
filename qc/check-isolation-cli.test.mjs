import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkIsolationPaths } from '../packages/harness-cli/src/check-isolation-cmd.mjs';

test('the CLI reads SQL files and reports a missing project filter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-project-'));
    const bad = path.join(dir, 'bad.sql');
    const good = path.join(dir, 'good.sql');
    fs.writeFileSync(bad, 'SELECT * FROM orders');
    fs.writeFileSync(good, 'SELECT * FROM orders WHERE caller_id = $1');

    const report = checkIsolationPaths([bad, good], ['orders']);
    assert.equal(report.files, 2);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].file, bad);
});
