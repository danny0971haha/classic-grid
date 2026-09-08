# Classic Grid — 2026-09-08 canary-scoped review prep

This packet is navigation and evidence for independent review. It is **not** PASS, ACCEPT, MERGE AUTHORIZED, or LIVE AUTHORIZED.

```text
TASK_STATUS=REVIEW_PREP_RECORDED
ROUTE_A=BLOCKED_MISSING_INPUTS
ROUTE_B_PUBLICATION_POLICY=NOT_ADOPTED
ROUTE_B_ENGINEERING_VERIFICATION_THIS_ROUND=YES
ROOT_DEPENDENCY_SECURITY_CLEARANCE=NO
CANARY_VERIFICATION_IS_NOT_ROOT_CLEARANCE=YES
R2B_STARTED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
SELF_DECLARED_PASS=NO
```

Evidence directory: `docs/evidence/classic-canary-review-20260908/`  
Machine-readable result: [status.json](status.json)

## 1. Identity (checked, not reset)

Official working directory `/Users/apple/classic-grid` was **not** reset, rebased, or force-pushed.

| Ref | Specified | Observed | Match |
| --- | --- | --- | --- |
| Repo | `danny0971haha/classic-grid` | `origin` https://github.com/danny0971haha/classic-grid.git | yes |
| PR #12 | Draft `fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf` tree `7f14f66eac518c4427076f18fbcfdc7d935c79d8` | same; `draft=true`; `mergeable_state=unstable` | yes |
| Frozen R1 | `990a790706e17b52e04d0d1957505cdad5d45862` | same on `origin/experiment/classic-v0.2-100u-safety` | yes |
| Remote R2-A | `39bf3a797b58f7fd91babf9f2d608cfd28e04487` | same on `origin/experiment/classic-v0.2-r2-extended-sepolia` | yes |
| Local R2-A | `d3129075d5866d27c79c6d2cba3b4b1128923889` tree `ce5de3b01e3506d5e3a7672958696a7acadfce1c` | same; official branch clean; **3 commits ahead** of origin | yes |
| PR #13 | `e420b317dc7f7166f70d24701763c0ab15364c68` | same; used as handoff source only | yes |

**Drift:** official workdir is 3 commits ahead of `origin/experiment/classic-v0.2-r2-extended-sepolia`. Those commits were **not** treated as already-reviewed, were **not** mixed into the PR #12 canary target, and the experiment branch was **not** pushed.

Worktrees used (official files untouched):

- `/private/tmp/classic-grid-pr12-canary-20260908` detached at TARGET_HEAD
- `/private/tmp/classic-grid-canary-review-20260908` branch `tooling/classic-canary-review-20260908`
- `/private/tmp/classic-grid-r2a-snapshot-20260908` branch `review/classic-r2a-local-snapshot-20260908`

Target / tool / publication identities are separate fields in [identities.json](identities.json).

## 2. A — local R2-A snapshot

Status: **OBSERVED** identity match. Secret scan: **OBSERVED** no credential values (`.env.example` placeholders only). Original three commits retained (no squash, rebuild, or rewrite).

| Commit | Tree | Subject |
| --- | --- | --- |
| `1fce4d1f5f9f988aa53f23cda029e13ee9d536b8` | `c59efe7b7c8393272dfa1b315bdd11b10944619e` | fix(r2a): reject non-exact SANDBOX_CONFIRM and sandbox proxy tokens |
| `1687c4a9725b4dc751cf66af00d83d4c0c274d37` | `87173cd8bc6bc98fe802ae12543dd7efd502ef77` | docs(r2a): bind Corrective 3 candidate identity |
| `d3129075d5866d27c79c6d2cba3b4b1128923889` | `ce5de3b01e3506d5e3a7672958696a7acadfce1c` | docs(r2a): record Corrective 3 result HEAD and tree |

Local branch: `review/classic-r2a-local-snapshot-20260908`  
Remote push: **NOT_RUN** at packet fill (classifier blocked autonomous push).  
Disposition when published: `PUBLISHED_FOR_REVIEW` — **not** accepted.

This snapshot is **not** the PR #12 canary verification target. See [local-r2a-publication.json](local-r2a-publication.json).

## 3. B — PR #12 Extended-only canary verification

Test target fixed at TARGET_HEAD / TARGET_TREE. Existing pack / lockfile-install / audit / probe / source-policy / artifact-content tools were reused. New helpers live only under `tools/review/classic-canary-20260908/`. Runtime, adapters, risk, lockfiles, and audit baseline were not modified.

Host toolchain **OBSERVED**: Node v26.5.0 / npm 11.17.0 / Python 3.13.14 / Darwin arm64. CI pin remains Node v22.23.2. This is recorded drift, not a pin change.

### Isolation

| Item | Classification | Detail |
| --- | --- | --- |
| `libseccomp.so.2` | **BLOCKED** | dlopen failed on Darwin |
| AF_UNIX | **OBSERVED** | `socket(AF_UNIX)` succeeded |
| Docker/Linux guest | **OBSERVED_UNAVAILABLE** | no docker binary |
| `python3 scripts/verify-current-candidate.py` | **BLOCKED** | exit 1, `blockers=["OSError"]`, `networkIsolation=null` |
| Kernel-isolated offline runtime | **BLOCKED** | no weaker filter was installed |

The wrapper was attempted. Isolation was **not** lifted to obtain a green wrapper.

### Registry phase (no trading credentials)

HOME was a credential-free directory. `LIVE_CONFIRM` and Extended/NPM tokens were unset.

| Step | Classification | Exit | Notes |
| --- | --- | --- | --- |
| Root `npm ci --ignore-scripts` (to run tests/tsx) | **OBSERVED** | 0 | Target worktree only |
| `packExtendedCanary` from TARGET_HEAD | **OBSERVED** | 0 | see hashes below |
| Canary lockfile `npm ci --omit=dev` | **OBSERVED** | 0 | installed: tsx, undici, ws, esbuild, fsevents, @esbuild/darwin-arm64 |
| `npm audit --omit=dev --json` | **OBSERVED** | 0 | **this-round query** 2026-09-08T06:20:42.761Z–06:20:43.192Z |
| Tarball extract + `npm ci` | **OBSERVED** | 0 | same names |

Canary audit this round (raw: [registry/canary-audit.json](registry/canary-audit.json)):

```text
queried_at_utc_start=2026-09-08T06:20:42.761Z
queried_at_utc_end=2026-09-08T06:20:43.192Z
high=0 critical=0 total=0
is_historical_zero_high_reuse=false
supports_root_clearance=NO
```

This 0 high / 0 critical figure is **not** the 2026-09-06 CI capture copied forward. It also does **not** clear the root graph.

### Artifact identity

| Field | Value |
| --- | --- |
| Canary lock blob | `08069e80df73b7995f13a4bf4c73595a7f2d6f4f` (identical to frozen R1) |
| Lockfile SHA-256 | `f66f1a14e91ca293d499b74420b1c669c9b11d0806cf87830d3ca59e64763f99` |
| Canary tree | `ff8743f5227f9ed3ae8abb53388fc21b17612d8a` (not R1 `74db4f60…`; R1 clearance does not rebind) |
| Content-manifest SHA-256 | `2510544ff839caa5ae82e972ffc2d583a864112eb0e6b86fa1d0a983461d1e84` (matches historical CI capture) |
| Artifact SHA-256 first | `f5f364c129b75ccd1e7a502736c36c529169c4e9f00c49ce8f2578e5033f3fb5` |
| Artifact SHA-256 second | `93131d2e53e5e938c0cf14c85fb876b997c2862a87abfa6037a0eed3dfda2eea` |
| Historical CI tarball SHA-256 | `4877250df71249778e560b9b0d156ef73ba474f1c4e4f117ec42173d03a96de0` **INHERITED_HISTORICAL** |

Tarball bytes were **not** deterministic on this Darwin `tar` (first ≠ second; neither equals the Linux CI tarball). Content-manifest identity matched the historical CI capture. Entrypoint: `src/cli/run-extended-canary.ts` blob `3078c3eb74a2ea4798eadacff65e7d413b429b69`.

Tarball listing does not include `src/venues/n1.ts`, `src/officialStats.ts`, `src/cli/run.ts`, or other forbidden source paths. File list: [registry/tarball-list.txt](registry/tarball-list.txt).

### Extra forbidden boundary (lockfile + installed graph + tarball + load log)

Not package.json-only. Scanner: [extra-boundary-scan.json](extra-boundary-scan.json). Hits for `toml`, `@n1xyz/*`, `@coral-xyz/anchor`, `src/venues/n1.ts`, `src/officialStats.ts`: **none** in lockfile keys/names, installed names, tarball entries, or loaded specifiers. **OBSERVED**.

Installed graph names: `tsx`, `undici`, `ws`, `esbuild`, `fsevents`, `@esbuild/darwin-arm64`.

### Userspace probe (not kernel isolation)

Classification: **OBSERVED** as `USERSPACE_PROBE_ONLY_NOT_LINUX_SECCOMP`. **Not** a substitute for LINUX_SECCOMP_AF_UNIX_ONLY.

- Probe exit 0; `liveExchangeWrite=false`; `productionCredentialUsed=false`; `forbiddenLoaded=[]`; `unexpectedNetwork=[]`; `moduleGraphHits=[]`
- stdout: `dryRun=true venues=extended`; `[extended] connected` is loop logging after `ExtendedExecutor.connect()` which **returns immediately when dryRun** (no vendor init)
- stderr: experiment HALT `RISK_STATE_*_MISSING` in empty HOME
- `VENUES=nado` exit 1 with `CANARY_VENUE_UNAVAILABLE:nado` from `applyCanaryProfileDefaults()` in `run-extended-canary.ts` — not root `src/cli/run.ts`, no remap to extended

Loaded inventory includes canary Extended sources, `extendedNetwork.ts`, tsx/esbuild/ws. It does not include `n1.ts`, `officialStats`, `toml`, `@n1xyz`, or `@coral-xyz/anchor`.

Kernel-isolated offline execution remains **BLOCKED**.

### Existing security regressions (assertions unchanged)

| Command | Classification | Stats |
| --- | --- | --- |
| `node --import tsx --test` extended-canary-boundary, source-policy, canary-manifest-strict, canary-artifact-content | **OBSERVED** | tests 122 / pass 122 / fail 0 / skipped 0 / `duration_ms=28491.703375` / exit 0 |
| unmodified `test/security/extended-canary-install.test.ts` | **OBSERVED** | tests 1 / pass 1 / fail 0 / `duration_ms=3347.783833` / exit 0 / kernel isolation **NOT_APPLIED** |

### Root audit

| Item | Classification |
| --- | --- |
| Fresh root `npm audit` this round | **NOT_RUN** |
| PR #12 CI capture 16 high / 0 critical / 24 total, NEW_HIGH `GHSA-82x6-q7mm-w9cf` + `GHSA-v5mp-jgw5-2x6j` | **INHERITED_HISTORICAL** original date **2026-09-06** — not a 2026-09-08 fresh audit |

Route A `SOURCE_BUILD_PREREQUISITE` is **retained**. No new upstream search, no SDK fork, no `npm audit fix` / override / downgrade / baseline widening.

## 4. What this cannot support

- Root / global dependency security clearance
- Treating canary audit 0/0 as root clearance
- Transfer of frozen R1 canary clearance onto PR #12
- Kernel-isolated offline validation on this Darwin host
- Testnet/mainnet write, merge, deployment, R2-B, or replacing root CLI with canary

## 5. Command index

See `logs/*.meta.json` for UTC timestamps. Summary:

| name | exitCode | classification |
| --- | --- | --- |
| 00-verify-current-candidate | 1 | BLOCKED |
| 01-root-npm-ci | 0 | OBSERVED |
| 02-test-security-canary-subset | 0 | OBSERVED |
| 03-registry-phase | 0 | OBSERVED |
| 05-userspace-probe | 0 | OBSERVED (not kernel isolation) |
| 07-test-canary-live | 0 | OBSERVED (not kernel isolation) |

Raw logs: `logs/`. Isolation JSON: [offline/isolation-check.json](offline/isolation-check.json).

```text
LIVE_EXCHANGE_WRITE_EXECUTED=NO
TESTNET_WRITE_EXECUTED=NO
PRODUCTION_CREDENTIAL_USED=NO
MERGE_EXECUTED=NO
FORCE_PUSH_USED=NO
REPOSITORY_SETTINGS_CHANGED=NO
FROZEN_REF_MOVED=NO
EXPERIMENT_R2A_BRANCH_PUSHED=NO
SELF_DECLARED_PASS=NO
```
