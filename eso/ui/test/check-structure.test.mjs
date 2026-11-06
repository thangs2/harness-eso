import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The four boundary laws of `angular-standard` §1.2 exist so a layer cannot quietly reach into another.
// The defect this prevents: the checker matched the literal text `features/<x>` and therefore never saw a
// relative import such as `../../onboarding/data/consumer-profile.service.js` — the exact violation that
// `consumers.page.ts` shipped with while the check stayed green.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../scripts/check-structure.mjs');

/** Build a throwaway app tree from `{ 'features/a/pages/a.page.ts': '…' }` and run the checker on it. */
function run(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eso-ui-structure-'));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    try {
        execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, ESO_UI_APP_ROOT: root }, stdio: 'pipe' });
        return { ok: true, out: '' };
    } catch (e) {
        return { ok: false, out: String(e.stderr ?? e.stdout ?? e.message) };
    }
}

const PAGE = (imports) => `${imports}\nexport class P {}\n`;

test('B-1: features must not import layout, even relatively', () => {
    const r = run({
        'layout/shell/shell.component.ts': 'export class Shell {}\n',
        'features/a/pages/a.page.ts': PAGE("import { Shell } from '../../../layout/shell/shell.component.js';"),
    });
    assert.equal(r.ok, false, 'a feature reaching into layout must fail');
    assert.match(r.out, /features.*layout|layout/);
});

test('B-2: layout must not import features', () => {
    const r = run({
        'features/a/pages/a.page.ts': PAGE(''),
        'layout/shell/shell.component.ts': "import { P } from '../../features/a/pages/a.page.js';\n",
    });
    assert.equal(r.ok, false, 'layout reaching into a feature must fail');
});

test('B-3: shared must not import features or layout', () => {
    const feature = run({
        'features/a/pages/a.page.ts': PAGE(''),
        'shared/x/x.component.ts': "import { P } from '../../features/a/pages/a.page.js';\n",
    });
    assert.equal(feature.ok, false, 'shared reaching into a feature must fail');

    const layout = run({
        'layout/shell/shell.component.ts': 'export class Shell {}\n',
        'shared/x/x.component.ts': "import { Shell } from '../../layout/shell/shell.component.js';\n",
    });
    assert.equal(layout.ok, false, 'shared reaching into layout must fail');
});

test('cross-feature imports are caught relatively, not only by the literal word', () => {
    const r = run({
        'features/a/pages/a.page.ts': PAGE("import { S } from '../../b/data/b.service.js';"),
        'features/b/data/b.service.ts': 'export class S {}\n',
    });
    assert.equal(r.ok, false, 'feature a importing feature b by relative path must fail');
});

test('the same import inside one feature is allowed', () => {
    const r = run({
        'features/a/data/a.service.ts': 'export class S {}\n',
        'features/a/pages/a.page.ts': PAGE("import { S } from '../data/a.service.js';"),
    });
    assert.equal(r.ok, true, `same-feature relative import must pass\n${r.out}`);
});

test('a correctly placed tree passes', () => {
    const r = run({
        'features/a/pages/a.page.ts': PAGE(''),
        'features/a/data/a.service.ts': 'export class S {}\n',
        'shared/state-frame/state-frame.component.ts': 'export class F {}\n',
        'core/scope/scope.service.ts': 'export class C {}\n',
    });
    assert.equal(r.ok, true, `clean tree must pass\n${r.out}`);
});
