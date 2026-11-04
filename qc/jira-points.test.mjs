// X33 — Story Points theo standard 07 §10, kiểm trên dữ liệu JIRA THẬT.
//
// Ba loại vi phạm: thiếu điểm · điểm ngoài Fibonacci · roll-up lệch (Story/Task = Σ subtask, Epic = Σ con).
//
// Test này cần mạng và credential, nên nó **skip** khi thiếu `JIRA_API_TOKEN` thay vì đỏ. Một phép kiểm đỏ vì
// máy không có token sẽ bị tắt, và tắt rồi thì không ai bật lại — nên skip có tên rõ ràng, và in ra vì sao.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = join(ROOT, '.env');
const load = () => {
    if (existsSync(env)) for (const l of readFileSync(env, 'utf8').split('\n')) {
        const m = /^([A-Z_]+)=(.*)$/.exec(l.trim());
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    if (process.env.JIRA_TLS_INSECURE === '1') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    return Boolean(process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN && process.env.JIRA_USER_EMAIL);
};

const FIB = new Set([1, 2, 3, 5, 8, 13]);
const SP = 'customfield_10016';

/*
 * Registered with `skip` up front rather than calling `t.skip()` inside the body: Bun's `node:test`
 * shim throws `NotImplementedError: skip() is not yet implemented in Bun` (Bun 1.3.14), so the
 * in-body form turned a credential-less machine into a red gate — which is how a check gets deleted.
 * The option form both skips and reports the reason under Bun.
 */
test('X33: story points — đủ, Fibonacci, và roll-up khớp', {
    skip: load() ? false : 'không có JIRA_* trong env — phép kiểm này cần Jira thật (standard 07 §10)',
}, async () => {
    const base = process.env.JIRA_BASE_URL.replace(/\/$/, '');
    const auth = 'Basic ' + Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

    const issues = [];
    let token;
    do {
        const q = `/rest/api/3/search/jql?jql=${encodeURIComponent('project = ESO ORDER BY key')}` +
            `&fields=summary,issuetype,parent,subtasks,${SP}&maxResults=100${token ? `&nextPageToken=${token}` : ''}`;
        const res = await fetch(base + q, { headers: { Authorization: auth, Accept: 'application/json' } });
        assert.ok(res.ok, `Jira trả ${res.status} — không kiểm được`);
        const d = await res.json();
        issues.push(...(d.issues || []));
        token = d.nextPageToken;
    } while (token);

    assert.ok(issues.length > 20, `chỉ thấy ${issues.length} issue — phép kiểm không phủ gì`);

    const byKey = new Map(issues.map((i) => [i.key, i]));
    // Con của Epic đi qua `parent`; con của Story/Task đi qua `subtasks`. Hai đường khác nhau, không phải một.
    const kidsOfEpic = new Map();
    for (const i of issues) {
        const p = i.fields.parent?.key;
        if (p) kidsOfEpic.set(p, [...(kidsOfEpic.get(p) || []), i.key]);
    }
    const sp = (i) => (i.fields[SP] === null || i.fields[SP] === undefined ? null : Number(i.fields[SP]));
    const type = (i) => i.fields.issuetype.name;
    const kids = (i) => (type(i) === 'Epic' ? kidsOfEpic.get(i.key) || [] : (i.fields.subtasks || []).map((s) => s.key));

    const missing = [], notFib = [], badRoll = [];
    for (const i of issues) {
        const tp = type(i), v = sp(i), k = kids(i);
        if (v === null) { missing.push(`${i.key} (${tp})`); continue; }
        if (['Story', 'Task', 'Epic'].includes(tp) && k.length) {
            const sum = k.reduce((a, c) => a + (sp(byKey.get(c)) ?? 0), 0);
            if (sum !== v) badRoll.push(`${i.key} (${tp}) = ${v} ≠ ${sum} [${k.join('+')}]`);
        } else if (tp === 'Epic') { if (v !== 0) notFib.push(`${i.key} (Epic rỗng) = ${v}, phải 0`); }
        else if (!FIB.has(v)) notFib.push(`${i.key} (${tp}) = ${v} ∉ {1,2,3,5,8,13}`);
    }

    assert.deepEqual(missing.sort(), [], 'issue thiếu Story Points');
    assert.deepEqual(notFib.sort(), [], 'điểm ngoài dãy Fibonacci');
    assert.deepEqual(badRoll.sort(), [], 'roll-up lệch so với con');
});
