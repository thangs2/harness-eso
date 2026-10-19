#!/usr/bin/env node
/**
 * `harnessctl fix consumer` — semi-auto remediations from maturity diagnostic.
 *
 * AUTO-SAFE: sync WORKFLOW_GUIDE, mkdir session dirs, host-pack refresh, optional provision.
 * NEVER auto: context-contract, agent-manifests, eso-coverage body, jira, domain rules
 *   → written to .harness/diagnostics/OPEN_FIXES.md for consumer self-adjust.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadWorkspace } from '@mu/harness-foundation/workspace';
import { ESO_ROOT } from './workspace-env.mjs';
import { diagnoseConsumer, writeDiagnostics } from './verify-consumer-cmd.mjs';

function die(msg, code = 2) {
  console.error(`fix-consumer: ${msg}`);
  process.exit(code);
}

function resolveConsumer(opts, positional) {
  if (positional) return path.resolve(positional);
  if (opts.project) {
    const ws = loadWorkspace();
    const row = (ws.projects || []).find((p) => p.id === opts.project);
    if (!row) die(`unknown project "${opts.project}"`);
    return path.resolve(row.rootHost || row.root);
  }
  die('needs a consumer path or --project <id>');
  return '';
}

function parse(argv) {
  const opts = {
    project: null,
    json: false,
    dryRun: false,
    fromLatest: false,
    forceProvision: false,
    noProvision: false,
    noReverify: false,
    strict: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') opts.project = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--from-latest') opts.fromLatest = true;
    else if (a === '--force-provision') opts.forceProvision = true;
    else if (a === '--no-provision') opts.noProvision = true;
    else if (a === '--no-reverify') opts.noReverify = true;
    else if (a === '--strict') opts.strict = true;
    else if (a.startsWith('-')) die(`unknown flag: ${a}`);
    else positional.push(a);
  }
  return { opts, positional };
}

function isAutoSafe(check) {
  const rem = check.remediation || {};
  if (typeof rem.autoSafe === 'boolean') return rem.autoSafe;
  return ['provision', 'sync', 'host-pack-refresh'].includes(rem.action);
}

function loadLatest(root) {
  const p = path.join(root, '.harness', 'diagnostics', 'latest.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function syncWorkflowGuide(root, dryRun) {
  const src = path.join(ESO_ROOT, 'profiles', 'templates', 'WORKFLOW_GUIDE.md');
  const dest = path.join(root, '.harness', 'WORKFLOW_GUIDE.md');
  if (!fs.existsSync(src)) return { ok: false, detail: `template missing: ${src}` };
  if (dryRun) return { ok: true, detail: `dry-run: would copy WORKFLOW_GUIDE → ${dest}` };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return { ok: true, detail: `synced WORKFLOW_GUIDE.md` };
}

function syncSessionDirs(root, dryRun) {
  const dirs = ['.cursor/session', '.agents/session'];
  if (dryRun) return { ok: true, detail: `dry-run: would mkdir ${dirs.join(', ')}` };
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return { ok: true, detail: `ensured session dirs` };
}

function runHostPackRefresh(root, dryRun) {
  const cli = path.join(ESO_ROOT, 'packages', 'harness-cli', 'src', 'cli.mjs');
  if (dryRun) return { ok: true, detail: `dry-run: would host-pack refresh ${root}` };
  const r = spawnSync(process.execPath, [cli, 'host-pack', 'refresh', root], {
    cwd: ESO_ROOT,
    encoding: 'utf8',
  });
  return {
    ok: r.status === 0,
    detail: r.status === 0 ? 'host-pack refresh ok' : `host-pack refresh exit ${r.status}: ${(r.stderr || r.stdout || '').slice(0, 400)}`,
  };
}

function runProvision(consumerId, force, dryRun) {
  const script = path.join(ESO_ROOT, 'provision.sh');
  if (!fs.existsSync(script)) return { ok: false, detail: 'provision.sh missing' };
  if (dryRun) {
    return {
      ok: true,
      detail: `dry-run: would ./provision.sh ${consumerId}${force ? ' --force' : ''} --host-mode dual-ide`,
    };
  }
  const args = [script, consumerId, '--host-mode', 'dual-ide'];
  if (force) args.push('--force');
  const r = spawnSync('bash', args, { cwd: ESO_ROOT, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    detail:
      r.status === 0
        ? `provision ${consumerId} ok`
        : `provision exit ${r.status}: ${(r.stderr || r.stdout || '').slice(-500)}`,
  };
}

function applySafe(root, consumerId, fails, opts) {
  const applied = [];
  const skipped = [];
  let needProvision = false;
  let needHostPack = false;
  let needWorkflow = false;
  let needSessions = false;

  for (const c of fails) {
    if (!isAutoSafe(c)) {
      skipped.push(c);
      continue;
    }
    const action = c.remediation?.action;
    if (action === 'provision') needProvision = true;
    else if (action === 'host-pack-refresh') needHostPack = true;
    else if (action === 'sync') {
      if (c.id === 'T1.1') needWorkflow = true;
      else if (c.id === 'T1.2') needSessions = true;
      else if ((c.remediation?.hint || '').includes('WORKFLOW')) needWorkflow = true;
      else if ((c.remediation?.hint || '').includes('session')) needSessions = true;
      else skipped.push({ ...c, note: 'unknown sync target — left for OPEN_FIXES' });
    } else skipped.push(c);
  }

  // Deduplicate: provision covers most T0; still allow host-pack refresh if only T0.4
  if (needProvision && !opts.noProvision) {
    const r = runProvision(consumerId, opts.forceProvision, opts.dryRun);
    applied.push({ action: 'provision', checks: fails.filter((f) => f.remediation?.action === 'provision').map((f) => f.id), ...r });
  } else if (needProvision && opts.noProvision) {
    skipped.push(...fails.filter((f) => f.remediation?.action === 'provision'));
  }

  if (needHostPack && (!needProvision || opts.noProvision)) {
    const r = runHostPackRefresh(root, opts.dryRun);
    applied.push({ action: 'host-pack-refresh', checks: ['T0.4'], ...r });
  }

  if (needWorkflow) {
    const r = syncWorkflowGuide(root, opts.dryRun);
    applied.push({ action: 'sync-workflow-guide', checks: ['T1.1'], ...r });
  }
  if (needSessions) {
    const r = syncSessionDirs(root, opts.dryRun);
    applied.push({ action: 'sync-session-dirs', checks: ['T1.2'], ...r });
  }

  return { applied, openDocs: skipped.filter((s) => !isAutoSafe(s) || s.note) };
}

function writeOpenFixes(root, openDocs, dryRun) {
  const dir = path.join(root, '.harness', 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    '# OPEN_FIXES — domain / docs remediations (not auto-applied)',
    '',
    '> Generated by `harnessctl fix consumer`. **Do not** copy baplatform ABP/Jira rules.',
    '> Consumer (FinESO / x79 / …) must author these artifacts itself.',
    '',
  ];
  if (!openDocs.length) {
    lines.push('_No open docs remediations._');
  } else {
    for (const c of openDocs) {
      lines.push(`## ${c.id} — ${c.title}`);
      lines.push(`- severity: ${c.severity}`);
      lines.push(`- action: \`${c.remediation?.action || 'docs'}\``);
      lines.push(`- hint: ${c.remediation?.hint || c.note || 'n/a'}`);
      lines.push('');
    }
  }
  const body = lines.join('\n') + '\n';
  const dest = path.join(dir, 'OPEN_FIXES.md');
  if (dryRun) return { path: dest, dryRun: true, count: openDocs.length };
  fs.writeFileSync(dest, body);
  return { path: dest, dryRun: false, count: openDocs.length };
}

/**
 * @param {string[]} argv after `fix consumer`
 */
export function runFixConsumer(argv) {
  const { opts, positional } = parse(argv);
  if (positional[0] === 'help') {
    console.log(`usage: harnessctl fix consumer <path|--project <id>> [--dry-run] [--from-latest] [--force-provision] [--no-provision] [--no-reverify] [--strict] [--json]`);
    process.exit(0);
  }
  const root = resolveConsumer(opts, positional[0] || null);
  if (!fs.existsSync(root)) die(`consumer path not found: ${root}`);

  let before;
  if (opts.fromLatest) {
    before = loadLatest(root);
    if (!before) die('no .harness/diagnostics/latest.json — run verify first or omit --from-latest');
  } else {
    before = diagnoseConsumer(root);
    writeDiagnostics(root, null, before);
  }

  const fails = (before.checks || []).filter((c) => c.status === 'FAIL');
  const { applied, openDocs } = applySafe(root, before.consumerId, fails, opts);
  const openFile = writeOpenFixes(root, openDocs, opts.dryRun);

  let after = null;
  if (!opts.noReverify && !opts.dryRun) {
    after = diagnoseConsumer(root);
    writeDiagnostics(root, null, after);
  }

  const result = {
    ok: after ? after.summary.criticalFail === 0 : before.summary.criticalFail === 0,
    consumerId: before.consumerId,
    consumerRoot: root,
    dryRun: opts.dryRun,
    before: { tierReached: before.summary.tierReached, criticalFail: before.summary.criticalFail, fail: before.summary.fail },
    after: after
      ? { tierReached: after.summary.tierReached, criticalFail: after.summary.criticalFail, fail: after.summary.fail }
      : null,
    applied,
    openFixes: openFile,
    openDocsCount: openDocs.length,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`fix-consumer  ${result.consumerId}${opts.dryRun ? '  [DRY-RUN]' : ''}`);
    console.log(`  before        tier=${result.before.tierReached} critical=${result.before.criticalFail} fail=${result.before.fail}`);
    for (const a of applied) {
      console.log(`  ${a.ok ? 'APPLIED' : 'FAILED '}  [${a.action}] ${a.detail}`);
    }
    console.log(`  OPEN_FIXES    ${openFile.path} (${openFile.count} item(s))`);
    if (after) {
      console.log(`  after         tier=${result.after.tierReached} critical=${result.after.criticalFail} fail=${result.after.fail}`);
      console.log(`  diagnostics   ${path.join(root, '.harness', 'diagnostics', 'latest.md')}`);
    }
  }

  const criticalLeft = after ? after.summary.criticalFail : before.summary.criticalFail;
  const warnLeft =
    opts.strict &&
    (after || before).checks.some((c) => c.status === 'FAIL' && (c.severity === 'WARN' || c.severity === 'INFO'));
  // under --strict, remaining OPEN docs (WARN+) also fail
  const openBlocksStrict = opts.strict && openDocs.length > 0 && !opts.dryRun;
  process.exit(criticalLeft > 0 || warnLeft || openBlocksStrict ? 1 : 0);
}
