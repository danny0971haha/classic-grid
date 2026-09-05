# Current-candidate tooling evidence

Date: 2026-09-05. Implementation evidence only; independent acceptance is not declared.

Base: `39bf3a797b58f7fd91babf9f2d608cfd28e04487`, tree `fb139e4737711602df44636e8186ccc6694de654`. The final implementation HEAD/tree are reported in the operator handoff; this file cannot recursively contain the hash of its own commit. Validation ran on the explicitly recorded working-tree candidate before adding this evidence packet. Source/runtime/dependency bytes are unchanged from that base.

Frozen R1: `990a790706e17b52e04d0d1957505cdad5d45862`, tree `c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8`. GitHub refs were read through the connected GitHub API and matching Git objects were verified locally. No frozen branch was moved. A new feature branch holds this work.

## Observed validation

Environment: Linux x86_64; Node 24.19.0; npm 11.9.0; Python 3.12.13; installed TypeScript 5.9.3 / tsx 4.23.0 / Node types 22.20.1. Existing locally available dependency installation was reused without changing package or lockfile versions. This is not a clean dependency-install proof.

| Command | Exit | Observed evidence |
| --- | --- | --- |
| `npm run verify:current-candidate` | 1 | Typecheck 0; stops at security suite 1; `offlineValidationCompleted=false`. |
| `npm run typecheck` | 0 | No diagnostics. |
| `npm run test:security` | 1 | 178 tests: 176 pass, 2 fail, 0 cancelled/skip/todo. |
| `npm test` | 1 | Grid smoke script succeeded, followed by 647 tests: 638 pass, 9 fail, 0 cancelled/skip/todo. |
| `npm run build` | 0 | Existing build is `tsc --noEmit`; semantic identity preserved. |
| `npm run verify:action-inventory` | 0 | Existing inventory assertions succeeded. |
| `npm run pack:extended-canary` | 0 | Existing deterministic artifact pack completed. |
| `npm run verify:extended-canary` | 1 | `CANARY_LOCK_CI_FAILED` / npm `ENOTCACHED`; no registry fallback. |
| `npm run test:verification` | 0 | 3 tests: first-failure stop, real missing-command failure, inherited Internet socket denial. |
| Formatter / lint / dedicated secret scan | N/A | No root commands configured. No dependency/tooling package added for them. |
| `git diff --check` | 0 | No whitespace errors. |

The two security failures are the real registry-audit baseline case A-10 and clean canary install/audit. The other seven full-suite failures require OS Unix-socket listen/lease turnover; this execution environment returned `EPERM`. The wrapper's filter allows Unix sockets but cannot remove the host environment's additional restrictions. No assertions, test-name filters or skip switches were changed to hide these failures. There is no evidence here of a product-code defect requiring a runtime change.

Root lockfile SHA-256 remains `f278d8b7f0d559839e35ee64e94db9e39c7d6037f5692d0cafa02ba6c6b254ed`. A real captured audit JSON was not available, so standalone offline audit validation remains uncompleted. The umbrella stops earlier, as required. Root dependency findings remain uncleared.

## Reproducible new-command evidence

[umbrella-summary.json](evidence/current-candidate/umbrella-summary.json) contains the full new command's structured output, candidate/tree, working-tree status, fail-fast stage and log hashes. [umbrella-01.txt](evidence/current-candidate/raw-logs.json) and [umbrella-02.txt](evidence/current-candidate/raw-logs.json) preserve its raw subprocess output. [results.json](evidence/current-candidate/results.json) records all separately attempted required validations; numbered keys in `raw-logs.json` preserve those logs. [files.json](evidence/current-candidate/files.json) binds archived file sizes and hashes. Original log paths in summaries describe where the command wrote them; the archive preserves the same bytes as decoded strings in `raw-logs.json`.

See [CURRENT_STATUS.md](CURRENT_STATUS.md) for invocation, strict offline limitations and audit-input requirements; see [REPOSITORY_PROTECTION.md](REPOSITORY_PROTECTION.md) for operator-managed recommendations. Linux/Python/libseccomp are new developer-tool prerequisites only, not production dependencies.

Raw console logs contain trailing whitespace. Initial `git diff --check` flagged it (exit 2); logs are now JSON-encoded without changing decoded bytes, so checks can remain strict.

## Preserved and deliberately unchanged

All `src/`, venue adapters, `vendor/`, `packages/extended-canary/`, security policies/tests, original npm script values, dependency sections, both lockfiles, frozen candidate objects, workflows and historical packets are unchanged. README gains current navigation and labels its existing production-start sentence as historical; venue content is retained. `.gitignore` narrowly admits new verification tooling and ignores generated verification output.

```text
LIVE_EXCHANGE_WRITE_EXECUTED=NO
TESTNET_WRITE_EXECUTED=NO
PRODUCTION_CREDENTIAL_USED=NO
TESTNET_CREDENTIAL_USED=NO
MERGE_EXECUTED=NO
FORCE_PUSH_USED=NO
REPOSITORY_SETTINGS_CHANGED=NO
SELF_DECLARED_PASS=NO
LIVE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
NEXT_PHASE_STARTED=NO
```

Next recommended action: independently review the new docs/tooling branch, then rerun in a compatible environment and design a separately reviewed offline input path for the registry-dependent evidence if required. Do not start R2-B/R3, rebind frozen identities, merge, deploy or enable exchange access from these results.
