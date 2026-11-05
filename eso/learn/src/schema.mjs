/**
 * @mu/eso-learn — Schema & DDL for Proposals (DM-PROPOSAL / ESO-150)
 */

export const PROPOSAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS proposal (
  project         TEXT NOT NULL,
  proposal_id     TEXT NOT NULL,
  version         INTEGER NOT NULL,
  risk_kind       TEXT NOT NULL,
  evidence        TEXT NOT NULL,
  expected_effect TEXT NOT NULL,
  revert          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('proposed', 'applied', 'reverted')),
  applied_at      TEXT,
  measure_window  TEXT,
  PRIMARY KEY (project, proposal_id, version)
);
`;

export async function initProposalSchema(db) {
  await db.exec(PROPOSAL_SCHEMA_SQL);
}
