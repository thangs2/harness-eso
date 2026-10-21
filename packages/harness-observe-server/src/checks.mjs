/**
 * Conformance checks per request.
 *
 * These answer the user's real question — "was this request's routing correct?"
 * — using only what the two sources actually recorded. Every check that infers
 * rather than observes is marked heuristic=1 and can render a `warn`, so the UI
 * never presents a guess as a verdict.
 *
 * Ground truth available: attached rules, tool list, file paths, and the raw
 * hook JSON (from which shell commands can be read).
 */

import path from 'node:path';

import { isoNow } from './observe-config.mjs';
import {
    loadDecisionPolicy,
    pathMode,
    resolvePathPolicy,
    shellHasWriteIntent,
    shellWriteTargets,
} from '@mu/harness-foundation/pure';

/**
 * A tool that runs a command. Bash and Terminal are accepted for non-Cursor harnesses.
 */
const SHELL_TOOL_RE = /^(Shell|Bash|Terminal)$/;
/**
 * Kept in lockstep with route-watch.mjs's `VERIFY_RE`. A verify is a real
 * COMMAND, so it may only ever be read out of a Shell payload: matching
 * arbitrary raw JSON false-passed on `.../verify-app.mjs` — the path of every
 * Read/Write of the harness's own verifier — so merely opening that file counted
 * as running it.
 */
const VERIFY_RE = /\b(bun\s+(run\s+)?(build|test)|tsc\b|npm\s+(run\s+)?(build|test)|vitest|jest|refresh\.sh|verify-app|verify-ingest)\b/;
const BRAIN_RE = /ask_deepseek/i;
/**
 * The Read *tool* is what proves a read. `beforeReadFile` cannot: Cursor emits it
 * before it overwrites a file too, since it reads the current body to compute the
 * edit. Its only reliable signal is the opposite one — no `beforeReadFile` for a
 * path means the path was created here. (Same reasoning as route-watch.mjs.)
 */
const READ_TOOL_RE = /^read/i;

function verdict(status, heuristic, detail) {
    return { status, heuristic, detail };
}

/** The command a Shell hook ran, from either payload shape, or ''. */
function shellCommand(rawJson) {
    let j = rawJson;
    try {
        j = typeof rawJson === 'string' ? JSON.parse(rawJson || '{}') : rawJson || {};
    } catch {
        return '';
    }
    const c = j?.payload?.tool_input?.command ?? j?.tool_input?.command ?? j?.command;
    return typeof c === 'string' ? c : '';
}

/**
 * Resolve an event path to a repository-relative one, or `null` when it is outside the checkout.
 *
 * `afterFileEdit` also fires for scratch files written outside the repo (an analysis script under
 * /tmp, for instance). Counting those as "the last edit" made a real turn report "no verify after
 * the final edit": the agent wrote `/tmp/analyze*.mjs` after `tsc` had already passed, so the verify
 * window was extended by files the repository build can never cover. `route-watch.mjs` already
 * normalises through the same rule; this file did not, and that drift is the defect.
 */
function repoRel(root, p) {
    const s = String(p || '');
    if (!s || !root) return null;
    const abs = path.isAbsolute(s) ? s : path.resolve(root, s);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..')) return null;
    return rel.split(path.sep).join('/');
}

function baseName(p) {
    const s = String(p || '');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * True when a shell invocation actually RUNS a verifier. Inspecting the
 * verifier's source is not running it, so `cat`/`grep`/`echo` segments are
 * dropped before the match — otherwise `cat verify-app.mjs` reads as a verify.
 */
function isVerifyCommand(cmd) {
    return String(cmd || '')
        .split(/(?:&&|\|\||;|\n)/)
        .some((part) => {
            const t = part.trim();
            if (!t) return false;
            if (/^(cat|grep|rg|less|head|tail|echo|printf|which|type)\b/.test(t)) return false;
            return VERIFY_RE.test(t);
        });
}

export function computeChecks(db, cfg, scope) {
    const projectId = cfg.project.id;
    const now = isoNow();
    /*
     * Which paths count as protected is **consumer policy**, resolved once per pass. It used to be a
     * regex in this file, which meant the product hardcoded one consumer's directories — and that the
     * second copy had already drifted: it was blind to `scripts/ci/`, the `hooks/` scripts and the
     * skills/agents directories, so a write to the verifiers reported as "no protected path was edited".
     * One list, in the consumer's policy, read by the guard and the observer alike.
     */
    const policy = loadDecisionPolicy(cfg).policy;
    const pathPolicy = resolvePathPolicy(policy);
    // Same scoping rule as overlayEvidence: recomputing every request each poll
    // is what made a pass take seconds.
    let requests;
    if (!scope) {
        requests = db.all('SELECT id, call_count, tool_count, status, generation_id FROM request WHERE project_id = ?', [projectId]);
    } else {
        const ids = [...(scope.requestIds || [])];
        const gens = [...(scope.generations || [])];
        if (!ids.length && !gens.length) return 0;
        const idPh = ids.map(() => '?').join(',') || 'NULL';
        const genPh = gens.map(() => '?').join(',') || 'NULL';
        requests = db.all(
            `SELECT id, call_count, tool_count, status, generation_id FROM request
             WHERE project_id = ? AND (id IN (${idPh}) OR generation_id IN (${genPh}))`,
            [projectId, ...ids, ...gens],
        );
    }

    for (const req of requests) {
        const rules = db.all('SELECT rule_id FROM request_rule WHERE request_id = ?', [req.id]);
        const tools = db.all('SELECT tool, count FROM request_tool WHERE request_id = ?', [req.id]);
        const files = db.all('SELECT path, actions, reads, edits FROM request_file WHERE request_id = ?', [req.id]);
        const events = db.all(
            'SELECT id, event_type, tool, path, raw_json FROM event WHERE request_id = ? ORDER BY id',
            [req.id],
        );

        // No hook evidence for this request at all — it predates hook tracing, or
        // the hook files were rotated away. ABSENCE OF EVIDENCE IS NOT A FAILURE:
        // every check reports skip. Reporting a fabricated `fail` here would be
        // worse than reporting nothing, because this panel exists to be trusted.
        if (events.length === 0) {
            for (const checkId of CHECK_IDS) {
                db.run(
                    `INSERT INTO check_result (request_id, check_id, status, heuristic, detail) VALUES (?, ?, 'skip', 1, ?)
                     ON CONFLICT(request_id, check_id) DO UPDATE SET status = 'skip', heuristic = 1, detail = excluded.detail`,
                    [req.id, checkId, 'no hook evidence recorded for this request'],
                );
            }
            db.run('UPDATE request SET checks_pass = 0, checks_fail = 0, has_failures = ?, updated_at = ? WHERE id = ?', [
                req.status === 'error' ? 1 : 0,
                now,
                req.id,
            ]);
            continue;
        }

        const editedPaths = files.filter((f) => f.edits > 0);
        const results = {};

        // Absence-of-evidence guard for the two rule-dependent checks. The
        // `beforeSubmitPrompt` hook fires for only a tiny fraction of requests, so
        // most prompts were never captured. When the prompt was NOT captured we do
        // not know which rules were attached, and reporting `fail` there is a
        // false verdict — the module's own rule ("absence of evidence is not
        // failure") has to apply to a missing capture, not just to zero events.
        // A captured prompt with an empty rule list is still a real failure.
        const promptCaptured =
            !!req.generation_id &&
            !!db.get('SELECT 1 FROM hook_prompt WHERE project_id = ? AND generation_id = ?', [
                projectId,
                req.generation_id,
            ]);

        // --- rules-attached: an edit turn with zero attached rules is the failure
        if (req.tool_count === 0 && rules.length === 0) {
            results['rules-attached'] = verdict('skip', 0, 'no tool activity recorded for this request');
        } else if (rules.length > 0) {
            results['rules-attached'] = verdict('pass', 0, `${rules.length} rule(s) attached at prompt time`);
        } else if (!promptCaptured) {
            results['rules-attached'] = verdict('skip', 1, 'prompt attachment was not captured — cannot judge');
        } else {
            results['rules-attached'] = verdict('fail', 0, 'prompt carried no rule attachment');
        }

        // --- eager-prefix-budget: token-diet conformance
        const tokenDiet = policy.tokenDiet || {};
        if (tokenDiet.enabled === false) {
            results['eager-prefix-budget'] = verdict('skip', 0, 'tokenDiet check disabled in policy');
        } else if (!promptCaptured) {
            results['eager-prefix-budget'] = verdict('skip', 1, 'prompt attachment was not captured — cannot judge');
        } else if (rules.length === 0) {
            results['eager-prefix-budget'] = verdict('skip', 0, 'no rules attached at prompt time');
        } else {
            const maxEagerRules = Number(tokenDiet.maxEagerRules) || 7;
            if (rules.length > maxEagerRules) {
                results['eager-prefix-budget'] = verdict(
                    'warn',
                    1,
                    `eager prefix exceeds budget: ${rules.length} rules attached (budget <= ${maxEagerRules})`,
                );
            } else {
                results['eager-prefix-budget'] = verdict(
                    'pass',
                    0,
                    `${rules.length} eager rule(s) attached within budget (<= ${maxEagerRules})`,
                );
            }
        }

        // --- edits-covered-by-attached-rules (heuristic: rule globs are not
        //     resolvable here, so this only asserts that rules existed at all)
        if (editedPaths.length === 0) {
            results['edits-covered-by-attached-rules'] = verdict('skip', 1, 'no edits in this request');
        } else if (rules.length > 0) {
            results['edits-covered-by-attached-rules'] = verdict(
                'pass',
                1,
                `${editedPaths.length} edited path(s) with ${rules.length} attached rule(s)`,
            );
        } else if (!promptCaptured) {
            results['edits-covered-by-attached-rules'] = verdict('skip', 1, 'prompt attachment was not captured — cannot judge');
        } else {
            results['edits-covered-by-attached-rules'] = verdict('fail', 1, 'edits happened with no attached rules');
        }

        // --- read-before-edit (heuristic, `warn`). Same invariant as
        //     route-watch.mjs's check of the same id; src/lib/checks.test.mjs
        //     pins it. The ONLY provable violation is overwriting a file that
        //     already existed and was never opened — not with the Read tool, not
        //     through the shell. A read landing AFTER an edit is NOT a violation:
        //     that is the normal read -> edit -> read -> edit repair loop, and
        //     flagging it is what made this check 20/20 false positives.
        //     Paths are taken from the EVENT stream alone so both sides of the
        //     comparison are in the same string space (event.path mixes absolute
        //     and relative forms, and request_file.path need not agree with it).
        const isRepoEdit = (e) => e.event_type === 'afterFileEdit' && repoRel(cfg.root, e.path) !== null;
        const editEventPaths = [...new Set(events.filter(isRepoEdit).map((e) => e.path).filter(Boolean))];
        const announcedRead = new Set();
        const readToolPaths = new Set();
        const firstEventOf = new Map();
        const shellCmds = [];
        for (const e of events) {
            if (e.path) {
                if (!firstEventOf.has(e.path)) firstEventOf.set(e.path, e.event_type);
                if (e.event_type === 'beforeReadFile') announcedRead.add(e.path);
                if (e.event_type === 'postToolUse' && READ_TOOL_RE.test(e.tool || '')) readToolPaths.add(e.path);
            }
            if (e.tool === 'Shell') {
                const cmd = shellCommand(e.raw_json);
                if (cmd.trim()) shellCmds.push(cmd);
            }
        }
        // A path whose first event is the edit was created here (no prior state
        // to read); `beforeReadFile`'s absence is the other proof of the same.
        const createdHere = (p) => (firstEventOf.has(p) ? firstEventOf.get(p) === 'afterFileEdit' : !announcedRead.has(p));
        // Shell inspection counts, matched by full path or basename — approximate
        // by nature (a basename collision can false-pass), which is why this
        // check is heuristic and can never render more than a `warn`.
        const openedByShell = (p) => {
            const b = baseName(p);
            return shellCmds.some((c) => c.includes(p) || (b && c.includes(b)));
        };
        const unreadEdits = editEventPaths.filter((p) => !createdHere(p) && !readToolPaths.has(p) && !openedByShell(p));
        if (editedPaths.length === 0) {
            results['read-before-edit'] = verdict('skip', 1, 'no edits in this request');
        } else if (editEventPaths.length === 0) {
            results['read-before-edit'] = verdict('skip', 1, 'edits recorded but no edit event captured — cannot judge');
        } else if (unreadEdits.length) {
            results['read-before-edit'] = verdict('warn', 1, `existing file(s) modified without being read: ${unreadEdits.slice(0, 3).join(', ')}`);
        } else {
            results['read-before-edit'] = verdict('pass', 1, `${editEventPaths.length} edited path(s) were read or created here`);
        }

        // --- verify-after-edit (heuristic, `warn`). A verify command must appear
        //     after the LAST edit. Only a Shell command counts. The check cannot
        //     see across the request boundary, so a verify that lands in the NEXT
        //     request still reads as a miss — hence `warn`, never a verdict.
        const lastEditIdx = events.reduce((acc, e, i) => (isRepoEdit(e) ? i : acc), -1);
        const verifyHit = events.findIndex(
            (e, i) => i > lastEditIdx && e.tool === 'Shell' && isVerifyCommand(shellCommand(e.raw_json)),
        );
        if (lastEditIdx < 0) {
            /*
             * Distinguish "nothing was edited" from "we cannot see edits". The pack does not wire the
             * `afterFileEdit` event, so this branch is the normal one — and "no edits in this request"
             * asserts something we have not established. Edits recorded in `request_file` prove the
             * latter.
             */
            const editsRecorded = editedPaths.some((f) => repoRel(cfg.root, f.path) !== null);
            results['verify-after-edit'] = editsRecorded
                ? verdict('skip', 1, 'edits recorded but no edit event captured — cannot judge')
                : verdict('skip', 1, 'no edits in this request');
        } else if (verifyHit > lastEditIdx) {
            results['verify-after-edit'] = verdict('pass', 1, 'a verify command ran after the final edit');
        } else {
            results['verify-after-edit'] = verdict('warn', 1, 'no verify command after the final edit');
        }

        // --- brain-before-protected-write
        /*
         * Two channels can write a protected file, and the check used to watch only one of them.
         *
         * `afterFileEdit` is the pack's own write signal — and the pack does not wire that event, so
         * this check could not see *any* write. Worse, it reported "no protected path was edited",
         * which reads as a finding rather than as an absence of one.
         *
         * Shell is the other channel, and it is the one that actually mattered: a turn wrote 7
         * protected files with `cat >` while this check said nothing was touched, because
         * `guard-write.py` only runs on Write/StrReplace and `actionOf` files Shell under `'shell'`.
         * Both channels are read now.
         */
        const relOf = (p) => String(p || '').replace(cfg.root + '/', '');
        const editSignals = [];
        events.forEach((e, i) => {
            if (e.event_type === 'afterFileEdit' && e.path) {
                editSignals.push({ idx: i, path: e.path, rel: relOf(e.path) });
                return;
            }
            if (!SHELL_TOOL_RE.test(e.tool || '')) return;
            const cmd = shellCommand(e.raw_json);
            if (!shellHasWriteIntent(cmd)) return;
            const parsed = shellWriteTargets(cmd).map(relOf);
            // A Python heredoc writes a path held in a variable: no target parses, and the event's own
            // path is the only signal available.
            const list = parsed.length ? parsed : e.path ? [relOf(e.path)] : [];
            for (const t of list) editSignals.push({ idx: i, path: t, rel: t, via: 'shell' });
        });
        const protectedSignals = editSignals.filter((s) => pathMode(s.rel, pathPolicy) !== null);
        if (protectedSignals.length === 0) {
            results['brain-before-protected-write'] =
                editSignals.length === 0
                    ? verdict('skip', 1, 'cannot determine — no file-edit events were captured')
                    : verdict('skip', 0, 'no protected path was edited');
        } else {
            const firstProtected = protectedSignals[0].idx;
            const brainHit = events.findIndex((e, i) => i < firstProtected && BRAIN_RE.test(e.raw_json || ''));
            const how = protectedSignals[0].via === 'shell' ? ' (via Shell)' : '';
            results['brain-before-protected-write'] =
                brainHit >= 0
                    ? verdict('pass', 0, `a brain call preceded the first protected write${how}`)
                    : verdict('fail', 0, `protected write with no preceding brain call${how}: ${protectedSignals[0].rel}`);
        }

        let pass = 0;
        let fail = 0;
        for (const [checkId, v] of Object.entries(results)) {
            db.run(
                `INSERT INTO check_result (request_id, check_id, status, heuristic, detail) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(request_id, check_id) DO UPDATE SET status = excluded.status, heuristic = excluded.heuristic, detail = excluded.detail`,
                [req.id, checkId, v.status, v.heuristic, v.detail],
            );
            if (v.status === 'pass') pass += 1;
            if (v.status === 'fail') fail += 1;
        }

        db.run(
            `UPDATE request SET checks_pass = ?, checks_fail = ?, has_failures = ?, updated_at = ? WHERE id = ?`,
            [pass, fail, fail > 0 || req.status === 'error' ? 1 : 0, now, req.id],
        );
    }

    return requests.length;
}

export const CHECK_IDS = [
    'rules-attached',
    'eager-prefix-budget',
    'edits-covered-by-attached-rules',
    'read-before-edit',
    'verify-after-edit',
    'brain-before-protected-write',
];
