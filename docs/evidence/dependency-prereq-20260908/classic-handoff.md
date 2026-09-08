# Classic Grid — 2026-09-08 dependency prerequisite reconcilation

This packet is navigation and evidence for independent review. It is **not** PASS, ACCEPT, MERGE AUTHORIZED, or LIVE AUTHORIZED.

```text
TASK_STATUS=OWNER_DECISION_REQUIRED
ROUTE_A=BLOCKED_MISSING_INPUTS
ROUTE_B=NOT_ADOPTED
CANDIDATE_CREATED=NOT_CREATED
ADOPTION=NOT_PERFORMED
INDEPENDENT_REVIEW=NOT_PERFORMED
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
DEPENDENCY_SECURITY_CLEARANCE=NO
LIVE_RELEASE_BLOCKED=YES
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
NEXT_TRADING_PHASE_STARTED=NO
```

Evidence directory: `docs/evidence/dependency-prereq-20260908/`  
Machine-readable result: [status.json](status.json)

## 1. Actual identity (this round)

Remote objects were read via `git fetch` / `gh`. The official working directory was **not** reset onto PR #12.

| Ref | Expected historical anchor | Observed 2026-09-08 | Match |
| --- | --- | --- | --- |
| PR #12 | open Draft `fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf` tree `7f14f66eac518c4427076f18fbcfdc7d935c79d8` | same; `merged=false`; `mergeStateStatus=UNSTABLE` | yes |
| PR #12 base | `fix/classic-audit-identity-v2-20260905` `e723f4c1596ab1e2348b67f2a8218578e06ef841` | same | yes |
| Frozen R1 | `990a790706e17b52e04d0d1957505cdad5d45862` tree `c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8` | same | yes |
| Remote R2-A | (CURRENT_STATUS) `39bf3a797b58f7fd91babf9f2d608cfd28e04487` tree `fb139e4737711602df44636e8186ccc6694de654` | same on `origin/experiment/classic-v0.2-r2-extended-sepolia` | yes |

PR comments on #9 / #11 / #12: none. Issue #2 comments were not used as new authorization.

**Official working directory (not PR #12; not reset):**

- Branch: `experiment/classic-v0.2-r2-extended-sepolia`
- HEAD: `d3129075d5866d27c79c6d2cba3b4b1128923889` tree `ce5de3b01e3506d5e3a7672958696a7acadfce1c`
- Clean; **3 local commits ahead** of `origin` (docs/r2a Corrective 3 + sandbox token rejection)
- Those local commits are **not** this packet's source identity.

## 2. Entry files

| File | Where found | Note |
| --- | --- | --- |
| `AGENTS.md` | PR #12 and docs branch `docs/classic-agent-autonomy-20260905` | Absent from the official R2-A working tree |
| `docs/CURRENT_STATUS.md` | same remote branches | Navigation; not acceptance |
| `AI_START_HERE.md` | same remote branches | Routes to CURRENT_STATUS / verification |
| Verification | `npm run test:verification` and `npm run verify:current-candidate` | Documented on CURRENT_STATUS |

## 3. Completed / still blocked / new this round

### Already completed (inherited; not re-implemented)

- GHSA-stable audit identities, same-run diagnostics, fail-closed aggregation, `--out-dir` / CLI argument honors (PR #10–#12 tooling).
- Frozen R1 engineering/R1 offline qualification remains at exact HEAD `990a790…` (historical cloud disposition). That is **not** transferred to PR #12 or to local R2-A descendants.
- Extended-canary isolation design: own lockfile (`tsx`, `undici`, `ws`), file-manifest allowlist, injected fallbacks for `officialStats` / `venues/index`, fail-closed `CANARY_VENUE_UNAVAILABLE`.

### Still blocked

- **Route A (full dependency repair):** source↔artifact provenance and parent build inputs for `@n1xyz/nord-ts` (see §5). No external SDK candidate was created.
- **Parser harness originals:** `classic-pr12-ci-supplement-20260906.md`, `classic-closure-ledger.md`, `classic-dependency-qualification.md`, `next-dependency-change-proposal.md`, `source-build-prerequisites.md`, and the original qualification packet / harness / fixtures remain **INPUT_MISSING**. Inherited 114 observations / 57 comparisons were **not re-run**.
- **Root live audit on PR #12 CI** still fail-closes (`required_19` and `required_20` outcome=failure). Historical capture is 16 high / 0 critical / 24 total with NEW_HIGH `GHSA-82x6-q7mm-w9cf` and `GHSA-v5mp-jgw5-2x6j`. That capture is **not** a 2026-09-08 fresh registry audit.
- No new CI run exists on `fix/classic-audit-output-path-20260906` besides `34004346097`.

### New this round (not a repair)

- Located agent/status/verification entrypoints on remote docs/PR #12 (they are not on the official R2-A worktree).
- Re-queried npm/GitHub/advisory metadata: **no new versions, integrity, gitHead, tags, engine tree, or `#openapi` flake output**. Recorded as **no new actionable candidate-build input**.
- Retrieved PR #12 CI security-inventory artifact (run `34004346097`, artifact `classic-v0.2-security-inventory-fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf`) and confirmed canary vs root boundary from lockfile, file-manifest, entrypoints, and that CI output.
- Route A vs Route B comparison below. Route B was **not** adopted.

## 4. Does the toml / nord-ts problem still exist?

**Root graph: yes, on the last captured live audit of PR #12 bytes.**

- Root lock still pins `@n1xyz/nord-ts@0.6.3` with integrity `sha512-Kp0rJHz7Vx8HP6JaHP4YsC1KeV1bDjISIWcGl2XuuaZiXSEuY3n+0sYqztHKf/dkklBIqZRmQgXlpx2LDOMAPw==` matching today's registry 0.6.3.
- Installed parser path remains `toml@3.0.0` via `@coral-xyz/anchor@0.31.1` ← `@n1xyz/proton@0.1.0`.
- CI `audit-baseline-verification.json` `newHigh` lists `GHSA-82x6-q7mm-w9cf` and `GHSA-v5mp-jgw5-2x6j` on `node_modules/toml`. Advisory pages are unchanged (`updated_at` 2026-09-03).
- Root public entries still dynamically import `@n1xyz/nord-ts`: `src/venues/n1.ts`, `src/officialStats.ts`. Root CLI `src/cli/run.ts` calls `runLoop({ once })` without canary bindings, so default loaders remain available.

**Bundled nord-ts parser path:** not re-tested. Original harness is INPUT_MISSING. A previous string search in one local `node_modules/@n1xyz/nord-ts@0.6.3` tree is **not** treated as disproof. Two-path finding remains inherited.

**Extended-canary graph: the installed toml / nord-ts packages are absent** from `packages/extended-canary/package-lock.json` (32 package keys: `tsx`, `undici`, `ws`, `esbuild`, optional `@esbuild/*` / `fsevents` only).

## 5. Route A — repair the full dependency (blocked)

Missing inputs (same set as 2026-09-07; re-checked 2026-09-08):

1. Verifiable mapping from npm `@n1xyz/nord-ts@0.6.3` (and any later candidate such as `0.7.4`) to an immutable source commit/tree. Public `n1xyz/nord-ts` HEAD is still `76ffae09239751b6cc4de51447e2d1591830f1d2` tree `9fc2536469378455e6e2432bc402782e7cfcd082`, manifest **0.3.1**. npm `0.3.1` `gitHead=6f40eeb96a98dc708d952c9bcf64212ec86b686a` is **not** that commit and is not on the public subtree. `0.6.3` / `0.7.4` still have **no gitHead** and **no dist attestations**. Public tags: 0.
2. Parent `engine` proto / buf module at that commit (`../engine` still 404 on the public subtree).
3. Parent Nix flake output `#openapi` plus `flake.lock`, or an upstream-supported standalone recipe. `n1xyz/n1.nix` still has only `bun-enforce.nix` and `cargo-build-static-release.nix`; `pushed_at` still `2026-08-18T19:07:07Z`.
4. Pinned Bun / Nix / `openapi-typescript` / `protoc-gen-es` versions and hashes actually used to produce published `dist/`.
5. Original parser harness/fixtures if historical observations must be replayed.

**Who can unblock:** N1/nord-ts vendor (or a public parent snapshot they designate). Classic cannot invent provenance.

**After those inputs exist:** one disposable clone outside the official workdir may attempt a minimal two-path candidate (installed `toml` **and** SDK bundle), reuse the original harness if recovered, and run type/compat/audit/replay without exchanging or loading user credentials. Do not integrate into the root lockfile in that increment.

**Risk / cost:** high. npm `fixAvailable` for the toml GHSAs still points at `@n1xyz/nord-ts@0.0.1` (forbidden major). A toml override alone would not cover a bundled parser. Fresh candidate audit cannot reuse the 2026-09-06 root capture.

**This round:** `CANDIDATE_CREATED=NOT_CREATED`. No tarball re-download; no parser matrix; no `package.json` / lockfile / baseline edits.

## 6. Route B — independently review existing Extended-only isolation (not adopted)

Inspected from actual bytes, not from policy hope.

**Entrypoints**

- Canary: `src/cli/run-extended-canary.ts` injects `createExtendedCanaryExecutor`, `refreshOfficialStats: emptyCanaryOfficialBundle`, `getOfficialCache`. Selecting a non-Extended venue throws `CANARY_VENUE_UNAVAILABLE:<id>`.
- Root: `src/cli/run.ts` does not inject those bindings.

**Dependency graph**

- Canary lock blob is **identical** on frozen R1 and PR #12: `08069e80df73b7995f13a4bf4c73595a7f2d6f4f`. No `toml`, `@n1xyz/*`, `@solana/*`, `@coral-xyz/anchor`.
- Root lock SHA-256 in the CI capture: `f278d8b7f0d559839e35ee64e94db9e39c7d6037f5692d0cafa02ba6c6b254ed` (matches baseline; findings **not** cleared).

**Packed artifact**

- `file-manifest.json` runtime files exclude `src/venues/n1.ts` and `src/officialStats.ts`. Approved dynamic import is vendor Extended only. `src/loop.ts` fallbacks to `./officialStats.js` and `./venues/index.js` are listed `excludedFromArtifact`.
- `canary-artifact-smoke.ts` treats those paths as `SOURCE_LEAK` if present in the tarball.
- Frozen R1 vs PR #12 canary **tree** differs: R1 `74db4f60…` vs PR #12/docs/R2-A `ff8743f5…`. The file-manifest add is `src/extendedNetwork.ts`. Package.json/lock blobs are unchanged. **R1 canary dependency clearance does not automatically rebind to PR #12.**

**PR #12 CI canary result (historical run, not a new execution):**

- `verify:extended-canary` JSON `ok=true`, audit 0 high / 0 critical / 0 total.
- `forbiddenInLockfile` / `forbiddenInstalled` / `forbiddenLoaded` / `moduleGraphHits` empty.
- `liveExchangeWrite=false`, `productionCredentialUsed=false`.
- Loaded inventory includes canary/Extended/`tsx`/`ws`/`esbuild` runtime files and `extendedNetwork.ts`; it does not list `n1.ts`, `officialStats.ts`, `toml`, or `@n1xyz/nord-ts`.

**What this can support (if independently accepted at a named identity)**

- A **scoped** statement that the isolated Extended-only production artifact, at that exact canary lock + content-manifest + entrypoint, did not install or load the root toml/`@n1xyz/nord-ts` packages in the recorded CI verify.
- Continued fail-closed root audit (do **not** change audit policy to match the canary).

**What this cannot support**

- Root / global dependency security clearance.
- Claim that the bundled nord-ts parser is fixed.
- Transfer of frozen R1 canary clearance onto PR #12 or onto local R2-A HEAD `d312907…`.
- Testnet/mainnet write, merge, deployment, or a new trading phase.
- Replacing root `npm start` with canary as a silent default.

**Independent acceptance still required**

- Current-byte review of whichever canary identity the owner names.
- Confirmation that publication/qualification policy may treat Classic verification as canary-scoped.
- Separate decision that root High findings remain visible and blocking for any non-canary artifact.

This round **does not choose or adopt Route B**, does not edit audit policy, and does not declare the root fixed.

## 7. Priority suggestion (not a decision)

Evidence supports treating **Route A as blocked** and **Route B as the only currently executable *review* path** toward “restricted Extended-only verification qualification.” That is a recommendation for the owner/independent reviewer, not an implementation choice made here.

Do **not** wait for a green root CI aggregator: `required_19`/`required_20` are correctly fail-closed on NEW_HIGH toml GHSAs. Do **not** override only `toml`. Do **not** treat npm `0.7.4` as a drop-in repair. Do **not** start R2-B / live trading.

**Decision gaps (do not guess)**

1. Publication policy: may Classic’s verification qualification be explicitly canary-scoped?
2. Which exact identity to review for that scope (frozen R1 canary tree vs PR #12 canary tree)?
3. Recovery of the original parser harness, if Route A later proceeds.

## 8. Tests this round

| Item | Result |
| --- | --- |
| External SDK candidate | NOT_CREATED |
| Parser matrix | NOT_RUN (`INPUT_MISSING` originals; no new source input) |
| Fresh root `npm audit` | NOT_RUN (no new CI; historical capture retained) |
| Canary candidate build | NOT_CREATED |
| Exchange / credentials | not used |
| Official workdir / root lock / canary lock | unmodified |

## 9. Evidence index

| Object | Location |
| --- | --- |
| This handoff | this file (commit-bound after push) |
| Machine-readable status | [status.json](status.json) |
| Upstream delta vs 2026-09-07 | [upstream-delta.json](upstream-delta.json) |
| Canary boundary facts | [canary-boundary.json](canary-boundary.json) |
| PR #12 CI aggregator extract | [ci-aggregator-extract.txt](ci-aggregator-extract.txt) |
| PR #12 CI canary audit | [extended-canary-audit.json](extended-canary-audit.json) |
| PR #12 CI canary verify | [extended-canary-verification.json](extended-canary-verification.json) |
| PR #12 CI root policy | [root-audit-baseline-verification.json](root-audit-baseline-verification.json) |
| CI run (supplementary; may expire) | https://github.com/danny0971haha/classic-grid/actions/runs/34004346097 |
| Security inventory artifact id | `9980564496` |
| Content hashes | [SHA256SUMS](SHA256SUMS) (does not hash itself) |

```text
LIVE_EXCHANGE_WRITE_EXECUTED=NO
TESTNET_WRITE_EXECUTED=NO
PRODUCTION_CREDENTIAL_USED=NO
MERGE_EXECUTED=NO
FORCE_PUSH_USED=NO
REPOSITORY_SETTINGS_CHANGED=NO
FROZEN_REF_MOVED=NO
SELF_DECLARED_PASS=NO
```
