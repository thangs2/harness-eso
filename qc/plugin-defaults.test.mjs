import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultPlugins, defaultProjectDraft } from '../packages/harness-foundation/src/project-registry.mjs';

/**
 * The registry writer (`addProjectEntry` in `workspace-store.mjs`) keeps its own copy of the default
 * plugin map, because `workspace-store.mjs` must not import the module that imports it. Two copies
 * of a policy seed is exactly how the observe port ended up with two answers, so this test holds
 * them together: adding an adapter to one and forgetting the other fails here instead of showing up
 * as a consumer whose `decision-policy.json` disagrees with the Console.
 */
const REGISTRY_COPY = {
    law: { adapterId: 'docgraph-cli' },
    code: { adapterId: 'codegraph-cli' },
    memory: { adapterId: 'noop-memory' },
    jev: { adapterId: 'off', mode: 'off' },
    l3_route: { adapterId: 'off' },
    brain: { adapterId: 'deepseek-mcp' },
};

test('the project draft and the registry-writer seed are the same plugin map', () => {
    assert.deepEqual(defaultProjectDraft({ displayName: 'alpha', id: 'alpha' }).plugins, REGISTRY_COPY);
    assert.deepEqual(defaultPlugins(), REGISTRY_COPY);
});
