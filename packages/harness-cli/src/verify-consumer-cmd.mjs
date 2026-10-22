#!/usr/bin/env node
/**
 * `harnessctl verify consumer` — read-only maturity diagnostic vs
 * profiles/standards/consumer-maturity.v1.json
 *
 * Emits <consumer>/.harness/diagnostics/latest.{json,md} (+ timestamped copies).
 * Does not mutate hooks/policy/source.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkspace } from '@mu/harness-foundation/workspace';
import { ESO_ROOT } from './workspace-env.mjs';

const STANDARD_REL = path.join('profiles', 'standards', 'consumer-maturity.v1.json');

function die(msg, code = 2) {
  console.error(`verify-consumer: ${msg}`);
  process.exit(code);
}

function resolveConsumer(opts, positional) {
  if (positional) return path.resolve(positional);
  if (opts.project) {
    const ws = loadWorkspace();
    const row = (ws.projects || []).find((p) => p.id === opts.project);
    if (!row) die(`unknown project "${opts.project}" — harnessctl configure list`);
    return path.resolve(row.rootHost || row.root);
  }
  die('needs a consumer path or --project <id>');
  return '';
}

function parse(argv) {
  const opts = { project: null, json: false, strict: false, out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') opts.project = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('-')) die(`unknown flag: ${a}`);
    else positional.push(a);
  }
  return { opts, positional };
}

function loadStandard() {
    // `HARNESS_STANDARD_PATH` lets a checkout verify against a throwaway standard instead of the
    // packaged one. Without it the only way to exercise a failing check is to break a real consumer's
    // files — which is exactly how a "test" ends up editing the thing it is testing.
    const override = process.env.HARNESS_STANDARD_PATH;
    const p = override ? path.resolve(override) : path.join(ESO_ROOT, STANDARD_REL);
    if (!fs.existsSync(p)) die(`standard missing: ${p}`);
    return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

function exists(root, rel, as = 'any') {
  const full = path.join(root, rel);
  try {
    const st = fs.statSync(full);
    if (as === 'dir') return st.isDirectory();
    if (as === 'file') return st.isFile();
    return true;
  } catch {
    return false;
  }
}

function readJson(root, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  } catch {
    return null;
  }
}

function hasNestedKey(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}

function readNestedKey(obj, dotted) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function globMin(root, pattern, min) {
  // Minimal glob: only supports "dir/prefix*suffix" one star
  const absPattern = path.join(root, pattern);
  const dir = path.dirname(absPattern);
  const base = path.basename(absPattern);
  const star = base.indexOf('*');
  if (!fs.existsSync(dir) || star < 0) return { ok: false, count: 0, evidence: `no dir ${path.relative(root, dir)}` };
  const prefix = base.slice(0, star);
  const suffix = base.slice(star + 1);
  const names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith(suffix));
  return {
    ok: names.length >= min,
    count: names.length,
    evidence: `${names.length} match(es) under ${path.relative(root, dir) || '.'} (need ≥${min})`,
  };
}

function runProbe(root, probe) {
  const type = probe?.type;
  if (type === 'dir_exists') {
    const ok = exists(root, probe.path, 'dir');
    return { ok, evidence: ok ? `dir ${probe.path}` : `missing dir ${probe.path}` };
  }
  if (type === 'file_exists') {
    const ok = exists(root, probe.path, 'file');
    return { ok, evidence: ok ? `file ${probe.path}` : `missing file ${probe.path}` };
  }
  if (type === 'all_exist') {
    const as = probe.as || 'any';
    const missing = (probe.paths || []).filter((p) => !exists(root, p, as));
    return {
      ok: missing.length === 0,
      evidence: missing.length ? `missing: ${missing.join(', ')}` : `all present (${(probe.paths || []).length})`,
    };
  }
  if (type === 'any_exists') {
    const as = probe.as || 'any';
    const hit = (probe.paths || []).find((p) => exists(root, p, as));
    return {
      ok: Boolean(hit),
      evidence: hit ? `found ${hit}` : `none of: ${(probe.paths || []).join(' | ')}`,
    };
  }
  if (type === 'json_has_keys') {
    const doc = readJson(root, probe.path);
    if (!doc) return { ok: false, evidence: `cannot read JSON ${probe.path}` };
    const missing = (probe.keys || []).filter((k) => !hasNestedKey(doc, k));
    return {
      ok: missing.length === 0,
      evidence: missing.length ? `${probe.path} missing keys: ${missing.join(', ')}` : `${probe.path} keys ok`,
    };
  }
  if (type === 'glob_min') {
    return globMin(root, probe.glob, probe.min ?? 1);
  }
  if (type === 'file_contains_any') {
    const rel = probe.path || '';
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return { ok: false, evidence: `missing file ${rel}` };
    }
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const patterns = probe.patterns || [];
    const hit = patterns.find((pat) => lines.some((l) => l === pat || l.startsWith(`${pat}`)));
    return {
      ok: Boolean(hit),
      evidence: hit
        ? `${rel} contains ${hit}`
        : `${rel} missing any of: ${patterns.join(' | ')}`,
    };
  }
  /**
   * A scope line is only a claim; the path it names is the fact.
   *
   * `file_contains_any` accepted `path:sdlc/00.agent-manifests` in `docgraph.scope` even when that
   * directory did not exist, so a consumer scored T3.4 for declaring an Agent Zone it never had
   * (H6). Here the line must name a path that exists as a directory.
   */
  if (type === 'file_contains_existing_path') {
    const rel = probe.path || '';
    const full = path.join(root, rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return { ok: false, evidence: `missing file ${rel}` };
    }
    const lines = fs
      .readFileSync(full, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim());
    const declared = [];
    for (const line of lines) {
      /*
       * Every `path:` line in the file, not only the prefixes the check is about. `file_contains`
       * probes run against a whole scope file, so the reported evidence has to describe what the file
       * says; the check itself still asks whether the Agent Zone is among it.
       */
      if (!line.startsWith('path:')) continue;
      const target = line.slice('path:'.length).split('#')[0].trim();
      if (target) declared.push(target);
    }
    if (!declared.length) {
      return { ok: false, evidence: `${rel} declares no path: line` };
    }
    const missing = declared.filter((p) => !exists(root, p));
    return {
      ok: missing.length === 0,
      evidence: missing.length
        ? `${rel} declares paths that do not exist: ${missing.join(', ')}`
        : `${rel} declares existing paths: ${declared.join(', ')}`,
    };
  }
  if (type === 'json_value') {
    const doc = readJson(root, probe.path);
    if (!doc) {
      if (probe.allow_absent_as === false) return { ok: false, evidence: `cannot read JSON ${probe.path}` };
      return { ok: Boolean(probe.allow_absent_as), evidence: `cannot read JSON ${probe.path}` };
    }
    const actual = hasNestedKey(doc, probe.key) ? readNestedKey(doc, probe.key) : undefined;
    if (actual === undefined) {
      const ok = Boolean(probe.allow_absent_as);
      return { ok, evidence: `${probe.path} has no ${probe.key}${ok ? ' (allowed absent)' : ''}` };
    }
    const ok = actual === probe.equals;
    return {
      ok,
      evidence: `${probe.path} ${probe.key} = ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(probe.equals)})`}`,
    };
  }
  return { ok: false, evidence: `unknown probe type: ${type}` };
}

function guessConsumerId(root) {
  const cfg = readJson(root, 'harness.config.json');
  if (cfg?.project?.id) return cfg.project.id;
  return path.basename(root);
}

function computeTierReached(checks) {
  const byTier = new Map();
  for (const c of checks) {
    if (!byTier.has(c.tier)) byTier.set(c.tier, []);
    byTier.get(c.tier).push(c);
  }
  const order = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'];
  let reached = 'NONE';
  for (const t of order) {
    const list = byTier.get(t) || [];
    const critical = list.filter((c) => c.severity === 'CRITICAL');
    if (critical.length === 0) {
      // tier with no critical: require all checks pass to count as reached
      if (list.length && list.every((c) => c.status === 'PASS')) reached = t;
      else if (list.length === 0) continue;
      else break;
      continue;
    }
    if (critical.every((c) => c.status === 'PASS')) reached = t;
    else break;
  }
  return reached;
}

function toMarkdown(report) {
  const lines = [];
  lines.push(`# Consumer Maturity Diagnostic`);
  lines.push('');
  lines.push(`- **Consumer:** \`${report.consumerId}\` (\`${report.consumerRoot}\`)`);
  lines.push(`- **Standard:** ${report.standardId} v${report.standardVersion}`);
  lines.push(`- **At:** ${report.at}`);
  lines.push(`- **Tier reached:** **${report.summary.tierReached}**`);
  lines.push(
    `- **Summary:** pass=${report.summary.pass} fail=${report.summary.fail} criticalFail=${report.summary.criticalFail}`,
  );
  lines.push('');
  lines.push('| ID | Tier | Sev | Status | Title | Evidence |');
  lines.push('| :--- | :---: | :---: | :---: | :--- | :--- |');
  for (const c of report.checks) {
    lines.push(
      `| ${c.id} | ${c.tier} | ${c.severity} | ${c.status} | ${c.title} | ${String(c.evidence).replace(/\|/g, '\\|')} |`,
    );
  }
  const fails = report.checks.filter((c) => c.status === 'FAIL');
  if (fails.length) {
    lines.push('');
    lines.push('## Remediations');
    lines.push('');
    for (const c of fails) {
      lines.push(`### ${c.id} — ${c.title}`);
      lines.push(`- **action:** \`${c.remediation?.action || 'docs'}\``);
      lines.push(`- **hint:** ${c.remediation?.hint || 'n/a'}`);
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('Verify is **read-only**. Apply remediations manually or via provision/sync — do not invent domain rules from another consumer.');
  return lines.join('\n') + '\n';
}

export function writeDiagnostics(root, outDir, report) {
  const dir = outDir || path.join(root, '.harness', 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.at.replace(/[:.]/g, '-');
  const jsonBody = JSON.stringify(report, null, 2);
  const mdBody = toMarkdown(report);
  fs.writeFileSync(path.join(dir, 'latest.json'), jsonBody);
  fs.writeFileSync(path.join(dir, 'latest.md'), mdBody);
  fs.writeFileSync(path.join(dir, `${stamp}.json`), jsonBody);
  fs.writeFileSync(path.join(dir, `${stamp}.md`), mdBody);
  return dir;
}

export function diagnoseConsumer(root, { standard } = {}) {
  const { path: standardPath, data } = standard || loadStandard();
  const checks = [];
  for (const tier of data.tiers || []) {
    for (const check of tier.checks || []) {
      const probeResult = runProbe(root, check.probe);
      checks.push({
        id: check.id,
        tier: tier.id,
        title: check.title,
        severity: check.severity || 'INFO',
        status: probeResult.ok ? 'PASS' : 'FAIL',
        evidence: probeResult.evidence,
        remediation: check.remediation || null,
      });
    }
  }
  const pass = checks.filter((c) => c.status === 'PASS').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;
  const criticalFail = checks.filter((c) => c.status === 'FAIL' && c.severity === 'CRITICAL').length;
  const report = {
    ok: criticalFail === 0,
    standardId: data.id,
    standardVersion: data.version,
    standardPath,
    consumerRoot: root,
    consumerId: guessConsumerId(root),
    at: new Date().toISOString(),
    summary: {
      pass,
      fail,
      skip: 0,
      criticalFail,
      tierReached: computeTierReached(checks),
    },
    checks,
  };
  return report;
}

/**
 * @param {string[]} argv raw args after `verify consumer`
 */
export function runVerifyConsumer(argv) {
  const { opts, positional } = parse(argv);
  if (positional[0] === 'help' || opts.help) {
    console.log(`usage: harnessctl verify consumer <path|--project <id>> [--json] [--strict] [--out <dir>]`);
    process.exit(0);
  }
  const root = resolveConsumer(opts, positional[0] || null);
  if (!fs.existsSync(root)) die(`consumer path not found: ${root}`);

  const report = diagnoseConsumer(root);
  const dir = writeDiagnostics(root, opts.out, report);

  if (opts.json) {
    console.log(JSON.stringify({ ...report, diagnosticsDir: dir }, null, 2));
  } else {
    console.log(`verify-consumer  ${report.consumerId}`);
    console.log(`  root          ${report.consumerRoot}`);
    console.log(`  standard      ${report.standardId} v${report.standardVersion}`);
    console.log(`  tierReached   ${report.summary.tierReached}`);
    console.log(
      `  summary       pass=${report.summary.pass} fail=${report.summary.fail} criticalFail=${report.summary.criticalFail}`,
    );
    console.log(`  diagnostics   ${dir}/latest.md`);
    for (const c of report.checks.filter((x) => x.status === 'FAIL')) {
        console.log(`  FAIL ${c.severity.padEnd(8)} ${c.id}  ${c.title}`);
      // `[undefined] undefined` is worse than no line: it looks like output, so the operator reads it
      // as "the report says nothing" instead of "this check has no remediation". Say which.
      if (c.remediation?.action || c.remediation?.hint) {
        console.log(`       → [${c.remediation.action || 'docs'}] ${c.remediation.hint || 'n/a'}`);
      } else {
        console.log(`       → ${c.evidence ? `no remediation recorded — evidence: ${c.evidence}` : 'no remediation recorded'}`);
      }
    }
  }

  const failStrict =
    report.summary.criticalFail > 0 ||
    (opts.strict && report.checks.some((c) => c.status === 'FAIL' && c.severity === 'WARN'));
  process.exit(failStrict ? 1 : 0);
}
