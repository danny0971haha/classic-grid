# Checkpoint F CI hardening corrective 3 — current-byte security closure

**Date:** 2026-08-26
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Draft PR:** `#3`
**Task:** `CLASSIC_CHECKPOINT_F_CURRENT_BYTE_SECURITY_CLOSURE`

This document records Corrective 3. Independent review rejected it. It is **not** the current review candidate. See `docs/classic-v0.2-checkpoint-f-ci-hardening-corrective-4.md`.

```text
CHECKPOINT_F_IMPLEMENTATION=ACCEPT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_3=REJECT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_4=REVIEW_CANDIDATE
CHECKPOINT_F_CURRENT_HEAD_ACCEPTED=NO
CHECKPOINT_F_SELF_DECLARED_PASS=NO
EXTENDED_CANARY_DEPENDENCY_BOUNDARY=REVIEW_CANDIDATE
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
DEPENDENCY_SECURITY_CLEARANCE=NO
LIVE_RELEASE_BLOCKED=YES
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
NEXT_CHECKPOINT_AUTHORIZED=NO
independentReview=NOT_PERFORMED
gateStatus=NOT_EMITTED
```

## Identity

```text
START_HEAD=807930dac585737fa98a9b4cb8233381d64efd81
START_TREE=c3f7b33073b09f5f76bb4dd3a60104e75acd7f07
IMPLEMENTATION_HEAD=1e6c80235a851d85487eb07862cea7e621b37bc5
IMPLEMENTATION_TREE=cc9c7707c5a6d8027bc5bc3f7a2e62f09b3b8823
FINAL_HEAD=f88f1a23f7aec521760be0925a5dba831b5922b4
FINAL_TREE=421b8fcdaefcf12acd97c11c2ae13df42dce0aa9
ACCEPTED_IMPLEMENTATION_HEAD=79c88bd08eaf96d069b7eaf947feb7b70739b551
CHECKPOINT_F_IMPLEMENTATION_BASE=3960e3634b1fc68ab90bd8f73cd6effd925932e2
```

Frozen 100U limits and Checkpoint E/F trading, risk, persistence, planner, journal, execution, venue-write, and evidence-schema semantics are unchanged. `src/loop.ts`, `src/venues/**`, and other forbidden implementation paths were not edited.

## Why this corrective

Corrective 1 isolated the Extended canary lockfile. Corrective 2 closed the GitHub Actions trust boundary. The remaining current-byte gap was that the canary source scanner was regex-authoritative and fail-open on unresolved loaders:

- `import(process.env.MODULE_NAME)` and `require(variable)` were not rejected unless the expression text visibly named a forbidden package.
- `src/venues/extended.ts` `import(pathToFileURL(vendor).href)` and `src/loop.ts` DI fallbacks were file-name allowances rather than exact AST contracts.
- `forbiddenSourceBasenames` was present in the manifest and ignored.
- The packed artifact had no exact content digest, so extra/missing/symlink tar entries were not authoritatively compared.

## What changed

Authoritative loader policy now uses the repository TypeScript compiler API (`scripts/security/source-policy.ts`). Regex remains supplemental in `scanCanarySourceText`.

```text
MANIFEST_SCHEMA=classic-v0.2-extended-canary-file-manifest/2
CONTENT_MANIFEST_SCHEMA=classic-v0.2-extended-canary-content-manifest/1
SOURCE_POLICY_SCHEMA=classic-v0.2-extended-canary-source-policy/1
MODULE_GRAPH_SCHEMA=classic-v0.2-extended-canary-module-graph/1
```

Exact approved exceptions, proven from the current AST:

1. `src/venues/extended.ts` — `import(pathToFileURL(vendor).href)` with `vendor` a same-function `const` whose initializer is `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vendor/extended/exchange/index.js")`, resolving to tracked `vendor/extended/exchange/index.js`.
2. `src/loop.ts` `bindLoopRuntime()` — literal `import("./venues/index.js")` and `import("./officialStats.js")` as injected fallbacks. They are excluded from the artifact. The only canary entrypoint is `src/cli/run-extended-canary.ts`, which must supply `createExecutor`, `refreshOfficialStats`, and `getOfficialCache`.
3. `src/experimentTelemetry.ts` — named static `import { execFileSync } from "node:child_process"` only. This is a current-byte exception because that frozen implementation file cannot be edited. `import("node:child_process")`, `require("child_process")`, and `process.getBuiltinModule("child_process")` remain rejected.

The packed canary includes `file-manifest.json` and a generated `content-manifest.json` with per-file `relativePath`, `fileType`, `mode`, and `sha256`. The content manifest is excluded from its own digest. The artifact is packed twice from clean staging directories; extracted content identity must match. Gzip `.tgz` bytes may differ.

The module-load hook records JSONL `{specifier, parentURL, resolvedURL}` after `nextResolve()` succeeds. Canary-origin parents may resolve only into the extracted canary, its `node_modules`, Node builtins, or verifier bootstrap files.

## Local results (not independent acceptance)

```text
FULL_TEST_TOTAL=543
SECURITY_TEST_TOTAL=134
CI_SECURITY_TAP_TOTAL=133
FULL_SUITE_FAIL=0
SECURITY_SUITE_FAIL=0
SKIP=0
TODO=0
CANARY_AUDIT_HIGH=0
CANARY_AUDIT_CRITICAL=0
ROOT_AUDIT_HIGH=14
ROOT_AUDIT_CRITICAL=0
FORBIDDEN_SOURCE_HITS=0
FORBIDDEN_LOADED_MODULES=0
UNEXPECTED_NETWORK=0
UNEXPECTED_ARTIFACT_FILES=0
CONTENT_HASH_MISMATCHES=0
ROOT_GLOBAL_CLEARANCE=NO
CONTENT_MANIFEST_SHA256=4209dc1d6c6deb32725d56cfa64fb2af8e9147d5efc9d0471ffb5717301e9375
ARTIFACT_SHA256=a75a8bcced0f0185c31014dcd6bb1d34a3fceb6b6bbcb60edfdedd4ae5a51c33
CI_RUN=32949840246
CI_JOB=98118550070
PUSH_CI_RUN=32949835688
PUSH_CI_JOB=98118534738
PR_EVENT_SOURCE_HEAD=f88f1a23f7aec521760be0925a5dba831b5922b4
PR_TESTED_CHECKOUT_HEAD=bdaa43710497a971f507d0e2692065b36ee88a18
```

Root `npm audit --omit=dev` remains the known High baseline. That is a live-release blocker, not a blocker for this verifier corrective. Matching the committed baseline is not vulnerability remediation. The isolated Extended canary still audits at High=0 / Critical=0.

## Changed files

Verifier, manifest, tests, CI wiring, and status documentation only.

```text
COMMITS=1e6c80235a851d85487eb07862cea7e621b37bc5,f88f1a23f7aec521760be0925a5dba831b5922b4
CHANGED_FILES=.github/workflows/ci.yml,SECURITY.md,docs/checkpoint-f-validation.md,docs/classic-v0.2-checkpoint-f-ci-hardening-corrective-3.md,docs/classic-v0.2-dependency-boundary-corrective-1.md,docs/classic-v0.2-implementation-contract.md,docs/security-audit-baseline.md,package.json,packages/extended-canary/file-manifest.json,packages/extended-canary/package.json,scripts/security/canary-artifact-smoke.ts,scripts/security/canary-manifest-schema.ts,scripts/security/content-manifest.ts,scripts/security/extended-canary-boundary.ts,scripts/security/forbidden-specifiers.ts,scripts/security/module-graph.ts,scripts/security/module-load-hook.mjs,scripts/security/pack-extended-canary.ts,scripts/security/source-policy.ts,scripts/security/tar-bytes.ts,test/security/action-pin.test.ts,test/security/canary-artifact-content.test.ts,test/security/canary-manifest-strict.test.ts,test/security/extended-canary-boundary.test.ts,test/security/source-policy.test.ts
```

`npm run test:security` is 134 including `extended-canary-install.test.ts`. The CI TAP security step omits that install test and reports 133. `npm run check` TAP is 543 plus `grid.test.ts`.

## Next action

```text
NEXT_ACTION=SUPERSEDED_BY_CORRECTIVE_4
```
