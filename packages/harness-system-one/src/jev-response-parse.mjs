export function parseChoiceAnswer(response, questionKey) {
    const answers = response?.answers ?? response?.results ?? response;
    const ans = answers?.[questionKey] ?? response?.[questionKey];
    if (!ans) return null;

    if (typeof ans.choice === 'string') {
        return { option: ans.choice, confidence: Number(ans.confidence ?? ans.probability ?? 0.5) };
    }
    if (typeof ans.answer === 'string') {
        return { option: ans.answer, confidence: Number(ans.confidence ?? 0.5) };
    }

    const probs = ans.probabilities ?? ans.distribution;
    if (probs && typeof probs === 'object') {
        let best = null;
        let bestP = -1;
        for (const [k, v] of Object.entries(probs)) {
            const p = Number(v);
            if (p > bestP) {
                bestP = p;
                best = k;
            }
        }
        if (best) return { option: best, confidence: bestP };
    }
    return null;
}

export function parseNoulAnswer(response, questionKey) {
    const answers = response?.answers ?? response?.results ?? response;
    const ans = answers?.[questionKey] ?? response?.[questionKey];
    if (!ans) return null;
    const p = Number(ans.probability ?? ans.p ?? ans.score);
    if (!Number.isFinite(p)) return null;
    return { probability: p };
}
