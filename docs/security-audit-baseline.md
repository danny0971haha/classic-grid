# Security audit baseline

**Status:** known high findings remain vulnerabilities. This document is not a clearance.
**Date:** 2026-08-25
**Lockfile:** `package-lock.json`
**Lockfile SHA-256:** `f278d8b7f0d559839e35ee64e94db9e39c7d6037f5692d0cafa02ba6c6b254ed`
**Machine-readable baseline:** `scripts/security/npm-audit-baseline.json`
**Audit command:** `npm audit --omit=dev --json`
**Verification schema:** `classic-v0.2-security-audit-verification/2`
**Action inventory schema:** `classic-v0.2-action-pin-inventory/3`

```text
CHECKPOINT_F_IMPLEMENTATION=ACCEPT
CHECKPOINT_F_ACCEPTED_IMPLEMENTATION_BASE=79c88bd08eaf96d069b7eaf947feb7b70739b551
CHECKPOINT_F_CI_HARDENING_HEAD=5116b2a02d0369e2122d69747f3cb39ccbb89ab8
CHECKPOINT_F_CI_HARDENING_HEAD_DISPOSITION=REJECT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_1=REJECT
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_2=ACCEPT_AT_EXACT_HEAD
CHECKPOINT_F_CI_HARDENING_CORRECTIVE_3=REVIEW_CANDIDATE
CHECKPOINT_F_CURRENT_HEAD_ACCEPTED=NO
CHECKPOINT_F_SELF_DECLARED_PASS=NO
DEPENDENCY_REMEDIATION=BLOCKED
DEPENDENCY_SECURITY_CLEARANCE=NO
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
EXTENDED_CANARY_DEPENDENCY_BOUNDARY=REVIEW_CANDIDATE
LIVE_RELEASE_BLOCKED=YES
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
```

Current `npm audit --omit=dev` known baseline: **14 high / 0 critical / 22 total** package rows. That match is "consistent with the known baseline", not "vulnerabilities cleared". Existing High findings are not repaired and not treated as safe. This corrective does not enlarge the committed npm-audit baseline, does not add advisories or package paths to manufacture PASS, and does not run `npm audit fix --force`.

Existing high findings are **not** treated as safe. CI fails closed on any critical, any high advisory or high package that is not in the baseline, any high advisory ID replacement, any high dependency-path or package-identity change, metadata/row count mismatch, invalid severity counts, missing advisory identity while a package remains high, lockfile hash mismatch, unreadable audit output, or a GitHub Actions trust-boundary violation. Moderate findings are stored in the CI `audit.json` artifact and do not pass this gate by themselves.

`npm audit fix --force` and major-version downgrades were not applied. Several npm `fixAvailable` values point at major downgrades (`@nadohq/client@0.26.0`, `@n1xyz/nord-ts@0.0.1`) and are recorded only as vendor suggestions.

## Policy

- Production tree means: present in `npm audit --omit=dev` for the current lockfile.
- Reachability of the vulnerable function or request path is **UNKNOWN** unless a later review proves it with an entrypoint/import graph **and** runtime tests. Static search that currently finds no call site is not UNREACHABLE.
- Compensating controls below do not remediate the advisories.
- Remediation owner for every row: repository maintainers of `danny0971haha/classic-grid`.
- Review deadline for every row: 2026-09-22.

## GitHub Actions trust boundary

The Action inventory is produced from `git ls-files -z --stage`, not from a working-tree directory walk. Every tracked `.github/workflows/**/*.{yml,yaml}` and `.github/actions/**/action.{yml,yaml}` must be scanned. YAML is parsed with vendored `yaml@2.8.4` (`uniqueKeys: true`, core schema, aliases/anchors rejected, unknown tags rejected). External Actions must match an exact identity+SHA tuple:

| identity | SHA | release |
|---|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 |

Local composite Actions and local reusable workflows are resolved recursively from the Git index with cycle detection. Docker Actions are forbidden. Remote reusable workflows are forbidden unless an exact repository/path/SHA tuple is added to the allowlist (currently empty). `npm run verify:action-inventory` independently re-lists `git ls-files` and checks coverage, allowlist tuples, acyclic local graphs, and Docker absence.

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

## Dependency remediation assessment (current bytes)

Investigation order: unused direct dependency removal → compatible patched version → proven override → alternative SDK / venue split. Checkpoint F implementation bytes remain frozen, so venue adapters were not rewritten.

| package | direct / transitive | exact installed version | advisory / GHSA | dependency path | repository import sites | production entrypoint reachability | current canary reachability | safe patched version available | upgrade compatibility | tests required | remediation result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `@n1xyz/nord-ts` | direct | 0.6.3 | inherits GHSA-3gc7-fjrx-p6mg | `node_modules/@n1xyz/nord-ts` | `src/venues/n1.ts` (dynamic `import` in `connect`), `src/officialStats.ts` (dynamic `import`) | UNKNOWN. `src/cli/run.ts` → `src/loop.ts` statically imports `src/venues/index.ts`, which statically constructs the N1 class module. `nord-ts` itself is dynamically imported only in `N1Executor.connect()` when not dry-run. | UNKNOWN. Canary config is `extended:BTC` / `VENUES=extended` in Checkpoint E/F tests; that is not runtime proof that `connect()` never runs, and is not UNREACHABLE. | Vendor `fixAvailable` is `@n1xyz/nord-ts@0.0.1` (major downgrade). Not used. | Unreviewed major downgrade forbidden; 0.6.3 → latest 0.7.x would change frozen venue SDK behavior | N1 live connect + Solana buffer tests; not present | BLOCKED |
| `@nadohq/client` | direct | 0.31.0 | inherits GHSA-gcfj-64vw-6mp9 and GHSA-96hv-2xvq-fx4p | `node_modules/@nadohq/client` | `src/venues/nado.ts`, `src/officialStats.ts` | UNKNOWN. Static import from `nado.ts` via `venues/index.ts` from the production loop. | UNKNOWN. Canary venue is Extended; static module graph still loads `nado.ts`. Function-level HTTP/ws use is unproven. | Latest 0.38.0 dropped the `axios` dependency, but 0.31 → 0.38 is an unproven SDK bump. Vendor also suggests 0.26.0 major downgrade. | API/ABI not proven by current tests | Nado HTTP snapshot/apply tests against 0.38; not present | BLOCKED |
| `@nadohq/shared` | direct | 0.31.0 | inherits the Nado axios/viem highs | `node_modules/@nadohq/shared` | `src/venues/nado.ts`, `src/officialStats.ts` | UNKNOWN (same Nado graph) | UNKNOWN | Vendor `fixAvailable` `0.9.0` is a major downgrade | Unreviewed major downgrade forbidden | Same as `@nadohq/client` | BLOCKED |
| `viem` | direct | 2.52.0 | inherits GHSA-96hv-2xvq-fx4p; npm package range includes `0.2.2 - 2.54.1` | `node_modules/viem` | `src/venues/nado.ts`, `src/venues/popdex.ts` | UNKNOWN. Static import from Nado/PopDEX adapters loaded by `venues/index.ts`. | UNKNOWN. Canary does not select nado/popdex, but those modules still load. Nested `ws` frame handling is unproven. | `viem@2.55.19` depends on `ws@8.21.0` (patched). `^2.52.0` would allow it. | Large minor jump; nado pins `viem@2.52.0` as a peer. No nado/popdex runtime suite | Wallet/public client + websocket transport tests | BLOCKED — not applied without ABI proof |
| `axios` | transitive | 1.16.1 (pinned by `@nadohq/engine-client`, `indexer-client`, `mobile-client`, `trigger-client`) | GHSA-gcfj-64vw-6mp9 | `node_modules/axios` | no direct import; loaded through `@nadohq/*` | UNKNOWN | UNKNOWN | `axios@1.18.0` is the 1.x patch | Override possible, but Nado pins `axios@1.16.1` and no HTTP interceptor tests exist | Nado request path with interceptor/proxy cloning | BLOCKED — override not applied |
| `bigint-buffer` | transitive | 1.1.5 | GHSA-3gc7-fjrx-p6mg | `node_modules/bigint-buffer` | no direct import; `@solana/web3.js` is statically imported by `src/venues/n1.ts` and `src/venues/phoenix.ts` | UNKNOWN. Module load of `@solana/web3.js` happens when `venues/index.ts` loads. `toBigIntLE()` invocation is unproven. | UNKNOWN | No official patched `bigint-buffer` release (`<=1.1.5` is the entire line). Replacement packages are unreviewed ABI substitutions. | Cannot patch in-range | Solana buffer conversion tests; venue split would edit frozen adapters | BLOCKED |
| `ws` | transitive nested (direct `ws@8.21.3` is patched) | nested `8.20.1` under `node_modules/viem/node_modules/ws` | GHSA-96hv-2xvq-fx4p | `node_modules/viem/node_modules/ws` | direct `ws` is `src/venues/extendedAccountStream.ts` (patched 8.21.3). Vulnerable copy is viem's nested dependency. | UNKNOWN for the nested copy | UNKNOWN. Extended canary uses direct `ws@8.21.3`. Nested viem `ws` still exists in the production tree. | `ws@8.21.0+` patches this advisory | Override of nested `ws` would fight viem's exact `8.20.1` pin; unproven | viem websocket transport tests | BLOCKED — not applied |
| `@nadohq/*` other | transitive | 0.31.0 | inherit axios/viem highs | `node_modules/@nadohq/{engine,indexer,mobile,trigger}-client` | imported only through `@nadohq/client` | UNKNOWN | UNKNOWN | See `@nadohq/client` | Same | Same | BLOCKED |
| `@n1xyz/proton` | transitive | 0.1.0 | inherits bigint-buffer | `node_modules/@n1xyz/proton` | via `@n1xyz/nord-ts` | UNKNOWN | UNKNOWN | See `@n1xyz/nord-ts` | Same | Same | BLOCKED |
| `@solana/buffer-layout-utils` | transitive | lockfile-installed via `@solana/web3.js` | inherits GHSA-3gc7-fjrx-p6mg | `node_modules/@solana/buffer-layout-utils` | via `@solana/web3.js` in `n1.ts` / `phoenix.ts` | UNKNOWN | UNKNOWN | No patched bigint-buffer | Replacing `@solana/web3.js` v1 would edit frozen adapters | Phoenix/N1 runtime | BLOCKED |
| `@solana/spl-token` | transitive | lockfile-installed via `@solana/web3.js` graph | inherits GHSA-3gc7-fjrx-p6mg | `node_modules/@solana/spl-token` | via Solana graph | UNKNOWN | UNKNOWN | Same | Same | Same | BLOCKED |

Unused-direct-dependency check: `@n1xyz/nord-ts`, `@nadohq/client`, `@nadohq/shared`, `viem`, and `ws` all have repository import sites. None were removed.

Because at least one high remains, and no in-range fix was proven compatible by API/ABI plus the full test suite:

```text
DEPENDENCY_REMEDIATION=BLOCKED
DEPENDENCY_SECURITY_CLEARANCE=NO
LIVE_RELEASE_BLOCKED=YES
REAL_FUND_TESTING_AUTHORIZED=NO
```

No `fix(deps)` commit is created for the root lockfile. The committed root baseline file is unchanged.

## Extended canary boundary (not global clearance)

Root High findings cannot be removed without breaking unrelated N1/Nado/Phoenix/PopDEX adapters. Corrective 1 adds `packages/extended-canary` with a separate production lockfile. The canary artifact is installable without the root `node_modules` and must audit at `critical=0` / `high=0`. That result is **not** `GLOBAL_DEPENDENCY_SECURITY_CLEARANCE`.

```text
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
EXTENDED_CANARY_DEPENDENCY_BOUNDARY=REVIEW_CANDIDATE
CURRENT_REVIEW_CANDIDATE=CHECKPOINT_F_CI_HARDENING_CORRECTIVE_3
LIVE_RELEASE_BLOCKED=YES
independentReview=NOT_PERFORMED
gateStatus=NOT_EMITTED
```

See `docs/classic-v0.2-checkpoint-f-ci-hardening-corrective-3.md`. Corrective 1 remains a historical isolation record and is not the current review candidate.

## Checker

```text
npm run audit:security-baseline
npm run test:security
npm run verify:action-inventory
```

Generated `audit.json` is a CI artifact and is not committed. A metadata match of 14 high / 0 critical / 22 total only means the report still matches the known baseline. It is not a remediation or clearance statement.
