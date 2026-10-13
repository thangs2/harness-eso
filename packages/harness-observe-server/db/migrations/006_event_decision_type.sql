-- 006_event_decision_type.sql — facade event type from route-hook trace (WP4)

ALTER TABLE event ADD COLUMN decision_event_type TEXT;

CREATE INDEX IF NOT EXISTS idx_event_decision_type
    ON event(project_id, decision_event_type)
    WHERE decision_event_type IS NOT NULL;
