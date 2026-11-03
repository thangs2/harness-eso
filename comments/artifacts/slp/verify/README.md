# `verify/` — written by `verify`

One file per pass: `<KEY>-<timestamp>.log`, holding the **verbatim** stdout/stderr and the real exit code of every command the
Task named.

Written because a summary ("42 pass") cannot be re-checked, and because `| tail` hides the exit code of the pipeline — the log is
the only thing that can settle "did this actually run, this session".
