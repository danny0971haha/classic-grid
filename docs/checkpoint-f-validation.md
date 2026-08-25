# Checkpoint F validation after CI security hardening corrective 2

**Date:** 2026-08-25
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-100u-safety`
**Draft PR:** `#3`

This document does **not** declare Checkpoint F PASS. It does not authorize live exchange writes, real funds, merge, deploy, or the next checkpoint. It does not self-declare this CI corrective PASS.

```text
CHECKPOINT_F_IMPLEMENTATION=ACCEPT
CHECKPOINT_F_ACCEPTED_IMPLEMENTATION_BASE=79c88bd08eaf96d069b7eaf947feb7b70739b551
CHECKPOINT_F_CI_HARDENING_HEAD=5116b2a02d0369e2122d69747f3cb39ccbb89ab8
CHECKPOINT_F_CI_HARDENING_HEAD_DISPOSITION=REJECT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_1=REJECT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_2=ACCEPT_AT_EXACT_HEAD
CHECKPOINT_F_CURRENT_HEAD_ACCEPTED=NO
CHECKPOINT_F_SELF_DECLARED_PASS=NO
DEPENDENCY_REMEDIATION=BLOCKED
DEPENDENCY_SECURITY_CLEARANCE=NO
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
EXTENDED_CANARY_DEPENDENCY_BOUNDARY=REVIEW_CANDIDATE
LIVE_RELEASE_BLOCKED=YES
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
NEXT_CHECKPOINT_AUTHORIZED=NO
```

Independent review accepted Checkpoint F **implementation** at `79c88bd08eaf96d069b7eaf947feb7b70739b551`. That acceptance does not transfer onto later CI/supply-chain HEADs. Independent review rejected CI hardening HEAD `5116b2a02d0369e2122d69747f3cb39ccbb89ab8` and rejected Corrective 1. This corrective is a review candidate for recursive GitHub Actions trust-boundary closure and a documented dependency-remediation assessment only. Checkpoint F strategy, risk, execution, recovery, journal, planner, and exchange-adapter implementation is unchanged and remains accepted at the implementation base above.

Schema `classic-v0.2-checkpoint-f/2` is unchanged. `tools/checkpoint-e-evidence.ts` and `tools/checkpoint-f-evidence.ts` were not modified.

## Known npm audit baseline (not clearance)

`npm audit --omit=dev` against the committed lockfile currently reports **14 high / 0 critical / 22 total** package rows. That is a known baseline, not a vulnerability clearance.

- Existing High findings are **not** remediated or cleared.
- `existingHighAreNotCleared=true` remains binding.
- Dependency remediation and reachability closure are live-release blockers.
- This corrective does **not** change `package-lock.json`, dependency versions, or `scripts/security/npm-audit-baseline.json`.
- Compatible axios/ws/viem patches exist in principle, but API/ABI plus full-suite proof is missing, and `bigint-buffer` has no official patch. See the matrix in `docs/security-audit-baseline.md`.

## What this corrective is waiting for

Independent review of:

- Git-index enumeration of every tracked workflow and Action manifest, including `.yaml` and `.github/actions/**`
- fail-closed handling of symlink, gitlink, non-regular blobs, case collision, path escape, untracked local `uses`, duplicate `action.yml`/`action.yaml`, malformed YAML, duplicate keys, aliases/anchors, unsupported tags, and dynamic `uses`
- exact identity+SHA allowlist for `actions/checkout`, `actions/setup-node`, and `actions/upload-artifact`
- recursive local composite Actions and local reusable workflows with cycle detection
- rejection of Docker Actions and remote reusable workflows
- `persist-credentials: false` and `fetch-depth: 0` on every checkout
- independent `npm run verify:action-inventory`
- dependency remediation remaining BLOCKED while any high remains

On `pull_request`, `sourceHeadSha` (PR head) and `testedCheckoutSha` (merge checkout) must remain distinct. `liveExchangeWrite=false`. `productionCredentialUsed=false`.

CI run IDs, artifact IDs, and digests are recorded on PR #3 after the corrective workflow finishes. They are not hand-written into this file in advance.
