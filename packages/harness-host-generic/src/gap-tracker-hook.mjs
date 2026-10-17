/**
 * Gap tracker — `postToolUse`. Attests recon tool use into `.eso-gap-closure.json`.
 */
import { allow, detectShape, extractToolMeta, loadPolicyForCwd, popAgyToolCache, readStdin } from './hook-io.mjs';
import { readPreflight, recordGapToolUse, resetGapClosure } from './eso-gap-io.mjs';

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
    const gapAttestation = policy?.eso?.cognition?.gapAttestation;
    if (gapAttestation === false) {
        allow(shape);
        return;
    }

    const pre = readPreflight();
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
    const closure = recordGapToolUse(toolName, toolInput) || resetGapClosure(pre.at);
    allow(shape, {
        esoGapClosure: {
            preflightAt: closure.preflightAt,
            closed: closure.closedGapIds?.length || 0,
            required: closure.requiredGapIds?.length || 0,
            allClosed: closure.allClosed === true,
        },
    });
}
