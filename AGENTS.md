# AGENTS.md — Classic Grid Agent Instructions

These repository instructions are model-neutral. A stronger or different model may improve execution within an authorized task; it does not expand permissions or change acceptance criteria.

## Mission and current scope

Maintain Classic Grid's existing execution and safety behavior while completing the operator's explicitly bounded engineering objective. Start with [CURRENT_STATUS.md](docs/CURRENT_STATUS.md) for candidate identities and evidence, then [AI_START_HERE.md](AI_START_HERE.md) for impact-based reading.

The current bounded engineering artifact is `packages/extended-canary/`. Its dependency isolation does not security-clear the root repository or qualify other venue adapters. Preserve the existing adapters and historical material; do not remove them or migrate SDKs merely to simplify the bounded artifact.

Status documents are navigation, not acceptance or authorization. Historical README launch examples and old phase instructions are not current permission to run trading or restart a phase. Long-term safety requirements are not claims of completed implementation or instructions to build deferred capabilities.

## Task entry and identity

Before changes, establish the operator's objective, analysis-only versus implementation mode, allowed paths and required validations. Record actual branch, HEAD/tree, working-tree status, relevant expected/observed candidate refs and toolchain versions. Inspect applicable repository and accessible workspace instructions; disclose unavailable local state or settings rather than inventing them.

Work on a separate task feature branch from the verified base. Preserve user changes. Stop affected work on an unexplained identity mismatch or overlapping edits. Never advance frozen R1, the R2-A review-candidate ref or review/gate branches as part of documentation/tooling work. Do not automatically rebind acceptance to a descendant commit, reset history, force-push, merge or rebase.

Keep Classic and Multi as separate repositories, branches, commits and evidence. Do not introduce a cross-repository runtime abstraction or copy Multi's implementation into this repository.

## Autonomous execution within the authorized objective

A request only to inspect, analyze or recommend changes is read-only: do not edit, commit, push or change repository settings. An implementation request grants only its stated scope and permitted actions, not trading, deployment or merge authority.

For an authorized objective, complete impact analysis, root-cause diagnosis, implementation, relevant tests, in-scope corrections, documentation and final self-review. Do not stop at a plan or request another prompt for ordinary implementation choices or related defects that can be resolved within scope. One checkpoint may include several necessary files and correction iterations, but only one primary engineering objective.

Choose naming, function boundaries and necessary local refactoring within allowed paths. Prefer the smallest coherent, maintainable correction, not the fewest changed characters. Task-specific byte-preservation requirements and file allowlists take precedence over this discretion. Do not bundle unrelated cleanup, features or dependency upgrades.

Classify failures from evidence: implementation, test, environment or contract. Fix your own in-scope type, format and test failures and rerun affected checks. Use the repository's specified validation toolchain within permitted environment operations; do not change locks, dependencies or requirements to accommodate the available machine.

Pause the affected operation for missing external facts, extra permissions, prohibited paths or a material contract decision. Continue only safe independent diagnosis; do not implement disputed semantics. Return exact conflicting files/statements, completed work, the safest no-change behavior and the smallest proposed resolution. Never change instructions, safety contracts, tests or gate criteria to bypass a blocker. Instruction changes require an explicitly authorized instruction-change task.

## Safety and authority that must remain intact

- Preserve fail-closed execution, risk, persistence, runtime lease/fencing, kill-switch, halt and acknowledgement boundaries. Do not replace independent authorities with a permissive boolean or automatically resume a hard halt.
- Preserve exchange-observed fill provenance, ownership, partial-fill accounting and deterministic deduplication. Missing orders or ambiguous responses do not become confirmed fills or permission to reseed.
- Preserve stale/unknown-input rejection, reconciliation before risk increase, notional/loss/drawdown/boundary guards and bounded reduction/flatten semantics under the applicable contract.
- Preserve the atomic Extended profile boundary, redirect rejection, WebSocket/profile consistency and exact execution-mode parsing documented in the R2-A packet. Do not loosen them for convenience.
- Keep frozen candidate objects, historical evidence and accepted-scope identities intact. Documentation/tooling tasks must not change `src/`, venue adapters, `vendor/`, bounded canary source/manifests, dependency locks, existing safety tests or trusted workflows unless a separately reviewed task explicitly authorizes the affected change.
- Do not use real/testnet trading credentials, perform exchange network access or writes, deploy, or run real-fund tests under the present task boundary. A future trading task requires its own explicit, commit-bound authorization; a model choice, green CI, README command or self-review cannot supply it.
- Never create/use withdrawal-enabled credentials or expose secrets in code, logs, fixtures, screenshots or evidence. Follow [SECURITY.md](SECURITY.md). Public documentation reads and dependency preparation remain subject to the task and environment permissions; never convert an offline validator into a network-enabled one.
- Respect source licenses and the independent-project boundary. Do not import third-party bot source without verified permission and explicit authorization.

Read applicable contracts before touching their behavior. Reading order does not let CURRENT_STATUS, README or these autonomy rules weaken the applicable experiment/safety contract. Unresolved material conflicts require a review decision, not guessing.

## Validation and self-review

Use the existing commands and prerequisites in [CURRENT_STATUS.md](docs/CURRENT_STATUS.md#local-verification) and the applicable task contract. Preflight tools, credential-free state, local IPC and isolation. Preserve mandatory checks, security baselines, exact manifests, raw evidence and wrapper fail-fast behavior. Registry/audit or IPC failures are blockers, not permission to skip tests or fabricate an audit report. Non-pinned diagnostic results do not substitute for required validation.

After a wrapper stops, separately permitted diagnosis may continue, but later stages remain unexecuted until actually run. Do not weaken assertions, hide failed/skipped tests, replace real crash tests with exception-only injection or transfer another SHA's results to the current candidate.

Before handoff, inspect the final diff and relevant counterexamples: malformed/stale input, duplicate events, partial/ambiguous outcomes, crash/restart and uncertain risk/lease/ACK authority. Retain every mandatory matrix case. Verify reported identities, changed paths and evidence hashes; distinguish fixed-object checks from branch-ref checks. Offline verification must report unverified remote refs rather than opening network access.

## Parallel work and handoff

When tools support it, parallelize read-only audits or explicitly non-overlapping work within the same scope. Assign file ownership and one integration owner; isolate editing worktrees where permitted. Subagents gain no extra permissions. Do not create competing safety-module edits or merge/rebase automatically. Revalidate affected behavior after any separately authorized integration.

Return the applicable checkpoint evidence: repository/branch, base and result HEAD/tree, actual worktree/ref observations, changed files/diff, tool versions, real commands/exits/counts, evidence hashes and remaining risks. Separate executed, not executed, failed and blocked checks. Internal correction iterations need not each create a formal packet unless the task requires it; final evidence must not omit failures.

State whether any real/testnet credentials, exchange writes, repository-setting changes, merge or deployment occurred. Self-review and subagent review are not formal independent acceptance. Do not self-declare PASS, ACCEPT, MERGE AUTHORIZED or LIVE AUTHORIZED. Stop after the authorized objective and evidence delivery; do not automatically start R2-B, R3 or any later phase.
