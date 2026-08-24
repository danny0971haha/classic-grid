# Classic Grid v0.2 — Checkpoint E

**Status:** CHECKPOINT_E_REJECTED / CORRECTIVE_1_REVIEW_CANDIDATE
**Date:** 2026-08-24  
**Repository:** `danny0971haha/classic-grid`  
**Branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Current task:** `CHECKPOINT_E_CORRECTIVE_1`

This document is engineering evidence only. It does **not** declare Checkpoint E PASS, engineering-ready, live-ready, or deploy-ready.

```text
CHECKPOINT=E
REQUESTED_GATE=CHECKPOINT_E_CORRECTIVE_1_REVIEW
CHECKPOINT_C=PASS
CHECKPOINT_D_CORRECTIVE_1=PASS
CHECKPOINT_E=REJECT
CHECKPOINT_E_CORRECTIVE_1=REVIEW_CANDIDATE
CHECKPOINT_E_SELF_DECLARED_PASS=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
```

Independent review rejected the original Checkpoint E campaign for vacuous E-09 proof and synthesized E-26 PASS rows. See [`classic-v0.2-checkpoint-e-corrective-1.md`](./classic-v0.2-checkpoint-e-corrective-1.md). The checked-in `artifacts/historical/classic-v0.2-checkpoint-e-results.non-authoritative.json` is historical only. CI-generated TAP evidence is authoritative.

## Binding

```text
ACCEPTED_CHECKPOINT_C_HEAD=13a96e12b7fc29485cb46fe471fb3cf5c0604404
ACCEPTED_CHECKPOINT_C_TREE=b019ef52da1d14051781ecd63334def0dfc6463c
CHECKPOINT_E_CORRECTIVE_1_IMPLEMENTATION_HEAD=c8e1b0d9c4fd7b20e2cd11c89653a58e0eef6881
CHECKPOINT_E_CORRECTIVE_1_IMPLEMENTATION_TREE=1daeb659727c7672da389e867c9842153d6b940a
REJECTED_CHECKPOINT_D_HEAD=ab673cadc8a12afb3051c5bbeb8ca53545de27f6
REJECTED_CHECKPOINT_D_TREE=1b49f2a6d08f8ddd4521bb799fc737a1774955c7
STAGE_1_RESULT_HEAD=3f0376ef06944f3b673be64f841c01a56a9e3d43
STAGE_1_RESULT_TREE=accb579d506ae0eb0cd096907a9a2b40b2b2ddf8
CAMPAIGN_HEAD=58782ad0beece20a77ab2525e8eedbee983356a7
CAMPAIGN_TREE=f85873c7e6d6bf84c1ecaed97a0d9d3b6683c51b
```

Stage 2 started only after the Stage 1 hard internal gate:

```text
STAGE_1_FOCUSED_TESTS=PASS
STAGE_1_FULL_SUITE=PASS
STAGE_1_DIFF_CHECK=PASS
STAGE_1_WORKTREE_CLEAN_AFTER_COMMIT=YES
STAGE_1_LIVE_WRITE=NO
```

Local toolchain: Node v26.5.0 / npm 11.17.0. GitHub Actions must prove Node v22.23.2 / npm 10.9.8.

## Production changes in this ordered batch

Stage 1 production wiring only (`src/grid.ts`, `src/types.ts`, `src/loop.ts`):

| File | Why |
|---|---|
| `src/grid.ts` | snapshot capacity; Option A cross-market; explicit `plannerDisposition`; `applyPlannerIntentGate` |
| `src/types.ts` | `PlannerDisposition`, `CROSS_MARKET_OWNED` |
| `src/loop.ts` | consume `applyPlannerIntentGate(planFromFillsAndSeed(...))` |

Stage 2 added **no additional production wiring**. Checkpoint E is tests, fixtures, this note, and `artifacts/classic-v0.2-checkpoint-e-results.json`.

Unchanged on purpose: `src/venues/extendedAccountStream.ts`, Checkpoint C cursor protocol, execution-journal authority, risk thresholds, Checkpoint B reduction/flatten, runtime lease implementation, `vendor/**`, dashboard mutation endpoints, deployment/service files, live authorization, capital/leverage/grid envelope, dependency versions.

## E integrated matrix

| ID | Category | Result | Proof |
|---|---|---|---|
| E-01 | configuration | PASS | frozen 100U / 5x / 30U / 150U / 10 / ±3% banner |
| E-02 | configuration | PASS | dry-run apply; v0.2 live start rejected |
| E-03 | planner | PASS | duplicate permutations byte-identical |
| E-04 | planner | PASS | cancel does not free capacity; fresh child replay |
| E-05 | planner | PASS | cross-market / unlocatable ambiguity; zero place; no unowned cancel |
| E-06 | execution-journal | PASS | one authoritative FILL; disappearance is not FILL |
| E-07 | execution-journal | PASS | partial quantity / cumulative / remaining |
| E-08 | execution-journal | PASS | `BEFORE_MEMORY_COMMIT` fault; zero published FILL |
| E-09 | execution-journal | PASS | watermark persist failure keeps at-least-once replay |
| E-10 | risk | PASS | actual >150U invokes flatten, not cancel-only |
| E-11 | risk | PASS | daily-loss 5U halt |
| E-12 | risk | PASS | drawdown-from-start 10U halt |
| E-13 | risk | PASS | long adverse boundary halt |
| E-14 | risk | PASS | short adverse boundary halt |
| E-15 | risk | PASS | missing/stale inputs fail closed |
| E-16 | risk | PASS | cancel UNKNOWN remains halted, not flat |
| E-17 | risk | PASS | flatten UNKNOWN remains halted |
| E-18 | risk | PASS | lease loss before mutation; no flatten transport |
| E-19 | restart | PASS | fresh child during HALTING cannot reseed |
| E-20 | restart | PASS | restart after flatten submit remains halted |
| E-21 | restart | PASS | ACK-era reload; newer halt identity preserved |
| E-22 | telemetry | PASS | emit failure does not halt or clear RUNNING |
| E-23 | telemetry | PASS | kill-switch still reaches HALTED_FLAT when telemetry throws |
| E-24 | fatal-runtime | PASS | uncaught exception exits non-zero; no place marker |
| E-25 | fatal-runtime | PASS | unhandled rejection exits non-zero; leftover OPEN session → reconciliation |
| E-26 | evidence | PASS | JSON schema for 30 cases |
| E-27 | telemetry | PASS | secret-like fields redacted / absent |
| E-28 | evidence | PASS | prior D/C/C-C18..C-C21 IDs remain; no skip |
| E-29 | configuration | PASS | dependency versions unchanged |
| E-30 | configuration | PASS | v0.2 live remains forbidden |

C-C18 / C-C19 / C-C20 remain in `test/experiment-v02-execution.test.ts` and ran in the full suite with `SKIP=0`.

## FILES_CHANGED (Stage 2)

| File | Why |
|---|---|
| `test/experiment-v02-checkpoint-e.test.ts` | E-01..E-30 |
| `test/fixtures/checkpoint-e-worker.ts` | planner / fatal / session child |
| `package.json` | `test:checkpoint-e` + suite registration |
| `docs/classic-v0.2-checkpoint-e.md` | this note |
| `docs/classic-v0.2-checkpoint-d-corrective-1.md` | Stage 1 result binding |
| `artifacts/classic-v0.2-checkpoint-e-results.json` | machine-readable campaign |

CI workflow was not changed. Timeout/artifact-upload edits were not required.

## COMMANDS_AND_EXIT_CODES

| Command | Exit |
|---|---|
| `npm run typecheck` | 0 |
| `npm run test:checkpoint-d-corrective` | 0 (33/33) |
| `npm run test:checkpoint-e` | 0 (30/30, skip 0) |
| `npm run check` | 0 |
| `npm audit --json` | 1 (inventory only) |
| `git diff --check` | 0 |

## TEST_TOTAL_PASS_FAIL_SKIP

```text
tests 343
pass 343
fail 0
cancelled 0
skipped 0
todo 0
```

Prior node:test total after Stage 1 was 313. This campaign adds E-01..E-30 (30 tests). `313 + 30 = 343`. Gate 0, A, B, C, C-C16..C-C24, D-01..D-21, and D-C1-01..D-C1-12 remain and were not weakened.

## AUDIT_SUMMARY

```text
vulnerabilities: 22 (0 info, 0 low, 8 moderate, 14 high, 0 critical)
dependency counts: prod=302, dev=0, optional=31, peer=33, total=364
```

Inventory is unchanged versus the accepted Checkpoint C / rejected Checkpoint D baseline. No `npm audit fix` and no `--force`.

## SECRET_SCAN

No production credentials, API keys, or account identifiers were committed. Telemetry `error_message` remains `diagnostic omitted; see local logs`. Artifact JSON contains only case IDs and SHAs.

## KNOWN_LIMITATIONS

- This note does not declare Checkpoint D or E PASS.
- Local verification used Node v26.5.0 / npm 11.17.0. CI pin is Node v22.23.2 / npm 10.9.8.
- Directory-fsync SIGKILL proof for C-C18/C-C19/C-C20 remains Ubuntu CI. E-08 uses the in-process `BEFORE_MEMORY_COMMIT` hook rather than SIGKILL so Darwin `SKIP=0`.
- Planner still returns `filled=[]` and `completedRungs=0`.
- No live exchange write. No real-fund testing. No deployment. No merge.
- 22 npm audit findings remain open on purpose.

## Independent review

The independent reviewer owns `PASS`, `REJECT`, or `BLOCKED`.

```text
CHECKPOINT_D_SELF_DECLARED_PASS=NO
CHECKPOINT_E_SELF_DECLARED_PASS=NO
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
MERGE=NO
DEPLOYMENT=NO
```
