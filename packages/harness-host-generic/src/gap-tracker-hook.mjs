/**
 * Gap tracker — `postToolUse`. Attests recon tool use into `.eso-gap-closure.json`.
 */
import { allow, detectShape, extractToolMeta, harnessTree, loadPolicyForCwd, popAgyToolCache, readStdin } from './hook-io.mjs';
import { readPreflight, recordGapToolUse, resetGapClosure } from './eso-gap-io.mjs';

export async function run() {
    const root = process.cwd();
    const tree = harnessTree();
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
    const gapAttestation = policy?.eso?.cognition?.gapAttestation;
    if (gapAttestation === false) {
        allow(shape);
        return;
    }

    const pre = readPreflight(root, tree);
    if (!pre?.at) {
        allow(shape);
        return;
    }

    let { toolName, toolInput } = extractToolMeta(data);
    const hasInput = Boolean(
        toolInput &&
        (toolInput.path ||
            toolInput.file_path ||
            toolInput.AbsolutePath ||
            toolInput.SearchPath ||
            toolInput.DirectoryPath ||
            toolInput.TargetFile ||
            toolInput.query ||
            toolInput.symbol ||
            (toolInput.arguments && Object.keys(toolInput.arguments).length > 0) ||
            Object.keys(toolInput).length > 1)
    );
    if (!toolName || !hasInput) {
        const cached = popAgyToolCache(data);
        if (cached) {
            toolName = toolName || cached.toolName;
            toolInput = hasInput ? toolInput : { ...(cached.toolInput || {}), ...(toolInput || {}) };
        }
    }
    /*
     * The policy, root and tree are passed **in**. They default to `{}` and `process.cwd()` inside
     * `recordGapToolUse`, and one of its callees falls back to `mode: 'observe'` when the policy is
     * absent — so calling this with a bare `(toolName, toolInput)` wrote an attestation whose mode
     * disagreed with `.harness/decision-policy.json` on every post-tool rewrite. `policy` was already
     * loaded three lines up for `gapAttestation`; not hand it down was the whole defect.
     */
    const closure = recordGapToolUse(toolName, toolInput, { policy, root, tree }) || resetGapClosure(pre.at, root, tree);
    allow(shape, {
        esoGapClosure: {
            preflightAt: closure.preflightAt,
            closed: closure.closedGapIds?.length || 0,
            required: closure.requiredGapIds?.length || 0,
            allClosed: closure.allClosed === true,
        },
    });
}
