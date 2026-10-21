/**
 * Pre-compact cost checkpoint — writes `CHECKPOINT.json` plus a route-trace line.
 * Always allows.
 */
import fs from 'node:fs';
import path from 'node:path';

const WINDOW_FALLBACK = 200_000;

function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', (c) => chunks.push(c));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        if (process.stdin.isTTY) resolve('');
    });
}

function emit(tree = harnessTree()) {
    if (tree === 'agents') {
        process.stdout.write('{"injectSteps":[]}\n');
    } else if (tree === 'claude') {
        process.stdout.write('{}\n');
    } else {
        process.stdout.write(`${JSON.stringify({ permission: 'allow' })}\n`);
    }
}

function findConsumerRoot() {
    const here = process.cwd();
    let cur = here;
    for (let i = 0; i < 24; i += 1) {
        if (fs.existsSync(path.join(cur, 'harness.config.json'))) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    return here;
}

function harnessTree() {
    const t = (process.env.HARNESS_TREE || 'cursor').replace(/^\./, '').toLowerCase();
    if (t === 'agents') return 'agents';
    if (t === 'claude') return 'claude';
    return 'cursor';
}

function tracePath(root, tree) {
    if (tree === 'agents') return path.join(root, '.agents', 'session', 'route-trace.jsonl');
    if (tree === 'claude') return path.join(root, '.claude', 'session', 'route-trace.jsonl');
    return path.join(root, '.cursor', 'session', 'route-trace.jsonl');
}

function isoNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Antigravity has no `PreCompact` event, so this hook is wired to `PreInvocation` and fires before
 * EVERY LLM call. A checkpoint per invocation is noise: the payload carries no context usage, and
 * the trace grew by one `preCompact` row for every step (20 in a two-minute run).
 *
 * `invocationNum` is the host's own counter. Invocation 0 is the turn's first call, which is the one
 * checkpoint worth writing; later invocations are continuations of the same turn. Cursor and Claude
 * send no counter and keep their real `preCompact` event, so they are unaffected.
 */
export function shouldRunForPayload(payload) {
    const inv = payload?.invocationNum ?? payload?.invocation_num;
    return !(typeof inv === 'number' && inv > 0);
}

export async function run() {
    let payload = {};
    try {
        const raw = await readStdin();
        payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
        emit();
        return;
    }

    if (!shouldRunForPayload(payload)) {
        emit();
        return;
    }

    const root = findConsumerRoot();
    const tree = harnessTree();
    const roundDir = path.join(root, '.round-cost');
    const costDir = path.join(root, '.harness', 'cost');
    fs.mkdirSync(roundDir, { recursive: true });
    fs.mkdirSync(costDir, { recursive: true });

    const ctxPct = payload.context_usage_percent ?? payload.contextUsagePercent;
    const ctxTok = payload.context_tokens ?? payload.contextTokens;
    const window = payload.context_window_size ?? payload.contextWindowSize ?? WINDOW_FALLBACK;
    const conversationId = payload.conversation_id ?? payload.conversationId ?? payload.session_id ?? null;

    const checkpoint = {
        at: isoNow(),
        event: 'preCompact',
        conversation_id: conversationId,
        trigger: payload.trigger ?? null,
        context_percent: typeof ctxPct === 'number' ? ctxPct : null,
        context_tokens: typeof ctxTok === 'number' ? ctxTok : null,
        context_window: window,
        harness: tree,
    };

    try {
        fs.writeFileSync(path.join(roundDir, 'CHECKPOINT.json'), `${JSON.stringify(checkpoint, null, 2)}\n`);
        fs.writeFileSync(path.join(costDir, 'pre-compact-latest.json'), `${JSON.stringify(checkpoint, null, 2)}\n`);
    } catch {
        /* best-effort */
    }

    const traceLine = {
        at: checkpoint.at,
        event: 'preCompact',
        conversationId,
        generationId: payload.generation_id ?? payload.generationId ?? conversationId,
        payload: {
            hook_event_name: 'preCompact',
            conversation_id: conversationId,
            context_usage_percent: checkpoint.context_percent,
            context_tokens: checkpoint.context_tokens,
            context_window_size: checkpoint.context_window,
        },
    };

    try {
        const tp = tracePath(root, tree);
        fs.mkdirSync(path.dirname(tp), { recursive: true });
        fs.appendFileSync(tp, `${JSON.stringify(traceLine)}\n`);
    } catch {
        /* best-effort */
    }

    emit();
}
