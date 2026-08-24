# Classic Grid v0.2 — Checkpoint D

**Status:** CHECKPOINT_D_REVIEW_CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/classic-grid`  
**Branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Current task:** `CHECKPOINT_D_ONLY`

This document does **not** declare Checkpoint D PASS. CI success is not a gate verdict. The implementation agent must not self-declare PASS.

```text
CHECKPOINT=D
REQUESTED_GATE=CHECKPOINT_D_REVIEW
CHECKPOINT_C=PASS
ACCEPTED_CHECKPOINT_C_HEAD=13a96e12b7fc29485cb46fe471fb3cf5c0604404
ACCEPTED_CHECKPOINT_C_TREE=b019ef52da1d14051781ecd63334def0dfc6463c
CHECKPOINT_D=REVIEW_CANDIDATE
CHECKPOINT_D_SELF_DECLARED_PASS=NO
CHECKPOINT_E_STARTED=NO
CHECKPOINT_E_AUTHORIZED=NO
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
AUTHORIZED_CHECKPOINT=CHECKPOINT_D_ONLY
BASE_HEAD=13a96e12b7fc29485cb46fe471fb3cf5c0604404
BASE_TREE=b019ef52da1d14051781ecd63334def0dfc6463c
IMPLEMENTATION_HEAD=1bc54a3e4706af6edd20426ea6e0eaacde61e181
IMPLEMENTATION_TREE=afed733e5a3827a092fe2e921762229e22b97045
EVIDENCE_HEAD=bf6640a915b0619e0ae63e76120cf742fee0d8f1
EVIDENCE_TREE=0f34382812563776abbd4be9362e22deb54da072
RESULT_HEAD=bf6640a915b0619e0ae63e76120cf742fee0d8f1
RESULT_TREE=0f34382812563776abbd4be9362e22deb54da072
```

Current-byte check at start: HEAD and TREE matched `EXPECTED_START_*`. Working tree was clean. Branch was ff-only with `origin/experiment/classic-v0.2-100u-safety`. No reset and no force-push. Branch had not advanced beyond the accepted Checkpoint C head.

## LOGICAL_SLOT_DEFINITION

An experiment-owned logical slot is the tuple:

```text
market + anchorEpoch + side + levelIndex
```

Price alone is never a slot key. Buy and sell are never duplicates of each other. Orders that differ in market, anchor epoch, side, level, or ownership scope are never merged.

## ORDER_CLASSIFICATION

Every live observation is classified before survivor selection:

| Class | Meaning | Cancel | nextActive | Seed same slot |
|---|---|---|---|---|
| `VALID_OWNED_CURRENT` | market, ownership prefix, exact current identity, side, price tolerance, size tolerance, and a non-empty string cancel ID all hold | no (survivor) / yes (non-survivor duplicate) | survivor only | no |
| `MALFORMED_OWNED` | ownership proven; level/price/size/side/identity do not match current slot | only with proven cancel ID | no | no |
| `STALE_EPOCH_OWNED` | ownership prefix matches; parsed epoch is not current | only with proven cancel ID | no | no |
| `UNOWNED` | no current experiment prefix | never | never | no (blocks slot) |
| `AMBIGUOUS` | missing cancel identity, non-finite price/size, invalid side, or same-ID field conflict | never | never | no |

`VALID_OWNED_CURRENT` does not coerce opaque exchange IDs with `Number()`. Non-string IDs normalize to empty and fail closed.

## SURVIVOR_COMPARATOR

Locale-independent `comparePlannerOrders`. Never uses `.localeCompare()`, `Number()` on IDs, `Math.random()`, `Date.now()`, or input-array order.

```text
1. normalizeOpaqueId(exchangeOrderId)   // trim; non-string → ""
2. normalizeOpaqueId(order.id)
3. normalizeOpaqueId(clientOrderId)
4. market, side, finite price, finite size
```

String keys use UTF-16 `charCodeAt` then length. Missing/empty IDs compare as empty strings (empty sorts first). Numeric observation fields use IEEE compare; non-finite sorts last.

## TIE_BREAK_RULES

- Same stable `id` or `exchangeOrderId` and identical canonical fields: one observation. No self-cancel.
- Same stable ID with conflicting fields: `RECONCILIATION_REQUIRED`. Do not cancel, claim, or place that slot.
- Empty / missing cancel ID, non-finite price/size, or invalid side: fail closed (`AMBIGUOUS` or `MALFORMED_OWNED` without cancel).

Survivor of a slot is always the first `VALID_OWNED_CURRENT` after the comparator sort. Remaining valid owned duplicates cancel in that same order.

## PERMUTATION_MATRIX

| Case | Input | Permutations | Invariant |
|---|---|---:|---|
| D-01 | 3 valid owned duplicates, same slot | 6 | survivor `id-a`; cancels `id-b`, `id-c`; byte-identical serialization |
| D-02 | opaque IDs `"2"`, `"10"`, `"0010"` | 6 | survivor `"0010"`; cancels `"10"`, `"2"` (not numeric 2 < 10) |
| D-15 | same 3 valid duplicates, `maxWrites` 1/2/3 | 18 | each budget emits the same cancel prefix; cancel before place |
| D-17 | mixed owned + unowned | 100 repeats | identical JSON serialization |

## AMBIGUOUS_ORDER_DISPOSITION

Exposed on `plan.diagnostics` (`AMBIGUOUS_ORDER`, `MISSING_CANCEL_IDENTITY`, or `RECONCILIATION_REQUIRED`). Never cancelled, never written to `nextActive`, and the inferred current-epoch slot is blocked for seeding. Not treated as absent.

## CANCEL_BEFORE_RESEED_PROOF

Any classified observation that occupies a price-matched level or a parsed identity slot adds that level/slot to the blocked set. Cancels are emitted first. Places cannot target a blocked slot in the same cycle. Cancel ACK is not disappearance proof and is not a FILL.

`maxWritesPerTick` only truncates the already-sorted cancel list. Unemitted duplicates remain on the venue count and keep the slot blocked.

## MAX_WRITES_MATRIX

For survivor `a` and cancel candidates `m`, `z`:

| maxWrites | intents |
|---:|---|
| 1 | `cancel m` |
| 2 | `cancel m`, `cancel z` |
| 3 | `cancel m`, `cancel z`, then at most one place on an unblocked slot |

Repeated permutations of the same snapshot produce the same bounded subset.

## FILES_CHANGED

| File | Why |
|---|---|
| `src/grid.ts` | classify → deterministic survivor → cancel-before-reseed |
| `src/types.ts` | planner slot / class / diagnostic types |
| `test/experiment-v02-planner-dedup.test.ts` | D-01..D-21 |
| `package.json` | register focused + suite test |
| `docs/classic-v0.2-checkpoint-d.md` | this evidence note |

Unchanged on purpose:

```text
src/loop.ts
src/venues/extendedAccountStream.ts
src/experimentReduction.ts
src/experimentRisk.ts
src/config.ts
src/runtimeLease.ts
vendor/**
Checkpoint C cursor protocol
execution journal authority
risk thresholds
Checkpoint B reduction/flatten semantics
```

Frozen v0.2 envelope is unchanged: capital=100 USDT, leverage=5x, marginFraction=0.30, plannedGrossNotionalCap=150 USDT, levels=10, gridHalfBand=0.03, dailyLossHalt=5 USDT, startingDrawdownHalt=10 USDT, boundaryBuffer=0.01, venue=Extended, market=BTC.

## DIFF_STAT

Implementation commit `1bc54a3e4706af6edd20426ea6e0eaacde61e181` (`BASE_HEAD..IMPLEMENTATION_HEAD`):

```text
 package.json                              |   3 +-
 src/grid.ts                               | 654 +++++++++++++++++++++++++-----
 src/types.ts                              |  33 ++
 test/experiment-v02-planner-dedup.test.ts | 490 ++++++++++++++++++++++
 4 files changed, 1084 insertions(+), 96 deletions(-)
```

```text
2	1	package.json
559	95	src/grid.ts
33	0	src/types.ts
490	0	test/experiment-v02-planner-dedup.test.ts
```

Production blob SHAs:

| Path | Before | After |
|---|---|---|
| `src/grid.ts` | `7e77be94cd474c680b719cf0a2399302acd53666` | `2c3acb665a53d85e6085224a1b5408e108f347d1` |
| `src/types.ts` | `6c1b329b5747270d195f1d800cf3d7b17821221f` | `ac63815d259238249f6096f71ac6ff466a9a9108` |
| `package.json` | `5ed44d1606649df0588421b3fe67f00be9a5a828` | `15bc199b1fe4a5f67be11a5332e101a832b1bf82` |
| `test/experiment-v02-planner-dedup.test.ts` | (absent) | `846de39dcfef0cb72988339fda24753182836334` |

## COMMANDS_AND_EXIT_CODES

| Command | Exit |
|---|---|
| `git status --short` (start) | 0, empty |
| `git branch --show-current` | 0, `experiment/classic-v0.2-100u-safety` |
| `git rev-parse HEAD` (start) | 0, `13a96e12b7fc29485cb46fe471fb3cf5c0604404` |
| `git rev-parse HEAD^{tree}` (start) | 0, `b019ef52da1d14051781ecd63334def0dfc6463c` |
| `node --version` (local) | 0, `v26.5.0` |
| `npm --version` (local) | 0, `11.17.0` |
| `npm ci` | 0 (printed 22 vulnerabilities; not hidden) |
| `npm run typecheck` | 0 |
| `node --import tsx --test test/experiment-v02-planner-dedup.test.ts` | 0 |
| `npm run check` | 0 (one Darwin C-C20 SIGKILL ready-file miss on first attempt; rerun 301/301) |
| `npm audit --json` | 1 (inventory only; no upgrade and no `--force`) |
| `git diff --check` | 0 |

Local toolchain is not the CI pin. GitHub Actions must prove Node v22.23.2 / npm 10.9.8.

## TEST_TOTAL_PASS_FAIL_SKIP

Focused Checkpoint D file:

```text
tests 21
pass 21
fail 0
skipped 0
```

Full `npm run check` node:test runner (excludes `grid.test.ts` script, which printed `grid.test.ts OK`):

```text
tests 301
pass 301
fail 0
cancelled 0
skipped 0
todo 0
```

Prior node:test total was 280. This checkpoint adds D-01..D-21 (21 tests). `280 + 21 = 301`. Gate 0, A, B, C, and C-C16..C-C24 remain and were not weakened.

## AUDIT_SUMMARY

`npm audit --json` (audit report version 2). **Not fixed in this checkpoint.** Warnings are not hidden.

```text
vulnerabilities: 22 (0 info, 0 low, 8 moderate, 14 high, 0 critical)
dependency counts reported by audit: prod=302, dev=0, optional=31, peer=33, total=364
```

Inventory is unchanged versus the accepted Checkpoint C baseline. No `npm audit fix` and no `npm audit fix --force` were run. No dependency was added.

## SECRET_SCAN

Changed paths only. Rule names, no values:

```text
src/grid.ts — no credential/private-key matches (sideToken is an order-side helper)
src/types.ts — no matches
test/experiment-v02-planner-dedup.test.ts — asserts absence of LIVE_CONFIRM / API_SECRET / PRIVATE_KEY
package.json — no matches
docs/classic-v0.2-checkpoint-d.md — no secrets
```

## KNOWN_LIMITATIONS

- Checkpoint E integrated campaign is not started.
- Execution records still do not advance planner completed-rung or `plan.filled`.
- `plan.filled=[]` and `completedRungs=0` remain required; disappearance is not FILL.
- Directory-fsync SIGKILL proof for Checkpoint C remains Ubuntu CI. One local Darwin C-C20 ready-file race was observed and passed on rerun; not a planner change.
- Local verification used Node v26.5.0 / npm 11.17.0. CI pin is Node v22.23.2 / npm 10.9.8.
- No production credentials. No live exchange write. No real-fund testing.
- 22 npm audit findings remain open on purpose.
- `loop.ts` was not modified. Diagnostics are returned on the planner result; the runtime loop still applies intents and `nextActive` only.
- Upstream `beibei030/classic-grid@e26ab196e01245ad70d0eb41e1b7ffc64249cd44` was not cherry-picked.

## CI_RUN_IDS

```text
PUSH_CI_RUN_ID=PENDING_PUSH
PR_CI_RUN_ID=PENDING_PUSH
PROVEN_HEAD=PENDING_PUSH
TOOLCHAIN=Node v22.23.2 / npm 10.9.8 (required on GitHub Actions)
TEST_TOTAL=301
TEST_PASS=301
TEST_FAIL=0
TEST_SKIP=0
LIVE_EXCHANGE_WRITE=NO
REAL_FUND_TESTING=NO
CHECKPOINT_E_STARTED=NO
```

## Independent review

The independent reviewer owns `PASS`, `REJECT`, or `BLOCKED`.

```text
CHECKPOINT_D_SELF_DECLARED_PASS=NO
CHECKPOINT_D=REVIEW_CANDIDATE
CHECKPOINT_E_STARTED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
```
