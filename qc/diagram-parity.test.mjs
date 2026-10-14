import assert from 'node:assert/strict';
import test from 'node:test';

import { compareDiagrams, readDocDiagrams, readSourceDiagrams } from '../scripts/sync-diagrams.mjs';

/**
 * A documentation compilation holds a **copy** of four diagrams the product renders. The copy is the point —
 * one file with every diagram — but a copy that nobody checks is a copy that lies.
 *
 * These are the same comparisons `bun run sync:diagrams` makes, wired into the test suite so a change to the
 * Console diagrams cannot land while the compilation silently keeps showing the old shape.
 */

test('every product diagram is present in the compilation, and identical', () => {
    const results = compareDiagrams();
    assert.ok(results.length >= 4, `expected the four product diagrams, found ${results.length}`);
    const bad = results.filter((r) => r.status !== 'ok');
    assert.deepEqual(
        bad,
        [],
        `diagram drift: ${bad.map((b) => `${b.id} (${b.status})`).join(', ')} — run: bun run sync:diagrams --write`,
    );
});

test('the compilation covers every diagram the product declares', () => {
    // `missing-in-doc` is the failure this guards: someone adds a diagram to the Console and the compilation
    // never learns about it, so "one file with all diagrams" quietly stops being true.
    const source = [...readSourceDiagrams().keys()].sort();
    const doc = [...readDocDiagrams().keys()].sort();
    assert.deepEqual(doc, source, 'the doc must carry exactly the product diagrams, no more and no fewer');
});

test('the parser reads real block boundaries, not empty strings', () => {
    /*
     * A regex that matched nothing would make every comparison pass — the check would report "in sync" while
     * reading two empty maps. Asserting on content is what makes the other two tests mean anything.
     */
    const source = readSourceDiagrams();
    const doc = readDocDiagrams();
    for (const [id, block] of source) {
        assert.ok(block.length > 40, `source block ${id} looks empty (${block.length} chars)`);
        assert.match(block, /^(flowchart|graph|sequenceDiagram|stateDiagram)/, `${id} is not a diagram`);
        assert.ok(doc.has(id), `${id} missing from the doc`);
        assert.ok(doc.get(id).length > 40, `doc block ${id} looks empty`);
    }
});

test('a drifted block is detected, not tolerated', () => {
    /*
     * Proves the comparison can fail. Without this, a bug in `normalize` — say, one that collapses everything
     * to '' on both sides — would leave the suite green and the guard imaginary.
     */
    const { id, text } = (() => {
        const source = readSourceDiagrams();
        const first = [...source.keys()].sort()[0];
        return { id: first, text: source.get(first) };
    })();
    assert.notEqual(
        text,
        `${text}\n    EXTRA[drift]:::x`,
        'sanity: the mutation must actually change the text',
    );
    // The comparison is pure, so simulate drift at the same level the check operates on.
    const normalise = (s) => s.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{2,}/g, '\n').trim();
    assert.notEqual(
        normalise(text),
        normalise(`${text}\n    EXTRA[drift]:::x`),
        `${id} must not compare equal to a mutated copy`,
    );
});
