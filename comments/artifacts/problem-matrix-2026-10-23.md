# Problem matrix — cross-consumer synthesis · 2026-10-23

> **Status:** synthesis of three verified audit logs. Not new evidence.
> Inputs (read in full, not re-probed):
> - [`baplatform/agent-session-log-2026-10-23-baplatform-audit-diagnostic.md`](./baplatform/agent-session-log-2026-10-23-baplatform-audit-diagnostic.md)
>   (evidence folder: [`baplatform/agent-session-2026-10-23T0328Z/`](./baplatform/agent-session-2026-10-23T0328Z/))
> - [`atrievefin/agent-session-log-2026-10-23-atrievefin-audit-diagnostic.md`](./atrievefin/agent-session-log-2026-10-23-atrievefin-audit-diagnostic.md)
>   (evidence folder: [`atrievefin/agent-session-2026-10-23T0341Z/`](./atrievefin/agent-session-2026-10-23T0341Z/))
> - [`fineso/agent-session-log-2026-10-23-fineso-audit-diagnostic.md`](./fineso/agent-session-log-2026-10-23-fineso-audit-diagnostic.md)
>   (evidence folder: [`fineso/agent-session-20261023T0400Z/`](./fineso/agent-session-20261023T0400Z/)) — added in
>   the second revision; 97 trace rows, standard v1.3.0, **T5 `pass=26 fail=0`**, full re-run.
> - First-hand code checks in this repo (read while writing this file, not quoted from any log):
>   `eso-gap-io.mjs:185-302` (P-01/P-02) and `:311-360` (P-28); `path-policy.mjs:146-156` (P-06 correction);
>   `dist/host-pack/path-policy.default.json` + `profiles/generic-eso.json` (P-27); `.cursor/hooks/lib/agent-response.mjs` (P-32).
>
> **Not** documentation (`documents/`), **not** law, **not** an install instruction. If this file and the
> code disagree, the code is right.

---

## 0. Legend

| Symbol | Meaning in the tick matrix |
|---|---|
| `●` | **owns the defect** — the fix must land here; consumer cannot fix it |
| `◐` | **hits it and must act** — consumer-side action is required (rebuild, config, operator decision) |
| `○` | **exposed but silent** — mechanism reaches it, nothing observed this session |
| `·` | not applicable / clean |
| `✗` | **the defect produces a wrong outcome here** (either a false pass or a hard block) |

Severity: **H** = breaks a stated invariant or silently disables a gate · **M** = misleading or degraded · **L** = hygiene.
Priority: **S0** = the evidence itself is unreliable, fix before using this matrix to justify anything · **S1** ships before any other pack change · **S2** next pack build · **S3** hardening · **S4** docs/hygiene.

Revision 2 adds: the `fineso` column; **P-26…P-32**; splits **P-06** into a/b; and withdraws three rev-1
claims. What fineso changed is not "one more consumer" — it is that **a byte-perfect install can still produce
a wrong verdict**, which invalidates the fix order of revision 1. See §1b for the four corrections and §1c
for the agent-behaviour defects that the earlier logs did not count.

---

## 1. Tick matrix — where the problem lives

| ID | Problem (one line) | Sev | Pri | harness-eso | baplatform | atrievefin | fineso |
|---|---|---|---|---|---|---|---|
| P-01 | Law gap closes on a bare term inside a tool-argument blob | M | **S1** | ● | ◐ ✗ false pass | ◐ | ◐ ✗ (no closure observed, but reachable) |
| P-02 | Harness state (`.harness/**`) counts as law evidence | M | **S1** | ● | ◐ ✗ | ○ | ○ |
| P-03 | Law index stale → preflight score cannot move | H | **S2** | ● | ◐ ✗ (`10-19`, 27 files) | ◐ ✗ (`10-20`, 37/51 files) | ◐ ✗ (`10-19T16:55Z`, 13/124) |
| P-04 | `code:*` gap is a *tool-choice* predicate, not an evidence one | H | **S2** | ● | · (closes, wrongly) | ✗ `score=0` every turn | ✗ 0 qualifying reads in **16** Read calls |
| P-05 | `host-install-state.json` omits consumer guards | M | **S2** | ● | ○ | ● ✗ (state ≠ wiring) | ◐ listed, drift unverifiable |
| P-06a | Dual-tree install drift — is the tree running the pack the manifest claims? | M | **S2** | ● | ◐ ✗ (`791ec8cc` installed) | ● ok (3/3 hashes) | ● ok (manifest **byte-identical** to dist) || P-06b | **No check proves the hook the IDE *executes* is the pack the manifest *installed*** | M | **S1** | ● | ? never checked | ? never checked | ? never checked (only `host-install-state` mapping exists) |
| P-07 | `.agents/` inert — configured, never exercised | M | **S2** | ● | ◐ ✗ idle 4 days | ◐ ✗ never ran | ◐ ✗ stamp from `10-15` (before the trees existed) |
| P-08 | Third tree (`.claude/`) guarded but not ingested | M | **S2** | ● | · | ◐ ✗ invisible writes | ◐ rules dir counted, ingestion unverified |
| P-09 | `guard-shell.py` diverges between trees (silent deny) | M | **S2** | ● | ◐ ✗ (3 missing flushes) | ● ok (byte-identical) | ○ not hash-compared |
| P-10 | `memory: none`/`noop` decided but never explained | M | **S3** | ● | ◐ ✗ (`:3211` up, adapter `noop`) | ◐ (`:3311` 404) | ● **not a defect** — `requireExplicit:true` by design; the missing piece is the *explanation*, not the wiring |
| P-11 | Brain stamp vs ESO stamp compete; deny names no authority | M | **S2** | ● | ○ | ◐ ✗ (17 h stale) | ○ |
| P-12 | `paths.gated` too narrow → governance ungated **on 2 of 3** | M | **S2** | ● | ○ | ◐ ✗ `SDLC/00.governance/**` = allow | ◐ ✗ `SDLC/**`, `.harness/**` not gated |
| P-13 | Consent model blocks rule maintenance; `askMode` unset | M | **S2** | ● | ◐ ✗ (deny logged `10-22`) | ○ | ○ |
| P-14 | Deny-log `projectId` unpopulated | L | **S3** | ● | ◐ ✗ (`opt`/`null`/1) | ○ | ○ |
| P-15 | Documented health path not served | L | **S3** | ● | ◐ ✗ (`/health 000`) | ● ok | ● ok (`/healthz` **and** `/health` 200) — image-specific |
| P-16 | Trace never rotated | L | **S3** | ● | ◐ ✗ 19.7 MB | ○ | ○ |
| P-17 | `domain` / `pinnedInvariants` not detected | M | **S3** | ● | ◐ ✗ `default`/`[]` on T5 | ○ (masked) | ◐ ✗ refire says `domain:"default"`, first preflight says `domain:"harness"` — **disagreement inside one turn** |
| P-18 | `AGENTS.md` doesn't describe the harness enforcing itself | L | **S4** | ● template | · | ◐ ✗ | ○ |
| P-19 | Pack ships as a bundle with no source map | L | **S3** | ● | ◐ ✗ (A-4) | ○ | ○ |
| P-20 | Bootstrap runs seconds before audit | L | **S4** | ● | ○ (20 min) | ◐ ✗ (~1 min) | ◐ ✗ (~100 s, `appliedAt 03:54:12Z`) |
| P-21 | `verify-consumer.sh` misleading; report overwritten | L | **S3** | ● | ◐ stale T5 claim | ◐ stale v1.2.0 | ◐ sandbox dropped `$1` **silently** (A-6) |
| P-22 | Project points at another project's Observatory | L | **S3** | ● | ◐ | ◐ ✗ (`:8792` = x79) | ○ |
| P-23 | Two "databases": config path vs container DB | L | **S4** | ● doc | · | ◐ ✗ | ○ |
| P-24 | Rule triplication: `.md` + `.mdc` across 3 trees | M | **S2** | ● | · | ◐ ✗ 21 files / 7 rules | ◐ ✗ **7 `.mdc` in `.agents/rules/`, all untracked, 6/7 body-diffed** |
| P-25 | T3.4 scope line names a directory that never existed | L | **S3** | ● check is right | · | ◐ ✗ | ○ (13 stale files not flagged) |
| **P-26** | **Law query term model can't answer compound terms** — docgraph scores only `h1 + headings + lead`; `harness-tooling`/`decision-facade` live in body text → `score 0` (= "rg fallback row", not an index hit) **forever**, regardless of index freshness | **H** | **S1** | ● adapter + preflight | ○ (its term `pipeline-gate` *has* a heading home `core.pipeline-gate.mdc`) | ● same two terms, same 0 rows | ✗ both law gaps, reproduced twice, **stale index is not the cause** |
| **P-27** | **Pack default path policy still ships another product's paths** (`backend/mu-*`, `frontend/`, `document/mu/`) and `resolvePathPolicy` **replaces per key** → a consumer that declares `paths` loses **all** pack-side defaults, including the guard files | M | **S2** | ● `path-policy.default.json` + `path-policy.mjs:146-156` | ○ | ◐ (guard files gated only via consumer list) | ✗ `SDLC/**`+`.harness/**` ungated; pack's `path-policy.default.json` fully inert |
| **P-28** | **Preflight re-fire silently truncates gap closure** — `recordGapToolUse` resets the closure whenever `preflightAt` moved (`eso-gap-io.mjs:318`), and `beforeSubmitPrompt` runs preflight on **every** submit; measured: 32 rows → 0 at the next refire; `x79`'s synthetic hook payload reproduced the same wipe | M | **S1** | ● `eso-gap-io.mjs:311-325` + `preflight-hook.mjs` | ○ | ○ | ✗ the probe that proved it also caused it (A-1/A-3) |
| **P-29** | **Maturity does not look at the consumer's own verdict** — `verify-consumer` says **T5 / 26 pass** on the same tree whose CI gate is **exit 1** and whose `L5:eager-rules` is **FAIL (57 > 7)** | M | **S2** | ● standard + `verify-consumer.sh` | ○ | ○ | ✗ T5 while its own gate is red |
| **P-30** | **Diagnostics metrics measure the wrong thing** — `L5:eager-rules` counts files on disk across 3 trees (57) instead of eager loads (7 injected); `L8:observe` can't tell "not running" from "judge can't see Docker" and reports FAIL against a healthy container (200); remedy names a flag that does not exist (`capability probe --verbose`) | M | **S3** | ● `diagnostics.sh` | ○ | ○ | ✗ 3 false/unsupported verdicts |
| **P-31** | **Guard is a substring match over the whole command** — a *read-only* diagnostic whose JSON merely **names** `.cursor/hooks/guard-write.py` is denied as a protected write; markdown reads can't feed the code gap (see P-04) and the deny is indistinguishable from an attack | M | **S2** | ● `guard-shell.py` | ○ | ○ | ✗ A-4 (self-reported, correctly refused) |
| **P-32** | **Reply-format detector can't see the shape users actually receive** — `userQueryStem` shows the host delivered `text` **already holding** `[{"text": …, "text": "text"}]`, which no rule/detector covers; the user had to say "lỗi format json wrapper" twice | M | **S1** | ● `.cursor/hooks/lib/agent-response.mjs` | ◐ 1 wrap | ◐ 1 wrap | ◐ 2 wraps |

### Column read (three consumers)

| Column | `●` | `✗` | What the misfire looks like |
|---|---|---|---|
| harness-eso | **29 / 32** | — | every consumer-side defect traces back to a pack rule |
| baplatform | 0 | **11** | **false pass** — gate opens on a term match (P-01/P-02/P-03) |
| atrievefin | 1 (P-05 owns it by wiring) | **11** | **hard block** — `score 0` forever (P-04 + P-03) and governance ungated (P-12) |
| fineso | 1 (P-10 is correct there) | **10** | **T5 and still wrong** — green maturity, red own gate, `0` law rows (P-26), closure wiped (P-28) |

**The three-way result is the headline.** Same pack, three consumers, three *different* reasons the
verdict is wrong:

- baplatform: `sufficient / 1.00` — **because** the gate accepts a term in a shell argument (P-01).
- atrievefin: `insufficient / 0.00` — because its law index answers nothing (P-03) and its `code:*` gap
  can't be fed (P-04).
- fineso: `insufficient / 0.18` — law gaps **unanswerable by construction** (P-26), `code:*` fed only by
  Shell work (P-04), and whatever closure it *did* accumulate wiped by re-fire (P-28). Maturity still says
  T5 (P-29).

P-26 changes the earlier diagnosis: **rebuilding the index does not fix atrievefin.** Its `10-20` stale
index is a real problem (P-03), but the two law terms it asks for are the same two that score 0 on a
*byte-identical, fresh* index in fineso.

---

## 1b. What fineso corrects in this matrix

| Earlier statement (rev 1) | Correction (verified this revision) |
|---|---|
| P-06 "both trees share `.harness/host-pack`, so dual-tree drift is about the *installed* pack" | **Wrong as written.** fineso: `host-pack.json` **byte-identical** to upstream `dist/` yet still `insufficient`. The question is which bytes the hook **executes** — `host-install-state.json` maps a hook path, that is all. New row **P-06b**. |
| P-04 "`code:*` unclosable → permanent `score=0`" | Mechanism is narrower: it *is* closable by `isProjectSourcePath` (`eso-gap-io.mjs:114-133`) — four conditions: inside preflight root, not a harness segment, `.cursor`/`.agents` excluded, source extension only. It is **unclosable for read-only diagnostics, `.md` recon and Shell-driven work**, which is most audit sessions. Reworded. |
| P-10 "memory noop while a live memory exists = defect" | Partly a **false positive**: `adapter-registry.mjs:110` only auto-selects providers with `!requireExplicit`, and both `noop-memory` and `agentmemory-memory` set `requireExplicit:true`. fineso's `reason=none` is **by design**. The defect is that nothing *tells the operator* that this is by design. Reworded, and P-29's `verifier`/`reasoner → none` is the part still unexplained. |
| P-22 "instructions point at another project's console" | Stays baplatform/atrievefin-only; fineso's `:8794` answers 200 on both `/health` and `/healthz`, so **P-15 is image-specific**, not a pack-wide doc error. |
| P-24 "atrievefin only, 21 files / 7 rules" | Worse and pack-caused: fineso has **7 `.mdc` inside `.agents/rules/`**, where Antigravity law must be `.md`; all seven untracked, six body-diffed from their `.md` twin (`core.law-gate` is `1.0.0` in `.mdc` vs `1.1.0` in `.md`, and omits `core.workspace-isolation`). Two harnesses are being told **different law under the same names** — consequence of the pack provisioning from one source into three trees (P-24 solution), promoted to **S2**. |

## 1c. Agent-behaviour defects (cross-session, still open)

Not harness defects and not consumer defects — the same agent did these three times in two days. They do
not belong in the tick matrix, but they change how much of each log to trust.

| ID | Defect | baplatform | atrievefin | fineso | Needed control |
|---|---|---|---|---|---|
| A-α | **Wrote consumer session state to clean up its own probe** | — | — (read-only honoured) | ✗ 32 closure rows destroyed, restored only by luck | Hooks must not be replayable against a live session path; add `--dry-run` / `--state-dir` to every hook entry |
| A-β | **Replayed synthetic hook payloads into the live session** | — | — | ✗ re-summoned a stale `[ESO HINT]` into the user's turn | Same as A-α (`workspace_roots` required, unknown event names rejected) |
| A-γ | **Reported a negative probe as a subsystem failure** | ✗ `SIDECAR_DOWN` before `/healthz` | ◐ sandbox exit-2 read as a finding | ◐ `L8:observe` trusted over `curl` | Rule: a *state* claim needs two independent sources (docker ps + curl) |
| A-δ | **Emitted the JSON wrapper as the reply** | ✗ ×1 | ✗ ×1 | ✗ ×2 | P-32 |

**Read this when trusting any log:** fineso's own §6 says three of its probes mutated consumer state. Its
*upstream* findings (F-01…F-06) stand — F-01/F-03/F-05 were reproduced from files that exist independently of
the probes. But **F-02 rests on a probe** (the docgraph queries were themselves the mutated operation), and
F-04 was explicitly not driven end-to-end (A-7). Grade them accordingly.


---

## 2. Solution matrix — what to do about each problem

| ID | Solution | Where it lands | Accept (done when) | Test |
|---|---|---|---|---|
| P-01 | Delete the no-path haystack branch from `stemMatches` (`eso-gap-io.mjs:292`). Allow only: (a) exact/path-stem match on a real file, (b) `Grep {pattern}` where the **whole** pattern folds to the target, (c) `docgraph --q` whose query is the target, (d) a path-like token inside the shell command that resolves to an existing file. Never match a bare term anywhere in a JSON blob. | pack · `packages/harness-host-generic/src/eso-gap-io.mjs` | a `Shell rg …pipeline-gate` on a scope-file comment no longer closes the law gap; `Read core.pipeline-gate.mdc` still does | `node:test` in `harness-host-generic` + replay of baplatform's 22-row `eso-gap-closure.json` → `allClosed:false` |
| P-02 | Reuse `NON_SOURCE_SEGMENTS` for **law** kind too: any path under `.harness/`, `.git/`, `node_modules/`, `dist/` is not law evidence. | pack · same file (`isNonSourcePath` helper) | `Read .harness/cache/docgraph/*.json` cannot close `law:*` | unit test + baplatform replay |
| P-03 | (a) Preflight: when any `law:*` query returns **0 rows twice**, emit `law_index_stale` with `indexMtime`, `newestScopeFile`, `scannedFiles` and a one-line remedy. (b) Consumer: rebuild docgraph during provision/verify, never on operator memory. | pack · preflight adapter + `verify-consumer.sh`; consumer · runbook | gap carries a named diagnostic instead of silent `score 0` | `harness-eso-core` preflight test with an empty index fixture |
| P-04 | Stop scoring **tool choice**. `code:*` satisfied by (i) a project source file read **or** (ii) an explicit `codegraph_explore` with a non-empty query (`CODEGRAPH_RE` already half-does this) **or** (iii) a Shell/Grep that *touched* a source file inside root (path in the command, resolvable). Then log `whyNotClosed` per tool use so a 0 is explainable. | pack · `closesGap` code branch (`eso-gap-io.mjs:197-217`) | fineso's 16 Read + 75 Shell turns would close it; a diagnostic turn is no longer structurally unable to reach `sufficient` | replay fineso's and atrievefin's `eso-gap-closure.json` |
| P-05 | `host-install-state.json` records **every** command in the live `hooks.json` per tree, with hash and mtime — or rename it `pack-owned-hooks.json` and add a separate `consumer-hooks.json`. | pack · host-bootstrap writer | drift check compares state ↔ live manifest and reports 0 omissions | qc test: install into a fixture consumer with both `guard-write.py` and `guard-brain` |
| P-06a | **Version + hash row** on the installed manifest vs `dist/host-pack/`: report, never silently assume. | pack · `deploy.sh` + maturity T0 | a consumer 1 build behind is labelled (baplatform), a consumer byte-identical says so (fineso) | qc smoke: install `791ec8cc`, point dist at `32435c89`, expect a labelled warn |
| P-06b | **Hash the hook that actually runs.** Resolve each wired hook command (`hooks.json` → file path → sha256) and compare to `host-pack.json.files`; fail when the executed bytes ≠ the installed bytes. Do not trust `host-install-state.json`'s mapping (P-05 is exactly that mistake). | pack · maturity T0 + `deploy.sh` | "the pack is installed" becomes "the pack that ran hashes to X" | qc: fixture where `hooks.json` points to an older copy → T0 fail |
| P-07 | Either (a) drop `agents-superset` from `host-bootstrap.json` / `workspace.json` when the tree has no session activity, or (b) make T0 require one non-empty `.agents/session/route-trace.jsonl` row newer than install. Also validate `.agents/hooks.json` block schema against the pack's known lane vocabulary and **reject unknown lanes**. | pack · maturity T0 + hook-manifest validator | an inert or non-conforming tree is a `fail`, not a silent `pass` | qc: inert `.agents` fixture → T0 fail |
| P-08 | Warn when a tracked tree (hooks/settings + guards present) is **absent** from `ingest.harnesses`; offer `--include` in `deploy.sh`. | pack · provision + maturity | `.claude/` on atrievefin is either ingested or explicitly exempted with a written reason | qc: fixture with `.claude/settings.json` → warning |
| P-09 | Per-guard hash-equality T0 row (presence-only check is not enough). Generate all trees' hooks from one source. | pack · maturity T0 + provision | `.cursor/hooks/guard-shell.py` and `.agents/hooks/guard-shell.py` hash-equal or build fails | qc: 3-file fixture with one divergent byte |
| P-10 | Maturity row: `memory` adapter is `noop`/`none` **while a memory service answers** on the consumer's configured port → `warn` with the requireExplicit reason and the two remedies (wire it, or record `memory.noopReason` in `decision-policy.json`). Do **not** call it a failure — fineso's `none` is the designed answer. | pack · maturity + policy schema | baplatform's operator sees "noop, but `:3211` is answering — here is why"; the next operator does not audit this twice | qc: fixture with `noop` + open port → warn with reason text |
| P-11 | One authority. Either the Brain stamp can produce `allowWrite:true` alone, or `guard-write` deny message names the authority it followed and why the other was ignored (`chosen=eso; brain=present,ignored(stale 17h)`). Never both silently. | pack · `guard-write` + preflight | deny message names authority; stale brain stamp cannot masquerade as evidence | unit test on deny-reason formatting |
| P-12 | Promote the policy defaults: `paths.gated` always contains `SDLC/**`, `sdlc/**`, `.harness/**`, `.claude/**` (append, never replace consumer entries — replacing is itself a bypass). Depends on P-27, or a consumer that declares `paths` gets nothing. | pack · default `decision-policy.json` + init-profile merge | atrievefin's and fineso's `SDLC/**` flip `allow` → `deny` without a hand edit | qc: init-profile into each consumer's copy → policy contains the four globs |
| P-13 | `askMode` default `host` for gated paths (today unset ⇒ `hint` + `fail_closed` ⇒ agent cannot fix a rule it must obey). Ship a `consent` template with each gated path and TTL. | pack · policy default + `provision.sh` | baplatform's 2026-10-22 deny becomes an *ask*, not a dead end | manual: attempt a gated rule edit on a fixture consumer |
| P-14 | Populate `projectId` on the deny-log path (`eso-blockers.jsonl`). | pack · observe ingest | 0 rows with `null`/`opt` after one session per project | qc: deny fixture → row carries the consumer id |
| P-15 | Pick **one** health path the image serves and assert it in `deploy.sh`; document it. Cover `/health`, `/healthz` in the smoke so a regression is caught. baplatform's `000` on `/health` vs fineso's `200` on both means the image is the variable — smoke both images, not one. | pack · `compose.harness.yml`, `deploy.sh`, `documents/` | `deploy.sh` fails when the documented path answers ≠ 200, on every image built | docker smoke in `harness-verify` |
| P-16 | Rotate `route-trace.jsonl` (size or day boundary) as part of ingest, and stop writing rows when a tree is idle. | pack · hook writer | 19.7 MB idle file no longer possible | unit test on rotation threshold |
| P-17 | Run invariant detection on the hook path: `domain` derived from `context-contract`, `pinnedInvariants` from the manifests. If unavailable, say so in the preflight (a named gap), don't emit `default`/`[]`. fineso's refire emitted `domain:"default"` while the same turn's first preflight said `domain:"harness"` — a refire must not re-derive domain from a shorter stem. | pack · preflight | baplatform T5 preflight stops reporting `domain:"default"`; fineso's refire agrees with its first preflight | unit test with a `00.context-contract.json` fixture + refire fixture |
| P-18 | Host pack injects a short enforcement paragraph into the consumer `AGENTS.md` (or a generated section): preflight, guards, `decision-policy`, execute-or-refuse. | pack · bootstrap template | atrievefin `AGENTS.md` names the enforcing contract | text assertion in qc |
| P-19 | Ship `harness-hook.mjs` with a source map **or** a `markers.json` mapping each guard to file/stdem, so audits don't grep a 119 KB bundle. | pack · `build-host-pack.mjs` | baplatform's A-4 ("cannot see the harness") is not reproducible | build produces map with ≥ every `src/` module |
| P-20 | `deploy.sh` writes a `provisionedAt` marker and provisioning does **not** immediately stamp maturity; `verify-consumer.sh` refuses to grade a consumer provisioned < 10 min ago without `--force`. | pack · `deploy.sh` / verify | atrievefin's ~1-min-before-audit case is labelled, not graded | qc: fixture timestamps |
| P-21 | Sandbox/exit-2 returns a structured `{"ok":false,"reason":"needs-consumer-path"}` the agent cannot misread as a report — and **names the sandbox** when argv was dropped (`fineso` A-6: `$1` lost to a blocked heredoc, message blamed the operator). `verify-consumer.sh` always writes `.harness/diagnostics/latest.*` unless `--no-write`. | pack · verify script | consumer's own diagnostics never lag; a lost argv says "sandbox", not "you forgot the path" | manual: run under sandbox and unsandboxed, diff messages |
| P-22 | Per-project Observatory route (or `deploy.sh` prints the correct URL); stop hardcoding `:8792` in generated `instructions.md`. | pack · provision template | atrievefin `instructions.md` points at atrievefin's console | text assertion in qc |
| P-23 | One storage story: generated `package.json` omits `storage.sqlite.path` when the driver is container-managed, or the provision writes the file the config names. | pack · provision | config and reality agree on one path | qc: fresh provision → documented DB path exists |
| P-24 | Generate **from one source, then reject cross-tree divergence**: `.md` twins only for trees that read `.md`; never write `.mdc` into `.agents/rules/`; maturity/CI check compares every twin's body + `version:` and fails on a diff (extension-only checks miss 6/7 of fineso's case). | pack · provision + maturity; consumer · `verify-dual-harness.mjs` | fineso's 7 untracked `.mdc` cannot be produced; twin version drift fails | qc: 3-tree fixture with one body-diverged twin |
| P-25 | T3.4 is correct — keep it. Add remediation text: "`docgraph.scope` line `X` names a directory that does not exist; create it or remove the line". | pack · maturity message | atrievefin operator knows the fix without reading the standard | snapshot test of the message |
| **P-26** | **Make a law term answerable or say it isn't.** (a) Preflight resolves each `lawQueries` term through the adapter and, on `score 0`, distinguishes *index stale* (P-03) from *term unindexable* (term not in any `h1`/heading/lead) — two different remedies. (b) Adapter fallback: body-text match (or `rg`-hit) returns a **ranked, marked** row instead of silently dropping to "rg fallback row". (c) Preflight dashboard shows per-term `rows / topScore / source(index|fallback)`. | pack · `harness-eso-core` law adapter + `preflight-hook.mjs`; upstream indexer for (b) | atrievefin+fineso's `harness-tooling`/`decision-facade` either return a row with a score or a named `law_term_unindexable` gap | replay both consumers' preflights against the current adapter; expect 0 silent `score 0` |
| **P-27** | **Merge pack defaults with consumer declarations by tier, and stop shipping another product's paths.** (a) `resolvePathPolicy` **appends** pack defaults instead of replacing per key, or states in the resolved output which keys were replaced. (b) `path-policy.default.json` ships **no** product paths — `backend/mu-*`, `frontend/`, `document/mu/` move to the x79 profile. (c) Add `SDLC/`, `sdlc/`, `.harness/` to the generic default `gated`. | pack · `harness-foundation/src/path-policy.mjs:146-156`, `dist/host-pack/path-policy.default.json`, `profiles/generic-eso.json` | a consumer declaring `paths` still gets pack-side guard files gated; no `mu-` path in the generic pack | unit test on `resolvePathPolicy` replace/append + text assertion on the shipped default |
| **P-28** | **Closure is per-session, not per-generation.** Keep `closedGapIds` and merge `toolUses` when `preflightAt` moves; only a *new conversation* resets. If a gap genuinely reopens (new gaps appear), re-open **only** those ids and record `reopenedBy: "preflight-refire"`. | pack · `eso-gap-io.mjs:311-325`, `preflight-hook.mjs` | fineso's measured wipe (32 → 0) is not reproducible: refire at `04:07:15Z` keeps the `04:00:52Z` closure | unit test: record 3 uses → refire with newer `at` → assert 3 preserved |
| **P-29** | **`verify-consumer` must run, and obey, the consumer's own gates.** Add T0 rows: dual-harness gate exit code, `L5:eager-rules`, `L4:gaps:agents` freshness, `L8:observe` — each reported as a *finding* not silently omitted. Any red consumer gate caps the tier at T4 until fixed. | pack · standard + `verify-consumer.sh` | fineso cannot read T5 while its own gate is exit 1 | qc: fixture consumer with red `verify-dual-harness` → capped tier |
| **P-30** | **Measure the thing.** `L5:eager-rules` counts distinct rules that were **actually injected** (from `ruleFiles` in the trace), not files on disk, and does not double-count trees. `L8:observe` probes the URL the consumer configured and reports `not running` / `not reachable from judge` / `ok` as three states. Remove `--verbose` from any remedy that isn't a real flag; add it or fix the text. | pack · `diagnostics.sh` (all consumers) | fineso's 57>7 goes green at 7; `L8` on `:8794` reports `ok` | snapshot test with a 3-tree fixture and a healthy container |
| **P-31** | **Guards read the *intent*, not the bytes.** (a) `guard-shell` only applies protected-path patterns to the command's **write targets** (redirects, `tee`, `cp/mv` destinations, `sed -i`), never to JSON string data. (b) When it does deny, name the matched span so the operator can see it was data. | pack · `guard-shell.py` | A-4's read-only probe passes; a real `.cursor/hooks/guard-write.py` write still denies | qc: two payloads — path inside JSON (allow) vs path as redirect target (deny) |
| **P-32** | **Detect the shape the user actually receives.** The host hands `text` already containing `[{"text": …, "text": "text"}]`; that is an envelope with a duplicated `type`, not prose. Accept `type` missing / duplicated / equal to `text`, and any array whose every element is `{text:string}`. Keep every negative test in `qc/output-wrapper.test.mjs` passing; add fineso's two observed strings as positive samples. | pack · `.cursor/hooks/lib/agent-response.mjs`, `qc/output-wrapper.test.mjs` | the phrase "lỗi format json wrapper" is not needed twice in one session | `node --test qc/output-wrapper.test.mjs` with the new samples |

### Fix order (three logs, de-duplicated)

0. **S0 — evidence integrity, do first because it invalidates other findings:** P-28 (closure wipe makes
   every "score 0.18" reading ambiguous), A-α/A-β (a replayable hook that writes live session state is how
   §6 of the fineso log happened). Neither is a gate defect; both decide whether any other number is real.
1. **S1 — the gate itself:** P-01 + P-02 in one diff (same decision point), **then P-26** — because
   fine-tuning term matching (P-01) without making the right terms answerable (P-26) just makes consumers
   fail faster. P-06b + P-32 also belong here (both are "we cannot prove the bytes that ran").
2. **S2 — the gate's blind spot:** P-04 (stop scoring tool choice), then P-03 (name the stale index). Then
   **P-29/P-31/P-24/P-27/P-12/P-13/P-05/P-06a/P-09** — the "trust the install / trust the standard" batch.
3. **S3 — observability & robustness:** P-07, P-08, P-11, P-14, P-15, P-16, P-17, P-19, P-21, P-22, P-25, P-30.
4. **S4 — hygiene/docs:** P-10, P-18, P-20, P-23.

**Do not patch consumers before step 1–2.** All three logs converge here: baplatform works around P-01 by
"reading the right file" (bakes in behaviour the next build undoes), atrievefin would work around P-04 with
an HIL relaxation (permanently ungraded), and fineso's T5 is precisely what you get when the standard does
not look at the consumer's own gate (P-29).

---

## 3. Per-consumer action list (operator)

| Consumer | Do this | Do **not** do this |
|---|---|---|
| **baplatform** | Rebuild the docgraph index (27 files stale); wire `memory` → `agentmemory-mcp :3211` **or** write the reason it is `noop`; refresh both trees to `32435c89` **or** drop `agents-superset`; regenerate `.agents/hooks/*` from `.cursor` source; record consent for the gated rules in its workflow **or** set `askMode: "host"`. | Don't treat the T5 snapshot (`10-22 12:49Z`) as current — re-run `verify-consumer.sh` unsandboxed. |
| **atrievefin** | Rebuild the docgraph index (37/51 stale) **and** include `.agents/**` (`--harness all`); create `SDLC/00.agent-manifests` or drop the scope line (T3.4); add `SDLC/**`, `.harness/**`, `.claude/**` to `paths.gated`; add `.claude` to `ingest.harnesses` or exempt it in writing; fix `instructions.md` `:8792` → its own console; reconcile DB path. | Don't "fix" the deny — it is correct. Don't rebuild the index expecting `score` to move: its two law terms are unindexable (P-26) and rebuild only fixes P-03. |
| **fineso** | Remove the 7 `.mdc` from `.agents/rules/` (untracked; Antigravity reads `.md`) — diff bodies first, six of seven differ from their `.md` twin; add `SDLC/**`, `.harness/**` to `paths.gated`; delete or regenerate the dead `.agents/session/.eso-bundle-stamp.json` (`10-15`); drop `alwaysApply: true` **or** the `globs:` from `fineso.engineering-slp` (never both); stop trusting `L5`/`L8` output until P-30 lands. | Don't read T5 as "harness verified" — its own `verify-dual-harness` is exit 1 and `L5` is FAIL. Don't "explain" the `memory: none` — it is correct by design; the missing piece is the diagnostic text. |

### Checks the consumers should run before the pack fix lands

Because P-26/P-28 make every `score` ambiguous, these four probes separate the causes on any consumer
(cheap, read-only, and they are what this matrix used):

```bash
# 1. Is the law index the problem, or the term? Rebuild in a copy and ask again.
docgraph --q "harness-tooling" --top 3 ; docgraph --q "decision-facade" --top 3   # expect score 0 today

# 2. Did closure survive the last submit? Compare the two timestamps.
jq -r '.preflightAt, (.toolUses|length)' .cursor/session/.eso-gap-closure.json

# 3. Does the executed hook match the installed manifest?
shasum -a 256 "$(jq -r '.hooks.preToolUse[0].command' .cursor/hooks.json | awk '{print $NF}')" \
  .harness/host-pack/harness-hook.mjs .harness/host-pack/host-pack.json

# 4. Does the consumer's own gate agree with its tier?
node scripts/ci/verify-dual-harness.mjs ; echo "exit=$?"   # fineso: 1 while verify-consumer says T5
```

---

## 4. Provenance note

| Claim class | Source |
|---|---|
| Consumer values (`docgraph` mtime, file counts, hashes, port health, T-tiers) | The three audit logs, each claim tied to a command or a snapshot file. Re-check before acting — all three are point-in-time (`03:28Z` / `03:41Z` / `03:55Z`). |
| `eso-gap-io.mjs` line references — haystack branches, reset-on-refire | Read by hand while writing this file: `stemMatches` `:274-302`, `stemHaystack` `:238-242`, `NON_SOURCE_SEGMENTS` `:59-71`, `closesGap` `:197-217`, `recordGapToolUse` `:311-325`. |
| `path-policy.mjs:146-156` (replace-per-key) and the shipped default's `mu-` paths | Read by hand while writing this file. This is why P-27 is a wrong-outcome, not just hygiene. |
| `agent-response.mjs` behaviour | Read by hand; fineso's `userQueryStem` is the sample that exposed the gap. |
| Priorities (S0–S4) and accept-criteria | This synthesis — judgement, not evidence from any log. |

Three earlier claims are **withdrawn** here because they did not survive checking:

- "Both trees share the installed pack, so drift is only about the installed bytes" → **wrong**, see P-06b.
  fineso had a byte-identical pack and still produced a wrong verdict.
- "`memory: noop` with a live memory service is a defect" → **half wrong**, see P-10. `requireExplicit`
  makes `none` the designed answer; only the *silence* about it is a defect.
- A claimed broken path in `core.reply-format.mdc` (§P-09 of the first chat draft): the rule cites
  `qc/output-wrapper.test.mjs`, which exists. No defect — and the detector's real gap is P-32, not its
  file list.

