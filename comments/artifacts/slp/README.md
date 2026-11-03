# `comments/artifacts/slp/` — evidence channels of the 7 SLP workers

**Not documentation.** Per [`../README.md`](../README.md): a file here records **what happened in one session**, including the
agent's own mistakes. If a file here and the code disagree, the code is right.

Each worker of the SLP loop writes to **one** directory, and no two workers share one — that is what
`core.slp.mdc` §2 means by `allowed_files` being disjoint, and `qc/slp-conformance.test.mjs` checks it pairwise.

| Directory | Writer | What lands there |
|---|---|---|
| [`recon/`](recon/README.md) | `scout` | context pack of one ticket: domains, invariants, touched files, open gaps, risks (≤300 words) |
| [`plan/`](plan/README.md) | `plan` | the slice table: `id` · `role` · `ac[]` · `inv[]` · `allowed_files[]` · `depends_on[]` · `verify` |
| [`verify/`](verify/README.md) | `verify` | the **verbatim** output of the commands it ran, plus the exit code |
| [`audit/`](audit/README.md) | `audit` | verdict, score 0–100, `critical[]`, `findings[{file,line,rule,fix}]`, AC coverage |

`build` and `qc` do not write here: `build` writes `packages/`, `qc` writes `qc/`. `fixbug` writes **nothing of its own** — it may
only touch the files named by `audit.findings[]` inside the failing slice.

**Retention.** These files exist to be read once, during the review of the ticket that produced them. Delete the folder of a
ticket once that review is closed; the code, the ticket and the tests are the record that stays.
