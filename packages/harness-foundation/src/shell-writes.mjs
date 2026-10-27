/**
 * Deciding whether a Shell command **writes** a file, and which files it writes.
 *
 * Why this exists: the write gate and three conformance checks were blind to Shell. `actionOf()`
 * classified the Shell tool as `'shell'`, so `request_file.edits` stayed 0 for every path a command
 * touched, and the checks — which filter on the `afterFileEdit` hook event — saw nothing at all.
 *
 * Measured on x79: one turn wrote **7 protected files** (`sdlc/…`, `backend/mu-fusion/package.json`)
 * with `cat >` and `python3` heredocs. The harness recorded all of them as **reads**, and
 * `brain-before-protected-write` reported "no protected path was edited" — a false statement, since
 * the files were on disk. `guard-write.py` protects `sdlc/` and `backend/mu-`, but it only runs on
 * Write/StrReplace, so the agent escalated to Shell and the gate never saw it.
 *
 * This is deliberately a *heuristic*, and it is deliberately conservative: it looks for constructs
 * that can only mean writing (a redirection, `tee`, a `cp`/`mv` destination, `sed -i`, `touch`, or a
 * Python write call). It does not try to model a shell. A missed write is a gap in a report; a
 * spurious one would accuse a read-only command of editing a protected file, which is worse.
 *
 * Both consumers import this so there is one definition — the alternative is a second copy that
 * drifts, which is the failure this codebase has already paid for more than once.
 */

/** Redirection into a file. Excludes fd redirections (`2>`) and special sinks (`/dev/null`, `&1`). */
const REDIRECT_RE = /(?:^|[^0-9&>])>>?\s*([^\s;&|<>()]+)/g;
/** `tee`, optionally with flags. */
const TEE_RE = /\btee\b((?:\s+-\S+)*)\s+([^\s;&|<>()]+)/g;
/** `cp`/`mv`: the destination is the last argument. */
const COPY_RE = /\b(?:cp|mv)\b((?:\s+-\S+)*)((?:\s+[^\s;&|<>()]+)+)/g;
/** `sed -i` edits in place; the target is the final argument. */
const SED_INPLACE_RE = /\bsed\b[^;&|]*?\s-i\S*((?:\s+-?\S+)*)\s+([^\s;&|<>()]+)/g;
/** `touch` creates or updates. Treat as a write. */
const TOUCH_RE = /\btouch\b((?:\s+-\S+)*)\s+((?:[^\s;&|<>()]+)(?:\s+[^\s;&|<>()]+)*)/g;
/** Python write calls. The path is often a variable, so intent matters more than the target. */
const PY_WRITE_RE = /(?:open\s*\([^,)]+,\s*['"](?:[wa]\+?b?|x[b]?)['"])|(?:\.write_text\s*\()|(?:\.write_bytes\s*\()|(?:json\.dump\s*\()|(?:\.writelines\s*\()/;
/**
 * An absolute path written as a string literal.
 *
 * Needed because a Python heredoc usually holds the path in a variable — `p = Path("/…/01.scenarios.md")`
 * then `p.write_text(…)` — so no operator names it, and Cursor reports no `path` on the Shell event for
 * a heredoc at all. Measured on x79: three such commands wrote files (two of them protected) and the
 * event carried `path = null`, so the literal was the only place the target existed.
 *
 * Only consulted when the command already has write intent, and only absolute paths are taken, so a
 * read-only script cannot contribute anything.
 */
const ABS_LITERAL_RE = /['"](\/[^'"\n]+)['"]/g;

/** Sinks that are not files. */
const NOT_A_FILE = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '&1', '&2', '-']);

/**
 * Blank out quoted regions, preserving length, so operators can be found outside quotes.
 *
 * A `>` inside a quoted argument is text, not redirection — `rg -n "x > y" src` was read as a write to
 * a file named `y`. Masking keeps every index aligned with the original, so a target can still be read
 * from the original string (where it may itself be quoted, e.g. `cat > "my file.md"`).
 *
 * The placeholder is a **letter**, not a space: a blanked-out token still has to look like a token, or
 * `cat > "my file.md"` loses its redirect entirely and the write goes undetected.
 */
export function maskQuoted(command) {
    const src = String(command);
    const chars = src.split('');
    let quote = null;
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '\\' && quote !== "'") {
            chars[i] = 'Q';
            if (i + 1 < src.length) chars[i + 1] = 'Q';
            i += 1;
            continue;
        }
        if (quote) {
            if (ch === quote) {
                quote = null;
            }
            chars[i] = 'Q';
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            chars[i] = 'Q';
            continue;
        }
    }
    return chars.join('');
}

/** Read one shell token from `src` at `start`, honouring quotes. Returns '' when none. */
function readToken(src, start) {
    let i = start;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (i >= src.length) return '';
    let out = '';
    let quote = null;
    for (; i < src.length; i += 1) {
        const ch = src[i];
        if (quote) {
            if (ch === quote) {
                quote = null;
                continue;
            }
            out += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (/[\s;&|<>()]/.test(ch)) break;
        out += ch;
    }
    return out;
}

/**
 * Drop heredoc bodies before parsing. A body is **data** — a shell script being written out, a JSON
 * blob — and scanning it produces false positives: a `sed -i` line inside a generated script was read
 * as an in-place edit of a file named `=`.
 *
 * `<<` / `<<-`, an optional quote, then the delimiter word; the body ends at a line that is exactly
 * that word.
 */
function stripHeredocs(command) {
    const lines = String(command).split('\n');
    const out = [];
    let terminator = null;
    for (const line of lines) {
        if (terminator !== null) {
            if (line.trim() === terminator) terminator = null;
            continue;
        }
        out.push(line);
        const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
        if (m) terminator = m[2];
    }
    return out.join('\n');
}

function clean(token) {
    let t = String(token || '').trim();
    // Strip quotes and shell punctuation that often hugs a path.
    t = t.replace(/^['"`]|['"`]$/g, '').replace(/[;,]$/, '');
    if (!t || NOT_A_FILE.has(t)) return '';
    if (t.startsWith('&')) return '';
    if (t.startsWith('$') || t.includes('$(')) return ''; // a variable, not a known path
    /*
     * A path, not punctuation. Without this, an operator or a stray `=` from a mis-scanned token
     * became a "written file" — and a spurious protected-path hit is worse than a missed one.
     */
    if (!/[A-Za-z0-9_~]/.test(t)) return '';
    return t;
}

/**
 * The command string out of a hook event's raw JSON, if it is a Shell payload.
 *
 * @param {string|object} rawJson
 * @returns {string}
 */
export function shellCommandOf(rawJson) {
    let j = rawJson;
    try {
        j = typeof rawJson === 'string' ? JSON.parse(rawJson || '{}') : rawJson || {};
    } catch {
        return '';
    }
    const c =
        j?.payload?.tool_input?.command ??
        j?.tool_input?.command ??
        j?.command ??
        j?.toolCall?.args?.CommandLine ??
        j?.toolCall?.args?.command ??
        j?.CommandLine;
    return typeof c === 'string' ? c : '';
}

/**
 * Paths this command writes. Heuristic by design — see the module note.
 *
 * @param {string} command
 * @returns {string[]} de-duplicated targets, in the order found
 */
export function shellWriteTargets(command) {
    const full = String(command || '');
    const raw = stripHeredocs(full);
    if (!full) return [];
    const cmd = maskQuoted(raw);
    const out = [];
    const push = (t) => {
        const c = clean(t);
        if (c && !out.includes(c)) out.push(c);
    };

    // Redirections: found on the masked text, but the target is read from the original so a quoted
    // path (`cat > "my file.md"`) survives.
    for (const m of cmd.matchAll(REDIRECT_RE)) {
        const at = m.index + m[0].length - m[1].length;
        push(readToken(raw, at));
    }
    for (const m of cmd.matchAll(TEE_RE)) push(readToken(raw, m.index + m[0].length - m[2].length));
    for (const m of cmd.matchAll(COPY_RE)) {
        const args = m[2].trim().split(/\s+/);
        if (args.length >= 2) push(args[args.length - 1]);
    }
    for (const m of cmd.matchAll(SED_INPLACE_RE)) push(readToken(raw, m.index + m[0].length - m[2].length));
    for (const m of cmd.matchAll(TOUCH_RE)) {
        for (const a of m[2].trim().split(/\s+/)) push(a);
    }

    /*
     * A Python heredoc names its target in a string literal, not as an operator, so the passes above
     * cannot see it. Only when the command already has write intent — a read-only script contributes
     * nothing — and only absolute literals, which is what a repo path looks like.
     *
     * Scanned on the FULL command, not the heredoc-stripped one: there the body *is* the code, which is
     * where the literal lives. That is the same split `shellHasWriteIntent` makes, for the same reason.
     */
    if (PY_WRITE_RE.test(full)) {
        for (const m of full.matchAll(ABS_LITERAL_RE)) {
            const p = m[1];
            if (p.includes('/') && /\.[A-Za-z0-9]+$/.test(p)) push(p);
        }
    }
    return out;
}

/**
 * Does the command use a shell **operator** that can write -- a redirect or `tee`?
 *
 * Exported because two gates ask this and only one of them had it right. `guards.mjs` (the DSH plugin)
 * carried its own copy, which scanned the raw command text. A `>` inside a quoted argument is text, not
 * a redirect, so a `find` whose `-path` exclusion names a glob was read as a write whose target could not
 * be resolved -- and a read-only command was denied. That is the spurious refusal this module's header
 * warns about, made by the copy that did not mask quotes.
 *
 * Every caller must now come through here, where `maskQuoted` is applied.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function shellHasRedirect(command) {
    const masked = maskQuoted(stripHeredocs(String(command || '')));
    /* A redirect operator is `>`/`>>` that is not part of `=>`, `->`, `<>` or an fd dup like `2>&1`. */
    if (/(?<![=<>0-9-])>>?\s*[^\s&|]/.test(masked)) return true;
    /* `tee` counts only as a command, not as a word inside a message. */
    return /\|\s*tee\b/.test(masked) || /(?:^|[;&]\s*)tee\b/.test(masked);
}

/**
 * Does this command have write intent at all?
 *
 * Distinct from `shellWriteTargets().length > 0` because a Python heredoc can write a path held in a
 * variable, where no target is parseable but the intent is unambiguous. The event's own `path` is
 * then the only signal available, and it is a real one.
 *
 * The two halves deliberately look at different text. Shell operators are read from the command with
 * heredoc bodies **removed**, because a body is data and its redirects belong to whatever generated
 * script. Python write calls are read from the **whole** command, because there the body *is* the
 * code — that is where `json.dump(path)` lives. Scanning one text for both is what produced a false
 * positive on a generated script and then missed the Python writes.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function shellHasWriteIntent(command) {
    const cmd = String(command || '');
    if (!cmd) return false;
    if (shellWriteTargets(cmd).length > 0) return true;
    return PY_WRITE_RE.test(cmd);
}
