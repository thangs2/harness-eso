/**
 * @mu/eso-knowledge — Declaration Authoring Validator & Lifecycle (ESO-145 / US-KB-04 / Slice S1)
 *
 * Implements:
 * - AC-KB-04-01: Valid declaration with closed attributes saves successfully, version increments, marked current.
 * - AC-KB-04-02: Unknown attributes in declaration or applies_when rejected with UNKNOWN_ATTRIBUTE (0 writes).
 * - AC-KB-04-03: Using required attributes undeclared by project warns "chưa khai", never assumes a default.
 * - AC-KB-04-04: Content changed but version not incremented is rejected with VERSION_REQUIRED (0 writes).
 * - AC-KB-04-05: Unicode id / maximum length is preserved verbatim, never normalized implicitly.
 * - AC-KB-04-06: Dangling override targeting missing/deleted declaration surfaces DANGLING_OVERRIDE.
 */

import { computeDeclarationHash } from './sync.mjs';

export const ALLOWED_DECLARATION_FIELDS = Object.freeze([
    'id',
    'version',
    'kind',
    'applies_when',
    'declared_by',
    'declared_at',
    'requires',
    'overrides',
    'path',
    'file',
    'content',
    'content_hash',
    'zone',
    'project',
    'status',
    'uses',
    'used_by_project',
    'proposal_id',
]);

export const ALLOWED_APPLIES_WHEN_FIELDS = Object.freeze([
    'always',
    'paths',
    'globs',
    'tenant_model',
    'consistency_need',
    'isolation_level',
]);

export const REQUIRED_PROJECT_ATTRIBUTES = Object.freeze([
    'tenant_model',
    'consistency_need',
    'isolation_level',
]);

export function validateDeclarationFormat({
    declaration,
    previousDeclaration,
    projectConfig = {},
} = {}) {
    if (!declaration || typeof declaration !== 'object') {
        const err = new Error('Declaration object is required');
        err.code = 'INVALID_DECLARATION';
        throw err;
    }

    const warnings = [];

    // 1. Check for unknown top-level attributes (AC-KB-04-02)
    const allowedFieldsSet = new Set(ALLOWED_DECLARATION_FIELDS);
    for (const key of Object.keys(declaration)) {
        if (!allowedFieldsSet.has(key)) {
            const err = new Error(`UNKNOWN_ATTRIBUTE: Field '${key}' is not allowed in declaration frontmatter`);
            err.code = 'UNKNOWN_ATTRIBUTE';
            err.field = key;
            throw err;
        }
    }

    // 2. Check applies_when fields (AC-KB-04-02)
    let appliesWhen = declaration.applies_when;
    if (typeof appliesWhen === 'string') {
        try {
            appliesWhen = JSON.parse(appliesWhen);
        } catch {
            const err = new Error('UNKNOWN_ATTRIBUTE: Malformed applies_when payload');
            err.code = 'UNKNOWN_ATTRIBUTE';
            throw err;
        }
    }

    if (appliesWhen && typeof appliesWhen === 'object') {
        const allowedAwSet = new Set(ALLOWED_APPLIES_WHEN_FIELDS);
        for (const key of Object.keys(appliesWhen)) {
            if (!allowedAwSet.has(key)) {
                const err = new Error(`UNKNOWN_ATTRIBUTE: Field '${key}' is not allowed in applies_when predicate`);
                err.code = 'UNKNOWN_ATTRIBUTE';
                err.field = `applies_when.${key}`;
                throw err;
            }
        }

        // 3. Check for undeclared project attributes (AC-KB-04-03)
        for (const reqAttr of REQUIRED_PROJECT_ATTRIBUTES) {
            if (appliesWhen[reqAttr] !== undefined) {
                const declaredInProject = projectConfig[reqAttr] !== undefined || projectConfig.attributes?.[reqAttr] !== undefined;
                if (!declaredInProject) {
                    warnings.push({
                        code: 'UNDECLARED_PROJECT_ATTRIBUTE',
                        attribute: reqAttr,
                        message: `Cảnh báo: thuộc tính '${reqAttr}' chưa khai trong cấu hình project — không dùng giá trị mặc định`,
                    });
                }
            }
        }
    }

    // 4. Content changed but version not incremented (AC-KB-04-04)
    if (previousDeclaration) {
        const prevContent = previousDeclaration.content;
        const currContent = declaration.content;
        const prevHash = previousDeclaration.content_hash || (prevContent ? computeDeclarationHash(prevContent) : null);
        const currHash = declaration.content_hash || (currContent ? computeDeclarationHash(currContent) : null);

        const contentChanged = (prevHash && currHash && prevHash !== currHash) ||
                               (prevContent !== undefined && currContent !== undefined && prevContent !== currContent);

        if (contentChanged && String(declaration.version).trim() === String(previousDeclaration.version).trim()) {
            const err = new Error(`VERSION_REQUIRED: Declaration content changed from hash '${prevHash}' to '${currHash}', but version remained '${declaration.version}'`);
            err.code = 'VERSION_REQUIRED';
            err.previous_version = previousDeclaration.version;
            err.version = declaration.version;
            throw err;
        }
    }

    // 5. Unicode id is preserved verbatim (AC-KB-04-05)
    const rawId = declaration.id;
    if (rawId && typeof rawId === 'string') {
        // Must maintain exact unicode codepoints
        declaration.id = rawId;
    }

    return {
        valid: true,
        declaration,
        warnings,
    };
}

export function checkDanglingOverrides({
    declaration,
    declarations = [],
} = {}) {
    if (!declaration || !declaration.overrides) {
        return { dangling: false };
    }

    const targetRef = typeof declaration.overrides === 'string'
        ? declaration.overrides
        : declaration.overrides.target || declaration.overrides.path;

    if (!targetRef) {
        return { dangling: false };
    }

    // Check if targetRef exists in known shared/pool declarations and is not deleted/revoked (AC-KB-04-06)
    const foundTarget = declarations.find((d) => {
        const pointer1 = `${d.zone}/${d.path}@${d.version}`;
        const pointer2 = `${d.path}@${d.version}`;
        const pointer3 = d.path;
        const pointer4 = d.id;
        const matchesTarget = (targetRef === pointer1 || targetRef === pointer2 || targetRef === pointer3 || targetRef === pointer4);
        const isActive = d.status !== 'revoked' && d.status !== 'deleted';
        return matchesTarget && isActive;
    });

    if (!foundTarget) {
        return {
            dangling: true,
            code: 'DANGLING_OVERRIDE',
            target: targetRef,
            message: `DANGLING_OVERRIDE: Override targets '${targetRef}' which is missing or revoked; does not silently fall back to shared`,
        };
    }

    return {
        dangling: false,
        target: targetRef,
    };
}

export function saveDeclaration({
    declaration,
    previousDeclaration,
    projectConfig = {},
    declarations = [],
} = {}) {
    const validation = validateDeclarationFormat({
        declaration,
        previousDeclaration,
        projectConfig,
    });

    const overrideCheck = checkDanglingOverrides({
        declaration,
        declarations,
    });

    if (overrideCheck.dangling) {
        const err = new Error(overrideCheck.message);
        err.code = 'DANGLING_OVERRIDE';
        err.target = overrideCheck.target;
        throw err;
    }

    return {
        saved: true,
        declaration: {
            ...declaration,
            status: declaration.status || 'current',
        },
        warnings: validation.warnings,
    };
}
