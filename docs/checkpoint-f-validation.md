# Checkpoint F validation after bounded CI hardening

**Date:** 2026-08-25
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Draft PR:** `#3`

This document does **not** declare Checkpoint F PASS for the CI-hardening HEAD. It does not authorize live exchange writes, real funds, merge, deploy, or the next checkpoint.

```text
CHECKPOINT_F_ACCEPTED_IMPLEMENTATION_BASE=79c88bd08eaf96d069b7eaf947feb7b70739b551
CHECKPOINT_F_ACCEPTED_IMPLEMENTATION_TREE=2d6c874df460485def1c11214bee11346ed4ef9e
CHECKPOINT_F_CI_HARDENING=REVIEW_CANDIDATE
CHECKPOINT_F_CURRENT_HEAD_ACCEPTED=NO
CHECKPOINT_F_SELF_DECLARED_PASS=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
NEXT_CHECKPOINT_AUTHORIZED=NO
```

## Preserved acceptance history

Independent review accepted Checkpoint E Corrective 2 as evidence-schema correction only.

Independent review of Checkpoint F on implementation HEAD `79c88bd08eaf96d069b7eaf947feb7b70739b551` (tree `2d6c874df460485def1c11214bee11346ed4ef9e`) remains the Checkpoint F implementation base. That acceptance does **not** transfer automatically onto a later HEAD that changes GitHub Actions, audit policy, or other CI supply-chain bytes.

Schema `classic-v0.2-checkpoint-f/2` is unchanged. Checkpoint F case semantics, strategy/risk/execution/recovery/journal/planner/exchange-adapter code, and tools/checkpoint-e-evidence.ts plus tools/checkpoint-f-evidence.ts were not modified by this CI-hardening task.

## What the new HEAD is waiting for

The CI-hardening HEAD is a review candidate for:

- pinned `actions/checkout`, `actions/setup-node`, and `actions/upload-artifact` commit SHAs on the current v4 major
- `persist-credentials: false` with `fetch-depth: 0` and a credential-free PR source-head fetch
- job timeout and per-workflow-per-ref concurrency
- fail-closed `npm run audit:security-baseline` against `scripts/security/npm-audit-baseline.json`
- a separate security inventory artifact that is not the Checkpoint F evidence artifact

On `pull_request`, `sourceHeadSha` (PR head) and `testedCheckoutSha` (merge checkout) must remain distinct. `liveExchangeWrite=false`. `productionCredentialUsed=false`.

CI run IDs, artifact IDs, and digests are recorded on PR #3 after the hardening workflow finishes. They are not hand-written into this file in advance.
