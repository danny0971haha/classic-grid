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
