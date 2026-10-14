-- Shell is a second write channel, and two derived tables were built without it.
--
-- `request_file` classified a tool as read/edit by name, and `actionOf('Shell')` is `'shell'` — never
-- `'edit'`. So a `cat > protected/file.md` was recorded as a **read** of that file. Measured on x79:
-- one turn wrote 7 protected files (`sdlc/…`, `backend/mu-fusion/package.json`) through Shell and every
-- one landed with `edits = 0`.
--
-- `check_result` then reported "no protected path was edited", because it filtered on the
-- `afterFileEdit` event, which the pack does not wire — so it could not see a write through *either*
-- channel. The verdict was not merely unhelpful: it asserted that nothing protected had been touched
-- while the files were on disk.
--
-- Both are derived, so they are cleared here and rebuilt on the next pass by the corrected code. That
-- pass is a full one by construction: `changed` is true whenever migrations ran.
DELETE FROM request_file;
DELETE FROM check_result;
