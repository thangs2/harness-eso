/**
 * Contract diff — a deterministic check over two OpenAPI-shaped documents (RFC 18 M5).
 *
 * Multi-service work breaks at the contract, not at the syntax: a field removed from a response or a
 * status code dropped passes every unit test in the producer and fails in the consumer. This module
 * answers one question with no heuristics about repository layout: **what did this change break for
 * a caller?**
 *
 * Scope is deliberately a subset of OpenAPI 3 (`paths → method → responses → content →
 * application/json → schema`). Anything outside it is ignored rather than guessed at; a check that
 * invents findings is worse than one that stays silent about what it cannot read.
 */

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const JSON_CONTENT = 'application/json';

function schemaOfResponse(operation, status) {
    return operation?.responses?.[status]?.content?.[JSON_CONTENT]?.schema ?? null;
}

function schemaOfRequest(operation) {
    return operation?.requestBody?.content?.[JSON_CONTENT]?.schema ?? null;
}

function typeOf(schema) {
    if (!schema || typeof schema !== 'object') return null;
    if (schema.type) return schema.type;
    if (schema.properties) return 'object';
    if (schema.items) return 'array';
    return null;
}

function propertiesOf(schema) {
    return schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
        ? schema.properties
        : {};
}

/**
 * @param {object} before parsed contract
 * @param {object} after parsed contract
 * @param {{ direction?: 'response'|'request' }} [options]
 * @returns {{ breaking: Array<{kind:string,path:string,detail:string}>, checked: number }}
 */
export function diffContracts(before, after, options = {}) {
    const direction = options.direction ?? 'response';
    const breaking = [];
    const beforePaths = before?.paths && typeof before.paths === 'object' ? before.paths : {};
    const afterPaths = after?.paths && typeof after.paths === 'object' ? after.paths : {};
    let checked = 0;

    for (const [route, beforePath] of Object.entries(beforePaths)) {
        const afterPath = afterPaths[route];
        if (!afterPath) {
            breaking.push({ kind: 'path-removed', path: route, detail: 'the whole path is gone' });
            continue;
        }
        for (const method of METHODS) {
            const beforeOp = beforePath?.[method];
            if (!beforeOp) continue;
            const afterOp = afterPath?.[method];
            if (!afterOp) {
                breaking.push({ kind: 'method-removed', path: `${method.toUpperCase()} ${route}`, detail: 'the method is gone' });
                continue;
            }
            checked += 1;

            const beforeStatuses = Object.keys(beforeOp.responses ?? {});
            for (const status of beforeStatuses) {
                if (!afterOp.responses || !(status in afterOp.responses)) {
                    breaking.push({
                        kind: 'response-removed',
                        path: `${method.toUpperCase()} ${route}`,
                        detail: `status ${status} is no longer documented`,
                    });
                    continue;
                }
                if (direction === 'response') {
                    compareSchema(schemaOfResponse(beforeOp, status), schemaOfResponse(afterOp, status), `${method.toUpperCase()} ${route} ${status}`, breaking);
                }
            }
            if (direction === 'request') {
                compareSchema(schemaOfRequest(beforeOp), schemaOfRequest(afterOp), `${method.toUpperCase()} ${route} request`, breaking);
            }
        }
    }

    return { breaking, checked };
}

function compareSchema(before, after, where, breaking) {
    if (!before) return;
    if (!after) {
        breaking.push({ kind: 'schema-removed', path: where, detail: 'the schema is gone' });
        return;
    }
    const beforeType = typeOf(before);
    const afterType = typeOf(after);
    if (beforeType && afterType && beforeType !== afterType) {
        breaking.push({ kind: 'type-changed', path: where, detail: `${beforeType} -> ${afterType}` });
        return;
    }
    const beforeProps = propertiesOf(before);
    const afterProps = propertiesOf(after);
    for (const [name, beforeProp] of Object.entries(beforeProps)) {
        if (!(name in afterProps)) {
            breaking.push({ kind: 'field-removed', path: `${where}.${name}`, detail: 'a caller may still read this field' });
            continue;
        }
        compareSchema(beforeProp, afterProps[name], `${where}.${name}`, breaking);
    }
}
