# Canary driver corrective — code-commit evidence

This packet records implementation and local counterexamples. Linux CI is **NOT_RUN at this code-commit snapshot**; its eventual result belongs to a separate evidence branch or PR comment bound to the actual final code HEAD. This document does not declare independent acceptance.

## Verified scope and identities

Repository: `danny0971haha/classic-grid`. Corrective branch: `fix/classic-canary-driver-20260909`, created from original tool HEAD `3ca01ae046f27aa4ca74e9e8370928a48d0c7810`, tree `c756dedb245d1560cafb8f3ea018cc0180da6244`. Draft PR base must remain `fix/classic-audit-output-path-20260906`, at target HEAD `fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf`, tree `7f14f66eac518c4427076f18fbcfdc7d935c79d8`.

Remote refs, PR #12/#13 Draft states and worktrees were read and reconciled before creating the corrective worktree. A subsequent timestamped capture is retained in `local/identity-reconciliation.json`. No specified remote ref had advanced. Official `/Users/apple/classic-grid` remains local R2-A `d3129075d5866d27c79c6d2cba3b4b1128923889`, three commits ahead of remote R2-A `39bf3a797b58f7fd91babf9f2d608cfd28e04487`; it is excluded from the target and not published here. Frozen R1 remains `990a790706e17b52e04d0d1957505cdad5d45862`. The original tooling worktree's existing node_modules symlink was preserved; the new driver never uses it.

## Counterexamples and corrections

`local/legacy-errexit-reproduction.json` executes the original `log_cmd()` body from the fixed original tool object: command exit 7 causes the shell to exit 7 before `DIAGNOSTIC_AFTER_FAILURE`. Both raw command streams and legacy metadata are preserved in that reproduction. `local/legacy-scan-reproduction.json` records the original scan returning 0 with forbidden `toml`, `src/officialStats.ts`, and a missing installed graph.

The corrected Python driver collects command metadata and raw streams without changing process-global shell flags. It distinguishes SUCCESS, FAILED, BLOCKED and NOT_RUN, gates dependent operations, preserves independent diagnostics and checks all mandatory outcomes before choosing its final exit. Output must be fresh and external to both checkouts. Actual tool/target Git HEAD/tree/status and remote publication refs are compared, not merely printed. Node/npm pin comparison uses real command output.

Registry and probe helpers now propagate policy failures. They dynamically import unchanged TARGET implementations. Fresh install artifacts, hashes and required input files are checked; necessary scans reject malformed or absent evidence and forbidden hits. The target's unchanged Linux `deny_network()` is installed and tested for every offline execution, including local IPC, Internet/packet socket rejection and exec inheritance. Userspace probe JSON remains explicitly userspace-only; enclosing isolation evidence is a separate mandatory record.

Latest local regression: `local/regression-precommit/command.json` and raw stdout/stderr — 25 tests, exit 0. Earlier intermediate runs are retained and explicitly timestamped. These are offline fixture regressions, not Linux canary qualification. Existing target security tests will run unchanged in Linux.

Host is Darwin arm64 with Node v26.5.0 / npm 11.17.0. `local/host-prerequisites.json` records unavailable libseccomp/Linux/container prerequisites; `local/isolation-record/` records the real corrected isolation check returning 78 / BLOCKED. No userspace fallback executed.

## Separate Linux CI entrance

Existing `ci.yml` runs the root graph without the scoped Linux filter. Historical review workflows bind frozen R1 and unrelated historical envelopes, so they cannot test this fixed target without changing their contracts. New `.github/workflows/classic-canary-scoped.yml` is limited to this corrective branch and requested base, with `contents: read`, no trading secrets and original-outcome settlement after artifact upload.

An initial two-Action bootstrap failed the existing repository-wide exact-one checkout/setup-node occurrence rule. That unsuccessful inventory is retained in `local/initial-workflow-inventory.json`. The final workflow preserves the rule and both existing occurrences. It uses credential-free public Git checkout plus an official checksum-pinned Node archive; only the existing approved upload Action is added. Final inventory verification is `local/inventory-precommit/` (exit 0), using local non-pinned Node as a tooling diagnostic, not Linux qualification.

Node source: `https://nodejs.org/dist/v22.23.2/SHASUMS256.txt`, retrieved during this task and preserved as `local/node-v22.23.2-SHASUMS256.txt`. Linux x64 archive SHA-256: `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`. The workflow verifies downloaded bytes before execution; the final driver also compares Node v22.23.2 and npm 10.9.8. Action inventory validates Action usage; it does not certify custom bootstrap semantics.

## Boundaries and remaining work

- Linux scoped execution and artifact redownload: NOT_RUN at this snapshot; publish actual outcomes separately after CI.
- Root dependency/security blockers: retained, not repaired or cleared. Full root CI and its required semantics remain unchanged. A canary audit applies only to the canary graph.
- Local R2-A snapshot publication: independent handoff, still absent remotely in this capture; it does not block this correction.
- Route B publication policy: NOT_ADOPTED. R2-B, root dependency repair, upstream SDK investigation/rebuild and trading development: NOT_RUN, outside scope.
- No runtime, adapter, risk, safety assertion, dependency graph/lock, audit baseline, frozen binding or existing workflow changed. No reset, rebase, force-push, frozen ref move, PR #12/#13 rewrite, repository setting change, merge, credentials, exchange writes or deployment.

Original 20260908 evidence bytes are preserved; `local/original-evidence-hashes.json` enumerates them. This packet's `SHA256SUMS` and `artifact-manifest.json` bind the local implementation evidence. The final code HEAD/tree are external Git identities and intentionally not recursively embedded into their own commit.
