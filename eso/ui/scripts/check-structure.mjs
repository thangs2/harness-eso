#!/usr/bin/env node
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '../apps/control-plane/src/app');

const errors = [];

function scanDir(dir) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            scanDir(fullPath);
        } else if (stat.isFile() && (entry.endsWith('.ts') || entry.endsWith('.js'))) {
            validateFile(fullPath);
        }
    }
}

function validateFile(filePath) {
    const rel = relative(APP_ROOT, filePath).replace(/\\/g, '/');
    const content = readFileSync(filePath, 'utf-8');

    // Strip comments for code check
    const codeOnly = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

    // Rule INV-UI-03: Never import packages/harness-*
    if (content.includes('packages/harness-')) {
        errors.push(`[INV-UI-03] ${rel} imports v1 packages/harness-*`);
    }

    // 1. Placement checks: *.page.ts only in features/<f>/pages/
    if (rel.endsWith('.page.ts')) {
        if (!rel.match(/^features\/[^/]+\/pages\/[^/]+\.page\.ts$/)) {
            errors.push(`[Placement] ${rel} must be inside features/<feature>/pages/`);
        }
        if (/HttpClient/.test(codeOnly)) {
            errors.push(`[Rule] ${rel} (page) must not call HttpClient directly`);
        }
    }

    // 2. *.component.ts in features/<f>/components/ or shared/ or layout/
    if (rel.endsWith('.component.ts')) {
        const validPlacement =
            rel.match(/^features\/[^/]+\/components\/[^/]+\.component\.ts$/) ||
            rel.startsWith('shared/') ||
            rel.startsWith('layout/');
        if (!validPlacement) {
            errors.push(`[Placement] ${rel} must be inside features/<feature>/components/, shared/, or layout/`);
        }
    }

    // 3. *.service.ts in features/<f>/data/ or core/
    if (rel.endsWith('.service.ts')) {
        const validPlacement =
            rel.match(/^features\/[^/]+\/data\/[^/]+\.service\.ts$/) ||
            rel.startsWith('core/');
        if (!validPlacement) {
            errors.push(`[Placement] ${rel} must be inside features/<feature>/data/ or core/`);
        }
    }

    // 4. *.store.ts in features/<f>/state/
    if (rel.endsWith('.store.ts')) {
        if (!rel.match(/^features\/[^/]+\/state\/[^/]+\.store\.ts$/)) {
            errors.push(`[Placement] ${rel} must be inside features/<feature>/state/`);
        }
        if (content.includes('fetch(') || content.includes('HttpClient')) {
            errors.push(`[Rule] ${rel} (store) must not make HTTP requests directly`);
        }
    }

    // 5. *.model.ts in features/<f>/models/
    if (rel.endsWith('.model.ts')) {
        if (!rel.match(/^features\/[^/]+\/models\/[^/]+\.model\.ts$/)) {
            errors.push(`[Placement] ${rel} must be inside features/<feature>/models/`);
        }
        if (content.includes('api-client/types')) {
            errors.push(`[Rule] ${rel} (model) must not import API DTO directly`);
        }
    }

    // 6. *.routes.ts in feature root or app root
    if (rel.endsWith('.routes.ts')) {
        const validPlacement =
            rel.match(/^features\/[^/]+\/[^/]+\.routes\.ts$/) ||
            rel === 'routes.ts';
        if (!validPlacement) {
            errors.push(`[Placement] ${rel} must be at feature root or app root`);
        }
    }

    // 7. *.guard.ts and *.interceptor.ts only in core/
    if (rel.endsWith('.guard.ts') || rel.endsWith('.interceptor.ts')) {
        if (!rel.startsWith('core/')) {
            errors.push(`[Placement] ${rel} must be inside core/`);
        }
    }

    // 8. Cross-boundary import checks
    // Core cannot import features
    if (rel.startsWith('core/') && content.includes('/features/')) {
        errors.push(`[Boundary] ${rel} (core) must not import from features/`);
    }

    // Shared cannot import features
    if (rel.startsWith('shared/') && content.includes('/features/')) {
        errors.push(`[Boundary] ${rel} (shared) must not import from features/`);
    }

    // Feature cannot import another feature directly
    const featureMatch = rel.match(/^features\/([^/]+)\//);
    if (featureMatch) {
        const currentFeature = featureMatch[1];
        // match imports like '../s2-why' or 'features/s2-why'
        const otherFeatureRegex = new RegExp(`features/(?!${currentFeature}/)[^/'"]+`, 'g');
        if (otherFeatureRegex.test(content)) {
            errors.push(`[Boundary] ${rel} imports another feature directly`);
        }
    }
}

try {
    scanDir(APP_ROOT);
    if (errors.length > 0) {
        console.error('❌ Structure Check Failed:');
        for (const err of errors) {
            console.error(' -', err);
        }
        process.exit(1);
    } else {
        console.log('✅ Structure check passed! All files adhere to angular-standard/SKILL.md.');
    }
} catch (err) {
    console.error('Error running structure check:', err);
    process.exit(1);
}
