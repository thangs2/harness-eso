/**
 * Post-tool hint — emits the ESO evidence hint once per turn when
 * `eso.mode` is `hint` or `fail_closed`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    allow,
    detectShape,
    harnessTree,
    loadPolicyForCwd,
    readStdin,
    sessionDir,
} from './hook-io.mjs';
import { readPreflight } from './eso-gap-io.mjs';

function hintSentPath(root = process.cwd(), tree = harnessTree()) {
    return path.join(sessionDir(root, tree), '.eso-hint-sent.json');
}

function buildHint(pre) {
    if (!pre) return null;
    const parts = [];
    const level = pre.level || 'partial';
    parts.push(`ESO sufficiency: ${level} (score ${Number(pre.score ?? 0).toFixed(2)}).`);
    const gaps = (pre.gaps || [])
        .slice(0, 6)
        .map((g) => `${g.kind}:${g.query || g.path || '?'}`)
        .join('; ');
    if (gaps && (level === 'partial' || level === 'insufficient')) {
        parts.push(`Evidence gaps — fetch before implementing: ${gaps}.`);
    }
    if (!parts.length) return null;
    return parts.join(' ');
}

export async function run() {
    let data = {};
    let shape = 'cursor';
    try {
        const raw = await readStdin();
        data = raw.trim() ? JSON.parse(raw) : {};
        shape = detectShape(data);
    } catch {
        allow(shape);
        return;
    }

    const { policy } = loadPolicyForCwd();
    const mode = policy?.eso?.mode ?? 'observe';
    if (mode !== 'hint' && mode !== 'fail_closed') {
        allow(shape);
        return;
    }

    const pre = readPreflight();
    const block = buildHint(pre);
    if (!block) {
        allow(shape);
        return;
    }

    const sentFp = hintSentPath();
    const generationId =
        data.generation_id ?? data.generationId ?? data.conversation_id ?? data.conversationId ?? '';
    let sent = null;
    try {
        if (fs.existsSync(sentFp)) sent = JSON.parse(fs.readFileSync(sentFp, 'utf8'));
    } catch {
        sent = null;
    }
    if (sent?.generationId === generationId && sent?.preflightAt === pre?.at) {
        allow(shape);
        return;
    }

    try {
        fs.mkdirSync(path.dirname(sentFp), { recursive: true });
        fs.writeFileSync(
            sentFp,
            `${JSON.stringify({ at: new Date().toISOString(), generationId, preflightAt: pre?.at }, null, 2)}\n`,
        );
    } catch {
        /* fail-open */
    }

    allow(shape, { additional_context: `[ESO HINT] ${block}` });
}
