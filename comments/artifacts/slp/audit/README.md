# `audit/` — written by `audit`

One file per pass: `<KEY>-<timestamp>.json`.

Shape: `{ verdict, score, critical[], findings[{file,line,rule,fix}], ac_coverage{} }`.

`AUDIT_PASS` requires `score >= 85` **and** `critical` empty. `findings[].file` is what gives `fixbug` a write surface at all —
without it, `fixbug` has no business touching a file.
