# Current development status

Snapshot: 2026-09-05. This is an operator navigation/status document, not a gate decision.

## Candidate identities

| Artifact | Branch | Commit | Tree |
| --- | --- | --- | --- |
| Frozen R1 | `experiment/classic-v0.2-100u-safety` | `990a790706e17b52e04d0d1957505cdad5d45862` | `c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8` |
| R2-A Corrective 2 review candidate | `experiment/classic-v0.2-r2-extended-sepolia` | `39bf3a797b58f7fd91babf9f2d608cfd28e04487` | `fb139e4737711602df44636e8186ccc6694de654` |

Documentation/tooling changes belong on a separate descendant branch. They do not replace either identity or transfer review acceptance to a new commit. Determine that branch's actual implementation identity with `git rev-parse HEAD HEAD^{tree}`.

The authoritative R2-A scope and evidence packet is [classic-v0.2-r2a-extended-sepolia-sandbox-boundary.md](classic-v0.2-r2a-extended-sepolia-sandbox-boundary.md). It records atomic Extended profile selection, rejection of HTTP redirects, the WebSocket/profile boundary, and exact `DRY_RUN` / `LIVE_CONFIRM` parsing, with offline regression evidence. These are implemented candidate behaviors, not testnet qualification.

R1 remains the frozen baseline. This document does not independently certify R1 acceptance. The R2-A packet explicitly requires independent current-byte review; no acceptance of the current R2-A candidate is established here. Historical test results and any earlier bounded acceptance apply only to their stated bytes and scope.

```text
R2A_IMPLEMENTATION=REVIEW_CANDIDATE
R2_SANDBOX_TESTNET_QUALIFIED=NO
R3_BOUNDED_LIVE_CANARY_ELIGIBLE=NO
TESTNET_NETWORK_WRITE_AUTHORIZED=NO
MAINNET_NETWORK_WRITE_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

## Bounded dependency scope

`packages/extended-canary/` is the current bounded engineering artifact. Its source manifest, package/lockfile, strict content checks and restricted module graph intentionally create a narrower Extended-only dependency boundary.

The root repository is **not a security-cleared production artifact**. Isolation does not fix or clear root dependency findings. Existing baseline findings remain findings unless separately resolved and verified. Other venue adapters and legacy venue documentation remain present, outside this bounded canary qualification scope. No broad SDK migration, dependency upgrade or `npm audit fix --force` is part of this work.

## Local verification

```sh
npm run test:verification
npm run verify:current-candidate -- --audit-json /absolute/path/to/captured-audit.json
```

Prerequisites: Linux, Python 3, `libseccomp.so.2`, installed lockfile dependencies, git objects for frozen R1, and a clean credential-free checkout. The wrapper installs an inherited kernel filter permitting only Unix sockets; DNS, HTTP, WebSocket and Internet sockets cannot reach an exchange. If isolation cannot be installed, it exits before validation. It does not read `.env`, use caller credentials, or fall back to network access. A fresh temporary HOME is used for child commands.

The mandatory order is typecheck, `test:security`, `test`, build, action inventory, canary pack, then `audit:security-baseline -- --audit-json ...`. Existing scripts and tests are unchanged. The first nonzero mandatory command stops the wrapper. Logs and their hashes are recorded in `artifacts/current-candidate/`; stdout is a structured informational JSON summary identifying HEAD/tree and working-tree status. A dirty checkout is identified explicitly and is not evidence for HEAD alone.

**Known offline constraint:** both historical test commands include the clean canary installation/audit test. That test internally invokes registry-dependent `npm ci` and `npm audit`. The wrapper does not skip it, fake its output or label a blocked installation successful. At the current implementation it may stop there with `offlineValidationCompleted=false`. Full `verify:extended-canary` is also registry-dependent and is not invoked by this offline entrypoint. This limitation needs a separately reviewed offline-input design before the entire historical install/audit evidence can be reproduced without a registry. It is not a product-code defect or authorization to loosen tests.

The root audit input is a previously captured report, not a fabricated empty report. Existing audit-policy semantics validate it against the lockfile/baseline. Its SHA-256 is reported; this command cannot establish current advisory freshness. No supplied file means the audit stage fails closed. Root vulnerabilities are never cleared by a successful baseline comparison.

`offlineValidationCompleted` describes only this local sequence. It never grants independent acceptance, sandbox qualification, merge, deployment, live access or authority to start R2-B/R3. Preserve all historical evidence and stop after evidence delivery.
