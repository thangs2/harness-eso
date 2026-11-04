import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const marker = fileURLToPath(new URL('../MERGE_BLOCKED.md', import.meta.url));

test('merge block: no open critical batch', () => {
    if (!existsSync(marker)) return;
    const text = readFileSync(marker, 'utf8');
    const title = text.split('\n').find((line) => line.startsWith('# ')) ?? 'MERGE_BLOCKED';
    assert.fail(`${title} — see ${marker}`);
});
