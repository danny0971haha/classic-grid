# Checkpoint F CI hardening corrective 4 — alias-taint source-policy closure

**Date:** 2026-08-26
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Draft PR:** `#3`
**Task:** `CHECKPOINT_F_CI_HARDENING_CORRECTIVE_4`

This document does **not** declare independent acceptance, Checkpoint F PASS, live authorization, merge, or deploy.

```text
CHECKPOINT_F_IMPLEMENTATION=ACCEPT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_3=REJECT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_4=REVIEW_CANDIDATE
CHECKPOINT_F_CURRENT_HEAD_ACCEPTED=NO
CHECKPOINT_F_SELF_DECLARED_PASS=NO
EXTENDED_CANARY_DEPENDENCY_BOUNDARY=ACCEPT
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
START_HEAD=9c320a44e40978647d31466e016362a4ad193dfc
START_TREE=d0ab301b170a7d3ffbc00b382bed5f2ddcadf7e6
IMPLEMENTATION_HEAD=8af9e222ae4ea687f829f5821d8be98de1d2db74
IMPLEMENTATION_TREE=c113d79bf6429fa82779a46ae30019c8419a6b31
TEST_HEAD=28f57d2f3c87aa065b7dda3c63b577a0222b1b8c
TEST_TREE=d05f1506860f7fcf59703a0f617664b188efbb61
ACCEPTED_IMPLEMENTATION_HEAD=79c88bd08eaf96d069b7eaf947feb7b70739b551
CHECKPOINT_F_IMPLEMENTATION_BASE=3960e3634b1fc68ab90bd8f73cd6effd925932e2
REJECTED_CORRECTIVE_3_HEAD=9c320a44e40978647d31466e016362a4ad193dfc
```

Frozen 100U limits and Checkpoint E/F trading, risk, persistence, planner, journal, execution, venue-write, and evidence-schema semantics are unchanged. `src/loop.ts`, `src/venues/**`, `src/experimentRisk.ts`, `src/experimentExecution*.ts`, `src/experimentPlanner*.ts`, `src/experimentTelemetry.ts`, `tools/checkpoint-e-evidence.ts`, `tools/checkpoint-f-evidence.ts`, `vendor/**`, and lockfiles were not edited.

## Why this corrective

Independent review rejected Corrective 3 at `9c320a44e40978647d31466e016362a4ad193dfc`. `analyzeCanarySourcePolicy` and `scanCanarySourceText` both returned zero findings for one-hop alias, destructure, and unresolved computed-dispatch forms such as:

```ts
const g = process.getBuiltinModule;
g("child_process");
const { require: r } = globalThis;
r("node:vm");
globalThis[k]("return 1")();
```

The AST binding model preserved `require` / `eval` / `function-ctor` / `createRequire` across assignment, but dropped `getBuiltin`, `module-load`, `module-require`, `import-meta-resolve`, and `reflect-construct` to generic `other`. Object destructuring always rebound locals to `other`. Element-access keys that were identifiers were treated as literal property names, so `globalThis[k]` was not fail-closed.

## What changed

`scripts/security/source-policy.ts` is still the authoritative loader policy. Regex in `scanCanarySourceText` remains supplemental.

- Explicit binding kinds now include `getBuiltin`, `module-load`, `module-require`, `import-meta-resolve`, `reflect-construct`, `process-binding`, `process-dlopen`, `main-module`, and `unresolved`.
- `expressionBindingKind()` copies those kinds across one-hop and two-hop `const` aliases.
- Object destructuring from a sensitive root (`globalThis`, `global`, `process`, `module`, `Module`, `Reflect`, `import.meta`) keeps the member kind, or emits `UNRESOLVED_COMPUTED_DISPATCH` when the property cannot be folded.
- Element-access keys are folded as expressions. An unresolved key on a sensitive dispatch root is `UNRESOLVED_COMPUTED_DISPATCH`. Ordinary computed access on local objects is unchanged.
- Walk-time bare-reference handling now covers the same dangerous property kinds as `main-module` / `process-binding` / `process-dlopen`.
- Exact approved exceptions are unchanged: Extended vendor `import(pathToFileURL(vendor).href)`, `bindLoopRuntime()` literal fallbacks, and the static `execFileSync` named import.

## Local results (not independent acceptance)

```text
FULL_TEST_TOTAL=561
SECURITY_TEST_TOTAL=152
FULL_SUITE_FAIL=0
SECURITY_SUITE_FAIL=0
SKIP=0
TODO=0
CANARY_AUDIT_HIGH=0
CANARY_AUDIT_CRITICAL=0
ROOT_AUDIT_HIGH=14
ROOT_AUDIT_CRITICAL=0
MANDATORY_ALIAS_CASES_BLOCKED=7/7
CONTENT_MANIFEST_SHA256=4209dc1d6c6deb32725d56cfa64fb2af8e9147d5efc9d0471ffb5717301e9375
ROOT_GLOBAL_CLEARANCE=NO
```

Root `npm audit --omit=dev` remains the known High baseline. Matching the committed baseline is not vulnerability remediation. The isolated Extended canary still audits at High=0 / Critical=0.

## Changed files

Verifier policy, supplemental text scan, tests, and status documentation only.

```text
COMMITS=8af9e222ae4ea687f829f5821d8be98de1d2db74,28f57d2f3c87aa065b7dda3c63b577a0222b1b8c
CHANGED_FILES=docs/checkpoint-f-validation.md,docs/classic-v0.2-checkpoint-f-ci-hardening-corrective-3.md,docs/classic-v0.2-checkpoint-f-ci-hardening-corrective-4.md,docs/classic-v0.2-dependency-boundary-corrective-1.md,docs/classic-v0.2-implementation-contract.md,docs/security-audit-baseline.md,scripts/security/extended-canary-boundary.ts,scripts/security/source-policy.ts,test/security/source-policy.test.ts
```

`npm run test:security` is 152 including `extended-canary-install.test.ts`. `npm run check` TAP is 561 plus `grid.test.ts`.

## Residual limitations (not claimed closed)

- Inherited `NODE_OPTIONS` / preload environment variables on the offline probe were not sanitized in this corrective.
- PAX tar metadata entries remain skipped rather than explicitly rejected; packing currently depends on ignoring typeflag `x`/`g`.
- Assignment to an already-declared name (`g = process.getBuiltinModule` without a binding declaration) is not a full data-flow rewrite.
- Root production High findings remain live-release blockers.

## Next action

```text
NEXT_ACTION=INDEPENDENT_CORRECTIVE_4_CURRENT_BYTE_REVIEW
```
