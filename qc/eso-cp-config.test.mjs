import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    previewConfigChange,
    saveConfigChange,
    revertConfigChange,
    previewAttributeChange,
    saveAttributeChange,
} from '../eso/control-plane/src/index.mjs';

test('SCN-IAM-06-01 (AC-IAM-06-01): Preview config change returns users, overrides, and affected artefacts', () => {
    const currentConfig = {
        project: 'baplatform',
        version: 1,
        roles: { lead: {}, build: {}, verify: {} },
        custom_overrides: ['rule.slp.strict'],
    };

    const pendingChange = {
        rule_set: 'enterprise-strict',
    };

    const artefacts = [
        { id: 'art-1', project: 'baplatform' },
        { id: 'art-2', project: 'other-project' },
    ];

    const preview = previewConfigChange({
        project: 'baplatform',
        currentConfig,
        pendingChange,
        artefacts,
    });

    assert.ok(preview.preview_hash);
    assert.equal(preview.base_version, 1);
    assert.deepEqual(preview.users, ['lead', 'build', 'verify']);
    assert.deepEqual(preview.overrides, ['rule.slp.strict']);
    assert.deepEqual(preview.affected_artefacts, ['art-1']);
});

test('SCN-IAM-06-02 (AC-IAM-06-02 & AC-IAM-06-05): Save without matching preview hash rejected; matching hash saves with version+1', () => {
    const currentConfig = { project: 'baplatform', version: 2, model: 'gemini-1.5' };
    const pendingChange = { model: 'gemini-2.5' };

    const preview = previewConfigChange({
        project: 'baplatform',
        currentConfig,
        pendingChange,
    });

    // 1. Unpreviewed / wrong hash rejected (AC-IAM-06-02)
    assert.throws(() => {
        saveConfigChange({
            project: 'baplatform',
            currentConfig,
            pendingChange,
            previewHash: 'invalid-hash',
        });
    }, (err) => {
        assert.equal(err.code, 'PREVIEW_HASH_MISMATCH');
        return true;
    });

    // 2. Exact match saves with version + 1 (AC-IAM-06-05 / ED4)
    const result = saveConfigChange({
        project: 'baplatform',
        currentConfig,
        pendingChange,
        previewHash: preview.preview_hash,
    });

    assert.equal(result.config.version, 3);
    assert.equal(result.config.model, 'gemini-2.5');
    assert.equal(result.history.previous_version, 2);
});

test('SCN-IAM-06-03 (AC-IAM-06-03): Revert rolls back to previous version and marks intermediate artefacts', () => {
    const history = [
        {
            version: 2,
            previous_version: 1,
            saved_at: '2026-11-04T01:00:00.000Z',
            operator: 'thang',
            snapshot: { project: 'baplatform', version: 1, setting: 'v1' },
        },
    ];

    const currentConfig = { project: 'baplatform', version: 2, setting: 'v2' };
    const artefacts = [
        { id: 'art-before', project: 'baplatform', created_at: '2026-11-04T00:30:00.000Z' },
        { id: 'art-during', project: 'baplatform', created_at: '2026-11-04T01:15:00.000Z' },
    ];

    const reverted = revertConfigChange({
        project: 'baplatform',
        currentConfig,
        history,
        artefacts,
    });

    assert.equal(reverted.config.version, 1);
    assert.equal(reverted.config.setting, 'v1');
    assert.ok(reverted.config.reverted_at);

    const artDuring = reverted.marked_artefacts.find((a) => a.id === 'art-during');
    assert.equal(artDuring.marked_reverted, true);
    assert.equal(artDuring.invalidation_reason, 'CONFIG_REVERTED');

    const artBefore = reverted.marked_artefacts.find((a) => a.id === 'art-before');
    assert.equal(artBefore.marked_reverted, undefined);
});

test('SCN-IAM-06-04 (AC-IAM-06-04): Tenant isolation prevents cross-project mutation', () => {
    const configA = { project: 'project-A', version: 1 };
    const pendingChange = { setting: 'new-val' };

    assert.throws(() => {
        saveConfigChange({
            project: 'project-B', // Attempting to modify project-A from project-B
            currentConfig: configA,
            pendingChange,
            previewHash: 'dummy',
        });
    }, (err) => {
        assert.equal(err.code, 'TENANT_VIOLATION');
        return true;
    });
});

test('SCN-IAM-06-05 (AC-IAM-06-06 / ED3): Shared preset upgrade impact spans all 50 projects', () => {
    const projectsList = Array.from({ length: 50 }, (_, i) => ({
        id: `project-${i + 1}`,
        preset_id: 'preset-standard-v1',
    }));

    const preview = previewConfigChange({
        project: 'project-1',
        currentConfig: { version: 1 },
        pendingChange: { preset_id: 'preset-standard-v1' },
        projectsList,
    });

    assert.equal(preview.impact.length, 50);
    assert.equal(preview.impact[0].project, 'project-1');
    assert.equal(preview.impact[49].project, 'project-50');
});

test('SCN-IAM-09-01 (AC-IAM-09-01): Preview attribute modification surfaces all affected policies', () => {
    const policies = [
        { id: 'pol-1', uses: ['region', 'tier'] },
        { id: 'pol-2', uses: ['region'] },
        { id: 'pol-3', uses: ['region', 'env'] },
        { id: 'pol-4', uses: ['env'] },
    ];

    const preview = previewAttributeChange({
        project: 'baplatform',
        attributeKey: 'region',
        action: 'delete',
        policies,
    });

    assert.equal(preview.affected_count, 3);
    assert.deepEqual(preview.affected_policies, ['pol-1', 'pol-2', 'pol-3']);
});

test('SCN-IAM-09-02 (AC-IAM-09-02): Agent role modification of attributes is prohibited with FORBIDDEN_MUTATION', () => {
    assert.throws(() => {
        saveAttributeChange({
            project: 'baplatform',
            attributeKey: 'region',
            action: 'update',
            newValue: 'ap-southeast-1',
            actorRole: 'build', // agent role build
        });
    }, (err) => {
        assert.equal(err.code, 'FORBIDDEN_MUTATION');
        return true;
    });
});

test('SCN-IAM-09-03 (AC-IAM-09-03): Deleting in-use attribute rejected with ATTRIBUTE_IN_USE', () => {
    const policies = [{ id: 'pol-security', uses: ['region'] }];

    assert.throws(() => {
        saveAttributeChange({
            project: 'baplatform',
            attributeKey: 'region',
            action: 'delete',
            policies,
            actorRole: 'operator',
        });
    }, (err) => {
        assert.equal(err.code, 'ATTRIBUTE_IN_USE');
        assert.deepEqual(err.used_by, ['pol-security']);
        return true;
    });
});

test('SCN-IAM-09-04 (AC-IAM-09-04 / ED7): Optimistic concurrency control rejects stale version with STALE_VERSION', () => {
    assert.throws(() => {
        saveAttributeChange({
            project: 'baplatform',
            attributeKey: 'region',
            action: 'update',
            newValue: 'us-west-1',
            currentVersion: 2,
            requestedVersion: 1, // Stale version
            actorRole: 'operator',
        });
    }, (err) => {
        assert.equal(err.code, 'STALE_VERSION');
        assert.equal(err.current_version, 2);
        assert.equal(err.requested_version, 1);
        return true;
    });
});

test('SCN-IAM-09-05 (AC-IAM-09-05 / ED10): Renaming in-use attribute without migration plan rejected with RENAME_WITHOUT_MIGRATION', () => {
    const policies = [{ id: 'pol-geo', uses: ['region'] }];

    // Renaming without migration rejected
    assert.throws(() => {
        saveAttributeChange({
            project: 'baplatform',
            attributeKey: 'region',
            action: 'rename',
            newValue: 'geo_region',
            policies,
            actorRole: 'operator',
            hasMigrationPlan: false,
        });
    }, (err) => {
        assert.equal(err.code, 'RENAME_WITHOUT_MIGRATION');
        return true;
    });

    // With explicit migration plan, rename succeeds
    const success = saveAttributeChange({
        project: 'baplatform',
        attributeKey: 'region',
        action: 'rename',
        newValue: 'geo_region',
        policies,
        actorRole: 'operator',
        hasMigrationPlan: true,
    });
    assert.equal(success.success, true);
    assert.equal(success.attribute_key, 'geo_region');
});
