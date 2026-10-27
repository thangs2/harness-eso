-- 001_graph.sql — W1-1: the code-graph schema, its isolation, and the denominator for coverage.
--
-- Packet: sdlc/09.wbs/09.packets/01.bip-w1-1.md (§5, §6). Every invariant in that packet lives in
-- this file or nowhere: the extractor will be rewritten many times, this will not.
--
-- Postgres, not SQLite: two of the invariants are row-level security and a trigger that refuses
-- UPDATE, and neither exists in the SQLite database the observe server uses for turns.
--
-- Idempotent: running it twice must leave the schema unchanged (packet §4).

CREATE TABLE IF NOT EXISTS manifest_entry (
    project      text        NOT NULL,
    build_id     text        NOT NULL,
    kind         text        NOT NULL,
    logical_id   text        NOT NULL,
    path         text        NOT NULL,
    at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, build_id, kind, logical_id)
);

-- What exists according to the compiler. Never written by the extractor: a denominator the
-- numerator can edit measures nothing.
COMMENT ON TABLE manifest_entry IS
    'Truth set for coverage: one row per symbol the build produced. Written by the manifest job only.';

CREATE TABLE IF NOT EXISTS graph_node (
    project     text NOT NULL,
    build_id    text NOT NULL,
    kind        text NOT NULL,
    logical_id  text NOT NULL,
    path        text NOT NULL,
    PRIMARY KEY (project, build_id, kind, logical_id),
    CONSTRAINT graph_node_path_not_empty CHECK (path <> '')
);

CREATE TABLE IF NOT EXISTS graph_edge (
    project     text    NOT NULL,
    build_id    text    NOT NULL,
    src         text    NOT NULL,
    kind        text    NOT NULL,
    dst         text    NOT NULL,
    conflict    boolean NOT NULL DEFAULT false,
    PRIMARY KEY (project, build_id, kind, src, dst),
    CONSTRAINT graph_edge_kind_closed CHECK (kind IN (
        'references', 'calls', 'implements', 'inherits', 'maps_to', 'reads', 'writes'
    ))
);

COMMENT ON COLUMN graph_edge.conflict IS
    'True when two source_claim rows disagree (D-57). Conflict is a property of the edge; it is NOT a deduction from completeness.';

-- The only place a source is kept. No parallel array column: a copy updated by overwriting cannot
-- stay in step with an append-only table, and the drift would be silent.
CREATE TABLE IF NOT EXISTS source_claim (
    id          bigserial   PRIMARY KEY,
    project     text        NOT NULL,
    build_id    text        NOT NULL,
    edge_src    text        NOT NULL,
    edge_kind   text        NOT NULL,
    edge_dst    text        NOT NULL,
    source_kind text        NOT NULL,
    claim       text        NOT NULL,
    at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_claim_edge_idx
    ON source_claim (project, build_id, edge_kind, edge_src, edge_dst);

-- BR-06: a record that can be edited is not a record.
CREATE OR REPLACE FUNCTION source_claim_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'source_claim is append-only (BR-06): % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS source_claim_no_update ON source_claim;
CREATE TRIGGER source_claim_no_update
    BEFORE UPDATE OR DELETE ON source_claim
    FOR EACH ROW EXECUTE FUNCTION source_claim_append_only();

-- completeness is a function of a question, not a number per project (19 §3, OPEN-1):
--   completeness(Q) = min { coverage(kind) : kind in K(Q) }
-- value and per_kind are computed; NULL here means "not measured", which is not the same as zero.
CREATE TABLE IF NOT EXISTS completeness (
    project      text        NOT NULL,
    build_id     text        NOT NULL,
    question     text        NOT NULL,
    per_kind     jsonb       NOT NULL,
    value        double precision NOT NULL,
    measured_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project, build_id, question),
    CONSTRAINT completeness_value_range CHECK (value >= 0 AND value <= 1)
);

COMMENT ON COLUMN completeness.value IS
    'min(coverage(kind)) over K(question). Denominator from manifest_entry of the same build_id. Conflict does not reduce this (D-57).';

-- --------------------------------------------------------------------------
-- Isolation. W5-9 owns the visibility rule; this is only the floor every table needs now,
-- because adding a project column later is a migration that rewrites data.
-- --------------------------------------------------------------------------

ALTER TABLE manifest_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_node     ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_edge     ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_claim   ENABLE ROW LEVEL SECURITY;
ALTER TABLE completeness   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['manifest_entry','graph_node','graph_edge','source_claim','completeness'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = t || '_project_isolation'
        ) THEN
            EXECUTE format(
                'CREATE POLICY %I ON %I USING (project = current_setting(''eso.project'', true)) WITH CHECK (project = current_setting(''eso.project'', true))',
                t || '_project_isolation', t
            );
        END IF;
    END LOOP;
END $$;
