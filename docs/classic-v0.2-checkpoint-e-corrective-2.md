# Classic Grid v0.2 — Checkpoint E Corrective 2

**Status:** CHECKPOINT_E_CORRECTIVE_2_REVIEW_CANDIDATE / INDEPENDENT REVIEW REQUIRED
**Date:** 2026-08-25
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Draft PR:** `#3`
**Current task:** `CHECKPOINT_E_CORRECTIVE_2`

This document does **not** declare Checkpoint E PASS. CI success is not a gate verdict. The implementation agent must not self-declare PASS. Authoritative CI run IDs, artifact ID, and digest for this candidate are recorded only in Draft PR #3 body so that recording them does not create a follow-up docs commit.

```text
CHECKPOINT=E_CORRECTIVE_2
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
AUTHORITATIVE_START_HEAD=55c75e6eb9920bf669c3fdadb00b0cdf04caabbf
AUTHORITATIVE_START_TREE=2a54ac24bb97b5dcf0ce6ef799f1bf87b980b947
ACCEPTED_CHECKPOINT_C_HEAD=13a96e12b7fc29485cb46fe471fb3cf5c0604404
REJECTED_CHECKPOINT_E_HEAD=8a53843c1049323478b29e590934a48771dcfe89
REJECTED_CHECKPOINT_E_CORRECTIVE_1_HEAD=55c75e6eb9920bf669c3fdadb00b0cdf04caabbf
REJECTED_CHECKPOINT_E_CORRECTIVE_1_TREE=2a54ac24bb97b5dcf0ce6ef799f1bf87b980b947
REJECTION_CLASS=EVIDENCE_SCHEMA_AND_CLAIM_INTEGRITY
KNOWN_PRODUCTION_DEFECT_FROM_THIS_REVIEW=NO
EVIDENCE_SCHEMA=classic-v0.2-checkpoint-e/3
EVIDENCE_ARTIFACT_NAME=classic-v0.2-checkpoint-e-results
```

Current-byte check at start: HEAD and TREE matched `AUTHORITATIVE_START_*`. Working tree was clean. Local HEAD equaled `origin/experiment/classic-v0.2-100u-safety`. No reset, rebase, amend, or force-push.

Local toolchain: Node v26.5.0 / npm 11.17.0. GitHub Actions must prove Node v22.23.2 / npm 10.9.8. `src/**` is byte-unchanged.

## BLOCKER_DISPOSITION

```text
BLOCKER_ID=E-C2-01
BLOCKER=FULLSUITE_COPIES_CHECKPOINT_E_TAP
DISPOSITION=FIXED_IN_CANDIDATE

BLOCKER_ID=E-C2-02
BLOCKER=E-28_OVERCLAIMS_PRIOR_SUITE_GREEN
DISPOSITION=FIXED_IN_CANDIDATE
```

### E-C2-01

Corrective 1 schema `classic-v0.2-checkpoint-e/2` stored `eCases` and `fullSuite` from the same 30-case Checkpoint E TAP. `fullSuite.total=30` was not a project suite.

Schema v3 removes `eCases`, `fullSuite`, top-level `command`, top-level `processExitCode`, and `testedCommitSha`. It records two independently executed suites plus split git identity.

### E-C2-02

E-28 is renamed to `prior-suite registration and source-integrity check`. It only asserts that prior test files remain registered, historical case IDs were not deleted, and those sources did not add `skip`/`todo`. It does not spawn `npm test` and does not claim the prior suite is green. Full-suite green is proven only by `projectSuite` from a real project TAP run.

## Schema v2 → v3 mapping

| v2 field | v3 field |
|---|---|
| `schemaVersion=classic-v0.2-checkpoint-e/2` | `classic-v0.2-checkpoint-e/3` |
| `eCases` | `checkpointSuite.{total,pass,fail,skip,cancelled,todo}` plus `checkpointSuite.testCases` |
| `fullSuite` (copy of the 30-case TAP) | removed; replaced by `projectSuite` from the `npm test` file list |
| top-level `command` | `checkpointSuite.command` and `projectSuite.command` |
| top-level `processExitCode` | `checkpointSuite.processExitCode` and `projectSuite.processExitCode` |
| `testedCommitSha` / `testedTreeSha` | `identity.sourceHeadSha` / `sourceHeadTreeSha` and `identity.testedCheckoutSha` / `testedCheckoutTreeSha` |
| `nodeVersion` / `npmVersion` | `toolchain.nodeVersion` / `toolchain.npmVersion` |
| top-level live/credential flags | `safety.liveExchangeWrite` / `safety.productionCredentialUsed` |
| *(absent)* | `projectSuite.preCheck` for the non-TAP `test/grid.test.ts` exit code |
| *(absent)* | `identity.baseSha`, `githubEventName`, `githubRunId`, `githubRunAttempt`, `githubJobId` |

On `push` and local generation, `sourceHeadSha` and `testedCheckoutSha` may be the same. On `pull_request`, `sourceHeadSha` is the PR head and `testedCheckoutSha` is the GitHub merge checkout. Mixing those SHAs into one field is `IDENTITY_COLLISION`.

## FILES_CHANGED

Allowed paths only. `src/**` is unchanged.

| File | Why |
|---|---|
| `tools/checkpoint-e-evidence.ts` | schema v3 generate/verify; two real suites; identity split |
| `test/experiment-v02-checkpoint-e.test.ts` | E-28 rename/constraint; E-26 uses v3 generator |
| `test/experiment-v02-checkpoint-e-evidence.test.ts` | 15 verifier cases including the required negatives |
| `package.json` | unchanged scripts; still the source of the project TAP file list |
| `.github/workflows/ci.yml` | fetch PR head; generate/verify/upload v3 artifact; push and PR CI |
| `artifacts/README.md` | v3 suite/identity semantics |
| `docs/classic-v0.2-checkpoint-e.md` | rejected E / corrective-2 status |
| `docs/classic-v0.2-checkpoint-e-corrective-1.md` | Corrective 1 rejected |
| `docs/classic-v0.2-checkpoint-e-corrective-2.md` | this note |
| PR #3 body | CI run / artifact binding after push |

## COMMANDS_AND_EXIT_CODES

Local validation on Node v26.5.0 / npm 11.17.0. GitHub Actions must prove Node v22.23.2 / npm 10.9.8.

| Command | Exit |
|---|---|
| `npm ci` | 0 (existing install reused locally; CI runs `npm ci`) |
| `npm run typecheck` | 0 |
| `npm run test:checkpoint-e` | 0 (30/30, skip 0) |
| `npm run test:checkpoint-e-corrective` | 0 (15/15, skip 0) |
| `npm run check` | 0 |
| `npm run evidence:checkpoint-e` | 0 |
| `npm run evidence:checkpoint-e:verify` | 0 |
| `npm audit --json` | 1 (inventory only) |
| `git diff --check` | 0 |

## TEST_TOTAL_PASS_FAIL_SKIP

Prior node:test total was 351. This corrective replaces 8 evidence-generator tests with 15 and does not remove or skip E-01..E-30. Live `projectSuite` total is parsed from TAP and is not hardcoded to 351.

Local generator result:

```text
checkpointSuite tests 30 pass 30 fail 0 skipped 0 cancelled 0 todo 0 processExitCode 0
projectSuite tests 358 pass 358 fail 0 skipped 0 cancelled 0 todo 0 processExitCode 0
grid pre-check processExitCode 0
```

## AUDIT_SUMMARY

Inventory is recorded from a fresh `npm audit --json`. No `npm audit fix` and no `--force`. 22 findings remain an independent release blocker.

```text
vulnerabilities: 22 (0 info, 0 low, 8 moderate, 14 high, 0 critical)
dependency counts: prod=302, dev=0, optional=31, peer=33, total=364
```

## SECRET_SCAN

Changed paths only. Rule names, no values:

```text
tools/checkpoint-e-evidence.ts — no credential matches
test/experiment-v02-checkpoint-e.test.ts — no credential matches
test/experiment-v02-checkpoint-e-evidence.test.ts — no matches
package.json — unchanged
.github/workflows/ci.yml — no matches
artifacts/README.md — no secrets
docs/** — no secrets
```

## KNOWN_LIMITATIONS

- This note does not declare Checkpoint E PASS.
- Local verification used Node v26.5.0 / npm 11.17.0. CI pin is Node v22.23.2 / npm 10.9.8.
- Local evidence generation uses `githubEventName=local` with `sourceHeadSha=testedCheckoutSha=HEAD`. Authoritative identity is the CI artifact: push may keep those SHAs equal; pull_request must record PR head vs merge checkout separately.
- Generated results JSON is not checked in.
- `AGENTS.md` is absent from this repository.
- Directory-fsync SIGKILL proof for C-C18/C-C19/C-C20 remains Ubuntu CI.
- Planner still returns `filled=[]` and `completedRungs=0`.
- No live exchange write. No real-fund testing. No deployment. No merge.
- 22 npm audit findings remain open on purpose.

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
