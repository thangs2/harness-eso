import assert from 'node:assert/strict';
import test from 'node:test';
import {
    consumerTypesafeEnvConfigured,
    looksLikeTypesafeKey,
    resolveApiKey,
} from '../packages/harness-console-server/src/jev-smoke.mjs';

test('looksLikeTypesafeKey', () => {
    assert.equal(looksLikeTypesafeKey('apikey_abc123456789012345678'), true);
    assert.equal(looksLikeTypesafeKey('short'), false);
});

test('resolveApiKey prefers body', () => {
    const prev = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'apikey_from_env_xxxxxxxxxxxx';
    assert.equal(resolveApiKey('apikey_from_body_xxxxxxxxxxxx'), 'apikey_from_body_xxxxxxxxxxxx');
    assert.equal(resolveApiKey(''), 'apikey_from_env_xxxxxxxxxxxx');
    process.env.TYPESAFE_API_KEY = prev;
});

test('consumerTypesafeEnvConfigured missing root', () => {
    assert.deepEqual(consumerTypesafeEnvConfigured(''), {
        envFileExists: false,
        keyConfigured: false,
    });
});
