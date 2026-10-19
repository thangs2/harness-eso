#!/usr/bin/env bun
/**
 * Dual-Harness Isolation Verifier (mechanism template)
 * Enforces isolation between Cursor (.cursor/) and Antigravity (.agents/).
 * Copy to consumer `scripts/ci/verify-dual-harness.mjs` if missing.
 * Equivalent probes: agent-platform-verify.sh / metadata-kind-parity.sh (BAP).
 */

import fs from 'node:fs';
import path from 'node:path';

export class DualHarnessViolationError extends Error {
  constructor(message) {
    super(`[Dual-Harness Violation] ${message}`);
    this.name = 'DualHarnessViolationError';
  }
}

export function verifyDualHarness(rootDir = process.cwd()) {
  const cursorDir = path.join(rootDir, '.cursor');
  const agentsDir = path.join(rootDir, '.agents');
  const violations = [];

  const cursorRulesDir = path.join(cursorDir, 'rules');
  if (fs.existsSync(cursorRulesDir)) {
    for (const file of fs.readdirSync(cursorRulesDir)) {
      if (file.endsWith('.md')) {
        violations.push(
          `Cursor rules: found "${file}" in .cursor/rules/ — Cursor rules MUST end with .mdc.`,
        );
      }
    }
  }

  const agentsRulesDir = path.join(agentsDir, 'rules');
  if (fs.existsSync(agentsRulesDir)) {
    for (const file of fs.readdirSync(agentsRulesDir)) {
      if (file.endsWith('.mdc')) {
        violations.push(
          `Antigravity rules: found "${file}" in .agents/rules/ — Antigravity rules MUST end with .md.`,
        );
      }
    }
  }

  if (fs.existsSync(path.join(cursorDir, 'mcp_config.json'))) {
    violations.push('Cross-contamination: mcp_config.json (Antigravity) inside .cursor/.');
  }
  if (fs.existsSync(path.join(agentsDir, 'mcp.json'))) {
    violations.push('Cross-contamination: mcp.json (Cursor) inside .agents/.');
  }

  if (violations.length > 0) {
    throw new DualHarnessViolationError(violations.join('\n'));
  }

  return {
    verified: true,
    cursorRulesCount: fs.existsSync(cursorRulesDir)
      ? fs.readdirSync(cursorRulesDir).filter((f) => f.endsWith('.mdc')).length
      : 0,
    agentsRulesCount: fs.existsSync(agentsRulesDir)
      ? fs.readdirSync(agentsRulesDir).filter((f) => f.endsWith('.md')).length
      : 0,
  };
}

if (import.meta.main) {
  try {
    const result = verifyDualHarness();
    console.log(
      `[Dual-Harness] ✅ Verified (${result.cursorRulesCount} .mdc, ${result.agentsRulesCount} .md).`,
    );
    process.exit(0);
  } catch (err) {
    console.error(`\x1b[31m${err.message}\x1b[0m`);
    process.exit(1);
  }
}
