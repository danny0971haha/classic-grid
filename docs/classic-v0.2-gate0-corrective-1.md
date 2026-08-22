# Classic Grid v0.2 — Gate 0 Corrective 1

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 0 REJECTED  
**Date:** 2026-08-22  
**Repository:** `danny0971haha/classic-grid`  
**Branch:** `experiment/classic-v0.2-100u-safety`  
**Rejected candidate:** `f2ff58abd42d7862910cb07fdf62a110ac4baa45`  
**Rejected candidate tree:** `144caf5c9a00c54c9f0d18f4a48dcbd7a31d3c76`  
**CI evidence:** run `32574237497` completed successfully, but green CI is not sufficient for Gate 0 acceptance.

## 1. Independent decision

```text
GATE_0=REJECT
CHECKPOINT_A_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

The candidate adds substantial durable-ACK and halt-identity work, but it does not yet prove the required fail-closed semantics across runtime-lease turnover, persistence failure, and real process death.

Implement only this corrective. Do not start Checkpoint A.

## 2. Rejection findings

### CG-G0-R1 — ACK is not atomically bound to the active runtime lease

Current startup order is effectively:

```text
acquire new runtime lease
-> load durable halt
-> acknowledge durable halt using the predecessor state's old leaseGeneration
-> commit RUNNING
-> afterward replace leaseGeneration with the newly acquired lease generation
-> persist again
```

A crash between the ACK commit and the later lease-generation rewrite can leave durable `RUNNING` bytes bound to an old lease generation. On the next restart, the stale durable `RUNNING` record can bypass the intended current-lease-bound acknowledgement transition.

Required correction:

- pass current runtime lease authority explicitly into the acknowledgement operation;
- prove the active scope and active lease generation independently of caller state;
- commit `RUNNING` with the **current active lease generation in the same durable transaction** that clears the halt;
- remove the follow-up "ACK first, rebind lease later" window;
- assert that the active lease remains current immediately before every authoritative state mutation and again before accepting final verification.

### CG-G0-R2 — `FORCED_HALT_IN_MEMORY_ONLY` does not survive restart

The current forced-halt latch is process-local. If both the initial `HALTING` persist and the final halted-state persist fail, durable bytes may remain at an older `RUNNING` generation. Process restart clears the in-memory map, so the old durable `RUNNING` record can be trusted without evidence that the prior process entered an unresolved emergency path.

Required correction:

Introduce a startup/restart proof that exists **before risk-increasing operation is possible** and survives an unclean or forced-halt termination. An acceptable design may use a verified runtime-session/reconciliation sentinel, an extension of the runtime-lease record, or another bounded durable mechanism, provided that it proves all of the following:

- startup cannot enter normal trading unless the current session marker is durably created and verified;
- an unclean previous session, forced in-memory halt, or unresolved persistence failure causes `RECONCILIATION_REQUIRED` / fail-closed startup;
- a clean marker cannot be written or cleared merely from caller memory;
- failure to create or verify the marker blocks startup;
- a clean shutdown may clear/complete the marker only after required state checks succeed;
- the mechanism is bound to experiment, scope, and lease generation;
- a stale `RUNNING` risk-state record alone is insufficient after an unresolved prior runtime.

Do not rely on a process-local `Map` as restart authority.

### CG-G0-R3 — acknowledged halt identity is not durably auditable

The candidate prints the acknowledged halt ID to `console.info`, but the committed `RUNNING` payload clears `haltId` and does not durably retain which halt incident was acknowledged. A crash after state commit and before the log/telemetry side effect leaves no durable acknowledgement lineage.

Required correction:

Co-commit an explicit historical acknowledgement record inside the checksummed authoritative state transition, for example:

```ts
type HaltAcknowledgementRecord = {
  haltId: string;
  acknowledgedAt: string;
  scopeKey: string;
  predecessorStoreGeneration: number;
  predecessorEnvelopeSha256: string;
  priorLeaseGeneration: string | null;
  activeLeaseGeneration: string;
};
```

Equivalent names are allowed. The record must be part of the hashed durable payload and verified after commit. Console or best-effort telemetry alone is insufficient.

### CG-G0-R4 — crash evidence is not real hard-termination coverage

The current worker calls `process.exit(33)` from inside the fault hook. That is not equivalent to a parent process delivering `SIGKILL`/hard termination. The current matrix also targets the primary path but does not independently cover all meaningful backup and primary write windows.

Required correction:

- child process must pause/signal readiness at a declared fault boundary;
- parent process must deliver real `SIGKILL` on supported Unix systems, or a documented equivalent hard termination on other platforms;
- parent must inspect bytes through a fresh process/module load;
- run the applicable atomic windows independently for backup and primary targets;
- do not reuse child memory, module globals, or process-local latches;
- report observed disk disposition, not only the fault-hook name.

Required post-crash outcomes are limited to:

```text
proven old halted authority
proven complete new acknowledgement lineage followed by restart reconciliation
fail-closed / reconciliation required
```

A naked `RUNNING` payload without durable acknowledgement lineage and current-lease proof is not acceptable.

### CG-G0-R5 — predecessor checks do not close the final mutation window

The acknowledgement path performs repeated inspection, but current-lease authority is not supplied to `persistRiskState()` and no equivalent serialization/fencing proof covers the final predecessor-read-to-write interval.

Required correction:

- acknowledgement mutation must execute under the current runtime ownership/fencing authority;
- predecessor generation/hash, scope, halt ID, and durable prior lease identity must be checked within that mutation boundary;
- active lease generation must be checked immediately before authoritative rename/write boundaries;
- a competing/stale owner must be unable to clear or overwrite a newer halt;
- add a two-process adversarial test showing a stale owner cannot commit after a newer owner/fencing generation exists.

A project-owned per-store mutation lock may be used if necessary, but it must itself fail closed after process death and remain subordinate to runtime lease generation.

## 3. Mandatory corrective tests

Add deterministic tests with stable case IDs covering at least:

```text
C1 active lease gN clears predecessor halt from gN-1 and commits RUNNING directly at gN
C2 crash after ACK state write but before final in-process verification
C3 crash before any post-ACK lease rebind; no stale-lease RUNNING may authorize startup
C4 lease lost immediately before ACK mutation -> no clear
C5 lease generation replaced between inspection and mutation -> no clear
C6 stale owner and current owner race -> stale owner cannot commit
C7 durable ACK record contains exact acknowledged haltId and predecessor lineage
C8 both HALTING persist and final halt persist fail
C9 fresh restart after C8 blocks normal operation despite older durable RUNNING bytes
C10 runtime/session reconciliation marker missing, corrupt, conflicting, or stale -> fail closed
C11 hard termination at every applicable backup write boundary
C12 hard termination at every applicable primary write boundary
C13 hard termination during ACK predecessor inspection/commit/final verification
C14 ACK token is consumed only after the final exact durable state is verified
C15 same incident preserves haltId; a later incident mints a new haltId
```

Tests must use fresh directories and fresh process reloads. Where `SIGKILL` is unavailable, mark the platform case explicitly and provide an equivalent hard-termination mechanism; do not silently replace it with a caught exception or normal process return.

## 4. Scope

Initially allowed production paths:

```text
src/experimentRisk.ts
src/experimentKillSwitch.ts
src/experimentStorage.ts
src/runtimeLease.ts
src/loop.ts
```

Allowed test paths:

```text
test/experiment-ack-authority.test.ts
test/experiment-killswitch.test.ts
test/runtime-lease.test.ts
test/fixtures/**
test/helpers/**
```

`package.json` may be changed only to register required focused tests/scripts.

Do not modify:

```text
vendor/**
venue adapters
v0.2 configuration values
strategy/grid geometry
telemetry schema unrelated to the durable acknowledgement audit record
dashboard behavior
deployment/service files
```

If the corrective requires another production path, stop with:

```text
BLOCKED_SCOPE_CHANGE_REQUIRED
```

and identify the exact path and invariant.

## 5. Prohibited actions

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USE=NO
DEPLOYMENT=NO
MERGE=NO
FORCE_PUSH=NO
CHECKPOINT_A_STARTED=NO
RISK_THRESHOLD_REDUCTION=NO
TEST_WEAKENING=NO
```

Emergency reduction behavior may be exercised only through test doubles/simulator fixtures. No real venue mutation is authorized.

## 6. Validation

Run from a clean checkout with the repository-required Node 22 baseline:

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

Also run focused corrective tests separately and report exact totals and exit codes.

## 7. Evidence packet

Stop after the corrective and return:

```text
CHECKPOINT=GATE_0_CORRECTIVE_1
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/classic-grid
BRANCH=experiment/classic-v0.2-100u-safety
BASE_SHA=<this contract commit parent/result binding>
HEAD_SHA=<candidate>
TREE_SHA=<candidate tree>

COMMITS:
<exact list>

CHANGED_FILES:
<exact list>

TESTS:
<commands, exit codes, totals>

FAULT_MATRIX:
<case ID | real termination method | target | observed disk disposition | fresh-process result>

LEASE_AND_ACK_EVIDENCE:
<active lease binding, predecessor binding, durable audit record, final verification>

RESTART_LATCH_EVIDENCE:
<how unresolved forced halt remains blocked after a completely fresh restart>

ARTIFACTS:
<raw patch path, bytes, LF count, SHA-256>

PROHIBITED_ACTION_ATTESTATION:
LIVE_EXCHANGE_WRITE=NO
DEPLOYMENT=NO
MERGE=NO
CHECKPOINT_A_STARTED=NO

KNOWN_LIMITATIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

The implementation agent must not self-declare Gate 0 PASS. After submitting this packet, stop.