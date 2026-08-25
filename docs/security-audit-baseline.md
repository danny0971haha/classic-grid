# Security audit baseline

**Status:** known high findings remain vulnerabilities. This document is not a clearance.
**Date:** 2026-08-25
**Lockfile:** `package-lock.json`
**Lockfile SHA-256:** `f278d8b7f0d559839e35ee64e94db9e39c7d6037f5692d0cafa02ba6c6b254ed`
**Machine-readable baseline:** `scripts/security/npm-audit-baseline.json`
**Audit command:** `npm audit --omit=dev --json`
**Verification schema:** `classic-v0.2-security-audit-verification/2`
**Action inventory schema:** `classic-v0.2-action-pin-inventory/2`

```text
CHECKPOINT_F_IMPLEMENTATION=ACCEPT
CHECKPOINT_F_ACCEPTED_IMPLEMENTATION_BASE=79c88bd08eaf96d069b7eaf947feb7b70739b551
CHECKPOINT_F_CI_HARDENING_HEAD=5116b2a02d0369e2122d69747f3cb39ccbb89ab8
CHECKPOINT_F_CI_HARDENING_HEAD_DISPOSITION=REJECT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_1=REVIEW_CANDIDATE
CHECKPOINT_F_CURRENT_HEAD_ACCEPTED=NO
CHECKPOINT_F_SELF_DECLARED_PASS=NO
```

Current `npm audit --omit=dev` known baseline: **14 high / 0 critical / 22 total** package rows. That match is "consistent with the known baseline", not "vulnerabilities cleared". Existing High findings are not repaired and not treated as safe. Dependency remediation and reachability closure remain live-release blockers. This CI corrective does not change dependency versions or the committed npm-audit baseline file.

Existing high findings are **not** treated as safe. CI fails closed on any critical, any high advisory or high package that is not in the baseline, any high advisory ID replacement, any high dependency-path or package-identity change, metadata/row count mismatch, invalid severity counts, missing advisory identity while a package remains high, lockfile hash mismatch, unreadable audit output, or an unpinned / non-allowlisted / unparseable GitHub Action `uses`. Moderate findings are stored in the CI `audit.json` artifact and do not pass this gate by themselves.

`npm audit fix --force` and major-version upgrades were not applied. Several npm `fixAvailable` values point at major downgrades (`@nadohq/client@0.26.0`, `@n1xyz/nord-ts@0.0.1`) and are recorded only as vendor suggestions.

## Policy

- Production tree means: present in `npm audit --omit=dev` for the current lockfile.
- Reachability of the vulnerable function or request path is **UNKNOWN** unless a later review proves it.
- Compensating controls below do not remediate the advisories.
- Remediation owner for every row: repository maintainers of `danny0971haha/classic-grid`.
- Review deadline for every row: 2026-09-22.

## High advisories

### GHSA-gcfj-64vw-6mp9 / source `1123967` (`axios`)

| Field | Record |
|---|---|
| Dependency path | `node_modules/axios` (transitive via `@nadohq/*`) |
| Enters production dependency tree | YES |
| Current known reachability | UNKNOWN |
| Unknown assumptions | Whether Nado HTTP client code runs in the Extended 100U canary; whether axios interceptor/proxy cloning on Node is exercised |
| Compensating controls | Live exchange write unauthorized; CI uses `contents: read` and no production credentials; no forced dependency upgrade in this change |
| Remediation owner | repository maintainers of `danny0971haha/classic-grid` |
| Review deadline | 2026-09-22 |

### GHSA-3gc7-fjrx-p6mg / source `1103747` (`bigint-buffer`)

| Field | Record |
|---|---|
| Dependency path | `node_modules/bigint-buffer` (transitive via `@solana/*` → `@n1xyz/nord-ts`) |
| Enters production dependency tree | YES |
| Current known reachability | UNKNOWN |
| Unknown assumptions | Whether `toBigIntLE()` is called; whether the N1 venue adapter is imported on the Extended canary path |
| Compensating controls | Live exchange write unauthorized; CI uses `contents: read` and no production credentials; no forced dependency upgrade in this change |
| Remediation owner | repository maintainers of `danny0971haha/classic-grid` |
| Review deadline | 2026-09-22 |

### GHSA-96hv-2xvq-fx4p / source `1123259` (`ws`)

| Field | Record |
|---|---|
| Dependency path | `node_modules/viem/node_modules/ws` (nested copy; not the direct `ws@8.21.3` dependency) |
| Enters production dependency tree | YES |
| Current known reachability | UNKNOWN |
| Unknown assumptions | Whether viem's nested `ws` 8.20.x is used at runtime; whether the fragment/chunk DoS path is reachable from Nado/PopDEX/officialStats |
| Compensating controls | Live exchange write unauthorized; CI uses `contents: read` and no production credentials; no forced dependency upgrade in this change |
| Remediation owner | repository maintainers of `danny0971haha/classic-grid` |
| Review deadline | 2026-09-22 |

## Inherited high packages

These packages are high in `npm audit --omit=dev` because they sit above the advisories above. They are still high findings. They are not cleared.

| Package | Direct | Dependency path | Production tree | Reachability | Unknown assumptions | Compensating controls | Owner | Deadline |
|---|---|---|---|---|---|---|---|---|
| `@n1xyz/nord-ts` | yes | `node_modules/@n1xyz/nord-ts` | YES | UNKNOWN | Whether the N1 adapter is loaded on the Extended canary path | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@n1xyz/proton` | no | `node_modules/@n1xyz/proton` | YES | UNKNOWN | Same N1/Solana import graph as above | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@nadohq/client` | yes | `node_modules/@nadohq/client` | YES | UNKNOWN | Whether Nado SDK HTTP/ws paths run in the current experiment | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@nadohq/engine-client` | no | `node_modules/@nadohq/engine-client` | YES | UNKNOWN | Same Nado graph | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@nadohq/indexer-client` | no | `node_modules/@nadohq/indexer-client` | YES | UNKNOWN | Same Nado graph | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@nadohq/mobile-client` | no | `node_modules/@nadohq/mobile-client` | YES | UNKNOWN | Same Nado graph | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@nadohq/shared` | yes | `node_modules/@nadohq/shared` | YES | UNKNOWN | Same Nado graph | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@nadohq/trigger-client` | no | `node_modules/@nadohq/trigger-client` | YES | UNKNOWN | Same Nado graph | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@solana/buffer-layout-utils` | no | `node_modules/@solana/buffer-layout-utils` | YES | UNKNOWN | Whether Solana buffer conversion runs | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `@solana/spl-token` | no | `node_modules/@solana/spl-token` | YES | UNKNOWN | Whether SPL token helpers run | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `axios` | no | `node_modules/axios` | YES | UNKNOWN | See GHSA-gcfj-64vw-6mp9 | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `bigint-buffer` | no | `node_modules/bigint-buffer` | YES | UNKNOWN | See GHSA-3gc7-fjrx-p6mg | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `viem` | yes | `node_modules/viem` | YES | UNKNOWN | Whether viem transport uses the nested vulnerable `ws` | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |
| `ws` | no | `node_modules/viem/node_modules/ws` | YES | UNKNOWN | See GHSA-96hv-2xvq-fx4p | Live write unauthorized; no production CI credentials | maintainers | 2026-09-22 |

## Checker

```text
npm run audit:security-baseline
npm run test:security
```

The checker has no third-party dependencies. Generated `audit.json` is a CI artifact and is not committed. A metadata match of 14 high / 0 critical / 22 total only means the report still matches the known baseline. It is not a remediation or clearance statement.
