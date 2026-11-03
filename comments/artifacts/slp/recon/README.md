# `recon/` — written by `scout`

One file per ticket: `<KEY>-<timestamp>.json`, the context pack the Lead handed to `plan`.

Shape: `{ key, domains[], inv[], touched_files[], open_gaps[], risks[] }` — ≤300 words, **no code**.

A pack is a claim about the repo at one moment. It is evidence, not a spec: when the ticket closes, delete it.
