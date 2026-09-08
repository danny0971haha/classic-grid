# Corrective canary review driver

This driver produces scoped engineering evidence for independent review. It grants no acceptance, Route B publication-policy adoption, root security clearance, merge, deployment, or trading authority.

Run from a clean corrective tool checkout descended from `3ca01ae046f27aa4ca74e9e8370928a48d0c7810`, with a **separate clean target** at `fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf` / tree `7f14f66eac518c4427076f18fbcfdc7d935c79d8`:

```sh
sh tools/review/classic-canary-20260908/run-scoped-verification.sh \
  --target-root /absolute/path/to/fixed-target \
  --tool-head "$(git rev-parse HEAD)" \
  --tool-tree "$(git rev-parse 'HEAD^{tree}')" \
  --publication-ref fix/classic-canary-driver-20260909 \
  --out /absolute/path/to/new-evidence-directory
```

The publication branch must already point to the tool commit. The driver verifies remote target, original tooling, frozen R1, remote R2-A and publication refs; local Git objects establish their relevant tree identities. Remote observations are a timestamped check, not a promise that refs cannot later move. Offline children never fetch refs. Local R2-A `d312907...` is outside the test target and is not published by this driver.

The output directory must not exist, even if empty, and must be outside both checkouts. Existing output is rejected on stdout with a nonzero exit and is never overwritten or read as current evidence. Each accepted run emits `summary.json`, per-step command/cwd/time/exit metadata and separate raw stdout/stderr with hashes. The final exit is nonzero for any mandatory failure, environment blocker or unexecuted step. `SUCCESS` is an individual command result; `COMPLETED` is scoped execution completion, neither is independent acceptance. Unexpected termination before settlement leaves incomplete evidence, never a success marker.

Python orchestration replaces the shell function's process-global `set -e` toggling. All independent diagnostics continue; dependent operations are `NOT_RUN` with explicit dependency reasons and null exit codes. Missing commands are recorded. Timeouts kill the step process group and retain exit 124. Pins compare actual Node and npm outputs against v22.23.2 / 10.9.8. The child environment is an allowlist with fresh HOME/TMPDIR and empty npm config; caller trading credentials, Node injection options, and npm tokens are not inherited.

The phases are deliberately separate:

1. Linux isolation preflight uses the target's unchanged `deny_network()` and exercises AF_UNIX bind/listen/connect/data/socketpair, Internet/packet socket and socketpair EPERM, and filter inheritance across exec. No probe executes if this fails. On Darwin this returns 78 / `BLOCKED`; library presence alone cannot qualify Linux execution.
2. Credential-free registry preparation runs root `npm ci --ignore-scripts --no-audit` only to obtain the existing development tools, then uses target pack/source-policy/content-manifest/install/audit functions for the **canary graph**. It never repairs root dependencies. Canary installs are fresh per run. Nested subprocess commands and raw outputs are retained by `trace-child.mjs`.
3. Offline tests and the installed canary probe each install and retest the original filter in their own parent process. The four existing boundary/source/manifest/artifact suites are unchanged. The existing module graph, forbidden package/source, unavailable venue and no-write/no-credential conditions remain blocking. The underlying probe JSON deliberately still labels its own instrumentation userspace-only; the corresponding `*-isolation.json` records the enclosing real kernel filter. Userspace output is never sufficient without that successful mandatory step.
4. Required scans reject missing/malformed lockfile, tar listing, installed package metadata or requested module graph. Hits cause nonzero exit. A failed pre-scan prevents probe execution while independent tests and final checkout diagnostics still run. The post-scan requires a successful probe from this run.

The existing full root verification wrapper is not invoked: it has a different mandatory order and root audit contract. The combined registry/live canary test is not relabeled as a kernel-isolated run; this driver explicitly splits its existing preparation and offline checks. Root CI, audit baseline, frozen binding and required-check semantics remain unchanged.

Offline regression command (fixtures only):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 tools/review/classic-canary-20260908/test_driver.py
```

`.github/workflows/classic-canary-scoped.yml` is a separate evidence job, restricted to this corrective PR branch and target base. It checks out the exact PR head, creates the fixed target worktree, pins the requested toolchain, uploads evidence even after a failed step, and settles original step outcomes including upload. It uses the already approved upload Action SHA and `contents: read`, with no persisted checkout credential or trading secrets. The existing inventory requires checkout/setup-node Actions exactly once repository-wide; those existing occurrences are preserved. The scoped job instead clones the public repository without credentials and installs the official Linux x64 Node archive bound to SHA-256 `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`. Bootstrap semantics and download identity are checked by the workflow and its logs, not certified by the Action inventory. The existing root CI remains separate and may fail.

`artifact-manifest.json` and `SHA256SUMS` cover portable raw evidence and the canary tgz, policy lock, content manifest and listing. Temporary installs, caches and HOME are excluded from publication; paths in logs describe the original run. Workflow bootstrap outcomes are covered by a second bundle-level `SHA256SUMS`. Download the GitHub artifact, check the bundle checksums, then check `scoped/SHA256SUMS`; publish CI evidence on a separate evidence branch/comment bound to the final code commit instead of adding commits merely to embed their own run.
