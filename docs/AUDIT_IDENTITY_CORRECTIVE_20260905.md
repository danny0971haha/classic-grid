# Audit identity and independent CI failure domains

Implementation scope: bounded correction stacked on
`fix/classic-audit-diagnostics-20260905` at
`53892592a1dad5d0a091448a6b2eb2a4c8aba113`, tree
`4fc002d42e3f372ee4ee1c8543927b61c22b5275`.
The successor branch is `fix/classic-audit-identity-v2-20260905` and its PR targets
the reviewed branch, remaining Draft. Final commit identities and command results
are supplied in the exact-HEAD handoff and CI artifacts, never inherited from this
parent or from a working-tree preflight.

## Stable identity and unchanged accepted set

Comparison uses package name plus a normalized GHSA. npm `advisoryId`/`sourceId`
fields remain metadata. Same-GHSA source renumbering is reported once as
`ADVISORY_SOURCE_RENUMBERED` and is not a blocking condition by itself.
An unseen high GHSA remains `NEW_HIGH`, including a same-package replacement.
Replacement diagnostics are deduplicated. Missing stable identity is explicit
and fails closed, as do dependency-path, package-identity and vulnerable-range
changes. Affected-package rows retain independent path/range checks and new
affected packages are reported separately; they do not fabricate leaf advisories.

The existing baseline already records GHSA identities, so no schema migration or
baseline edit is necessary. Its three leaf advisories and fourteen affected high
packages are preserved byte-for-byte. Neither `GHSA-82x6-q7mm-w9cf` nor
`GHSA-v5mp-jgw5-2x6j` is added. Existing highs remain vulnerabilities.

## Diagnostic and test boundary

`runNpmAudit` still captures one subprocess invocation's exit status, signal,
sanitized stdout/stderr, process error and capture time. Executable, arguments,
cwd and environment injection enable concurrent-safe subprocess fixtures without
global PATH mutation. No diagnostic retry or replacement success request exists.

`npm run test:audit-diagnostics` runs subprocess diagnostic and CI aggregation
regressions. `npm test`, `npm run test:security` and `npm run check` use deterministic
audit fixtures. A-10 is explicitly synthetic baseline-consistent data, not a
regenerated historical registry result. The unchanged canary installation/audit
assertions run under `npm run test:canary-live`, which remains mandatory in CI.

`npm run test:audit-live` is the dedicated root live policy entrypoint. Replay is:

```sh
npm run audit:security-baseline -- --audit-json artifacts/security/audit.json --out-dir artifacts/security/replay
```

The replay writes to a separate directory and makes no registry request. Missing
CLI option values fail before a live invocation could occur.

## Required CI outcome

The `ci` workflow and `compiler-and-tests` job identities are retained. Clean
installation disables its incidental npm audit; the controlled root policy step
captures the live report. Deterministic checks, E/F evidence generation and
verification, security fixtures, action inventory, canary install/boundary,
production smoke/content checks, whitespace and clean-tree checks remain required.
Checks can continue after an earlier failure to collect evidence and run later
validation. All uploads run with `always()` and missing artifacts are errors.
The final aggregation inspects original `outcome`, not the continue-on-error
`conclusion`, and rejects failed, missing, cancelled or unexpectedly skipped
required steps. A root audit failure therefore leaves the job failed even if all
other checks complete successfully. Registry/canary failures remain failures.

No dependency, package-lock, runtime, adapter, frozen candidate or accepted
binding is changed. Dependency-remediation investigation is read-only; no
override, forced audit fix, SDK upgrade or compatibility claim is supplied here.
No merge, force-push, rebase, deployment, settings change, credential access,
exchange write, testnet/mainnet action or new trading phase is authorized or
performed by this correction. No independent acceptance is declared.
