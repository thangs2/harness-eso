import assert from 'node:assert/strict';
import test from 'node:test';

import { diffContracts } from '../packages/harness-eso-core/src/contract-diff.mjs';

function spec(operation, route = '/approvals') {
    return { paths: { [route]: { get: operation } } };
}

const ok = {
    responses: {
        200: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } } } } },
    },
};

test('an unchanged contract has no findings', () => {
    const out = diffContracts(spec(ok), spec(ok));
    assert.deepEqual(out.breaking, []);
    assert.equal(out.checked, 1);
});

test('a removed path is breaking', () => {
    const out = diffContracts(spec(ok), { paths: {} });
    assert.deepEqual(out.breaking.map((b) => b.kind), ['path-removed']);
});

test('a removed method is breaking', () => {
    const out = diffContracts(spec(ok), { paths: { '/approvals': {} } });
    assert.deepEqual(out.breaking.map((b) => b.kind), ['method-removed']);
});

test('a removed response status is breaking', () => {
    const after = spec({ responses: { 200: ok.responses[200] } });
    const before = spec({ responses: { ...ok.responses, 201: { content: { 'application/json': { schema: { type: 'object' } } } } } });
    const out = diffContracts(before, after);
    assert.deepEqual(out.breaking.map((b) => b.kind), ['response-removed']);
});

test('a removed response field is breaking, at any depth', () => {
    const before = spec({
        responses: {
            200: { content: { 'application/json': { schema: { type: 'object', properties: { meta: { type: 'object', properties: { callerId: { type: 'string' } } } } } } } },
        },
    });
    const after = spec({
        responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { meta: { type: 'object', properties: {} } } } } } } },
    });
    const out = diffContracts(before, after);
    assert.deepEqual(out.breaking.map((b) => b.kind), ['field-removed']);
    assert.match(out.breaking[0].path, /meta\.callerId$/);
});

test('a type change is breaking and stops descending', () => {
    const before = spec({ responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } } });
    const after = spec({ responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } } });
    const out = diffContracts(before, after);
    assert.deepEqual(out.breaking.map((b) => b.kind), ['type-changed']);
});

test('the request direction compares request bodies', () => {
    const before = spec({ responses: ok.responses, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { note: { type: 'string' } } } } } } });
    const after = spec({ responses: ok.responses, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: {} } } } } });
    const out = diffContracts(before, after, { direction: 'request' });
    assert.deepEqual(out.breaking.map((b) => b.kind), ['field-removed']);
});
