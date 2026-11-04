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

export function initIamSchema(db) {
  db.exec(VERB_SCHEMA_SQL);
  db.exec(ATTRIBUTE_DEF_SCHEMA_SQL);
  db.exec(ROLE_SCHEMA_SQL);
  db.exec(ROLE_SCOPE_SCHEMA_SQL);
  db.exec(WORKER_SCHEMA_SQL);
  db.exec(POLICY_SCHEMA_SQL);

  // Seed closed verbs
  for (const v of CLOSED_VERBS) {
    db.run?.(`INSERT OR IGNORE INTO verb (name) VALUES (?)`, [v]) ||
    db.exec(`INSERT OR IGNORE INTO verb (name) VALUES ('${v}')`);
  }

  // Seed closed attributes
  for (const a of CLOSED_ATTRIBUTES) {
    db.run?.(`INSERT OR IGNORE INTO attribute_def (name) VALUES (?)`, [a]) ||
    db.exec(`INSERT OR IGNORE INTO attribute_def (name) VALUES ('${a}')`);
  }
}
