/**
 * PostgreSQL Row-Level Security (RLS) Generator and Simulation for ESO Knowledge
 * Enforces project isolation according to D-22, D-82, and 02.schema.md.
 */

export function createProjectTableSql(tableName = 'eso_knowledge') {
  return `
CREATE TABLE IF NOT EXISTS ${tableName} (\n    id VARCHAR(255) PRIMARY KEY,\n    project VARCHAR(100),\n    zone VARCHAR(50) NOT NULL DEFAULT 'project',\n    content JSONB NOT NULL DEFAULT '{}'::jsonb,\n    owner VARCHAR(255),\n    approved_by_human BOOLEAN NOT NULL DEFAULT FALSE,\n    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;\nALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY;\n`.trim();
}

export function createRlsPolicySql(tableName = 'eso_knowledge', column = 'project') {
  const policyName = `rls_${tableName}_isolation`;
  return `
CREATE POLICY ${policyName} ON ${tableName}\nFOR ALL\nUSING (\n    zone IN ('shared', 'pool')\n    OR ${column} = COALESCE(current_setting('eso.project', true), current_setting('eso.current_project', true))\n);\n`.trim();
}

export function setEsoProject(session, project) {
  if (!session || typeof session !== 'object') {
    session = {};
  }
  session['eso.project'] = project;
  session['eso.current_project'] = project;
  return session;
}

export function filterByProject(rows = [], project) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => {
    if (row.zone === 'shared' || row.zone === 'pool') {
      return true;
    }
    return row.project === project;
  });
}
