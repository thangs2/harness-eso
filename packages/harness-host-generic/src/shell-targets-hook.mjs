/**
 * Shell target query — an **answer**, not a verdict.
 *
 * Every other hook in this pack decides whether an operation may proceed, and emits a permission
 * payload for the IDE. This one does not: it answers "which files would this command write?" and
 * prints JSON, so the consumer's own shell guard can apply its own policy.
 *
 * Why it exists — the split of responsibilities:
 *
 *   - **The parser** is one implementation, in this pack, imported from `@mu/harness-foundation/pure`.
 *   - **The policy** — which paths are protected — stays with the consumer, in `guard-write.py`.
 *
 * That split is deliberate. Shell is a second write channel: `guard-write.py` only runs on
 * Write/StrReplace, and `guard-shell.py` only blocked database and secret targets, so a
 * `cat > sdlc/foo.md` passed through untouched. One turn wrote 7 protected files that way while the
 * observer recorded all of them as *reads*.
 *
 * The alternative — porting the parser into `guard-shell.py` — would have left two copies of a
 * heuristic in two languages. Two copies is what let this gap open in the first place, so the copy is
 * avoided even though it costs a process spawn per shell command. See §28.
 *
 * Deliberately **not** wired into any host profile: no IDE event should call this, and a stray entry
 * would replace a real guard's permission payload with this JSON.
 */
import { shellCommandOf, shellHasWriteIntent, shellWriteTargets } from '@mu/harness-foundation/pure';
import { readStdin } from './hook-io.mjs';

/**
 * @returns {Promise<void>}
 */
export async function run() {
    let payload = {};
    try {
        const raw = await readStdin();
        payload = raw && raw.trim() ? JSON.parse(raw) : {};
    } catch {
        payload = {};
    }

    const command =
        shellCommandOf(payload) || (typeof payload?.command === 'string' ? payload.command : '');
    /*
     * `ok: false` on an unparseable payload, and the caller decides. The guard asking the question is
     * the one that knows its posture (`guards.unavailable`); answering `allow` from here would make
     * this function the policy owner, which it is not.
     */
    if (!command.trim()) {
        process.stdout.write(`${JSON.stringify({ ok: true, writeIntent: false, targets: [] })}\n`);
        return;
    }

    process.stdout.write(
        `${JSON.stringify({
            ok: true,
            writeIntent: shellHasWriteIntent(command),
            targets: shellWriteTargets(command),
        })}\n`,
    );
}
