# harness-eso spec

Every requirement is a row with an id. Agents build against approved rows; commits cite the ids they serve. Không còn tool nào lint file này (pullboard đã gỡ 2026-11-06) — review row bằng tay.

Statuses: approved = decided · draft = proposed · pending = open question · fact = true today · wont = won't build, decided and kept · retired = no longer applies, kept. Ids are permanent: never delete or renumber a row. Tiers: must · aim.

Write each requirement as one row under its section, in this format. The fence keeps the example out of the spec, so no placeholder id is ever committed; your own rows go below, outside it.

```text
- G1 [draft, must] The first thing the client needs, in one line. | gate: npm test
- K1 [draft, must] A constraint, e.g. runs locally with no account. | gate: review
```

## G · Goals: what the client asked for
- G1 [draft, must] Fix batch ESO-368...389: init-profile, db-adapter, flaky hook, and AST extractor | gate: review
- G2 [draft, must] Migrate eso/control-plane fully to NestJS/TypeScript: zero .mjs under src; build and tests green | gate: review

## K · Constraints
