// The SLP audit rubric as a durable check (ESO-374 fail case, ESO-379 evidence blocker).
//
// Why this file exists in `qc/`: the audits this ticket was opened to stop were prose that scored themselves 100/100 —
// `commands[]` nobody ran, a test file that never existed, no commit, no failing case, no independence statement. The
// rubric that rejects that shape previously lived only under `comments/artifacts/slp/audit/`, which is throwaway
// evidence: delete the folder and the check disappears with it. This file is the durable half — it runs in the suite,
// it can fail, and it names the rule for every rejection.
//
// Rules (core.slp.mdc §6, four criteria + the CRITICAL override, expressed so a machine can refuse an audit):
//   R1  `commands[]` is not empty, and every repository file a command names exists.
//   R2  the audit names the commit it judged — an audit of "the code" that does not name the code is an audit of
//       whatever happened to be on disk.
//   R3  a 100/100 score is rejected: a rubric that finds nothing on every audit is either unused or wrong. A
//       zero-finding audit must carry a finding or an attestation, so "no findings" is never the whole story.
//   R4  a failing case actually ran: a command, a non-zero exit code, and what failure was expected.
//   R5  independence is stated: the audit re-ran its commands, and a same-worker audit records that limit as a
//       non-INFO finding instead of implying an independence it does not have.
//   R6  `passed` agrees with score >= 85 and an empty `critical[]`.
//
// The fail cases below are the point of the file. If the rubric ever accepts the fabricated audit, or accepts a
// well-formed audit that scores itself 100, this suite goes red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The commit every audit artifact in this batch names. */
export const VERIFIED_COMMIT = '868290b';

const REPO = new URL('..', import.meta.url).pathname;

/** Path-shaped tokens inside a shell command: a slash and a file extension. Directories and flags are not files. */
const PATH_TOKEN = /(?:\.{0,2}\/)?[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@/-]*\.[A-Za-z0-9]+/g;

/** Every repo-relative file a command names. Absolute paths are environment, not repository evidence. */
export function commandPaths(command) {
    if (typeof command !== 'string') return [];
    return [...command.matchAll(PATH_TOKEN)].map((m) => m[0]).filter((p) => !p.startsWith('/'));
}

/** Rubric violations for one audit object. Empty array = the audit meets the bar. */
export function validateAudit(audit, { repo = REPO, commit = VERIFIED_COMMIT } = {}) {
    const problems = [];
    const add = (rule, message) => problems.push({ rule, message });

    // R1 — an audit with no command is a claim; a command naming a missing file is a broken claim.
    if (!Array.isArray(audit?.commands) || audit.commands.length === 0) {
        add('R1', 'commands[] is empty');
    } else {
        for (const command of audit.commands) {
            if (typeof command !== 'string' || command.trim() === '') {
                add('R1', 'commands[] holds something that is not a command');
                continue;
            }
            for (const named of commandPaths(command)) {
                if (!existsSync(join(repo, named))) add('R1', `command names a file that does not exist: ${named}`);
            }
        }
    }

    // R2 — the commit the audit judged.
    if (typeof audit?.commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(audit.commit)) {
        add('R2', 'no commit SHA');
    } else if (!commit.startsWith(audit.commit) && !audit.commit.startsWith(commit)) {
        add('R2', `commit ${audit.commit} is not the verified commit ${commit}`);
    }

    // R3 — the self-score problem, and the empty-findings problem that always travels with it.
    if (typeof audit?.score !== 'number' || !Number.isInteger(audit.score)) {
        add('R3', 'score is not an integer');
    } else if (audit.score >= 100) {
        add('R3', 'score 100 — an audit that cannot lose points reports its own absence');
    }
    if (!Array.isArray(audit?.findings) || audit.findings.length === 0) add('R3', 'findings[] is empty');

    // R4 — the failing case, executed. `executed` is a claim; `exit_code` is the measurement.
    const negative = audit?.negative_case ?? {};
    if (negative.executed !== true) add('R4', 'no negative case was executed');
    if (typeof negative.command !== 'string' || negative.command.trim() === '') add('R4', 'negative case has no command');
    if (!Number.isInteger(negative.exit_code) || negative.exit_code === 0) {
        add('R4', 'negative case did not fail (exit_code must be a non-zero integer)');
    }
    if (typeof negative.expected !== 'string' || negative.expected.trim() === '') {
        add('R4', 'negative case does not say what failure it expected');
    }

    // R5 — independence, stated.
    const independence = audit?.independence ?? {};
    if (independence.commands_rerun_in_audit !== true) add('R5', 'independence: audit did not re-run its commands');
    if (independence.same_worker_as_verify === true) {
        const noted = (audit.findings ?? []).some((f) => f.code === 'INDEPENDENCE_LIMIT' && f.severity !== 'INFO');
        if (!noted) add('R5', 'same worker ran verify and audit — record INDEPENDENCE_LIMIT as a non-INFO finding');
    } else if (independence.same_worker_as_verify !== false) {
        add('R5', 'independence: same_worker_as_verify must be stated');
    }
    if (independence.self_audited_own_artifact === true && audit.provisional !== true) {
        add('R5', 'self-audited artifact must carry provisional: true');
    }

    // R6 — a red audit cannot carry a green flag, and a green flag cannot hide a red score.
    const critical = Array.isArray(audit?.critical) ? audit.critical : null;
    if (critical === null) add('R6', 'critical[] is missing');
    else if (audit?.passed === true && (audit.score < 85 || critical.length > 0)) {
        add('R6', `passed=true contradicts score ${audit.score} / ${critical.length} critical`);
    } else if (audit?.passed === false && audit.score >= 85 && critical.length === 0) {
        add('R6', `passed=false contradicts a clean ${audit.score}`);
    }

    return problems;
}

/** A real audit, with findings, at the verified commit — the shape the rubric must accept. */
const realAudit = {
    key: 'ESO-371',
    commit: VERIFIED_COMMIT,
    score: 88,
    passed: true,
    verdict: 'AUDIT_PASS',
    commands: ['bun test qc/eso-core-host-ui.test.mjs'],
    findings: [
        { code: 'RETENTION_IS_A_COPY', severity: 'INFO', message: 'the retained file is re-read before the sandbox is removed' },
    ],
    critical: [],
    negative_case: {
        executed: true,
        command: 'node --test /tmp/eso-371-red.test.mjs',
        exit_code: 1,
        expected: 'the retention test fails against the pre-fix script',
    },
    independence: { commands_rerun_in_audit: true, same_worker_as_verify: false },
};

test('ESO-374: a fabricated 100/100 audit is rejected by every evidence rule', () => {
    // Every defect the ticket lists, in one object: `ls` as an audit command, a test file that does not exist, no
    // commit, no failing case, no findings, 100/100. Rejecting it proves little if only one rule fires, so the
    // assertion is the full rule set.
    const fabricated = {
        key: 'ESO-000',
        ticket: 'ESO-000',
        score: 100,
        passed: true,
        verdict: 'AUDIT_PASS',
        commands: ['ls -la comments/artifacts/slp/audit/', 'bun test qc/eso-evidence.test.mjs'],
        findings: [],
        critical: [],
    };
    const problems = validateAudit(fabricated);
    assert.deepEqual([...new Set(problems.map((p) => p.rule))].sort(), ['R1', 'R2', 'R3', 'R4', 'R5']);
    assert.ok(
        problems.some((p) => p.message.includes('qc/eso-evidence.test.mjs')),
        'the nonexistent test file must be named, not just counted',
    );
});

test('ESO-374: a well-formed audit that scores itself 100 is rejected on that score alone', () => {
    // The same fixture as above is broken in every field at once, so any single rule could be carrying the rejection.
    // This one is valid everywhere except its perfect score. If 100/100 can pass, the rubric has stopped detecting the
    // defect it exists for.
    const perfect = { ...realAudit, score: 100 };
    const problems = validateAudit(perfect);
    assert.deepEqual(problems.map((p) => p.rule), ['R3'], problems.map((p) => `${p.rule} ${p.message}`).join(' | '));
    assert.match(problems[0].message, /score 100/);
    // The rule rejects the self-score, not well-formed audits: one point lower is accepted.
    assert.deepEqual(validateAudit({ ...perfect, score: 99 }), []);
});

test('ESO-374: a real audit with findings passes every rule', () => {
    assert.deepEqual(validateAudit(realAudit), []);
    // And the two rules that a passing audit must not be able to fake: a zero-command audit and a phantom file.
    assert.deepEqual(validateAudit({ ...realAudit, commands: [] }).map((p) => p.rule), ['R1']);
    assert.deepEqual(
        validateAudit({ ...realAudit, commands: ['bun test qc/eso-evidence.test.mjs'] }).map((p) => p.rule),
        ['R1'],
    );
});

test('ESO-379: every audit artifact on disk names 868290b, and no perfect score is left unproven', () => {
    // The audit JSONs under comments/artifacts are throwaway evidence — this test reads them when present and says so
    // when they are not, so a fresh clone is not red because a tmp folder is absent. What it enforces is the rule the
    // Lead set: an audit names its commit, and a 100/100 audit carries a finding or an attestation instead of being
    // zero-finding.
    const dir = join(REPO, 'comments/artifacts/slp/audit');
    if (!existsSync(dir)) {
        console.log('[ESO-379] comments/artifacts/slp/audit is absent — on-disk audit check skipped (tmp evidence folder)');
        return;
    }
    const files = readdirSync(dir).filter((name) => name.endsWith('-audit.json')).sort();
    assert.ok(files.length > 0, 'the audit directory exists but holds no *-audit.json');

    const uncommitted = [];
    const unproven = [];
    for (const name of files) {
        const audit = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (audit.commit !== VERIFIED_COMMIT) uncommitted.push(`${name}(${audit.commit ?? 'none'})`);
        const findings = Array.isArray(audit.findings) ? audit.findings : [];
        if (audit.score >= 100 && findings.length === 0 && !audit.attestation) unproven.push(name);
    }
    assert.deepEqual(uncommitted, [], `audits that do not name ${VERIFIED_COMMIT}: ${uncommitted.join(', ')}`);
    assert.deepEqual(unproven, [], `perfect scores with no finding and no attestation: ${unproven.join(', ')}`);
    console.log(`[ESO-379] ${files.length} audit artifacts name ${VERIFIED_COMMIT}; 0 perfect scores without proof`);
});
