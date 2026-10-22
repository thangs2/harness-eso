#!/usr/bin/env node
/**
 * `harnessctl fix consumer` — semi-auto remediations from maturity diagnostic.
 *
 * AUTO-SAFE: sync WORKFLOW_GUIDE, mkdir session dirs, host-pack refresh, optional provision,
 *   append Agent Zone path line to docgraph.scope (T3.4) when manifests dir exists.
 * NEVER auto: context-contract, agent-manifests *content*, eso-coverage body, jira, domain rules
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

/**
 * The operator-facing docs a consumer is seeded with. `fix` refreshes all of them, not only the guide:
 * a checklist that describes a `diagnostics.sh` from an older release is worse than one that says
 * nothing, because the operator follows it and the commands do not match.
 */
const CONSUMER_DOCS = [
  { src: ['WORKFLOW_GUIDE.md'], rel: '.harness/WORKFLOW_GUIDE.md', exec: false },
  { src: ['ONBOARDING.md'], rel: '.harness/ONBOARDING.md', exec: false },
  { src: ['diagnostics.sh'], rel: '.harness/diagnostics.sh', exec: true },
];

function syncWorkflowGuide(root, dryRun) {
  const synced = [];
  const missing = [];
  for (const doc of CONSUMER_DOCS) {
    const src = path.join(ESO_ROOT, 'profiles', 'templates', ...doc.src);
    if (!fs.existsSync(src)) {
      missing.push(doc.rel);
      continue;
    }
    synced.push(doc);
  }
  if (!synced.length) return { ok: false, detail: `templates missing: ${missing.join(', ')}` };
  if (dryRun) {
    return { ok: true, detail: `dry-run: would copy ${synced.map((d) => d.rel).join(', ')}` };
  }
  for (const doc of synced) {
    const dest = path.join(root, doc.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ESO_ROOT, 'profiles', 'templates', ...doc.src), dest);
    if (doc.exec) {
      try {
        fs.chmodSync(dest, 0o755);
      } catch {
        /* Windows: file modes are not the entrypoint */
      }
    }
  }
  const detail = `synced ${synced.map((d) => d.rel.split('/').pop()).join(', ')}`;
  return { ok: true, detail: missing.length ? `${detail} (missing: ${missing.join(', ')})` : detail, synced: synced.map((d) => d.rel) };
}

/**
 * Refresh only the docs an operator reads, without touching policy, hooks or session dirs.
 *
 * `harnessctl fix consumer` derives its work from failing maturity checks, so a consumer whose T1.1
 * passes never picks up a newer checklist or a newer `diagnostics.sh`. Those two files are how the
 * operator finds out what changed, so they have to be refreshable on their own — and that is the only
 * reason this action exists.
 */
export function syncConsumerDocs(root, { dryRun = false } = {}) {
  return syncWorkflowGuide(root, dryRun);
}

function syncSessionDirs(root, dryRun) {
  const dirs = ['.cursor/session', '.agents/session'];
  if (dryRun) return { ok: true, detail: `dry-run: would mkdir ${dirs.join(', ')}` };
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return { ok: true, detail: `ensured session dirs` };
}

/** Mechanism-only: ensure docgraph.scope declares Agent Zone path (does not author specs). */
function ensureDocgraphAgentZoneScope(root, dryRun) {
  const scopeRel = 'docgraph.scope';
  const scopePath = path.join(root, scopeRel);
  if (!fs.existsSync(scopePath)) {
    return { ok: false, detail: 'docgraph.scope missing — author T2.1 first (OPEN)' };
  }
  const text = fs.readFileSync(scopePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const trimmed = lines.map((l) => l.trim());
  const patterns = ['path:sdlc/00.agent-manifests', 'path:SDLC/00.agent-manifests'];
  if (patterns.some((p) => trimmed.some((l) => l === p || l.startsWith(p)))) {
    return { ok: true, detail: 'docgraph.scope already lists Agent Zone path' };
  }

  let pathLine = null;
  if (fs.existsSync(path.join(root, 'SDLC', '00.agent-manifests'))) {
    pathLine = 'path:SDLC/00.agent-manifests';
  } else if (fs.existsSync(path.join(root, 'sdlc', '00.agent-manifests'))) {
    pathLine = 'path:sdlc/00.agent-manifests';
  } else {
    return {
      ok: false,
      detail: 'no sdlc|SDLC/00.agent-manifests dir — create Agent Zone (T3.2) first (OPEN)',
    };
  }

  const block = [
    '',
    '# --- Agent Zone (high-density normative specs for AI / ESO Preflight) --------',
    pathLine,
    '',
  ].join('\n');

  // Prefer insert before Human Zone path:sdlc / path:SDLC; else after last ext: line; else prepend.
  let insertAt = -1;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === 'path:sdlc' || trimmed[i] === 'path:SDLC') {
      insertAt = i;
      break;
    }
  }
  if (insertAt < 0) {
    for (let i = trimmed.length - 1; i >= 0; i -= 1) {
      if (trimmed[i].startsWith('ext:')) {
        insertAt = i + 1;
        break;
      }
    }
  }
  if (insertAt < 0) insertAt = 0;

  const next = [...lines.slice(0, insertAt), ...block.split('\n'), ...lines.slice(insertAt)];
  const body = next.join('\n').replace(/\n{3,}/g, '\n\n');
  if (dryRun) {
    return { ok: true, detail: `dry-run: would insert ${pathLine} into ${scopeRel}` };
  }
  fs.writeFileSync(scopePath, body.endsWith('\n') ? body : `${body}\n`);
  return { ok: true, detail: `appended ${pathLine} to ${scopeRel}` };
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
  let needDocgraphAgentZone = false;

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
      else if (c.id === 'T3.4') needDocgraphAgentZone = true;
      else if ((c.remediation?.hint || '').includes('WORKFLOW')) needWorkflow = true;
      else if ((c.remediation?.hint || '').includes('session')) needSessions = true;
      else if ((c.remediation?.hint || '').includes('Agent Zone')) needDocgraphAgentZone = true;
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
  }  if (needSessions) {
    const r = syncSessionDirs(root, opts.dryRun);
    applied.push({ action: 'sync-session-dirs', checks: ['T1.2'], ...r });
  }
  if (needDocgraphAgentZone) {
    const r = ensureDocgraphAgentZoneScope(root, opts.dryRun);
    applied.push({ action: 'sync-docgraph-agent-zone', checks: ['T3.4'], ...r });
    if (!r.ok) {
      skipped.push({
        id: 'T3.4',
        title: 'docgraph.scope lists Agent Zone path',
        severity: 'WARN',
        remediation: {
          action: 'docs',
          hint: r.detail,
        },
        note: r.detail,
      });
    }
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
