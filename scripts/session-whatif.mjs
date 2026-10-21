#!/usr/bin/env node
/**
 * What-if cost simulator for a DSH session log (`session.v4.jsonl`).
 *
 * Why this exists
 * ---------------
 * A "turn" is not one model call. The loop calls the model once per step and every call re-sends the
 * whole surface history, so the bill is `Σ(history at each step)` — a product, not a sum. The same
 * property makes any claim about saving tokens unverifiable by reading the final context size alone.
 *
 * `token-audit.mjs` reports the *actual* cost from the observe DB. This script answers a different
 * question: **how much of that cost is attributable to a specific, removable behaviour**, and what
 * would the same transcript have cost under that behaviour. It is a cost model, not a live A/B:
 * it assumes the agent would make the same decisions, therefore every scenario is an UPPER BOUND.
 *
 * Scenarios
 * ---------
 *   baseline  the transcript as written
 *   A         (1) a repeated read becomes a one-line stub ("already read at step N");
 *             (2) a compact state ledger is injected every `--ledger-every` steps.
 *   B         history is replaced by a `--summary-tokens` checkpoint at each `--boundary` step.
 *   A+B       both, in one pass.
 *
 * Explicitly NOT modelled (reported as `unmodelled`):
 *   - fewer steps because the agent explored less (the dominant cost driver);
 *   - better retrieval replacing a full-file read with a section;
 *   - provider prompt caching (reduces money, not context pressure).
 *
 * Usage
 *   node scripts/session-whatif.mjs <session.v4.jsonl>
 *   node scripts/session-whatif.mjs <log> --json out.json --md out.md
 *   node scripts/session-whatif.mjs <log> --boundary 50,75 --summary-tokens 6000 --ledger-every 12
 *
 * Reading the result
 *   saving < 15%   the token claim is not supported by this transcript
 *   15% .. 30%     supportable only if the product owns context lifecycle, not retrieval
 *   > 30%          worth building, still an upper bound
 */
import fs from 'node:fs';
import path from 'node:path';

const CHARS_PER_TOKEN = 3.6; // same convention as scripts/token-audit.mjs
const SURFACE = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']);

function parseArgs(argv) {
    const out = {
        file: null,
        json: null,
        md: null,
        cpt: CHARS_PER_TOKEN,
        summaryTokens: 6000,
        boundary: null, // default: 50% and 75% of steps
        ledgerEvery: 12,
        ledgerTokens: 250,
        stubTokens: 12,
        capArtifacts: 400,
        capReads: 800,
        quiet: false,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        const v = () => argv[++i];
        if (a === '--json') out.json = v();
        else if (a === '--md') out.md = v();
        else if (a === '--cpt') out.cpt = Number(v());
        else if (a === '--summary-tokens') out.summaryTokens = Number(v());
        else if (a === '--boundary') out.boundary = String(v()).split(',').map(Number).filter(Number.isFinite);
        else if (a === '--ledger-every') out.ledgerEvery = Number(v());
        else if (a === '--ledger-tokens') out.ledgerTokens = Number(v());
        else if (a === '--cap-artifacts') out.capArtifacts = Number(v());
        else if (a === '--cap-reads') out.capReads = Number(v());
        else if (a === '--quiet') out.quiet = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (!a.startsWith('--') && !out.file) out.file = a;
        else throw new Error(`unknown argument: ${a}`);
    }
    return out;
}

function loadEvents(file) {
    const events = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
            events.push(JSON.parse(s));
        } catch {
            /* a torn tail is not a reason to refuse the whole file */
        }
    }
    return events;
}

/** Chars that a message contributes to surface history: text + tool-call arguments (not reasoning). */
function messageChars(message) {
    let text = 0;
    let callArgs = 0;
    let reasoning = 0;
    for (const block of message?.content ?? []) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') text += (block.text ?? '').length;
        else if (block.type === 'tool-call') callArgs += (block.arguments ?? '').length;
        else if (block.type === 'reasoning') reasoning += (block.text ?? '').length;
    }
    return { text, callArgs, reasoning };
}

function resultChars(message) {
    let n = 0;
    for (const block of message?.content ?? []) if (block?.type === 'text') n += (block.text ?? '').length;
    return n;
}

function buildIndex(events) {
    // rootCallId -> sub-calls ({name, args}); PTC programs hide their tool calls inside run_code.
    const subs = new Map();
    for (const e of events) {
        if (e.type !== 'tool/ptc-dispatch-start') continue;
        const d = e.data ?? {};
        const list = subs.get(d.rootCallId) ?? [];
        list.push({ name: d.name, args: d.arguments ?? {} });
        subs.set(d.rootCallId, list);
    }
    const steps = [];
    for (const e of events) if (e.type === 'step/start') steps.push(e.data ?? {});
    return { subs, steps };
}

const artifactRe = /(^\/tmp\/|bap\d+-brain|\/brain[^/]*\.md$|chunk\d+-out\.md$)/i;
const docsRe = /\.(md|mdx|ya?ml|json)$/i;
// A test *runner* invocation, not a path that happens to contain "vitest" (e.g. `cat vitest.config.ts`).
const testRe = /(^|[;&|]\s*)(\S*\/)?(vitest|jest|pytest|mocha|tsc)\b|\b(npm|pnpm|yarn|bun) (run )?test\b/i;

function classifyResult(message, subs) {
    const callId = message?.toolCallId;
    const list = subs.get(callId) ?? [];
    const names = [...new Set(list.map((s) => s.name))];
    const reads = list.filter((s) => s.name === 'read').map((s) => s.args.file_path ?? s.args.path);
    const paths = list.map((s) => s.args.file_path ?? s.args.path).filter(Boolean);
    const commands = list.filter((s) => s.name === 'bash').map((s) => String(s.args.command ?? ''));
    return {
        callId,
        names,
        readPaths: reads.filter(Boolean),
        paths,
        commands,
        singleRead: names.length === 1 && names[0] === 'read' && reads.length === 1 ? reads[0] : null,
        isArtifact: paths.some((p) => artifactRe.test(String(p))),
        isTest: commands.some((c) => testRe.test(c)),
        isDoc: reads.some((p) => docsRe.test(String(p))) && !reads.some((p) => artifactRe.test(String(p))),
    };
}

/**
 * One pass over the transcript. Every option is independent, so `simulate(events, {})` is the
 * baseline and the scenarios differ only by flags.
 */
function simulate(events, opts, index, boundarySteps) {
    const summaryChars = opts.summaryTokens * opts.cpt;
    const ledgerChars = opts.ledgerTokens * opts.cpt;
    const stubChars = opts.stubTokens * opts.cpt;

    let history = 0;
    let stepIdx = 0;
    let peak = 0;
    const perStep = [];
    const seenRead = new Map(); // path -> first stepIdx
    const stats = {
        dedupedReads: 0,
        dedupeChars: 0,
        ledgerInserts: 0,
        compactions: 0,
        cappedArtifacts: 0,
        cappedChars: 0,
        cappedReads: 0,
        cappedReadChars: 0,
        unmodelledDuplicates: 0,
    };

    for (const e of events) {
        const d = e.data ?? {};
        if (e.type === 'step/start') {
            stepIdx += 1;
            if (opts.compact && boundarySteps.has(stepIdx)) {
                history = summaryChars;
                stats.compactions += 1;
            }
            if (opts.ledger && opts.ledgerEvery > 0 && stepIdx > 1 && stepIdx % opts.ledgerEvery === 0) {
                history += ledgerChars;
                stats.ledgerInserts += 1;
            }
            perStep.push({ step: stepIdx, turn: d.turn ?? null, tokens: Math.ceil(history / opts.cpt) });
            peak = Math.max(peak, history);
            continue;
        }
        if (!SURFACE.has(e.type)) continue;

        if (e.type === 'system/message') history += messageChars(d.message).text;
        else if (e.type === 'user/message') {
            for (const b of d.content ?? []) if (b?.type === 'text') history += (b.text ?? '').length;
        } else if (e.type === 'assistant/message') {
            const m = messageChars(d.message);
            history += m.text + m.callArgs;
        } else if (e.type === 'tool/result') {
            let chars = resultChars(d.message);
            if (opts.capArtifacts) {
                const info = classifyResult(d.message, index.subs);
                const capChars = opts.capArtifacts * opts.cpt;
                if ((info.isArtifact || info.isTest) && chars > capChars) {
                    stats.cappedArtifacts += 1;
                    stats.cappedChars += chars - capChars;
                    chars = capChars;
                }
            }
            if (opts.capReads) {
                const info = classifyResult(d.message, index.subs);
                const capChars = opts.capReads * opts.cpt;
                if (info.singleRead && chars > capChars) {
                    stats.cappedReads += 1;
                    stats.cappedReadChars += chars - capChars;
                    chars = capChars;
                }
            }
            if (opts.dedupe) {
                const info = classifyResult(d.message, index.subs);
                if (info.singleRead) {
                    const first = seenRead.get(info.singleRead);
                    if (first !== undefined) {
                        stats.dedupedReads += 1;
                        stats.dedupeChars += chars - stubChars;
                        chars = stubChars;
                    } else {
                        seenRead.set(info.singleRead, stepIdx);
                    }
                } else if (info.readPaths.some((p) => seenRead.has(p))) {
                    stats.unmodelledDuplicates += 1; // a batched program printed several reads; not attributable
                }
                for (const p of info.readPaths) if (!seenRead.has(p)) seenRead.set(p, stepIdx);
            }
            history += chars;
        }
        peak = Math.max(peak, history);
    }

    const tokens = perStep.map((s) => s.tokens);
    return {
        steps: perStep.length,
        cumulativeTokens: tokens.reduce((a, b) => a + b, 0),
        finalTokens: tokens.at(-1) ?? 0,
        peakTokens: Math.ceil(peak / opts.cpt),
        perStep,
        stats,
    };
}

function attribution(events, index, opts) {
    const byTool = new Map();
    const reads = new Map();
    let toolResultChars = 0;
    let artifactChars = 0;
    let testChars = 0;
    let docReadChars = 0;
    let duplicateChars = 0;
    let duplicateCalls = 0;
    let errorResults = 0;
    let docsRead = new Set();

    for (const e of events) {
        if (e.type !== 'tool/result') continue;
        const m = e.data?.message ?? {};
        const chars = resultChars(m);
        const info = classifyResult(m, index.subs);
        toolResultChars += chars;
        const label = info.names.length === 1 ? info.names[0] : info.names.length ? 'mixed' : 'unknown';
        byTool.set(label, (byTool.get(label) ?? 0) + chars);
        if (info.isArtifact) artifactChars += chars;
        if (info.isTest) testChars += chars;
        if (info.isDoc) docReadChars += chars;
        for (const p of info.readPaths) {
            const prev = reads.get(p);
            if (prev) {
                duplicateCalls += 1;
                duplicateChars += chars;
            } else {
                reads.set(p, chars);
            }
        }
        for (const p of info.readPaths) if (docsRe.test(String(p)) && !artifactRe.test(String(p))) docsRead.add(p);
        if (info.singleRead === null && info.names.length === 0) errorResults += 1;
    }

    const tokens = (chars) => Math.ceil(chars / opts.cpt);
    return {
        toolResultTokens: tokens(toolResultChars),
        byTool: [...byTool.entries()]
            .map(([name, chars]) => ({ name, tokens: tokens(chars), share: chars / (toolResultChars || 1) }))
            .sort((a, b) => b.tokens - a.tokens),
        artifactTokens: tokens(artifactChars),
        testOutputTokens: tokens(testChars),
        docReadTokens: tokens(docReadChars),
        duplicateReadCalls: duplicateCalls,
        duplicateReadTokens: tokens(duplicateChars),
        uniqueFilesRead: reads.size,
        readCalls: [...reads.values()].length + duplicateCalls,
        docsRead: [...docsRead].slice(0, 12),
    };
}

/** Quality counters computable from the log alone — a preview of what checks could see. */
function quality(events, index) {
    const seq = [];
    for (const e of events) {
        if (e.type !== 'tool/ptc-dispatch-start') continue;
        const d = e.data ?? {};
        if (!['read', 'write', 'edit', 'bash'].includes(d.name)) continue;
        seq.push({ name: d.name, args: d.arguments ?? {} });
    }
    let known = new Set();
    let blindEdits = 0;
    let lastEditAt = -1;
    let lastTestAt = -1;
    let testRuns = 0;
    const skills = new Map();
    for (let i = 0; i < seq.length; i += 1) {
        const { name, args } = seq[i];
        const file = args.file_path ?? args.path;
        if (name === 'read' || name === 'write') known.add(file);
        if (name === 'edit') {
            if (!known.has(file)) blindEdits += 1;
            lastEditAt = i;
        }
        if (name === 'write') lastEditAt = i;
        if (name === 'bash' && testRe.test(String(args.command ?? ''))) {
            testRuns += 1;
            lastTestAt = i;
        }
        if (name === 'skill') skills.set(args.name, (skills.get(args.name) ?? 0) + 1);
    }
    let errors = 0;
    for (const e of events) if (e.type === 'tool/ptc-dispatch' && e.data?.isError) errors += 1;
    /*
     * `lastTestAt = -1` means the session never ran a test. Treating "edit at index 57 > -1" as
     * "edits after the last test" reported a verify gap for a session that simply never verified —
     * a different, worse finding that the old counter hid. Keep them separate.
     */
    const hasTests = testRuns > 0;
    const actionsAfterLastTest = hasTests && lastEditAt > lastTestAt ? lastEditAt - lastTestAt : 0;
    return {
        actions: seq.length,
        blindEdits,
        testRuns,
        editsAfterLastTest: hasTests && lastEditAt > lastTestAt,
        noTestAtAll: !hasTests && lastEditAt >= 0,
        actionsBetweenLastTestAndLastEdit: actionsAfterLastTest,
        errors,
        skills: [...skills.entries()].map(([name, count]) => ({ name, count })),
    };
}

function pct(from, to) {
    if (!from) return 0;
    return 1 - to / from;
}
function fmt(n) {
    return n.toLocaleString('en-US');
}

function main() {
    const opts = parseArgs(process.argv);
    if (opts.help || !opts.file) {
        console.log('usage: node scripts/session-whatif.mjs <session.v4.jsonl> [--json out] [--md out]');
        process.exit(opts.help ? 0 : 2);
    }
    const events = loadEvents(opts.file);
    const index = buildIndex(events);
    const totalSteps = index.steps.length;
    if (!totalSteps) throw new Error('no step/start events — is this a DSH session.v4 log?');

    const boundary = opts.boundary ?? [Math.round(totalSteps * 0.5), Math.round(totalSteps * 0.75)];
    const boundarySteps = new Set(boundary.filter((n) => n > 0 && n <= totalSteps));

    const base = simulate(events, { cpt: opts.cpt }, index, boundarySteps);
    const dedupeOpts = { cpt: opts.cpt, dedupe: true, ledger: true, ledgerEvery: opts.ledgerEvery, ledgerTokens: opts.ledgerTokens, stubTokens: opts.stubTokens };
    const capOpts = { cpt: opts.cpt, capArtifacts: opts.capArtifacts };
    const readOpts = { cpt: opts.cpt, capReads: opts.capReads };
    const compactOpts = { cpt: opts.cpt, compact: true, summaryTokens: opts.summaryTokens };
    const a = simulate(events, dedupeOpts, index, boundarySteps);
    const c = simulate(events, capOpts, index, boundarySteps);
    const d = simulate(events, readOpts, index, boundarySteps);
    const ac = simulate(events, { ...dedupeOpts, ...capOpts, ...readOpts }, index, boundarySteps);
    const b = simulate(events, compactOpts, index, boundarySteps);
    const ab = simulate(events, { ...dedupeOpts, ...capOpts, ...readOpts, ...compactOpts }, index, boundarySteps);

    const attr = attribution(events, index, opts);
    const q = quality(events, index);

    const rows = [
        ['baseline', base.cumulativeTokens, base.finalTokens],
        ['A dedupe+ledger', a.cumulativeTokens, a.finalTokens],
        ['C cap artifacts', c.cumulativeTokens, c.finalTokens],
        ['D cap reads', d.cumulativeTokens, d.finalTokens],
        ['A+C+D (ESO-owned)', ac.cumulativeTokens, ac.finalTokens],
        ['B compact (host)', b.cumulativeTokens, b.finalTokens],
        ['A+C+D+B', ab.cumulativeTokens, ab.finalTokens],
    ].map(([name, cum, fin]) => ({
        scenario: name,
        cumulativeTokens: cum,
        finalTokens: fin,
        savingPct: Number((pct(base.cumulativeTokens, cum) * 100).toFixed(1)),
    }));

    const out = {
        file: path.resolve(opts.file),
        sessionId: events.find((e) => e.type === 'session')?.id ?? null,
        cwd: events.find((e) => e.type === 'session')?.cwd ?? null,
        assumptions: {
            charsPerToken: opts.cpt,
            summaryTokens: opts.summaryTokens,
            ledgerEvery: opts.ledgerEvery,
            ledgerTokens: opts.ledgerTokens,
            boundaries: [...boundarySteps],
            capArtifactsTokens: opts.capArtifacts,
            capReadsTokens: opts.capReads,
            note: 'Cost model, not a live A/B: assumes identical agent behaviour. Every saving is an upper bound.',
        },
        baseline: { steps: base.steps, cumulativeTokens: base.cumulativeTokens, finalTokens: base.finalTokens, peakTokens: base.peakTokens, perTurn: perTurn(base.perStep) },
        scenarios: rows,
        attribution: attr,
        quality: q,
        stats: { a: a.stats, c: c.stats, d: d.stats, ac: ac.stats, b: b.stats, ab: ab.stats },
        verdict: verdict(rows),
        unmodelled: [
            'fewer steps from less exploration (dominant cost driver; not modelled)',
            'retrieval returning a section instead of a whole file',
            'provider prompt caching (money, not context pressure)',
        ],
    };

    if (opts.json) fs.writeFileSync(opts.json, `${JSON.stringify(out, null, 2)}\n`);
    if (opts.md) fs.writeFileSync(opts.md, renderMarkdown(out));
    if (!opts.quiet) printTable(out);
    return out;
}

function perTurn(perStep) {
    const by = new Map();
    for (const s of perStep) {
        const t = s.turn ?? 0;
        const agg = by.get(t) ?? { turn: t, steps: 0, tokens: 0 };
        agg.steps += 1;
        agg.tokens += s.tokens;
        by.set(t, agg);
    }
    return [...by.values()];
}

/**
 * Two levers with different owners, so they must be judged separately:
 *   A is the only lever harness-eso could own (dedupe + state ledger);
 *   B is compaction, which the host already ships (/compact) and which is lossy —
 *     a 6K summary cannot really replace 150K of history without re-exploration,
 *     so B is not a saving the product can claim.
 */
function verdict(rows) {
    const saving = (prefix) => rows.find((r) => r.scenario.startsWith(prefix))?.savingPct ?? 0;
    const esoOwned = saving('A+C+D');
    const hostOwned = saving('B compact');
    const combined = saving('A+C+D+B');
    const level = esoOwned < 15 ? 'unsupported' : esoOwned < 30 ? 'partial' : 'worth-building';
    const note =
        level === 'unsupported'
            ? `harness-eso's own lever saves ${esoOwned}% — below the 15% bar; the ${combined}% headline belongs to host compaction`
            : level === 'partial'
              ? `harness-eso's own lever saves ${esoOwned}% — only defensible as a context-lifecycle feature`
              : `harness-eso's own lever saves ${esoOwned}% — worth building, verify with a live run`;
    return { level, savingPct: combined, esoOwnedPct: esoOwned, hostOwnedPct: hostOwned, note };
}

function printTable(o) {
    console.log(`\nsession  ${o.sessionId ?? '?'}  (${o.cwd ?? '?'})`);
    console.log(`steps    ${o.baseline.steps}   final ${fmt(o.baseline.finalTokens)} tok   peak ${fmt(o.baseline.peakTokens)} tok\n`);
    console.log('scenario            cumulative       final    saving');
    for (const r of o.scenarios) {
        console.log(
            `${r.scenario.padEnd(18)} ${fmt(r.cumulativeTokens).padStart(12)} ${fmt(r.finalTokens).padStart(10)} ${String(r.savingPct).padStart(8)}%`,
        );
    }
    console.log('\nattribution (tool results)');
    for (const t of o.attribution.byTool) {
        console.log(`  ${t.name.padEnd(10)} ${fmt(t.tokens).padStart(9)} tok  ${(t.share * 100).toFixed(1)}%`);
    }
    console.log(`  duplicate reads: ${o.attribution.duplicateReadCalls} calls, ${fmt(o.attribution.duplicateReadTokens)} tok`);
    console.log(`  artifacts(/tmp): ${fmt(o.attribution.artifactTokens)} tok   test output: ${fmt(o.attribution.testOutputTokens)} tok`);
    console.log('\nquality counters');
    console.log(`  actions=${o.quality.actions} blindEdits=${o.quality.blindEdits} testRuns=${o.quality.testRuns} editsAfterLastTest=${o.quality.editsAfterLastTest} errors=${o.quality.errors}`);
    console.log(`\nverdict  ${o.verdict.level.toUpperCase()} — ${o.verdict.note}`);
    console.log(`         ESO-owned ${o.verdict.esoOwnedPct}%  ·  host-owned ${o.verdict.hostOwnedPct}%  ·  combined ${o.verdict.savingPct}% (upper bound)`);
    console.log('note     cost model, not a live A/B; every saving is an upper bound\n');
}

function renderMarkdown(o) {
    const lines = [];
    lines.push(`# Session what-if — ${o.sessionId ?? 'unknown'}`);
    lines.push('');
    lines.push(`- file: \`${o.file}\``);
    lines.push(`- cwd: \`${o.cwd}\``);
    lines.push(`- steps: **${o.baseline.steps}**, final context: **${fmt(o.baseline.finalTokens)} tok**, peak: **${fmt(o.baseline.peakTokens)} tok**`);
    lines.push(`- assumption: ${o.assumptions.charsPerToken} chars/token; boundaries ${o.assumptions.boundaries.join(', ')}; summary ${o.assumptions.summaryTokens} tok`);
    lines.push('');
    lines.push('## Scenarios (upper bound)');
    lines.push('');
    lines.push('| scenario | cumulative tok | final tok | saving |');
    lines.push('|---|---:|---:|---:|');
    for (const r of o.scenarios) lines.push(`| ${r.scenario} | ${fmt(r.cumulativeTokens)} | ${fmt(r.finalTokens)} | ${r.savingPct}% |`);
    lines.push('');
    lines.push('## Attribution');
    lines.push('');
    lines.push('| tool | tokens | share |');
    lines.push('|---|---:|---:|');
    for (const t of o.attribution.byTool) lines.push(`| ${t.name} | ${fmt(t.tokens)} | ${(t.share * 100).toFixed(1)}% |`);
    lines.push('');
    lines.push(`- duplicate reads: ${o.attribution.duplicateReadCalls} calls / ${fmt(o.attribution.duplicateReadTokens)} tok`);
    lines.push(`- artifacts (/tmp): ${fmt(o.attribution.artifactTokens)} tok`);
    lines.push(`- test output: ${fmt(o.attribution.testOutputTokens)} tok`);
    lines.push(`- unique files read: ${o.attribution.uniqueFilesRead} of ${o.attribution.readCalls} calls`);
    lines.push('');
    lines.push('## Quality counters (log only)');
    lines.push('');
    lines.push(`- actions: ${o.quality.actions}, blind edits: ${o.quality.blindEdits}`);
    lines.push(`- test runs: ${o.quality.testRuns}, edits after last test: ${o.quality.editsAfterLastTest}`);
    lines.push(`- errors: ${o.quality.errors}`);
    lines.push('');
    lines.push(`**Verdict:** ${o.verdict.level} — ${o.verdict.note}`);
    lines.push('');
    lines.push(`- ESO-owned lever (A): **${o.verdict.esoOwnedPct}%**`);
    lines.push(`- host-owned lever (B, /compact): **${o.verdict.hostOwnedPct}%**`);
    lines.push(`- combined upper bound: **${o.verdict.savingPct}%**`);
    lines.push('');
    lines.push('Unmodelled: ' + o.unmodelled.map((u) => `\`${u}\``).join('; '));
    lines.push('');
    return lines.join('\n');
}

try {
    main();
} catch (err) {
    console.error(`session-whatif: ${err.message}`);
    process.exit(1);
}
