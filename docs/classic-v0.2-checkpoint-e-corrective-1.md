# Classic Grid v0.2 — Checkpoint E Corrective 1

**Status:** CHECKPOINT_E_CORRECTIVE_1_REJECTED / SUPERSEDED BY CORRECTIVE 2
**Date:** 2026-08-24
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Draft PR:** `#3`
**Current task:** `CHECKPOINT_E_CORRECTIVE_2`

This document does **not** declare Checkpoint E PASS. Independent review rejected Corrective 1 (`55c75e6`) for evidence-schema integrity: `fullSuite` reused the 30-case Checkpoint E TAP. See [`classic-v0.2-checkpoint-e-corrective-2.md`](./classic-v0.2-checkpoint-e-corrective-2.md).

```text
CHECKPOINT=E_CORRECTIVE_1
REQUESTED_GATE=CHECKPOINT_E_CORRECTIVE_2_REVIEW
CHECKPOINT_C=PASS
CHECKPOINT_D_CORRECTIVE_1=PASS
CHECKPOINT_E=REJECT
CHECKPOINT_E_CORRECTIVE_1=REJECT
CHECKPOINT_E_CORRECTIVE_2=REVIEW_CANDIDATE
CHECKPOINT_E_SELF_DECLARED_PASS=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
```

## Binding

```text
AUTHORITATIVE_START_HEAD=8a53843c1049323478b29e590934a48771dcfe89
AUTHORITATIVE_START_TREE=534ec0a614402a181cab88e5015b916f7d6d9859
ACCEPTED_CHECKPOINT_C_HEAD=13a96e12b7fc29485cb46fe471fb3cf5c0604404
REJECTED_CHECKPOINT_E_HEAD=8a53843c1049323478b29e590934a48771dcfe89
REJECTED_CHECKPOINT_E_TREE=534ec0a614402a181cab88e5015b916f7d6d9859
REJECTION_CLASS=EVIDENCE_AND_TEST_INTEGRITY
KNOWN_PRODUCTION_DEFECT_FROM_THIS_REVIEW=NO
IMPLEMENTATION_HEAD=c8e1b0d9c4fd7b20e2cd11c89653a58e0eef6881
IMPLEMENTATION_TREE=1daeb659727c7672da389e867c9842153d6b940a
TESTED_HEAD=f6868aa5290e7ba2c6733f6189b964f214572f63
TESTED_TREE=5d34f61940818baf77939ac63ebc110229b2da50
PUSH_CI_RUN_ID=32742254242
PUSH_CI_CONCLUSION=success
PR_CI_RUN_ID=32742261165
PR_CI_CONCLUSION=success
EVIDENCE_ARTIFACT_NAME=classic-v0.2-checkpoint-e-results
EVIDENCE_ARTIFACT_ID=9525638365
EVIDENCE_JSON_SHA256=614015e1b6b122c1784e41fff026ced3c2b112c341410b39cebe88aa4d61bcd6
```

Current-byte check at start: HEAD and TREE matched `AUTHORITATIVE_START_*`. Working tree was clean. Branch was ff-only with `origin/experiment/classic-v0.2-100u-safety`. No reset, rebase, amend, or force-push.

`AGENTS.md` was requested as a pre-read and is not present in this repository.

Local toolchain: Node v26.5.0 / npm 11.17.0. GitHub Actions must prove Node v22.23.2 / npm 10.9.8.

## BLOCKER_DISPOSITION

```text
BLOCKER_ID=E-C1-01
BLOCKER=E-09_IS_VACUOUS
DISPOSITION=FIXED_IN_CANDIDATE

BLOCKER_ID=E-C1-02
BLOCKER=E-26_SYNTHESIZES_PASS_RESULTS
DISPOSITION=FIXED_IN_CANDIDATE
```

### E-C1-01

The rejected E-09 ended with `assert.ok(replay.journalSnapshot().executions.length >= 0)`, which cannot fail. Corrective 1 keeps the same watermark persist-failure hook and independently proves:

1. one authoritative trade with stable exchange trade ID `tr-e09-stable`;
2. exactly one FILL with dedupe key `extended|BTC-USD|trade|tr-e09-stable`;
3. cursor/watermark persist failure during acknowledge;
4. `cursorPersistenceBlocked() === true`, durable cursor lacks the published key, still contains that pending authoritative execution, and contains no unrelated execution;
5. a true fresh child process reloads the cursor from disk and replays the same trade;
6. exactly one replayed authoritative FILL with the same trade ID, dedupe key, and `source=exchange`;
7. the child successfully acknowledges the replayed execution;
8. a second fresh reload produces zero new authoritative FILL.

C-C21 remains the semantic reference. E-09 now has its own current-byte assertions and does not treat length/truthiness/source-text checks as proof. The stronger test did not expose a `src/**` defect.

### E-C1-02

The rejected E-26 mapped `CASE_IDS` to `result="PASS"` / `exitCode=0` before checking JSON shape. Corrective 1 derives every E-01..E-30 result from TAP produced by the Node 22 test process.

Generator command:

```text
node --import tsx --test --test-reporter=tap test/experiment-v02-checkpoint-e.test.ts
```

Evidence generation fails on nonzero process exit, missing/duplicate/unexpected E-* cases, FAIL/SKIP/CANCELLED/TODO, or totals that do not equal the parsed case set. PASS is never filled from `CASE_IDS`.

The checked-in `artifacts/historical/classic-v0.2-checkpoint-e-results.non-authoritative.json` is historical only. The GitHub Actions artifact `classic-v0.2-checkpoint-e-results` is authoritative. A generated results JSON that claims the current commit SHA is not checked in.

## FILES_CHANGED

Allowed paths only. `src/**` is unchanged.

| File | Why |
|---|---|
| `test/experiment-v02-checkpoint-e.test.ts` | current-byte E-09; TAP-derived E-26 |
| `test/fixtures/checkpoint-e-worker.ts` | fresh-process journal replay/ack |
| `test/experiment-v02-checkpoint-e-evidence.test.ts` | negative verifier coverage |
| `tools/checkpoint-e-evidence.ts` | TAP parse, generate, verify |
| `package.json` | register corrective tests and evidence commands |
| `.github/workflows/ci.yml` | pin npm 10.9.8; generate/verify/upload evidence |
| `artifacts/README.md` | historical vs CI-authoritative |
| `artifacts/historical/classic-v0.2-checkpoint-e-results.non-authoritative.json` | relabeled rejected artifact |
| `docs/classic-v0.2-checkpoint-e-corrective-1.md` | this note |
| `docs/classic-v0.2-checkpoint-e.md` | rejected E / corrective status |
| `docs/classic-v0.2-implementation-contract.md` | bounded status block |

## COMMANDS_AND_EXIT_CODES

Local validation on Node v26.5.0 / npm 11.17.0. GitHub Actions must prove Node v22.23.2 / npm 10.9.8.

| Command | Exit |
|---|---|
| `npm ci` | 0 |
| `npm run typecheck` | 0 |
| `npm run test:checkpoint-e` | 0 (30/30, skip 0) |
| `npm run test:checkpoint-e-corrective` | 0 (8/8, skip 0) |
| `npm run check` | 0 |
| `npm run evidence:checkpoint-e` | 0 |
| `npm run evidence:checkpoint-e:verify` | 0 |
| `npm audit --json` | 1 (inventory only) |
| `git diff --check` | 0 |

## TEST_TOTAL_PASS_FAIL_SKIP

Prior node:test total was 343. This corrective adds 8 evidence-generator/verifier tests and does not remove or skip E-01..E-30. `343 + 8 = 351`.

```text
tests 351
pass 351
fail 0
cancelled 0
skipped 0
todo 0
```

## AUDIT_SUMMARY

Inventory is recorded from a fresh `npm audit --json`. No `npm audit fix` and no `--force`. Expected unless the fresh command differs:

```text
vulnerabilities: 22 (0 info, 0 low, 8 moderate, 14 high, 0 critical)
```

## SECRET_SCAN

Changed paths only. Rule names, no values:

```text
test/experiment-v02-checkpoint-e.test.ts — no credential matches
test/fixtures/checkpoint-e-worker.ts — no matches
test/experiment-v02-checkpoint-e-evidence.test.ts — no matches
tools/checkpoint-e-evidence.ts — no matches
package.json — no matches
.github/workflows/ci.yml — no matches
artifacts/** — historical case IDs and SHAs only
docs/** — no secrets
```

## KNOWN_LIMITATIONS

- This note does not declare Checkpoint E PASS.
- Local verification used Node v26.5.0 / npm 11.17.0. CI pin is Node v22.23.2 / npm 10.9.8.
- Authoritative evidence is the CI artifact generated at `TESTED_HEAD`, not a checked-in JSON that claims its own commit SHA. This CI-ID binding commit is docs-only after that tested commit.
- `AGENTS.md` is absent from this repository.
- Directory-fsync SIGKILL proof for C-C18/C-C19/C-C20 remains Ubuntu CI.
- Planner still returns `filled=[]` and `completedRungs=0`.
- No live exchange write. No real-fund testing. No deployment. No merge.
- 22 npm audit findings remain open on purpose unless a fresh audit reports a different current inventory.

## Independent review

The independent reviewer owns `PASS`, `REJECT`, or `BLOCKED`.

```text
CHECKPOINT_E_SELF_DECLARED_PASS=NO
CHECKPOINT_E=REJECT
CHECKPOINT_E_CORRECTIVE_1=REJECT
CHECKPOINT_E_CORRECTIVE_2=REVIEW_CANDIDATE
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
MERGE=NO
DEPLOYMENT=NO
```
