/**
 * Walk-up to harness.config.json — never anchor from package install path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_NAME = 'harness.config.json';

export function findConfigPath(startDir = process.cwd()) {
    let dir = path.resolve(startDir);
    for (;;) {
        const candidate = path.join(dir, CONFIG_NAME);
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) return '';
        dir = parent;
    }
}

export function findRepoRoot(startDir = process.cwd()) {
    const configPath = findConfigPath(startDir);
    return configPath ? path.dirname(configPath) : '';
}

export function isoNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function expandHome(p) {
    if (!p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
}
