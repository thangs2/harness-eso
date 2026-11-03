# `plan/` — written by `plan`

One file per ticket: `<KEY>-<timestamp>.json`, the slice table the Lead spawned `build` peers from.

Shape: `{ key, slices[{ id, role, ac[], inv[], allowed_files[], depends_on[], verify }] }`.

**Two slices whose `allowed_files` overlap make the plan invalid** — the file here is how a later reader checks whether the plan
that ran was the plan that was approved.
