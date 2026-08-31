# Classic v0.2 R2-A — Extended Sepolia sandbox boundary

**Status:** R2A_CORRECTIVE_2_IMPLEMENTATION=REVIEW_CANDIDATE / INDEPENDENT REVIEW REQUIRED
**Date:** 2026-08-31
**Repository:** `danny0971haha/classic-grid`
**Branch:** `experiment/classic-v0.2-r2-extended-sepolia`
**Base:** `experiment/classic-v0.2-100u-safety`
**Task:** `CLASSIC_V02_R2A_CORRECTIVE_2`

This document does **not** declare R2 PASS, R2A PASS, testnet qualification, live readiness, merge, or deployment. This is only R2-A sandbox-boundary qualification. Credentialed Sepolia access, testnet writes, mainnet writes, R2-B, deployment, and merge remain unauthorized. CI success is evidence only.

```text
TASK=CLASSIC_V02_R2A_CORRECTIVE_2
R1_BASE_PRESERVED=YES
R2A_IMPLEMENTATION=REVIEW_CANDIDATE
R2A_CORRECTIVE_IMPLEMENTATION=REVIEW_CANDIDATE
R2A_CORRECTIVE_2_IMPLEMENTATION=REVIEW_CANDIDATE
R2_SANDBOX_TESTNET_QUALIFIED=NO
R3_BOUNDED_LIVE_CANARY_ELIGIBLE=NO
TESTNET_NETWORK_WRITE_EXECUTED=NO
MAINNET_NETWORK_WRITE_EXECUTED=NO
PRODUCTION_CREDENTIAL_USED=NO
TESTNET_CREDENTIAL_USED=NO
REAL_FUNDS_USED=NO
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
SELF_DECLARED_PASS=NO
NEXT_ACTION=INDEPENDENT_R2A_CURRENT_BYTE_REVIEW
TESTNET_NETWORK_WRITE_AUTHORIZED=NO
MAINNET_NETWORK_WRITE_AUTHORIZED=NO
HTTP_REDIRECT_MANUAL=YES
REDIRECT_STATUS_301_TO_308_REJECTED=YES
REDIRECT_TARGET_CONTACTED=NO
WEBSOCKET_BASE_REQUIRED=YES
ATOMIC_PROFILE_ENFORCED=YES
DRY_RUN_STRICT_EXACT=YES
LIVE_CONFIRM_STRICT_EXACT=YES
EXTERNAL_EXTENDED_NETWORK_CONTACTED=NO
PACKAGE_LOCK_CHANGED=NO
DEPENDENCY_CHANGED=NO
```

## Binding

```text
FROZEN_R1_BRANCH=experiment/classic-v0.2-100u-safety
FROZEN_R1_HEAD=990a790706e17b52e04d0d1957505cdad5d45862
FROZEN_R1_TREE=c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8
SOURCE_BRANCH=experiment/classic-v0.2-r2-extended-sepolia
REVIEWED_STARTING_HEAD=92de0e7d71ab5418412d35135604e1f1d776be08
ACTUAL_STARTING_HEAD=92de0e7d71ab5418412d35135604e1f1d776be08
ACTUAL_STARTING_TREE=53acae880cecfa50495ddedb930b195b36a8b76f
IMPLEMENTATION_HEAD=a7f90d2e0de06dc00d276a568bb61557e7761046
IMPLEMENTATION_TREE=46caf75a80048d18a56e46737f273e8ae0bb272a
RESULT_HEAD=b50cd4c2dc1d7e9cfc01d46a38165021187519e7
RESULT_TREE=871f7866c88a6400b4c06ac0b56ecb207ba039c5
FULL_DIFF_SHA256=2dc50fcd508b82d6569a7c83e3094370892849a2d575c52e5acc88a20320f3e5
CORRECTIVE_IMPLEMENTATION_HEAD=c478a0b36d112f4ecba490a2c7d97e5a74fa910d
CORRECTIVE_IMPLEMENTATION_TREE=9bd60b17852edc4598dd247d358d5660789dde92
CORRECTIVE_PRODUCT_DIFF_SHA256=3a3ea87fb588ebb9c16a5250dfee2701ae53f6a8ad3c00fade6ae4ea88388040
FINAL_HEAD=7f8c7d671df5cb9f0d51b95bcb4113525c372c25
FINAL_TREE=66873562118ef0a0ede08a262ba57abb7b8d5536
CORRECTIVE_FULL_DIFF_SHA256=3f57e0fdbf6538a6dacce954cc24084fa6ed597ff942b1f017bb644a4d1751dd
CORRECTIVE_2_REVIEWED_STARTING_HEAD=7300422bef95ab5a533d521e1826af300a7d8652
CORRECTIVE_2_ACTUAL_STARTING_HEAD=7300422bef95ab5a533d521e1826af300a7d8652
CORRECTIVE_2_ACTUAL_STARTING_TREE=65c269e758cf7153e6e87eb5b83299e098df5518
CORRECTIVE_2_IMPLEMENTATION_HEAD=2f01b52afea04c4a0d2fab5eb0260b81e9a62c66
CORRECTIVE_2_IMPLEMENTATION_TREE=abf8892e6f995f390d0ecfbc6771cb949045b915
CORRECTIVE_2_PRODUCT_DIFF_SHA256=b97cbf0f208fe8804ad194f78680194a12f36d29f36f673a7348615881eed82b
```

`IMPLEMENTATION_HEAD` is the original R2-A product-code commit. `RESULT_HEAD` is the identity-bind commit that first recorded that implementation identity. `CORRECTIVE_IMPLEMENTATION_HEAD` is the Corrective 1 product commit. `FINAL_HEAD` is the Corrective 1 identity-bind commit. `CORRECTIVE_2_IMPLEMENTATION_HEAD` is the Corrective 2 product commit on top of `CORRECTIVE_2_REVIEWED_STARTING_HEAD` (exact match; no reset/rebase/amend). There is no stale `REVIEW_CANDIDATE_TIP=92de0e7…` identity for this corrective: that SHA is the original R2-A packet-fill / Corrective 1 starting HEAD only. Independent review should use `git rev-parse` of `experiment/classic-v0.2-r2-extended-sepolia` after push as the checkout tip. Frozen origin R1 must remain:

```text
git rev-parse origin/experiment/classic-v0.2-100u-safety
= 990a790706e17b52e04d0d1957505cdad5d45862
git rev-parse origin/experiment/classic-v0.2-100u-safety^{tree}
= c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8
```

Local toolchain during Corrective 2: Node v22.23.2 / npm 10.9.8 (repository-pinned). Corrective 1 and the original R2-A implementation used the same pin.

## Corrective 2 — strict fail-closed DRY_RUN / LIVE_CONFIRM parsing

Corrective 2 does not authorize testnet or mainnet writes. It closes the R2-A review finding that permissive `truthy()` parsing treated unknown `DRY_RUN` values as explicit false.

`parseExecutionBoundary` now accepts only the documented exact tokens. There is no trim, case-fold, prefix match, or numeric coercion.

```text
DRY_RUN=0|1          # unset or empty defaults to 1 (historical dry-run)
LIVE_CONFIRM=YES     # unset or empty means not confirmed
```

Rejected with `DRY_RUN_INVALID` (never interpreted as `DRY_RUN=false`): `banana`, `FALSEE`, `TRUE`, `00`, `yesplease`, `true`, `yes`, `YES`, `false`, `FALSE`, whitespace-padded `0`/`1`, `00`, `01`, `1.0`, `-0`, `no`, `off`, `2`, and any other non-exact value.

Rejected with `LIVE_CONFIRM_INVALID`: `yes`, `Yes`, `true`, `TRUE`, `1`, `banana`, padded `YES`, and any other non-exact value. Sandbox still cannot reuse `LIVE_CONFIRM=YES` (`EXECUTION_CONFIRMATION_CONFLICT`).

Official Extended mainnet/Sepolia REST, WebSocket, signing-domain, chain-ID, and SNIP-12 profile values are unchanged.

### Corrective 2 changed-file inventory

Paths changed in `CORRECTIVE_2_IMPLEMENTATION_HEAD` relative to `CORRECTIVE_2_ACTUAL_STARTING_HEAD`:

```text
2	0	.env.example
25	19	src/extendedNetwork.ts
317	0	test/experiment-v02-r2a-sandbox-boundary.test.ts
```

| path | before (starting HEAD `7300422`) | after (corrective 2 product `2f01b52`) | justification |
| --- | --- | --- | --- |
| `src/extendedNetwork.ts` | `d31a26b51205f44c9bc6d66f5bcd1f23c6b3fb7a` | `94c9c920b773de173d462245f4d6cf105c97eb7f` | Replace `truthy()` with exact `0`/`1` and `YES` parsers; unknown values throw `DRY_RUN_INVALID` / `LIVE_CONFIRM_INVALID`. |
| `test/experiment-v02-r2a-sandbox-boundary.test.ts` | `8742be308110fc26aee88bb1c3e314a58dcace6f` | `44a8149ecd9d0e4eb93bec90bff612c9040e48ce` | Accepted/rejected matrix in offline, sandbox, and live; execution-path fail-closed tests. |
| `.env.example` | `742ff3c18ed156bb2556f9836142abacba6f3f73` | `8d7f7db2e869c9e38114f1644f1a991621a5f73d` | Document the exact accepted `DRY_RUN` / `LIVE_CONFIRM` tokens. |
| `docs/classic-v0.2-r2a-extended-sepolia-sandbox-boundary.md` | `938359f0a1a625e9b5af87b3bb910a41a060f561` | this evidence commit blob | Record Corrective 2 identity and results. |

`package-lock.json` and dependency versions were not changed. Official profile tuples in `EXTENDED_NETWORK_PROFILES` were not changed.

Product diff SHA-256 versus `CORRECTIVE_2_ACTUAL_STARTING_HEAD` (excluding this evidence file):

```text
b97cbf0f208fe8804ad194f78680194a12f36d29f36f673a7348615881eed82b
```

### Corrective 2 tests

| id | case | result |
| --- | --- | --- |
| C2-DOC | documented allowlists are exact `0`/`1` and `YES` | pass |
| C2-DRY-ACC-OFFLINE | unset / empty / `1` remain dry-run; exact `0` is live, not sandbox | pass |
| C2-DRY-ACC-SANDBOX | sandbox accepts only exact `DRY_RUN=0`; `1`/absent conflict | pass |
| C2-DRY-ACC-LIVE | live accepts exact `0` and absent with `EXECUTION_MODE=live`; `1` conflicts | pass |
| C2-DRY-REJ-OFFLINE | all rejected values throw `DRY_RUN_INVALID` (historical and explicit dry-run) | pass |
| C2-DRY-REJ-SANDBOX | rejected values are not treated as sandbox `DRY_RUN=0` | pass |
| C2-DRY-REJ-LIVE | rejected values are not treated as live `DRY_RUN=0` | pass |
| C2-LIVE-CONFIRM | `LIVE_CONFIRM` accepts only exact `YES`; rejected in offline/sandbox/live | pass |
| C2-PATH | `loadRuntimeConfig` / `runLoop` / `runStatus` / `runFlat` / `connect` throw before create/connect/write | pass |
| C2-PATH-VENDOR | Sepolia vendor `init`/`_reqOnce` stay `TESTNET_NETWORK_WRITE_UNAUTHORIZED` | pass |
| C2-PATH-STATS | official Extended fetch returns empty on parse failure before `createExchange` | pass |
| N12 / P1 / P2 / write gates | v0.2 live forbid, historical dry-run, sandbox parse, write hard-disable | still pass |

R2-A sandbox-boundary file: 60 tests, 60 pass (was 49). `npm run check` TAP: `# tests 647` `# pass 647` `# fail 0` (was 636; +11 corrective cases). `grid.test.ts OK` is additional.

## Corrective 1 — HTTP redirect boundary and atomic WebSocket profile

Corrective 1 does not authorize testnet or mainnet writes. It closes two R2-A review findings on the existing vendor transport:

1. **HTTP redirects.** Native `fetch` and the proxy/undici path now share one request-init builder (`redirect: "manual"`) and one redirect guard. Statuses 301, 302, 303, 307, and 308 fail closed with `EXTENDED_ENDPOINT_REDIRECT_FORBIDDEN` **before** `res.json()` / body parse. The `Location` target is never requested, including same-origin, cross-origin, mainnet, Sepolia, localhost, and credential-bearing URLs. Thrown diagnostics are the stable code only — no API key, vault ID, private key, Location, or response body. `assertSameOriginResponse` in `src/extendedNetwork.ts` is **not** the production control; inspecting `response.url` after an automatic follow is not used and is not claimed sufficient. Credential-bearing requests never automatically follow a redirect.
2. **WebSocket profile atomicity.** `resolveVendorProfile` requires `websocketBase` to be present and exactly equal to the frozen network profile value. Missing or empty values throw `EXTENDED_WEBSOCKET_BASE_REQUIRED`. A mismatched host (mainnet WS on Sepolia, or Sepolia WS on mainnet) throws `EXTENDED_PROFILE_MIXED`. The WebSocket endpoint is not derived from REST. Caller-supplied custom WS hosts are rejected.

### Corrective 1 changed-file inventory

Paths changed in `CORRECTIVE_IMPLEMENTATION_HEAD` relative to `ACTUAL_STARTING_HEAD`:

```text
1	0	src/extendedNetwork.ts
358	12	test/experiment-v02-r2a-sandbox-boundary.test.ts
34	14	vendor/extended/exchange/extended.js
```

| path | before (starting HEAD `92de0e7`) | after (corrective product `c478a0b`) | justification |
| --- | --- | --- | --- |
| `vendor/extended/exchange/extended.js` | `812d777ebf61a67332fd797dc992868773286fc6` | `2004ef3f90915eb82581aa3e8ceb5645f5d027b8` | Production HTTP transport: shared `redirect: "manual"` init + reject 301–308 before body; require exact `websocketBase`. |
| `test/experiment-v02-r2a-sandbox-boundary.test.ts` | `6aeeeb473a15385fe62dfb6f8972d26437574bdb` | `8742be308110fc26aee88bb1c3e314a58dcace6f` | Behavioral native/proxy redirect tests and websocket tuple tests. |
| `src/extendedNetwork.ts` | `dfce8a64712f64497f2a52fd0846f629996ec848` | `d31a26b51205f44c9bc6d66f5bcd1f23c6b3fb7a` | One-line comment: `assertSameOriginResponse` is not the production redirect control. |
| `docs/classic-v0.2-r2a-extended-sepolia-sandbox-boundary.md` | `dbd815ef12e7b93e69a7ebc190166464b7bc151a` | `bdf01c4de79d88611039ebebdc1de0194e13cb65` at Corrective 1 identity-bind; later packet-fill blob supersedes | Record Corrective 1 identity and results. |

`vendor/extended/exchange/index.js` was not changed; `createExchange` already forwarded `websocketBase`. `package-lock.json` and dependency versions were not changed.

Product diff SHA-256 versus `ACTUAL_STARTING_HEAD` (excluding this evidence file):

```text
3a3ea87fb588ebb9c16a5250dfee2701ae53f6a8ad3c00fade6ae4ea88388040
```

### Corrective 1 tests

Behavioral coverage (not source-text-only):

| id | case | result |
| --- | --- | --- |
| C-R-MOCK | mock follow control: omitted `redirect: "manual"` contacts Location | `TEST_REDIRECT_TARGET_CONTACTED` |
| C-R301-native / C-R301-proxy | 301 rejected; `redirect: "manual"`; target not contacted; body not parsed | `EXTENDED_ENDPOINT_REDIRECT_FORBIDDEN` |
| C-R302-native / C-R302-proxy | 302 same | pass |
| C-R303-native / C-R303-proxy | 303 same | pass |
| C-R307-native / C-R307-proxy | 307 same | pass |
| C-R308-native / C-R308-proxy | 308 same | pass |
| C-R200-native / C-R200-proxy | non-redirect still returns `j.data` | pass |
| C-R-SAME-ORIGIN | same-origin Location not followed | pass |
| C-WS1 | missing `websocketBase` | `EXTENDED_WEBSOCKET_BASE_REQUIRED` |
| C-WS2 | empty / whitespace `websocketBase` | `EXTENDED_WEBSOCKET_BASE_REQUIRED` |
| C-WS3 | mainnet WS with Sepolia profile | `EXTENDED_PROFILE_MIXED` |
| C-WS4 | Sepolia WS with mainnet profile | `EXTENDED_PROFILE_MIXED` |
| C-WS5 | correct mainnet tuple in authorized v0.1 context | accepted |
| C-WS6 | correct Sepolia tuple parses; writes unauthorized | `TESTNET_NETWORK_WRITE_UNAUTHORIZED` |
| N8/N9 | sandbox/mainnet credential separation | still pass |
| N13/N14/P5 | state network binding | still pass |
| sandbox connect / vendor Sepolia `init` | testnet write hard-disable | still pass |
| N12 | v0.2 live forbid | still pass |
| P1 | historical dry-run | still pass |
| N15/N16 / offline guard | no external Extended access in tests | still pass |

Redirect tests use placeholder credentials only (`PLACEHOLDER_MAINNET_API_KEY_R2A`, `PLACEHOLDER_TESTNET_*`) and a Location containing those placeholders plus `user:…@evil.example`. The thrown message is exactly `EXTENDED_ENDPOINT_REDIRECT_FORBIDDEN`. Loopback proxy URL `http://127.0.0.1:9` is used only to exercise `ProxyAgent` construction; fetch is mocked and never contacts Extended or the loopback proxy.

R2-A sandbox-boundary file: 49 tests, 49 pass (was 29). `npm run check` TAP: `# tests 636` `# pass 636` `# fail 0` (was 616; +20 corrective cases). `grid.test.ts OK` is additional.

## Goal

Smallest fail-closed offline boundary required before a credentialed Extended Sepolia review.

1. Separate sandbox/testnet authority from live/mainnet authority.
2. Make the Extended network profile explicit and atomic.
3. Remove the vendor's unconditional mainnet signing assignment.
4. Prevent endpoint, signing-domain, chain-ID, credential, state, and execution-authority mixing.
5. Preserve accepted R1 trading, risk, storage, lease, ACK, planner, provenance, kill-switch, and dependency-boundary semantics.
6. Do not contact Extended, load real credentials, place/sign/cancel orders, or authorize R2/R3/live/deploy/merge.

## Execution-target contract

Exact values only. Ambiguous truthy sandbox confirmations are rejected.

```text
EXECUTION_MODE=dry-run|sandbox|live
EXTENDED_NETWORK=mainnet|sepolia
SANDBOX_CONFIRM=EXTENDED_SEPOLIA_TEST_ONLY
LIVE_CONFIRM=YES   # exact token only; not valid for sandbox
DRY_RUN=0|1        # exact tokens only; unset/empty defaults to 1
```

Absent new settings preserve historical behavior:

- missing `EXECUTION_MODE` + default/`DRY_RUN=1` → dry-run
- missing `EXECUTION_MODE` + `DRY_RUN=0` → live path via existing `assertLiveAllowed`
- `DRY_RUN=0` is never converted into sandbox
- sandbox is never inferred from `EXTENDED_API_URL`
- `DRY_RUN` and `LIVE_CONFIRM` are compared exactly. No trim, case-fold, or truthy aliases. Unknown values throw `DRY_RUN_INVALID` / `LIVE_CONFIRM_INVALID` and are never treated as `DRY_RUN=false`.

Sandbox double opt-in:

```text
EXECUTION_MODE=sandbox
EXTENDED_NETWORK=sepolia
SANDBOX_CONFIRM=EXTENDED_SEPOLIA_TEST_ONLY
DRY_RUN=0
```

Live and sandbox confirmations cannot be present together. v0.2 live remains `EXPERIMENT_V02_LIVE_FORBIDDEN`. Sandbox does not reuse `LIVE_CONFIRM`. Live does not reuse `SANDBOX_CONFIRM`.

R2-A write gate: even after sandbox config parses, `assertSandboxWriteAllowed()` throws `TESTNET_NETWORK_WRITE_UNAUTHORIZED`. Vendor `init`/`_reqOnce` also hard-disable Sepolia.

## Atomic Extended profiles

| field | mainnet | sepolia |
| --- | --- | --- |
| network | mainnet | sepolia |
| REST origin | `https://api.starknet.extended.exchange` | `https://api.starknet.sepolia.extended.exchange` |
| REST prefix | `/api/v1` | `/api/v1` |
| WebSocket base | `wss://api.starknet.extended.exchange/stream.extended.exchange/v1` | `wss://starknet.sepolia.extended.exchange/stream.extended.exchange/v1` |
| signing domain | `extended.exchange` | `starknet.sepolia.extended.exchange` |
| chain ID | `SN_MAIN` | `SN_SEPOLIA` |

REST, WebSocket, signing domain, and chain ID are one frozen tuple. Mixed tuples fail before connect or signing. URLs are parsed and compared by exact protocol, hostname, port, and pathname. Hostname substring matching is not used.

Effective REST URL for `/info/markets` on Sepolia:

```text
https://api.starknet.sepolia.extended.exchange/api/v1/info/markets
```

Origins with a non-root pathname, or resources that already include `/api/v1`, fail with `EXTENDED_REST_PREFIX_DOUBLE`.

SNIP-12 `name` remains `Perpetuals` (official SDK vector / existing hash). Profile `chainId` selects `SN_MAIN` vs `SN_SEPOLIA`. Profile `signingDomain` is the host identity used for qualification.

## Credentials

Sandbox reads only:

```text
EXTENDED_TESTNET_API_KEY
EXTENDED_TESTNET_STARK_PRIVATE_KEY
EXTENDED_TESTNET_STARK_PUBLIC_KEY
EXTENDED_TESTNET_VAULT_ID
```

Sandbox rejects any present mainnet credential name (`EXTENDED_API_KEY`, `EXTENDED_STARK_PRIVATE_KEY`, `EXTENDED_STARK_PUBLIC_KEY`, `EXTENDED_VAULT`, `EXTENDED_VAULT_ID`) and mixed sets. Live rejects present testnet credential names. This packet uses placeholder names only. No `.env` file was created. No real key was requested or loaded.

## State isolation

Network identity is bound into scope keys as `#extended-net-mainnet` or `#extended-net-sepolia` when sandbox is selected or `EXTENDED_NETWORK` is explicit. Historical dry-run scope keys remain unbound. Legacy state without a network token fails closed in sandbox (`EXTENDED_NETWORK_IDENTITY_MISSING`). Mainnet vs Sepolia bound keys differ. Client-order ownership prefix includes the network token when one is bound.

## Changed files

Additional source paths beyond the expected list, with justification:

- `src/extendedNetwork.ts` — single module for profiles, execution-target parse, credential separation, URL exactness, and write gate.
- `src/loop.ts` — must apply the execution gate and bind network into lease/risk/cursor/ownership identities before connect.
- `src/officialStats.ts` — `createExchange` now requires an atomic profile; sandbox must not construct a mainnet transport.
- `src/experimentTelemetry.ts` — `ExperimentMode` includes `sandbox`.
- `test/helpers/env.ts` — restore new env names so tests cannot leak placeholder secrets.
- `test/helpers/offlineNetworkGuard.ts` — accidental fetch/DNS to Extended hosts fails the unit test.
- `test/helpers/reduction.ts` — existing offline vendor fixture must construct an atomic mainnet profile, then sink `apiUrl` to `http://127.0.0.1:1`.
- `packages/extended-canary/file-manifest.json` — exact add of `src/extendedNetwork.ts` (required by local import closure).
- `package.json` — add the new test file to `npm test` only.
- `docs/classic-v0.2-r2a-extended-sepolia-sandbox-boundary.md` — this packet.

`package-lock.json` and production dependency versions were not changed. Root audit baseline was not relaxed. GitHub Actions trust policy was not changed. Source-policy exceptions were not broadened.

### numstat vs frozen R1

```text
15	0	.env.example
326	0	docs/classic-v0.2-r2a-extended-sepolia-sandbox-boundary.md
1	1	package.json
1	0	packages/extended-canary/file-manifest.json
33	4	src/config.ts
1	1	src/experimentTelemetry.ts
413	0	src/extendedNetwork.ts
28	6	src/loop.ts
19	4	src/officialStats.ts
15	5	src/venues/extended.ts
4	2	src/venues/extendedAccountStream.ts
544	0	test/experiment-v02-r2a-sandbox-boundary.test.ts
32	12	test/helpers/env.ts
48	0	test/helpers/offlineNetworkGuard.ts
8	1	test/helpers/reduction.ts
58	6	vendor/extended/exchange/extended.js
3	1	vendor/extended/exchange/index.js
```

Implementation diff SHA-256 (excluding this evidence file):

```text
107e18b2596beca621ba2ecae7676d87f768b9a470ccdda13d14a4466ee45909
```

### per-file blob SHA (git hash-object)

| path | before (frozen R1) | after |
| --- | --- | --- |
| `.env.example` | `9e6f256a746e969836e5d687b6e06cbf17462343` | `742ff3c18ed156bb2556f9836142abacba6f3f73` |
| `docs/classic-v0.2-r2a-extended-sepolia-sandbox-boundary.md` | (absent) | `b2936daaf3a01b3b57a555b82a9366e726d4415b` at identity-bind; later packet-fill blob supersedes |
| `package.json` | `ae63c398940b297790cdb386f859d5a4e4441f2d` | `6884451e20d569ef8df74a19f94e4224d9f8f7df` |
| `packages/extended-canary/file-manifest.json` | `6a92dd24fa0ac49ccd6285035402e3b44aa83f9f` | `cf1f1024e9b4f49f03bf45081f67068f1e24e9fe` |
| `src/config.ts` | `264804315837bf5e87f3f045397db6487eaf5900` | `3bf0e78de3001a6bffcbfb0aafe1fdb7f5478cde` |
| `src/experimentTelemetry.ts` | `8f47d8faa31e3bee2773d34dc9cbc19e54da6b6f` | `caef518d3962ae6ebad873fa9a36e2b9e44455c8` |
| `src/extendedNetwork.ts` | (absent) | `dfce8a64712f64497f2a52fd0846f629996ec848` |
| `src/loop.ts` | `b8cb9eed9b4d5d6428d90f8d7ecefe7be85e2188` | `429adf11865e899c5e0c02c281b89de78ffd7d22` |
| `src/officialStats.ts` | `0dfc16ba9186ce9740c743833d22caca6072f0d5` | `006e47f237c3a35be3128d0e9db57d0349282d26` |
| `src/venues/extended.ts` | `cc3ccedd64f0bd94868f229b9aec90f8ea468794` | `2b5bb0c1771ca658b0197ad95ae371a3519b9ce3` |
| `src/venues/extendedAccountStream.ts` | `95f649553d42df492f67649f90c9a097f8da3811` | `807d0a4e205657c8a96e921952fc139f555336bc` |
| `test/experiment-v02-r2a-sandbox-boundary.test.ts` | (absent) | `6aeeeb473a15385fe62dfb6f8972d26437574bdb` |
| `test/helpers/env.ts` | `018a34314c54b15c89340f56df5cfed273f3439b` | `62fd27710b3318e44c53a2d4c30606a2505ee7b9` |
| `test/helpers/offlineNetworkGuard.ts` | (absent) | `e056672591e84a9b15be0d073707772d29e5d46e` |
| `test/helpers/reduction.ts` | `58be1917f18e15767a85d2f1e3ac37c492a299fb` | `60913912dfd6f2358f2bdcbe06f12a5ee53f638d` |
| `vendor/extended/exchange/extended.js` | `8dda1f29cb7be0986955296e3e47de6b9be80750` | `812d777ebf61a67332fd797dc992868773286fc6` |
| `vendor/extended/exchange/index.js` | `de4bc830f2f7ae0e109d31fabfc80329421d8c98` | `1f25a52d541bc8a1a1ce7898c737797257a9cc49` |

## Red-first matrix

Tests were added against the unmodified frozen R1 APIs first. A probe on exact HEAD `990a790706e17b52e04d0d1957505cdad5d45862` showed the negative cases were accepted (NO_THROW) except the existing v0.2 live forbid.

| id | case | frozen R1 | after implementation |
| --- | --- | --- | --- |
| N1 | sandbox missing explicit network | NO_THROW / accepted | `EXTENDED_NETWORK_REQUIRED` |
| N2 | sandbox mainnet REST origin | NO_THROW / accepted | `EXTENDED_SANDBOX_MAINNET_REST` |
| N3 | sandbox mainnet WebSocket origin | derived from REST | `EXTENDED_SANDBOX_MAINNET_WS` |
| N4 | sandbox SN_MAIN | hardcoded `this.network = 'mainnet'` | `EXTENDED_SANDBOX_SN_MAIN` |
| N5 | sandbox mainnet signing domain | `this.domain = DOMAINS.mainnet` | `EXTENDED_SANDBOX_MAINNET_SIGNING_DOMAIN` |
| N6 | sandbox custom endpoint override | NO_THROW / accepted | `EXTENDED_SANDBOX_CUSTOM_ENDPOINT_FORBIDDEN` |
| N7 | sandbox proxy enabled | NO_THROW / accepted | `EXTENDED_SANDBOX_PROXY_FORBIDDEN` |
| N8 | sandbox mainnet credential fallback | connector used `EXTENDED_API_KEY` only | `EXTENDED_SANDBOX_MAINNET_CREDENTIAL_FORBIDDEN` |
| N9 | mixed mainnet and testnet credentials | NO_THROW / accepted | `EXTENDED_SANDBOX_CREDENTIAL_MIXED` |
| N10 | live mode with Sepolia profile | NO_THROW / accepted | `EXTENDED_LIVE_SEPOLIA_FORBIDDEN` |
| N11 | live and sandbox confirmations together | NO_THROW / accepted | `EXECUTION_CONFIRMATION_CONFLICT` |
| N12 | v0.2 live remains forbidden | already THREW `EXPERIMENT_V02_LIVE_FORBIDDEN` | unchanged |
| N13 | state/cursor/lease network mismatch | unbound scope keys | `EXTENDED_NETWORK_STATE_MISMATCH` |
| N14 | legacy state without network identity | unbound | `EXTENDED_NETWORK_IDENTITY_MISSING` |
| N15 | attempted real fetch from a unit test | no guard | `TEST_NETWORK_GUARD_FETCH` |
| N16 | attempted real WebSocket from a unit test | no guard | `TEST_NETWORK_GUARD_DNS` |
| N17 | secret values absent from diagnostics | n/a | placeholders absent |
| N18 | effective URL cannot double-append `/api/v1` | n/a | `EXTENDED_REST_PREFIX_DOUBLE` |

False-positive / positive controls (green after implementation):

| id | control | result |
| --- | --- | --- |
| P1 | historical dry-run remains allowed | pass |
| P2 | explicit Sepolia profile parses offline in sandbox | pass; writes still unauthorized |
| P3 | explicit mainnet profile parses in authorized v0.1 live context | pass |
| P4 | official Sepolia REST/WS/domain/chain-ID tuple | pass |
| P5 | mainnet vs Sepolia state identities differ | pass |
| P6 | ordinary non-secret diagnostics remain usable | pass |
| N12 | v0.2 live forbid (pre-existing) | pass |
| — | do not infer sandbox from Sepolia API URL in dry-run | pass |
| — | do not convert `DRY_RUN=0` into sandbox | pass |

R2-A tests added: `test/experiment-v02-r2a-sandbox-boundary.test.ts` (29 cases, 29 pass).

## Corrective 1 validation (2026-08-31)

Toolchain: Node v22.23.2 / npm 10.9.8. Commands from a clean `npm ci`. No `.env` file in the workspace.

```text
node --version                 # v22.23.2
npm --version                  # 10.9.8
npm ci                         # exit 0; package-lock unchanged
npm run typecheck              # exit 0
npm run test:security          # exit 0; tests 178 pass 178 fail 0
node --import tsx --test test/experiment-v02-r2a-sandbox-boundary.test.ts
                               # exit 0; tests 49 pass 49 fail 0
npm run check                  # exit 0; TAP tests 636 pass 636 fail 0 (plus grid.test.ts OK)
npm run build                  # exit 0 (tsc --noEmit)
npm run verify:action-inventory  # exit 0; ok true, codes PASS
npm run pack:extended-canary   # exit 0
npm run verify:extended-canary # exit 0; ok true, CHECKS_OK
npm run audit:security-baseline  # exit 0; ok true, high 14, critical 0, existingHighAreNotCleared true
git diff --check               # exit 0
```

`npm run check` TAP summary: `# tests 636` `# pass 636` `# fail 0`. `grid.test.ts OK` is additional and is not included in that TAP count.

## Corrective 2 validation (2026-08-31)

Toolchain: Node v22.23.2 / npm 10.9.8. Commands from a clean `npm ci`. No `.env` file in the workspace.

```text
node --version                 # v22.23.2
npm --version                  # 10.9.8
npm ci                         # exit 0; package-lock unchanged
npm run typecheck              # exit 0
npm run test:security          # exit 0; tests 178 pass 178 fail 0
node --import tsx --test test/experiment-v02-r2a-sandbox-boundary.test.ts
                               # exit 0; tests 60 pass 60 fail 0
npm run check                  # exit 0; TAP tests 647 pass 647 fail 0 (plus grid.test.ts OK)
npm run build                  # exit 0 (tsc --noEmit)
npm run verify:action-inventory  # exit 0; ok true, codes PASS
npm run pack:extended-canary   # exit 0
npm run verify:extended-canary # exit 0; ok true, CHECKS_OK
npm run audit:security-baseline  # exit 0; ok true, high 14, critical 0, existingHighAreNotCleared true
git diff --check               # exit 0
```

`npm run check` TAP summary: `# tests 647` `# pass 647` `# fail 0`. `grid.test.ts OK` is additional and is not included in that TAP count.

## Final test totals

Original R2-A packet (2026-08-28) used the same toolchain pin. That run recorded TAP tests 616 pass 616. Corrective 1 adds 20 cases in the R2-A boundary file (29 → 49). Corrective 2 adds 11 cases (49 → 60). Suite TAP 616 → 636 → 647.

## Security / canary

```text
ROOT_AUDIT_HIGH=14
ROOT_AUDIT_CRITICAL=0
ROOT_EXISTING_HIGH_ARE_NOT_CLEARED=true
CANARY_AUDIT_HIGH=0
CANARY_AUDIT_CRITICAL=0
CANARY_AUDIT_TOTAL=0
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
```

Canary content-manifest (after Corrective 2 product bytes):

```text
schema=classic-v0.2-extended-canary-content-manifest/1
contentManifestSha256=2510544ff839caa5ae82e972ffc2d583a864112eb0e6b86fa1d0a983461d1e84
lockfileSha256=f66f1a14e91ca293d499b74420b1c669c9b11d0806cf87830d3ca59e64763f99
```

Corrective 1 canary content-manifest SHA-256 was `0b2551674e871d9da3fbb0ee5b06b788822ce321a769954fc42d1f98943bc4d0`. Original R2-A was `20ae2223a140a383d27e59be6bda9f32944b5b822f698de57e2791a53836c6c1`. The lockfile SHA-256 is unchanged.

`verify:extended-canary`: `unexpectedNetwork=[]`, `secretLikeFiles=[]`, `liveExchangeWrite=false`, `productionCredentialUsed=false`, `probeExitCode=0`.

Independent isolated canary install of `artifacts/extended-canary/classic-grid-extended-canary-0.2.0.tgz` into a temp directory: `npm ci --omit=dev` then `npm audit --omit=dev` reported 0 vulnerabilities (high=0, critical=0, total=0).

Action inventory: `overallPolicyOk=true`, 6 uses, 0 docker actions, codes `PASS`.

## Proof: no credentials, no exchange I/O

- Workspace had no `.env` file.
- Tests used only `PLACEHOLDER_*` tokens and the already-public starkcrypto self-test vector inside the existing offline reduction fixture.
- Diagnostic/error tests assert placeholder values never appear in thrown messages. Redirect failures equal `EXTENDED_ENDPOINT_REDIRECT_FORBIDDEN` with no Location.
- Unit tests install fetch/DNS guards; accidental Extended fetch or WebSocket fails the test.
- Redirect tests mock `globalThis.fetch` (native and proxy/undici dispatcher path). They never perform DNS lookup or HTTP/WebSocket to Extended mainnet or Sepolia.
- Invalid `DRY_RUN` / `LIVE_CONFIRM` fail at `parseExecutionBoundary` with `DRY_RUN_INVALID` / `LIVE_CONFIRM_INVALID` before `runLoop` / `runStatus` / `runFlat` / `ExtendedExecutor.connect` create a transport or call official stats.
- Sandbox `ExtendedExecutor.connect()` throws `TESTNET_NETWORK_WRITE_UNAUTHORIZED` before vendor `init` when sandbox config is otherwise valid.
- Vendor Sepolia `init`/`_reqOnce` also throw `TESTNET_NETWORK_WRITE_UNAUTHORIZED`.
- Canary verify: no unexpected network, no production credential, no live exchange write.
- This agent did not contact Extended mainnet or Sepolia, and did not use an API key, Stark key, vault ID, or wallet.

## Proof: frozen R1 branch unchanged

```text
git rev-parse origin/experiment/classic-v0.2-100u-safety
= 990a790706e17b52e04d0d1957505cdad5d45862
git rev-parse origin/experiment/classic-v0.2-100u-safety^{tree}
= c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8
```

No commit, amend, rebase, merge, reset, or force-push was performed on `experiment/classic-v0.2-100u-safety`. This work is only on `experiment/classic-v0.2-r2-extended-sepolia`. Frozen R1 HEAD and tree were identical before and after Corrective 1 and Corrective 2.

## Unresolved limitations

1. R2 sandbox/testnet is **not** qualified. This packet is only R2-A sandbox-boundary qualification. Credentialed Sepolia access, testnet writes, mainnet writes, R2-B, deployment, and merge remain unauthorized.
2. Root High=14 findings are unchanged and are not cleared.
3. Valid sandbox `runLoop` / `runFlat` / `runStatus` fail closed at `TESTNET_NETWORK_WRITE_UNAUTHORIZED` before lease, telemetry files, or connect. Invalid `DRY_RUN` fails earlier at `DRY_RUN_INVALID`. No sandbox run artifacts are produced in R2-A.
4. WebSocket URL is no longer derived from REST (`http`→`ws`). Sepolia REST host and WS host are different by profile and must stay atomic. Corrective 1 requires `websocketBase` to be supplied and exact.
5. Independent byte review is required. Draft PR CI, if green, is not R2 authorization.
6. `assertSameOriginResponse` remains as an unused offline URL-comparison helper. It is not wired into vendor HTTP and is not evidence that redirects cannot be followed.
7. Node global `fetch` is used for both native and proxy paths; proxy still constructs undici `ProxyAgent` as `dispatcher`. Redirect policy is shared (`redirect: "manual"` + status guard) so the two paths cannot diverge.
8. `EXTENDED_USE_PROXY` is not a `DRY_RUN`/`LIVE_CONFIRM` token and still uses the existing `1|true|yes` sandbox-forbid regex. Vendor proxy enablement is unchanged.

## Commits

```text
a7f90d2e0de06dc00d276a568bb61557e7761046 feat(r2a): add Extended Sepolia sandbox execution boundary
b50cd4c2dc1d7e9cfc01d46a38165021187519e7 docs(r2a): bind R2-A candidate identity
92de0e7d71ab5418412d35135604e1f1d776be08 docs(r2a): record R2-A result HEAD and tree
c478a0b36d112f4ecba490a2c7d97e5a74fa910d fix(r2a): reject vendor HTTP redirects and require websocketBase
7f8c7d671df5cb9f0d51b95bcb4113525c372c25 docs(r2a): bind Corrective 1 candidate identity
7300422bef95ab5a533d521e1826af300a7d8652 docs(r2a): record Corrective 1 result HEAD and tree
2f01b52afea04c4a0d2fab5eb0260b81e9a62c66 fix(r2a): reject non-exact DRY_RUN and LIVE_CONFIRM values
```

The identity-bind and packet-fill commits do not change product bytes. Independent review should check out the pushed branch tip. There is no current-review identity named `REVIEW_CANDIDATE_TIP=92de0e7…`.
