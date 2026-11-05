/**
 * @mu/eso-iam — Schema & DDL for Workers, Roles, Verbs, Role Scope, Attributes & Policies (DM-WORKER, DM-ROLE, DM-VERB, DM-ROLE-SCOPE, DM-ATTRIBUTE-DEF, DM-POLICY / ESO-186)
 */

export const CLOSED_VERBS = Object.freeze([
  'read',
  'write',
  'append',
  'approve',
  'configure',
  'handoff',
]);

/**
 * Ranking of evidence basis values used by a role bar (`bar[].min_basis`).
 *
 * Two vocabularies live in the tree: the IAM role basis {unverified, partial, full, strict}
 * and the evidence basis {assumption, heuristic, deterministic}. The control-plane handover
 * check (eso/control-plane/src/modules/flow/domain/flow.ts) already ranks both on one scale;
 * IAM role sufficiency must rank them identically or the same bar means two different things
 * depending on which path evaluates it.
 */
export const BASIS_RANK = Object.freeze({
  unverified: 0,
  none: 0,
  assumption: 1,
  partial: 1,
  heuristic: 2,
  full: 2,
  deterministic: 3,
  strict: 3,
});

export const CLOSED_ATTRIBUTES = Object.freeze([
  'project',
  'path',
  'harness_source',
  'risk_kind',
  'stage',
]);

export const VERB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS verb (
  name TEXT PRIMARY KEY
);
`;

export const ATTRIBUTE_DEF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS attribute_def (
  name TEXT PRIMARY KEY
);
`;

export const ROLE_SCOPE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS role_scope (
  project      TEXT NOT NULL,
  role_name    TEXT NOT NULL,
  role_version INTEGER NOT NULL,
  verb         TEXT NOT NULL REFERENCES verb (name),
  kind         TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (project, role_name, role_version, verb, kind, value),
  FOREIGN KEY (project, role_name, role_version) REFERENCES role (project, name, version)
);
`;

export const WORKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker (
  project        TEXT NOT NULL,
  worker_id      TEXT NOT NULL,
  role_name      TEXT NOT NULL,
  harness_source TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('declared','active','paused','retired')),
  PRIMARY KEY (project, worker_id)
);
`;

export const ROLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS role (
  project      TEXT NOT NULL,
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  capabilities TEXT NOT NULL,
  bar          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('current', 'superseded')),
  PRIMARY KEY (project, name, version)
);
`;

export const POLICY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS policy (
  project    TEXT NOT NULL,
  policy_id  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  attribute  TEXT NOT NULL REFERENCES attribute_def (name),
  operator   TEXT NOT NULL CHECK (operator IN ('eq', 'starts_with', 'in')),
  value      TEXT NOT NULL,
  effect     TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  subjects   TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('current', 'superseded', 'deleted')),
  PRIMARY KEY (project, policy_id, version)
);
`;

export const CAPABILITY_PIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS capability_pin (
  project         TEXT NOT NULL,
  capability_kind TEXT NOT NULL,
  pinned_branch   TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (project, capability_kind)
);
`;

export const PROVIDER_AUDIT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provider_audit (
  project     TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  capability  TEXT NOT NULL,
  branch      TEXT NOT NULL,
  provider_id TEXT,
  guarantee   TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  history     TEXT NOT NULL DEFAULT '[]',
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project, turn_id, capability)
);
`;

export async function initIamSchema(db) {
  await db.exec(VERB_SCHEMA_SQL);
  await db.exec(ATTRIBUTE_DEF_SCHEMA_SQL);
  await db.exec(ROLE_SCHEMA_SQL);
  await db.exec(ROLE_SCOPE_SCHEMA_SQL);
  await db.exec(WORKER_SCHEMA_SQL);
  await db.exec(POLICY_SCHEMA_SQL);
  await db.exec(CAPABILITY_PIN_SCHEMA_SQL);
  await db.exec(PROVIDER_AUDIT_SCHEMA_SQL);

  // Seed closed verbs
  for (const v of CLOSED_VERBS) {
    await db.run(`INSERT INTO verb (name) VALUES (?) ON CONFLICT (name) DO NOTHING`, [v]);
  }

  // Seed closed attributes
  for (const a of CLOSED_ATTRIBUTES) {
    await db.run(`INSERT INTO attribute_def (name) VALUES (?) ON CONFLICT (name) DO NOTHING`, [a]);
  }
}
