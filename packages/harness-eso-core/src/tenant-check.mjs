/**
 * Tenant-isolation check (RFC 18 M5).
 *
 * The failure this targets is silent and expensive: a new query or migration touches a tenant-scoped
 * table without naming the tenant, and every test passes because the test database has one tenant.
 *
 * It is a **heuristic over SQL text**, and it says so. Two rules keep it honest:
 *   - Only tables the caller declares as tenant-scoped are examined. Guessing scope from a name
 *     (`%tenant%`) would flag joins that are correct and miss tables that are not obvious.
 *   - A statement is exempt when it carries an explicit marker (`/* tenant:global *\/`), so a
 *     deliberate cross-tenant admin query is a documented decision rather than a finding.
 *
 * A tenant marker anywhere in the statement satisfies it. That is deliberately conservative: the
 * check is here to catch "nobody thought about tenancy", not to prove the predicate is correct.
 */

export const TENANT_MARKER = /tenant[_\s-]?id|@tenant|#\{?tenant/i;
export const EXEMPT_MARKER = /tenant\s*:\s*global/i;

const TABLE_REFERENCE = /\b(?:from|join|update|delete\s+from|insert\s+into)\s+(?:if\s+not\s+exists\s+)?[`"[]?([A-Za-z0-9_.]+)[`"\]]?/gi;

function stripComments(statement) {
    return statement

        .replace(/\/\*[\s\S]*?\*\//g, ' ')

        .replace(/--[^\n]*/g, ' ');
}

function normaliseTables(tables) {
    return new Set(
        (tables ?? [])
            .map((t) => String(t).trim().toLowerCase())
            .filter(Boolean)
            .map((t) => t.split('.').pop()),
    );
}

/**
 * @param {{ file?: string, content: string, tenantTables?: string[] }} input
 * @returns {{ file: string, findings: Array<{kind:string,table:string,detail:string,statement:string}> }}
 */
export function checkTenantIsolation(input = {}) {
    const file = input.file ?? '<memory>';
    const tenantTables = normaliseTables(input.tenantTables);
    const findings = [];
    if (!tenantTables.size) return { file, findings };

    const statements = String(input.content ?? '').split(';');
    for (const raw of statements) {
        if (!raw.trim()) continue;
        if (EXEMPT_MARKER.test(raw)) continue;

        const statement = stripComments(raw);
        const lower = statement.toLowerCase();
        const tables = new Set();
        TABLE_REFERENCE.lastIndex = 0;
        for (const match of statement.matchAll(TABLE_REFERENCE)) {
            const name = match[1].toLowerCase().split('.').pop();
            if (tenantTables.has(name)) tables.add(match[1]);
        }
        if (!tables.size) continue;
        if (TENANT_MARKER.test(lower)) continue;

        for (const table of tables) {
            const isInsert = /\binsert\s+into\b/i.test(statement);
            findings.push({
                kind: isInsert ? 'insert-without-tenant' : 'query-without-tenant',
                table,
                detail: isInsert
                    ? `INSERT into tenant-scoped "${table}" without a tenant column`
                    : `statement reads/writes tenant-scoped "${table}" without a tenant filter`,
                statement: statement.trim().replace(/\s+/g, ' ').slice(0, 200),
            });
        }
    }

    return { file, findings };
}

/** Check several files at once, keeping the file name on every finding. */
export function checkTenantFiles(files = [], options = {}) {
    const findings = [];
    for (const { file, content } of files) {
        const result = checkTenantIsolation({ file, content, tenantTables: options.tenantTables });
        for (const finding of result.findings) findings.push({ ...finding, file });
    }
    return { files: files.length, findings };
}
