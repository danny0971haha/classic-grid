# Audit failure diagnostic corrective

Date: 2026-09-05. Base: `a80bcca7f1a0b997456308f5a42962129375b208`
(tree `38caf70813341640f1d122e57451076ced12eac5`).
Branch: `fix/classic-audit-diagnostics-20260905`. Implementation evidence only.

PR #9's A-10 assertion failed before its temporary audit output could be
uploaded. The previous command wrapper discarded stderr on accepted npm exit
codes and stdout on command errors. That prevented distinguishing a registry
failure from policy reasons using the uploaded evidence.

This corrective records the **same** npm invocation's status, signal, error,
sanitized stdout/stderr and capture time in `audit-command.json` alongside the
existing `audit-baseline-verification.json`. Streams are sanitized diagnostic
text, not a claim of byte-exact unsanitized output. Malformed stdout and registry
error JSON are retained; they are never replaced with a successful audit.
Existing parser, policy, baseline, return classification and A-10 assertions
are unchanged. No extra audit request is made.

The existing security upload now runs even after failure and includes retained
`artifacts/security-a10-*/` directories. Its immutable Action pin and required
file checks are retained. Successful A-10 still removes its temporary directory.
Diagnostic tests run separately without changing historical suite totals.

## Validation and limits

Local Linux x86_64: Node v24.19.0, npm 11.9.0; reused available TypeScript 5.9.3
and tsx 4.23.0. These are not the pinned CI environment or a clean install proof.

- `node --import tsx --test test/security/audit-diagnostics.test.ts`: exit 0,
  5 tests, 0 failed/cancelled/skipped/todo. Covers vulnerability exit 1,
  registry error stdout, malformed output, secret redaction and spawn failure.
- `npm run typecheck`: exit 0.
- `npm run verify:action-inventory`: exit 0; exact approved Action tuples remain.
- `git diff --check`: exit 0.
- Live registry audit and full historical suites: not run locally; the network
  preparation probe was cancelled by the environment. The historical CI root
  cause is still unconfirmed until current diagnostic evidence is available.

No runtime, vendor, canary, lockfile, policy, baseline or existing safety test
bytes changed. R1 `990a790706e17b52e04d0d1957505cdad5d45862` and R2-A
`39bf3a797b58f7fd91babf9f2d608cfd28e04487` were observed on GitHub before edits.
Final commit/tree and patch identity belong in the PR handoff.

No credentials, exchange access, merge, force-push, deployment, settings change
or new phase. Existing root highs remain uncleared. No independent gate decision
is made. Review the captured command alongside policy codes before proposing
any dependency or baseline corrective; do not enlarge the baseline to get green CI.

## Captured CI diagnosis

Run `33964860391` tested source `75157059f5af474dbcbc9f2ca7c1b9102b7d12fb`.
Pinned install, typecheck, the five new diagnostic tests and checkpoint suites
completed. The historical check failed and the security upload still succeeded.
Artifact `9969122759` ZIP SHA-256 is
`67af386da3fec55dd2c587d8b3301286897fba50d84b6cd66e8bee8e4f734e21`;
downloaded bytes independently matched GitHub's digest.

The [captured files](evidence/audit-diagnostic-20260905/capture.json) retain the
original artifact member bytes and hashes. At `2026-09-05T12:02:40.905Z`, npm
returned status 1, no process error, empty stderr and a valid report. The
lockfile still matches the baseline. Observed counts are **16 high, 0 critical,
8 moderate, 24 total**, versus historical 14 high/22 total. Policy reasons:

- `NEW_HIGH`: toml advisories and the affected @coral-xyz/anchor package row.
- `ADVISORY_REPLACED`: axios source ID 1123967 is now reported as 1153178.
- `ADVISORY_IDENTITY_MISSING`: the expected historical axios ID is absent.

This confirms current advisory/policy mismatch, not a failed registry command
or an agent-documentation regression. It does not establish exploitability.
Do not clear these findings by accepting a larger baseline.

Replaying the captured `audit.json` through the existing CLI with `--audit-json`
returned exit 1 and the same three policy codes; no registry was contacted.
An initial replay invocation from the workspace parent failed ENOENT (exit 254)
before execution; rerunning from this repository produced the result above.
Dependency remediation remains a separate review with the existing safety and
bounded-canary constraints. No dependency changes were made here.
