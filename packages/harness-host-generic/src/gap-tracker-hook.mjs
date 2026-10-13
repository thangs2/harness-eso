/**
 * Gap tracker — `postToolUse`. Attests recon tool use into `.eso-gap-closure.json`.
 */
import { allow, detectShape, extractToolMeta, loadPolicyForCwd, readStdin } from './hook-io.mjs';
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

    const { toolName, toolInput } = extractToolMeta(data);
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
