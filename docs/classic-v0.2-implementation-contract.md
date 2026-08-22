# Classic Grid v0.2 — Bounded Implementation Contract

**Status:** AUTHORITATIVE ENGINEERING PLAN / IMPLEMENTATION NOT YET ACCEPTED  
**Date:** 2026-08-22  
**Tracking issue:** [#2](../issues/2)  
**Draft PR:** [#3](../pull/3)  
**Parent safety baseline:** `experiment/classic-v0.1` @ `a168c487e210306aab17cf428dec67d8168b68fe`  
**Pre-contract v0.2 head:** `b9289ed485e9033f0867fc84e333c93e85e19dba`  
**Functional specification:** [`docs/experiment-spec-v0.2-100u-safety.md`](./experiment-spec-v0.2-100u-safety.md)

## 1. Decision

The v0.2 branch is **not ready for feature implementation to be treated as accepted**, and it is not live-canary-ready.

The branch currently contains the v0.2 specification only. Before the 100U configuration, active exposure reduction, or fill telemetry can be accepted, the implementation must close inherited v0.1 fail-closed gaps in durable halt acknowledgement and halt identity.

Required execution order:

1. **Gate 0 — inherited safety invariants**
2. **Checkpoint A — versioned v0.2 configuration**
3. **Checkpoint B — actual-notional hard reduction/flatten path**
4. **Checkpoint C — exchange-observed execution journal and telemetry**
5. **Checkpoint D — deterministic planner deduplication without inferred fills**
6. **Checkpoint E — dry-run, restart, and fault-injection evidence**
7. **Independent phase-gate review**

No later checkpoint may be used to bypass an earlier failed or incomplete gate.

## 2. Explicit non-authorization

This document does **not** authorize any of the following:

- live exchange writes;
- use of real funds as a test substitute;
- deployment to a VPS or production host;
- merging PR #3;
- merging PR #1;
- increasing capital above 100 USDT;
- increasing leverage above 5x;
- enabling multiple venues or markets;
- treating CI success as trading approval;
- treating a dry-run PASS as live approval;
- committing API keys, private keys, account secrets, cookies, tokens, or unredacted environment files.

PR #3 must remain Draft until a separate, explicit live-canary review is completed.

## 3. Verified current state

| Area | Current state | Gate status |
|---|---|---|
| v0.2 specification | Present | PASS as planning input only |
| Baseline CI for pre-contract head | Successful | PASS as build evidence only |
| v0.2 implementation | No functional code changes yet | NOT STARTED |
| Durable ACK final-authority semantics | Caller state can still authorize a clear | BLOCKED |
| Non-running halt identity | `haltId` is not enforced for every non-`RUNNING` state | BLOCKED |
| Actual notional over cap | Classified as `reduceOnly`, but only cancel intents survive | BLOCKED |
| Authoritative fill telemetry | Planner no longer infers fills, but no accepted exchange execution journal exists | NOT STARTED |
| Fault-injection evidence | No v0.2 matrix yet | NOT STARTED |
| Live authorization | Not granted | PROHIBITED |

### 3.1 Current-byte safety debt that must not be hidden by v0.2 work

At the pre-contract head:

- `acknowledgeHaltIfRequested()` accepts a caller-supplied state and can persist `RUNNING` after matching `EXPERIMENT_HALT_ACK`; it does not perform a final durable compare-and-commit against the exact authoritative halt record at the commit point;
- the risk-state validator permits `haltId=null` outside `RUNNING`;
- `runExperimentKillSwitch()` can transition to `HALTING` without first guaranteeing a unique durable or in-memory halt identity;
- `ACTUAL_NOTIONAL_CAP` sets `reduceOnly=true`, while `filterRiskIncreasingIntents()` retains only cancellations;
- the loop therefore has no accepted path that actively reduces position exposure for an actual-position cap breach.

These are release blockers, not optional refactors.

## 4. Frozen v0.2 engineering envelope

The following values are binding for v0.2 engineering validation:

| Parameter | Required value |
|---|---:|
| Experiment spec version | `0.2.0` |
| Starting capital | 100 USDT |
| Exchange leverage | 5x |
| Margin fraction | 0.30 |
| Maximum margin budget | 30 USDT |
| Maximum planned gross notional | 150 USDT |
| Grid levels | 10 total |
| Grid half-band | 0.03 / ±3% |
| Daily-loss hard halt | 5 USDT |
| Drawdown-from-start hard halt | 10 USDT |
| Boundary buffer | 0.01 / 1% |
| Venue/market engineering target | Extended / BTC only |
| Tick target | 15 seconds |

The arithmetic invariant is:

```text
100U capital × 0.30 margin fraction × 5x leverage = 150U planned gross notional
```

Legacy non-experiment defaults must remain unchanged.

---

# Gate 0 — Inherited fail-closed safety invariants

## 5. Goal

Make durable halt state the sole authority for acknowledgement and guarantee that every non-running state has a unique halt identity.

Gate 0 must be implemented and independently accepted before Checkpoint A begins.

## 6. Required halt-state invariants

The state validator and all transition writers must enforce:

1. `RUNNING` implies:
   - `halted === false`;
   - `haltId === null`;
   - no active halt reasons.
2. Every non-`RUNNING` status implies:
   - `halted === true`;
   - `haltId` is a non-empty unique string;
   - `acknowledged === false` unless the field is replaced by an explicit historical acknowledgement record.
3. A transition into `HALTING`, `HALTED_UNFLAT`, `HALTED_FLAT`, or `HALT_FAILED` must preserve the same halt identity for the same incident.
4. A new halt incident after a completed acknowledgement must mint a new identity.
5. State scope and lease generation must not silently change during an acknowledgement or halt transition.
6. Invalid, ambiguous, missing, conflicting, or unverifiable state remains halted.

## 7. Durable acknowledgement authority

Replace the caller-state clear path with a dedicated durable acknowledgement operation.

The accepted operation must:

1. read and verify the authoritative primary/backup pair;
2. reject missing, corrupt, conflicting, legacy-ambiguous, or non-halted state;
3. compare the supplied acknowledgement token to the **currently durable** `haltId`;
4. bind the transition to the current scope, lease generation, store generation, and predecessor envelope hash;
5. perform a compare-and-commit transition that fails if the authoritative predecessor changes;
6. re-read and verify the committed result;
7. consume the environment acknowledgement only after verified commit;
8. never clear a newer halt using an older caller object or older token;
9. emit an auditable acknowledgement record containing the acknowledged halt identity without exposing secrets.

A plain read followed by an unconditional `persistRiskState()` is insufficient because a newer halt can appear between the read and write.

### 7.1 Required adversarial ACK tests

Tests must prove rejection of:

- static values such as `YES`;
- an old halt token after a newer halt has been committed;
- a caller-forged `RUNNING` state;
- a stale caller state whose `haltId` differs from durable state;
- a stale caller state whose scope or lease generation differs;
- a predecessor generation/hash change between inspection and commit;
- a truncated or corrupt primary with a valid backup;
- a same-generation primary/backup hash conflict;
- a persistence failure after token validation;
- a crash at every durable-write boundary.

No test may pass by merely calling the function with a freshly loaded state. The race and stale-authority cases are mandatory.

## 8. Kill-switch halt identity

Before any risk-increasing operation is possible, a halt incident must have a unique identity in memory. The kill path must then attempt to persist and verify `HALTING` with that identity.

If durable persistence or reinspection fails:

- latch `FORCED_HALT_IN_MEMORY_ONLY` or an equivalent explicit condition;
- prohibit all new placement and reseeding;
- prohibit acknowledgement in that process;
- allow only exposure-reducing emergency actions such as owned-order cancellation and reduce-only flattening;
- require restart/reconciliation before any return to `RUNNING`;
- preserve fail-closed behavior on restart when durable state is missing or corrupt.

Emergency cancellation/flattening must not be suppressed merely because persistence failed, but persistence failure can never be interpreted as permission to resume.

## 9. Gate 0 acceptance

Gate 0 is PASS only when all of the following are present:

- exact code diff and current-byte patch;
- focused ACK race tests;
- non-running `haltId` invariant tests;
- kill-switch persistence-failure tests;
- crash-boundary matrix with fresh process reloads;
- clean `npm run check`;
- independent review result `PASS`.

A green CI run without the adversarial cases is insufficient.

---

# Checkpoint A — Versioned v0.2 configuration

## 10. Goal

Introduce v0.2 values without mutating legacy or v0.1 behavior.

## 11. Required configuration design

1. Model supported experiment versions explicitly, at minimum:

```ts
type ExperimentSpecVersion = "0.1.0" | "0.2.0";
```

2. Resolve configuration from a version-specific frozen profile rather than replacing the v0.1 constants in place.
3. Require `EXPERIMENT_SPEC_VERSION=0.2.0` for the v0.2 profile.
4. Fail closed on an unsupported or malformed version when `EXPERIMENT_MODE=1`.
5. Preserve non-experiment defaults byte-for-byte unless a separate approved reason exists.
6. Preserve v0.1 behavior for PR #1 and historical tests.
7. Update `.env.example` with non-secret examples only.
8. Do not add a live v0.2 allowlist in this checkpoint. Live authorization remains disabled.

## 12. Required configuration tests

Tests must cover:

- exact 100U / 5x / 0.30 / 10 / 0.03 / 150U / 5U / 10U / 0.01 resolution;
- exact 30U margin budget and 150U planned notional;
- unsupported spec version rejection;
- malformed numeric values;
- v0.1 compatibility;
- non-experiment compatibility;
- live mode still rejected for v0.2;
- single venue and single market restrictions remain enforced.

Checkpoint A must not modify venue write behavior.

---

# Checkpoint B — Actual-notional active reduction/flatten

## 13. Safety decision for v0.2

For the 100U canary, the minimum accepted behavior for `ACTUAL_NOTIONAL_CAP` is a **hard halt plus verified full flatten**.

Partial reduction back to the cap is optional and must not be used to delay the safe minimum. It requires a separate, independently reviewed target-sizing and rounding contract.

This means:

- `PLANNED_NOTIONAL_CAP` may stop placements and cancel owned risk-increasing orders;
- `ACTUAL_NOTIONAL_CAP` must enter a halt/reduction lifecycle and invoke a reduce-only flatten path;
- an exchange submit acknowledgement is not proof of reduced exposure;
- only a fresh authoritative snapshot can verify success;
- no automatic reseed is allowed after an actual-notional incident, even when the position later appears inside the cap;
- manual acknowledgement and a fresh reconciliation are required before any future run.

## 14. Required lifecycle

The accepted lifecycle must be explicit and testable. Equivalent names are allowed, but semantics must distinguish:

```text
NORMAL
CANCEL_RISK_INCREASING
HALTING / REDUCING_EXPOSURE
HALTED_UNFLAT
HALTED_FLAT
HALT_FAILED
```

For an actual-position breach:

1. acquire/assert the current runtime lease;
2. mint or preserve the incident `haltId`;
3. latch halt in memory;
4. persist/verify `HALTING` when possible;
5. stop all placements;
6. cancel experiment-owned risk-increasing open orders, or use market-wide cancellation only when the dedicated account-scope precondition is independently verified;
7. invoke a venue-supported reduce-only flatten operation;
8. fetch a fresh authoritative snapshot after the write;
9. verify both:
   - position is within the configured tolerance, with v0.2 target equal to flat;
   - no experiment-owned risk-increasing orders remain;
10. persist `HALTED_FLAT`, `HALTED_UNFLAT`, or `HALT_FAILED`;
11. prohibit reseeding and planner-state advancement.

## 15. Venue API boundary

Do not encode a position-reduction order as a normal grid `place` intent.

Use an explicit venue capability, for example:

```ts
type ReductionRequest = {
  market: string;
  targetAbsPositionQty: number; // v0.2 safe minimum: 0
  incidentId: string;
  leaseGeneration: string;
};

type ReductionResult = {
  submitted: boolean;
  ambiguous: boolean;
  exchangeOrderId?: string;
  clientOrderId?: string;
};
```

The exact names may differ, but the API must:

- be reduce-only at the venue;
- be idempotent or reconcile an ambiguous previous submit;
- carry deterministic incident identity where the venue supports client order IDs;
- reject stale lease generation;
- never increase absolute exposure;
- expose ambiguity instead of guessing success.

The existing Extended vendor primitive accepts an optional close quantity. It may be adapted, but the entire upstream commit must not be cherry-picked as a substitute for this contract.

## 16. Required reduction tests

At minimum:

- actual notional `150.00U` does not breach; `>150.00U` does;
- breach invokes active flatten, not cancel-only behavior;
- long and short positions both use the exposure-reducing side;
- rounding cannot increase absolute position;
- cancel failure keeps the state halted;
- flatten submit failure keeps the state halted;
- ambiguous flatten submit requires fresh reconciliation;
- fresh snapshot still over cap produces retry or `HALTED_UNFLAT`;
- stale snapshot cannot verify success;
- flat snapshot plus remaining owned risk-increasing order cannot produce `HALTED_FLAT`;
- lease loss before any write prevents that write;
- lease loss between cancel and flatten prevents unsafe continuation and remains halted;
- persistence failure still permits only emergency risk-reducing actions;
- restart during each lifecycle step cannot reseed;
- a successful flatten never automatically clears the halt.

---

# Checkpoint C — Exchange-observed execution journal and telemetry

## 17. Goal

Emit authoritative `FILL` telemetry only from exchange-observed executions. Do not reintroduce open-order-disappearance inference.

## 18. Required normalized execution record

Add an explicit normalized type. It must contain, where the venue provides the fields:

```ts
type ExecutionRecord = {
  source: "exchange";
  venue: VenueId;
  market: string;
  side: Side;
  price: number;
  quantity: number;
  exchangeTradeId?: string;
  exchangeOrderId?: string;
  clientOrderId?: string;
  cumulativeFilledQuantity?: number;
  remainingQuantity?: number;
  exchangeTimestamp?: string;
  observedAt: string;
  streamConnectionId: string;
  streamSequence: number;
  dedupeKey: string;
};
```

Requirements:

- price and quantity must be finite and positive;
- side and market must be normalized;
- trade/order/client identifiers must be preserved, not replaced by local guesses;
- duplicate websocket delivery or reconnect replay must not double-count an execution;
- sequence gaps, disconnects, or unidentifiable execution identity must be explicit reconciliation faults;
- a locally derived hash may be used as a dedupe key only from canonical exchange-observed fields; it must not turn an inferred event into an exchange-confirmed event;
- a venue event lacking enough identity for replay-safe accounting must not advance authoritative completed-rung or realized-fill metrics.

## 19. Extended account-stream work

The Extended account websocket already receives `TRADE` messages. Extend it with a bounded execution journal or cursor-based reader that:

- retains normalized execution payloads rather than only event metadata;
- binds records to connection ID and sequence;
- provides deterministic deduplication;
- exposes a cursor/checkpoint suitable for restart reconciliation;
- invalidates authority on sequence gaps;
- supports fixtures for full fill, partial fill, duplicate delivery, reconnect replay, malformed payload, and out-of-order data.

Do not couple raw websocket callbacks directly to grid order placement.

## 20. Planner boundary for v0.2

For v0.2, exchange executions may drive telemetry and audited counters, but they must not drive replacement-order state until replay, deduplication, partial-fill, and restart semantics are independently accepted.

The existing safe behavior of keeping `plan.filled` empty is preferable to reintroducing disappearance-based inference.

Grid gaps may continue to be repaired from authoritative open-order snapshots subject to ownership and notional guards.

## 21. Telemetry semantics

Required events:

- `FILL` — only exchange-observed execution, with `source=exchange`;
- `ORDER_DISAPPEARED` — diagnostic/inferred condition only, never counted as a fill;
- `EXECUTION_RECONCILIATION_REQUIRED` — gap, malformed identity, replay ambiguity, or journal discontinuity;
- `REDUCTION_STARTED`;
- `REDUCTION_SUBMITTED`;
- `REDUCTION_VERIFIED`;
- `REDUCTION_FAILED`.

Partial fills must preserve actual filled quantity. A partial fill is an execution event, but it must not be represented as a completed full order unless terminal status is proven.

## 22. Required execution tests

- full exchange fill produces one `FILL`;
- duplicate delivery produces one authoritative record;
- partial fill preserves quantity and remaining/cumulative data;
- two legitimate partial fills are not collapsed into one;
- order disappearance produces no `FILL`;
- cancel produces no `FILL`;
- rejection produces no `FILL`;
- sequence gap invalidates the journal and requests reconciliation;
- reconnect replay does not double-count;
- malformed/non-finite fields are rejected;
- missing stable identity does not advance authoritative counters;
- restart from a persisted cursor is replay-safe;
- telemetry failure never controls exchange-risk handling.

---

# Checkpoint D — Deterministic planner deduplication

## 23. Goal

Eliminate duplicate-order selection oscillation while preserving experiment ownership and fill-provenance safety.

The upstream commit `beibei030/classic-grid@e26ab196e01245ad70d0eb41e1b7ffc64249cd44` contains a deterministic duplicate-order retention idea. Adapt the idea; do not cherry-pick the whole commit.

## 24. Required dedup semantics

For each logical experiment-owned slot:

1. classify ownership from the deterministic experiment prefix;
2. validate expected client order identity, side, level, price tolerance, and size tolerance;
3. group only valid experiment-owned duplicates for the same logical slot;
4. deterministically retain one order using a stable key such as exchange order ID then normalized order ID;
5. cancel only the remaining experiment-owned duplicates;
6. never cancel, claim, or count an unowned/manual order as experiment-owned;
7. ensure input array order cannot change the survivor;
8. preserve the rule that open-order disappearance is not a fill;
9. preserve post-batch notional checking and lease fencing.

## 25. Required planner tests

- every permutation of the same duplicate set selects the same survivor;
- unowned orders are never cancelled;
- malformed owned orders are cancelled;
- valid order plus malformed duplicate retains the valid order;
- duplicate buy and sell identities are not conflated;
- stale anchor-epoch orders are cancelled only when owned;
- dedup cancellation respects `maxWritesPerTick`;
- dedup never emits `FILL`;
- planner output is deterministic across repeated runs.

---

# Checkpoint E — Dry-run and fault-injection evidence

## 26. Required test layers

### 26.1 Unit and contract tests

Suggested bounded files:

- `test/experiment-v02-config.test.ts`;
- `test/experiment-ack-authority.test.ts`;
- `test/experiment-reduction.test.ts`;
- `test/extended-executions.test.ts`;
- extensions to `test/experiment-risk.test.ts`;
- extensions to `test/experiment-killswitch.test.ts`;
- extensions to `test/runtime-lease.test.ts`;
- planner dedup tests in `test/grid.test.ts` or a dedicated file.

### 26.2 Process/crash matrix

Use fresh child processes and fresh durable reloads. Inject termination or write failure around:

- before/after HALTING primary write;
- before/after primary verification;
- before/after backup rotation;
- before/after acknowledgement predecessor inspection;
- before/after acknowledgement commit;
- before cancel submit;
- after cancel submit but before acknowledgement;
- before flatten submit;
- after flatten submit but before acknowledgement;
- before fresh verification snapshot;
- after verified flat snapshot but before final durable state;
- runtime lease loss at each write boundary;
- websocket sequence gap and reconnect;
- partial/ambiguous apply;
- risk-state primary corruption and backup conflict.

Every case must prove that restart cannot seed new risk unless durable state and reconciliation explicitly permit it.

### 26.3 Bounded dry-run

Dry-run evidence must show:

- v0.2 configuration banner and exact frozen values;
- planned gross notional at or below 150U;
- no live exchange write path invoked;
- actual-over-cap fixture enters halt/flatten simulation rather than cancel-only mode;
- inferred disappearance does not emit `FILL`;
- exchange fixtures emit provenance-complete `FILL` records;
- restart preserves anchor and halt state;
- no duplicate experiment-owned logical orders.

Dry-run is engineering evidence only. It is not a live authorization.

---

# 27. Upstream update disposition

The upstream 2026-08-19 commit must be split by behavior and reviewed independently.

| Upstream behavior | Disposition | Reason |
|---|---|---|
| Deterministic duplicate retention | ADAPT | Useful, but must preserve ownership prefix, expected identity, size checks, and no inferred fills |
| Extended optional close quantity | ADAPT LATER / TEST FIRST | Useful primitive for bounded reduction, but v0.2 safe minimum may use full flatten |
| Decibel 48-hour ghost-order filter | CONDITIONAL / DEFER | Requires venue evidence, configurability, telemetry, and false-positive analysis; not needed for Extended-only canary |
| Per-venue dashboard mutation endpoints | DEFER | Expands unauthenticated/mutation surface; live experiment dashboard must remain local-only and mutation-gated |
| Mobile dashboard styling | DEFER | No safety value for this phase |
| Global `uncaughtException` / `unhandledRejection` continuation | REJECT FOR SAFETY PATHS | Continuing after unknown process corruption can violate fail-closed assumptions; use supervised fail-stop or explicit bounded recovery |
| Upstream disappearance-based fill inference | REJECT | Conflicts with authoritative fill provenance requirement |

Do not cherry-pick `e26ab196e01245ad70d0eb41e1b7ffc64249cd44` wholesale.

# 28. Implementation scope

## 28.1 Initially allowed production paths

- `.env.example`
- `src/config.ts`
- `src/types.ts`
- `src/experimentRisk.ts`
- `src/experimentKillSwitch.ts`
- `src/experimentTelemetry.ts`
- `src/loop.ts`
- `src/grid.ts`
- `src/runtimeLease.ts` only when required for an explicit lease invariant
- `src/venues/types.ts`
- `src/venues/extended.ts`
- `src/venues/extendedAccountStream.ts`
- `src/venues/extendedObservation.ts` only when required for freshness/reconciliation
- test files and test helpers
- `package.json` only to register tests/scripts
- documentation directly related to v0.2 evidence

## 28.2 Prohibited without a separate contract change

- `vendor/**`;
- adapters for venues other than Extended;
- dashboard mutation endpoints;
- withdrawal or transfer code;
- deployment scripts;
- production service configuration;
- secret-bearing files;
- strategy optimization or profitability tuning;
- leverage/capital expansion;
- unrelated refactors or formatting sweeps.

An implementation agent must stop the checkpoint and report `BLOCKED_SCOPE_CHANGE_REQUIRED` before modifying a prohibited or unlisted production path.

# 29. Commit and review sequencing

Use bounded commits. Do not deliver one monolithic patch.

Recommended sequence:

1. `fix(risk): make halt acknowledgement durable-authoritative`
2. `test(risk): add ack race and halt identity crash matrix`
3. `feat(config): add frozen v0.2 experiment profile`
4. `feat(risk): hard-flatten actual notional breaches`
5. `feat(telemetry): journal exchange-observed executions`
6. `fix(grid): make owned duplicate selection deterministic`
7. `test(experiment): add v0.2 dry-run and fault evidence`

After each checkpoint:

- stop implementation;
- provide current-byte evidence;
- request independent `PASS`, `REJECT`, or `BLOCKED`;
- do not start the next checkpoint after `REJECT` or `BLOCKED`.

The implementation agent may push bounded commits only to `experiment/classic-v0.2-100u-safety`. It may not merge, deploy, enable live mode, or rewrite published history.

# 30. Required verification commands

Run from a clean checkout using Node 22:

```bash
node --version
npm --version
npm ci
npm run check
git diff --check
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

Also report:

```bash
git diff --stat <checkpoint-base>...HEAD
git diff --name-status <checkpoint-base>...HEAD
git log --oneline --decorate <checkpoint-base>..HEAD
```

Perform a secret scan over changed files. Report paths and rule names only; never print secret values. Any suspected secret is an automatic `REJECT` until removed and rotated as appropriate.

# 31. Current-byte evidence packet

Every checkpoint review request must include:

1. repository, branch, checkpoint base SHA, candidate HEAD SHA, and tree SHA;
2. exact commit list;
3. exact changed-file list and numstat;
4. raw patch or independently downloadable patch artifact;
5. patch byte size, LF line count, and SHA-256;
6. production-file blob SHAs before and after;
7. test-file blob SHAs before and after;
8. raw command output for `npm ci`, `npm run check`, and focused tests;
9. fault-injection matrix with case IDs and outcomes;
10. statement that no live exchange write occurred;
11. statement that no deployment or merge occurred;
12. secret-scan result with values redacted;
13. known limitations and untested assumptions;
14. exact requested reviewer verdict: `PASS`, `REJECT`, or `BLOCKED`.

Self-authored summaries are not substitutes for patch bytes and reproducible evidence.

# 32. Acceptance rules

## PASS

A checkpoint is PASS only when:

- its bounded requirements are fully implemented;
- all required adversarial tests exist and pass;
- full `npm run check` passes from a clean install;
- the patch stays inside scope;
- current-byte evidence is complete;
- no live exchange write, deployment, secret exposure, or unrelated change occurred;
- independent review finds no unresolved safety blocker.

## REJECT

Use REJECT when evidence shows a concrete defect, including:

- stale caller state can clear a newer halt;
- a non-running state can persist without `haltId`;
- actual over-cap remains cancel-only;
- submit acknowledgement is treated as proof of reduced exposure;
- stale snapshot verifies flattening;
- inferred disappearance emits `FILL`;
- partial/ambiguous apply advances planner state;
- lease loss permits additional exchange writes;
- restart can reseed after unresolved halt/reduction;
- unowned orders are cancelled or claimed;
- required tests are absent or non-adversarial.

## BLOCKED

Use BLOCKED when the required decision cannot be made because evidence is missing, the patch cannot be reconstructed, the branch moved without rebinding, or a required scope/venue capability is unavailable.

# 33. Definition of engineering-ready

PR #3 may be described as **engineering-ready for a separate live-canary review** only after:

- Gate 0 and Checkpoints A–E independently PASS;
- the branch is frozen at an exact candidate SHA and tree SHA;
- clean Node 22 CI passes;
- fault-injection and restart evidence passes;
- authoritative execution provenance is demonstrated with fixtures;
- actual-notional breach actively flattens and verifies from a fresh snapshot;
- no automatic reseed occurs after a halt;
- no unresolved review thread or safety exception remains;
- a release evidence bundle is attached to PR #3.

Even then, the status is **not live-authorized**.

A later live-canary contract must separately define account isolation, credential permissions, deployment identity, observability, rollback/stop procedure, maximum runtime, operator presence, and explicit authorization for the exact frozen commit.

# 34. Implementation-agent response format

At the end of each checkpoint, respond exactly with:

```text
CHECKPOINT=<GATE_0|A|B|C|D|E>
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/classic-grid
BRANCH=experiment/classic-v0.2-100u-safety
BASE_SHA=<40-hex>
HEAD_SHA=<40-hex>
TREE_SHA=<40-hex>
LIVE_EXCHANGE_WRITES=NO
DEPLOYMENT=NO
MERGE=NO
WORKTREE_CLEAN=<YES|NO>

CHANGED_FILES:
<exact list>

TESTS:
<commands and raw-result summary>

FAULT_MATRIX:
<case IDs and outcomes>

ARTIFACTS:
<patch path, bytes, LF lines, SHA-256>

KNOWN_LIMITATIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

No claim such as “safe”, “complete”, “production-ready”, or “live-ready” is valid without the independent gate verdict.