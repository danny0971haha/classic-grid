# Classic Grid v0.2 — Checkpoint C Corrective 2

**Status:** CHECKPOINT_C_REVIEW_CANDIDATE / INDEPENDENT REVIEW REQUIRED  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/classic-grid`  
**Branch:** `experiment/classic-v0.2-100u-safety`  
**Draft PR:** `#3`  
**Current task:** `CHECKPOINT_C_CORRECTIVE_2_ONLY`

This document does **not** declare Checkpoint C PASS. CI success is not a gate verdict. The implementation agent must not self-declare PASS.

```text
TASK=CHECKPOINT_C_CORRECTIVE_2_ONLY
CHECKPOINT_B=PASS
CHECKPOINT_C=REVIEW_CANDIDATE
CHECKPOINT_C_CORRECTIVE_1=REJECT
CHECKPOINT_C_CORRECTIVE_2_SELF_DECLARED_PASS=NO
CHECKPOINT_D_STARTED=NO
CHECKPOINT_D_AUTHORIZED=NO
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
ACCEPTED_CHECKPOINT_B_HEAD=197369a00a7c1f7080f2a1ebea76ffae20ac13ba
ACCEPTED_CHECKPOINT_B_TREE=6c08c9e3fb78a86591423ea47a60ce96e1c9f796
REJECTED_CHECKPOINT_C_CORRECTIVE_1_HEAD=8d52b67d234ed5a76bb972f566c41ae42e7dda5c
REJECTED_CHECKPOINT_C_CORRECTIVE_1_TREE=5db57c5b43940195bc295d72dbf0367a9f8d108c
BASE_HEAD=8d52b67d234ed5a76bb972f566c41ae42e7dda5c
BASE_TREE=5db57c5b43940195bc295d72dbf0367a9f8d108c
IMPLEMENTATION_HEAD=69b4a6b608cd6ec95757bea0ca42b9dfb00f3f88
IMPLEMENTATION_TREE=1482e0214593161114b7d6380e4b901926fc327c
RESULT_HEAD=PENDING_DOCS_BIND
RESULT_TREE=PENDING_DOCS_BIND
```

Current-byte check at start of this corrective: HEAD and TREE matched `EXPECTED_START_*`. Working tree was clean. Branch was ff-only with `origin/experiment/classic-v0.2-100u-safety`. No reset and no force-push.

## BLOCKER_DISPOSITION

```text
BLOCKER_ID=C-CORR2-BLOCKER-01
BLOCKER=CURSOR_PERSISTENCE_FAILURE_CAN_PUBLISH_UNCOMMITTED_FILL
DISPOSITION=FIXED_IN_CANDIDATE
```

Corrective 1 `acceptTrade()` mutated `seenDedupeKeys`, `pendingAuthoritative`, `trustedCount`, and lineage, then called a void `persistCursor()` that swallowed mkdir/open/write/fsync/close/rename failures while leaving the record in `pendingAuthoritative`. `drainJournal()` could therefore publish an authoritative FILL that was never durable.

Corrective 2 stages a candidate cursor payload first. Durable persist + readback must return `COMMITTED` before any publish-authority memory commit. `drainJournal()` hides all authoritative records while the process-lifetime persistence latch is set.

## CURSOR_COMMIT_PROTOCOL

`persistCursor(candidate, phase)` now returns an explicit disposition:

| Disposition | Meaning |
|---|---|
| `COMMITTED` | temp create, write, file fsync, close, atomic rename, Linux/GHA directory fsync, reopen/readback, exact-byte + identity/pending/dedupe validation all succeeded |
| `PRE_RENAME_FAILURE` | failure before rename was attempted |
| `RENAME_OR_DURABILITY_UNCERTAIN` | rename attempted or directory fsync not proven |
| `READBACK_UNPROVEN` | rename/dir-fsync completed but readback did not finish |
| `VALIDATION_FAILURE` | readback bytes or canonical identity/schema/pending/dedupe did not match the candidate |

Protocol for a new execution:

1. Validate the trade against committed state only.
2. Build a staged candidate (`seen`, `pending`, `lineage`, `authoritativeCount`) without mutating publish-authority memory.
3. Persist the candidate: same-directory unpredictable temp (`.${basename}.${pid}.${uuid}.tmp`), directory mode `0700`, temp/file mode `0600`, full write, fsync temp, close, atomic rename, Linux / GitHub Actions parent-directory fsync, reopen, exact-byte and canonical verification.
4. Fire `BEFORE_MEMORY_COMMIT`.
5. Only then apply the candidate to process-local publishable state.
6. Fire `BEFORE_PUBLICATION`.

`acknowledgeJournal()` uses the same staged-candidate path:

```text
telemetry FILL append success
-> build published-watermark candidate
-> persist and verify cursor candidate
-> only then modify in-memory pending/published sets
```

Any non-`COMMITTED` result:

- `cursorFailedClosed=true`
- `executionAuthority=invalidated`
- emit `CURSOR_CONFLICT`
- process-lifetime latch (a later successful write cannot clear it)
- this process subsequent authoritative FILL count is 0
- no watermark/ack of unproven data

If rename landed but directory fsync/readback is unproven: the current process does not publish. A fresh process re-validates the actual landed bytes. The current process does not guess success.

When the latch is set, `drainJournal()` returns empty `authoritativeExecutions`. Proven pending bytes remain on disk for a fresh process.

No-cursor-path unit tests remain in-memory only (`persistCursor` returns `COMMITTED` without I/O). That path makes no durability claim.

## FAULT_HOOK_MAPPING

Project-owned, test-only constructor hook: `onCursorPersistStep`. Production never installs it. No global `fs` monkeypatch.

| Boundary | Where |
|---|---|
| `BEFORE_TEMP_OPEN` | after mkdir/chmod, before exclusive temp open |
| `AFTER_TEMP_OPEN` | after `openSync(..., "wx", 0o600)` |
| `AFTER_WRITE` | after temp write |
| `AFTER_FILE_FSYNC` | after temp `fsync` |
| `AFTER_CLOSE` | after temp close |
| `BEFORE_RENAME` | immediately before `renameSync` |
| `AFTER_RENAME` | after atomic rename |
| `BEFORE_DIRECTORY_FSYNC` | before parent-dir fsync (Linux/GHA performs the fsync) |
| `AFTER_DIRECTORY_FSYNC` | after dir fsync or after the skipped non-Linux fsync |
| `BEFORE_READBACK` | before reopen/read |
| `AFTER_READBACK` | after read, before exact-byte/canonical validation |
| `BEFORE_MEMORY_COMMIT` | after `COMMITTED`, before applying the candidate in memory |
| `BEFORE_PUBLICATION` | after memory commit, before `drainJournal` can expose the record |

Hook context includes `{ cursorPath, phase: "accept" \| "ack" \| "invalidate" }`.

## REAL_SIGKILL_MATRIX

Child worker: `test/fixtures/execution-cursor-crash-worker.ts`  
Parent helper: `test/helpers/cursorPersistCrash.ts`

Parent prepares a fresh temp directory, spawns a child, waits for an IPC/ready-file notification at the named boundary, sends real `SIGKILL`, and never reuses child module state. Assertions use a second process (`inspect` / `replay`) that loads only durable bytes.

| Case | Kill window | Current process | Fresh process | Local result |
|---|---|---|---|---|
| C-C18 | `AFTER_FILE_FSYNC` / `BEFORE_RENAME` | zero FILL; `SIGKILL` observed | no unpersisted pending on disk; exchange replay produced exactly one FILL | PASS |
| C-C19 | `AFTER_RENAME` / `BEFORE_DIRECTORY_FSYNC` | zero FILL; `SIGKILL` observed | follow landed bytes (valid pending → drain that record; invalid/missing → fail closed) | PASS |
| C-C20 | `AFTER_DIRECTORY_FSYNC` / `BEFORE_PUBLICATION` | zero FILL; `SIGKILL` observed | durable pending present; exactly one eventual FILL; no silent loss | PASS |

These cases throw no exception as a SIGKILL substitute. They are not skipped on Ubuntu or Darwin.

## C-C22 old proven record disposition

Pre-existing trusted durable pending record `tr-proven` remains on disk after a later persist failure for `tr-unproven`.

- The new record is never committed to memory or disk.
- The current process latches and publishes zero FILLs.
- `journalSnapshot()` still shows the old proven record for evidence.
- A fresh process reloads the durable pending record and can drain it.

## C-C21 publication → watermark crash window

If telemetry FILL append succeeds and published-watermark persist then fails:

- Current process latches and stops subsequent authoritative FILLs.
- In-memory and disk `publishedDedupeKeys` are not updated.
- The record remains durable pending.
- Fresh restart re-drains it (documented at-least-once).
- Duplicate identification is `exchange_trade_id` / `dedupeKey`.
- This is **not** exactly-once.

## FILES_CHANGED

| File | Why |
|---|---|
| `src/venues/extendedAccountStream.ts` | staged candidate persist; explicit dispositions; latch; test-only fault hooks |
| `test/experiment-v02-execution.test.ts` | C-C16..C-C24 |
| `test/fixtures/execution-cursor-crash-worker.ts` | child-process accept/inspect/replay worker |
| `test/helpers/cursorPersistCrash.ts` | parent SIGKILL / fresh-process helpers |
| `package.json` | `test:execution` script |
| `.github/workflows/ci.yml` | pin Node 22.23.2; print toolchain; record `npm audit --json` without hiding it |
| `docs/classic-v0.2-checkpoint-c-corrective-2.md` | this evidence note |

Unchanged on purpose:

```text
src/loop.ts
src/experimentTelemetry.ts
src/venues/extended.ts
src/venues/types.ts
src/experimentReduction.ts
src/experimentRisk.ts
src/grid.ts
src/config.ts
vendor/**
```

Frozen v0.2 envelope is unchanged: capital=100 USDT, leverage=5x, marginFraction=0.30, plannedGrossNotionalCap=150 USDT, levels=10, gridHalfBand=0.03, dailyLossHalt=5 USDT, startingDrawdownHalt=10 USDT, boundaryBuffer=0.01, venue=Extended, market=BTC.

## DIFF_STAT

Implementation commit `69b4a6b608cd6ec95757bea0ca42b9dfb00f3f88` (`BASE_HEAD..IMPLEMENTATION_HEAD`):

```text
 .github/workflows/ci.yml                       |   9 +-
 package.json                                   |   1 +
 src/venues/extendedAccountStream.ts            | 328 ++++++++++++++++++++----
 test/experiment-v02-execution.test.ts          | 338 +++++++++++++++++++++++++
 test/fixtures/execution-cursor-crash-worker.ts | 170 +++++++++++++
 test/helpers/cursorPersistCrash.ts             | 127 ++++++++++
 6 files changed, 928 insertions(+), 45 deletions(-)
```

## COMMANDS_AND_EXIT_CODES

| Command | Exit |
|---|---|
| `git status --short` (start) | 0, empty |
| `git branch --show-current` | 0, `experiment/classic-v0.2-100u-safety` |
| `git rev-parse HEAD` | 0, `8d52b67d234ed5a76bb972f566c41ae42e7dda5c` |
| `git rev-parse HEAD^{tree}` | 0, `5db57c5b43940195bc295d72dbf0367a9f8d108c` |
| `npm ci` | 0 (also printed 22 vulnerabilities; not hidden) |
| `npm run typecheck` | 0 |
| `node --import tsx --test test/experiment-v02-execution.test.ts` | 0 |
| `npm run check` | 0 (outside sandbox; unix-socket lease tests need real `listen`) |
| `npm audit --json` | 1 (inventory only; no upgrade and no `--force`) |
| `git diff --check` | 0 |

Sandbox `npm run check` failed 7 pre-existing unix-socket lease tests with `listen EPERM`. Those tests pass outside the sandbox and on GitHub Actions Ubuntu. Not a product regression.

## TEST_TOTAL_PASS_FAIL_SKIP

Execution file only:

```text
tests 47
pass 47
fail 0
skipped 0
```

Full `npm run check` node:test runner (excludes `grid.test.ts` script, which printed `grid.test.ts OK`):

```text
tests 280
pass 280
fail 0
cancelled 0
skipped 0
todo 0
```

Prior node:test total was 271. This corrective adds C-C16..C-C24 (9 tests). `271 + 9 = 280`. All prior C-01..C-22 and C-C1..C-C15 remain and were not weakened.

## AUDIT_SUMMARY

`npm audit --json` (audit report version 2). **Not fixed in this corrective.** Warnings are not hidden.

```text
vulnerabilities: 22 (0 info, 0 low, 8 moderate, 14 high, 0 critical)
dependency counts reported by audit: prod=302, dev=0, optional=31, peer=33, total=364
```

Direct production parents from `package.json` that audit marks:

| Package | Severity | Role | Direct parent / notes |
|---|---|---|---|
| `@n1xyz/nord-ts` | high | production direct | via `@n1xyz/proton`, `@solana/spl-token`, `@solana/web3.js` |
| `@nadohq/client` | high | production direct | via `@nadohq/*` clients and `viem` |
| `@nadohq/shared` | high | production direct | via `viem` |
| `viem` | high | production direct | via nested `ws@8.0.0-8.20.1` DoS advisory |
| `@solana/web3.js` | moderate | production direct | via `jayson` → `uuid` |
| `undici` | moderate | production direct | retry desync / CRLF / cookie injection advisories |

Transitive (not direct in `package.json`):

| Package | Severity | Direct parent chain |
|---|---|---|
| `@n1xyz/proton` | high | `@n1xyz/nord-ts` |
| `@nadohq/engine-client` | high | `@nadohq/client` |
| `@nadohq/indexer-client` | high | `@nadohq/client` |
| `@nadohq/mobile-client` | high | `@nadohq/client` |
| `@nadohq/trigger-client` | high | `@nadohq/client` |
| `axios` | high | `@nadohq/*` clients |
| `@solana/spl-token` | high | `@n1xyz/nord-ts` / `@n1xyz/proton` |
| `@solana/buffer-layout-utils` | high | `@solana/spl-token` |
| `bigint-buffer` | high | `@solana/buffer-layout-utils` |
| `ws` (nested under `viem`) | high | `viem` |
| `@coral-xyz/anchor` | moderate | `@n1xyz/proton` |
| `@coral-xyz/borsh` | moderate | `@coral-xyz/anchor` |
| `@solana/spl-token-group` | moderate | `@solana/spl-token` |
| `@solana/spl-token-metadata` | moderate | `@solana/spl-token` |
| `jayson` | moderate | `@solana/web3.js` |
| `uuid` | moderate | `jayson` |

No `npm audit fix` and no `npm audit fix --force` were run.

## KNOWN_LIMITATIONS

- Checkpoint D planner deduplication is not started.
- Checkpoint E integrated campaign is not started.
- Execution records still do not advance planner completed-rung or `plan.filled`.
- Directory fsync is required and performed on Linux and GitHub Actions. On Darwin the hooks still fire so SIGKILL tests run, but the kernel directory fsync is skipped. Durability proof for dir fsync is the Ubuntu CI matrix.
- C-C11 remains an in-process restart simulation. Real SIGKILL evidence is C-C18/C-C19/C-C20.
- FILL-append / watermark-persist crash window is at-least-once, not exactly-once.
- Cursor restart still does not restore `lastSeq`. Sequence-gap detection remains intra-connection.
- No production credentials. No live exchange write. No real-fund testing.
- 22 npm audit findings remain open on purpose.
- `persistCursor` with no `cursorPath` is in-memory `COMMITTED` and makes no disk durability claim.

## CI_RUN_IDS

```text
CI_RUN_IDS=PENDING_AFTER_PUSH
EXPECTED_TOOLCHAIN=Node 22.23.2 / npm 10.9.8
```

GitHub Actions must show exact branch-push HEAD success and PR event success, zero skipped crash cases on Ubuntu, 280 node:test tests passing, no production credential, no live exchange mutation.

## Independent review

The independent reviewer owns `PASS`, `REJECT`, or `BLOCKED`.

```text
CHECKPOINT_C_CORRECTIVE_2_SELF_DECLARED_PASS=NO
CHECKPOINT_C=REVIEW_CANDIDATE
CHECKPOINT_D_STARTED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
```
