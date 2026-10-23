import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    buildOwnershipReport,
    classifyPolicyOwnership,
    ownershipVerdict,
    renderOwnershipReport,
    sameValue,
} from '@mu/harness-foundation/ownership-report';
import { initProfile, projectDraftForConsumer } from '@mu/harness-foundation/init-profile';

/**
 * `init report` exists because the boundary between the two owners was prose while the merge that
 * crosses it was code. These tests pin the three states, and the one property that makes the report
 * worth reading: **an `overridden` key is one the next provision actually changes.** Asserting the
 * classification without asserting the merge would let the report drift into a confident lie — G-16.
 *
 * Atrievefin, 2026-10-23, before this file existed: the operator asked "is this key mine?" and the
 * answer was three files deep. The report is that answer, so the states are the contract.
 */
const ESO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILES_DIR = path.join(ESO_ROOT, 'profiles');

function tmpConsumer() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ownership-'));
}

test('ownership: a key equal to the plan is product-owned, an absent key is product-owned', () => {
    const r = classifyPolicyOwnership({ eso: { mode: 'hint' } }, { eso: { mode: 'hint', preflight: { enabled: true } } });
    assert.deepEqual(r.product.sort(), ['eso.mode', 'eso.preflight.enabled']);
    assert.deepEqual(r.overridden, []);
    assert.deepEqual(r.operator, []);
});

test('ownership: a key the file disagrees with is overridden, and names both values', () => {
    const r = classifyPolicyOwnership({ eso: { mode: 'off' } }, { eso: { mode: 'hint' } });
    assert.deepEqual(r.product, []);
    assert.deepEqual(r.overridden, [{ path: 'eso.mode', current: 'off', planned: 'hint' }]);
});

test('ownership: keys the plan never mentions are consumer-owned, reported as one subtree', () => {
    // `sot` is a map of a hundred entries on a real consumer; one line per entry is how a report stops
    // being read. The contract is the subtree, matching what `deepMergePolicyObjects` leaves alone.
    const r = classifyPolicyOwnership(
        { paths: { locked: ['a'], sot: { one: 'x', two: 'y' } }, teamTuning: { k: 1 } },
        { paths: { locked: ['a'] } },
    );
    assert.deepEqual(r.operator.sort(), ['paths.sot', 'teamTuning']);
});

test('ownership: arrays are replaced, not merged — a partial diff would suggest a union', () => {
    const r = classifyPolicyOwnership({ paths: { locked: ['a', 'b'] } }, { paths: { locked: ['a'] } });
    assert.equal(r.overridden.length, 1);
    assert.equal(r.overridden[0].path, 'paths.locked');
    assert.equal(sameValue(['a'], ['a']), true);
    assert.equal(sameValue(['a'], ['a', 'b']), false);
    assert.equal(sameValue({ a: [1] }, { a: [1] }), true);
});

test('ownership: overridden keys are exactly what a provision changes on disk', () => {
    // The load-bearing test. Provision a fresh consumer, tune two keys by hand (one with a different
    // value, one adding a key the product does not ship), then report and provision.
    const root = tmpConsumer();
    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-ownership' });
    initProfile(project, PROFILES_DIR, '/tmp/registry.json', { dryRun: false, verify: false });

    const policyPath = path.join(root, '.harness/decision-policy.json');
    const before = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    before.eso.mode = before.eso.mode === 'off' ? 'observe' : 'off';
    before.teamTuning = { keepMe: true };
    fs.writeFileSync(policyPath, JSON.stringify(before, null, 2));

    const plan = {
        root,
        files: initProfile(project, PROFILES_DIR, '/tmp/registry.json', { dryRun: true, verify: false }).files,
    };
    const report = buildOwnershipReport(root, plan);
    assert.deepEqual(report.policy.overridden.map((o) => o.path), ['eso.mode']);
    assert.deepEqual(report.policy.operator, ['teamTuning']);
    assert.equal(ownershipVerdict(report), 'drift');

    // Now provision and check the promise the report made.
    initProfile(project, PROFILES_DIR, '/tmp/registry.json', { dryRun: false, verify: false });
    const after = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    assert.notEqual(after.eso.mode, before.eso.mode, 'the overridden key must be replaced');
    assert.deepEqual(after.teamTuning, { keepMe: true }, 'the consumer-owned key must survive');
    assert.equal(ownershipVerdict(buildOwnershipReport(root, plan)), 'in-sync');
});

test('ownership: an absent policy file is `absent`, not an empty in-sync report', () => {
    const root = tmpConsumer();
    const project = projectDraftForConsumer(root, { hostMode: 'dual-ide', projectId: 'qc-ownership-absent' });
    const plan = {
        root,
        files: initProfile(project, PROFILES_DIR, '/tmp/registry.json', { dryRun: true, verify: false }).files,
    };
    const report = buildOwnershipReport(root, plan);
    assert.equal(report.policy.state, 'absent');
    assert.deepEqual(report.policy.operator, []);
    // The merge target is what the *next* provision writes; with no file it is the plan itself.
    assert.deepEqual(report.afterProvision, plan.files.find((f) => f.relative === '.harness/decision-policy.json').preview);
});

test('ownership: an unreadable policy is reported as broken, never as in-sync', () => {
    const root = tmpConsumer();
    fs.mkdirSync(path.join(root, '.harness'), { recursive: true });
    fs.writeFileSync(path.join(root, '.harness/decision-policy.json'), '{ not json');
    const report = buildOwnershipReport(root, { root, files: [] });
    assert.equal(report.policy.state, 'unreadable');
    assert.equal(ownershipVerdict(report), 'broken');
    assert.match(renderOwnershipReport(report), /not valid JSON/);
});
