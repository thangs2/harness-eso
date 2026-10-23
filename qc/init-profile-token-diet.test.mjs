import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initProfile, projectDraftForConsumer } from '../packages/harness-foundation/src/init-profile.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROFILES_DIR = path.join(REPO_ROOT, 'profiles');

test('initProfile seeds micro-rules and returns tokenDiet audit report', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-profile-diet-'));
    try {
        const registryFile = path.join(tmp, 'registry.json');
        const consumerRepo = path.join(tmp, 'my-consumer');
        fs.mkdirSync(consumerRepo, { recursive: true });

        // Add dummy package.json or git root so it looks like a consumer repo
        fs.writeFileSync(path.join(consumerRepo, 'package.json'), '{"name": "test-consumer"}');
        fs.writeFileSync(path.join(consumerRepo, 'AGENTS.md'), '# Consumer AGENTS\n');

        const project = projectDraftForConsumer(consumerRepo, {
            projectId: 'test-consumer',
            displayName: 'Test Consumer',
            hostMode: 'dual-ide',
        });

        const res = initProfile(project, PROFILES_DIR, registryFile, { verify: false });

        assert.equal(res.ok, true);
        assert.equal(typeof res.tokenDiet, 'object');
        assert.equal(res.tokenDiet.status, 'pass');
        assert(res.tokenDiet.eagerRulesCount <= 6);

        // Verify seeded micro-rules exist in .cursor/rules
        assert(fs.existsSync(path.join(consumerRepo, '.cursor/rules/core.conversation-hygiene.mdc')));
        assert(fs.existsSync(path.join(consumerRepo, '.cursor/rules/core.pipeline-gate.mdc')));
        assert(fs.existsSync(path.join(consumerRepo, '.cursor/rules/core.scope-fallback.mdc')));

        // Verify seeded micro-rules exist in .agents/rules
        assert(fs.existsSync(path.join(consumerRepo, '.agents/rules/core.conversation-hygiene.mdc')));
        assert(fs.existsSync(path.join(consumerRepo, '.agents/rules/core.pipeline-gate.mdc')));
        assert(fs.existsSync(path.join(consumerRepo, '.agents/rules/core.scope-fallback.mdc')));

        // Verify seeded workflow guide & instructions
        assert(fs.existsSync(path.join(consumerRepo, '.harness/WORKFLOW_GUIDE.md')));
        assert(fs.existsSync(path.join(consumerRepo, '.cursor/instructions.md')));
        assert(fs.existsSync(path.join(consumerRepo, '.agents/instructions.md')));

        // Verify decision policy has tokenDiet
        const policy = JSON.parse(
            fs.readFileSync(path.join(consumerRepo, '.harness/decision-policy.json'), 'utf8')
        );
        assert.equal(policy.tokenDiet?.enabled, true);
        assert.equal(policy.tokenDiet?.maxEagerRules, 7);
        assert.equal(policy.tokenDiet?.maxEagerTokens, 10000);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
