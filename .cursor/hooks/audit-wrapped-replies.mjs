/**
 * Transcript audit: how often the model's answer actually reached the user as a JSON envelope.
 *
 * The `stop` guard can only correct a wrap after the fact, and only when the live hook fires. Auditing
 * the transcripts answers the question the guard cannot: is this rare, or is it every other turn? It
 * runs the *same* detector as the guard (`lib/agent-response.mjs`), so a rate measured here is a rate
 * the guard would have caught.
 *
 * Free of product dependencies on purpose: it reads the host's transcript folder, not the observe DB,
 * so it works on an operator's machine before any consumer is provisioned.
 *
 * Usage:
 *   node .cursor/hooks/audit-wrapped-replies.mjs                      # every visible project, 30 days
 *   node .cursor/hooks/audit-wrapped-replies.mjs --root ~/.cursor --days 7 --json
 *   node .cursor/hooks/audit-wrapped-replies.mjs --file <transcript>.jsonl --samples 5
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectAgentText } from './lib/agent-response.mjs';

/** Transcripts are Claude-shaped: one JSON object per line, `message.content[]` with text blocks. */
export function readAssistantTexts(file) {
    const out = [];
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return out;
    }
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let record;
        try {
            record = JSON.parse(trimmed);
        } catch {
            continue;
        }
        if (!record || record.role !== 'assistant') continue;
        const content = record.message?.content;
        if (typeof content === 'string') {
            out.push(content);
            continue;
        }
        if (!Array.isArray(content)) continue;
        // Only `text` blocks count as the answer; tool_use blocks are not shown to the user.
        const text = content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('');
        if (text) out.push(text);
    }
    return out;
}

function* transcriptFiles(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* transcriptFiles(full);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full;
    }
}

/**
 * @param {{ root?: string, days?: number, samples?: number, now?: number }} opts
 * @returns {{ turns: number, wrapped: number, rate: number, byProject: Record<string, { turns: number, wrapped: number }>, samples: { file: string, text: string }[] }}
 */
export function auditWrappedReplies(opts = {}) {
    const root = opts.root ?? path.join(os.homedir(), '.cursor', 'projects');
    const days = Number(opts.days ?? 30);
    const maxSamples = Number(opts.samples ?? 3);
    const cutoff = (opts.now ?? Date.now()) - days * 24 * 60 * 60 * 1000;

    const result = { turns: 0, wrapped: 0, rate: 0, byProject: {}, samples: [] };

    let projects;
    try {
        projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
        return result;
    }

    for (const project of projects) {
        const dir = path.join(root, project.name, 'agent-transcripts');
        const stats = (result.byProject[project.name] = { turns: 0, wrapped: 0 });
        for (const file of transcriptFiles(dir)) {
            let stat;
            try {
                stat = fs.statSync(file);
            } catch {
                continue;
            }
            if (stat.mtimeMs < cutoff) continue;
            for (const text of readAssistantTexts(file)) {
                result.turns += 1;
                stats.turns += 1;
                if (!inspectAgentText(text).wrapped) continue;
                result.wrapped += 1;
                stats.wrapped += 1;
                if (result.samples.length < maxSamples) {
                    result.samples.push({ file: path.relative(root, file), text: text.slice(0, 300) });
                }
            }
        }
    }

    result.rate = result.turns === 0 ? 0 : result.wrapped / result.turns;
    return result;
}

function main(argv) {
    const arg = (name) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const asJson = argv.includes('--json');
    const file = arg('file');

    const report = file
        ? (() => {
              const texts = readAssistantTexts(file);
              const wrapped = texts.filter((t) => inspectAgentText(t).wrapped).length;
              return {
                  turns: texts.length,
                  wrapped,
                  rate: texts.length ? wrapped / texts.length : 0,
                  byProject: {},
                  samples: [],
              };
          })()
        : auditWrappedReplies({
              root: arg('root'),
              days: arg('days'),
              samples: arg('samples'),
          });

    if (asJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
    }
    const pct = (report.rate * 100).toFixed(1);
    process.stdout.write(
        `assistant turns: ${report.turns}\nwrapped: ${report.wrapped} (${pct}%)\n`,
    );
    for (const [project, s] of Object.entries(report.byProject)) {
        if (s.wrapped === 0) continue;
        process.stdout.write(`  ${project}: ${s.wrapped}/${s.turns}\n`);
    }
    for (const sample of report.samples) {
        process.stdout.write(`\n— ${sample.file}\n${sample.text}\n`);
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
    main(process.argv);
}
