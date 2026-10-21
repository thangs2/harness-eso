/**
 * Migration-safety check (RFC 18 M5).
 *
 * A migration that is not backward-compatible fails in the window between deploy and rollback, when
 * old and new code run against the same schema. Tests rarely cover that window; this check reads the
 * DDL and names the statements that break it.
 *
 * Rules are deliberately conservative and text-based:
 *   DROP TABLE / DROP COLUMN / RENAME       — the old shape disappears immediately
 *   ALTER COLUMN ... TYPE                    — old readers decode the new representation
 *   ALTER COLUMN ... SET NOT NULL            — existing NULL rows block the deploy
 *   ADD COLUMN ... NOT NULL without DEFAULT  — existing INSERTs no longer satisfy the table
 *
 * `/* breaking:approved *\/` records a deliberate, reviewed exception. An expand-contract migration
 * (add nullable → backfill → switch reads → drop later) produces no finding by construction.
 */

export const APPROVED_MARKER = /breaking\s*:\s*approved/i;

const RULES = [
    { kind: 'drop-table', re: /\bdrop\s+table\b/i, detail: 'the table disappears for every reader' },
    { kind: 'drop-column', re: /\bdrop\s+column\b/i, detail: 'the column disappears for every reader' },
    { kind: 'rename', re: /\b(?:rename\s+(?:column|to)|alter\s+table\s+\S+\s+rename\s+to)\b/i, detail: 'old name stops resolving' },
    { kind: 'type-change', re: /\balter\s+column\s+\S+\s+(?:set\s+data\s+)?type\b/i, detail: 'old readers decode the new representation' },
    { kind: 'set-not-null', re: /\balter\s+column\s+\S+\s+set\s+not\s+null\b/i, detail: 'existing NULL rows block the deploy' },
];

function stripComments(statement) {
    return statement

        .replace(/\/\*[\s\S]*?\*\//g, ' ')

        .replace(/--[^\n]*/g, ' ');
}

/**
 * @param {{ file?: string, content: string }} input
 */
export function checkMigrationSafety(input = {}) {
    const file = input.file ?? '<memory>';
    const findings = [];

    for (const raw of String(input.content ?? '').split(';')) {
        if (!raw.trim()) continue;
        if (APPROVED_MARKER.test(raw)) continue;
        const statement = stripComments(raw);
        const flat = statement.trim().replace(/\s+/g, ' ');

        let matched = false;
        for (const rule of RULES) {
            if (rule.re.test(statement)) {
                findings.push({ kind: rule.kind, detail: rule.detail, statement: flat.slice(0, 200) });
                matched = true;
            }
        }

        /*
         * ADD COLUMN needs its own look: the column clause ends at the next comma or the statement
         * end, and DEFAULT may appear after NOT NULL, so the whole statement is the safe scope.
         */
        if (/\badd\s+column\b/i.test(statement) && /\bnot\s+null\b/i.test(statement) && !/\bdefault\b/i.test(statement)) {
            findings.push({
                kind: 'add-not-null-without-default',
                detail: 'existing INSERTs that omit the column will fail',
                statement: flat.slice(0, 200),
            });
            matched = true;
        }

        if (!matched && /\bdrop\s+(?:constraint|index)\b/i.test(statement)) {
            // Dropping a constraint or an index does not break readers; intentionally silent.
        }
    }

    return { file, findings };
}

export function checkMigrationFiles(files = []) {
    const findings = [];
    for (const { file, content } of files) {
        const result = checkMigrationSafety({ file, content });
        for (const finding of result.findings) findings.push({ ...finding, file });
    }
    return { files: files.length, findings };
}
