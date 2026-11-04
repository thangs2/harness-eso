import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryKnowledgeItem } from '../eso/knowledge/src/index.mjs';

test('SCN-KB-02 (AC-KB-01-02): Foreign project item returns NOT_FOUND identical to non-existent item', () => {
    const declarations = [
        { id: 'secret-Y', project: 'tenant-secret-corp', zone: 'project', content: 'Top Secret Plans' }
    ];

    // Case 1: Query an item that truly does not exist
    const absentResult = queryKnowledgeItem('tenant-guest', 'completely-absent-id', declarations);

    // Case 2: Query an item that exists in another project
    const foreignResult = queryKnowledgeItem('tenant-guest', 'secret-Y', declarations);

    // Both must indicate not found
    assert.equal(absentResult.found, false);
    assert.equal(foreignResult.found, false);
    assert.equal(absentResult.error, 'NOT_FOUND');
    assert.equal(foreignResult.error, 'NOT_FOUND');

    // The answer returned to the actor must not leak the existence of Y
    assert.equal(foreignResult.found, absentResult.found);
    assert.equal(foreignResult.error, absentResult.error);

    // Internal record must truthfully record reality without exposing it to caller (D-45)
    assert.equal(absentResult.exists, 'absent');
    assert.equal(foreignResult.exists, 'present');
    assert.equal(foreignResult.visibility, 'not-visible');
});
