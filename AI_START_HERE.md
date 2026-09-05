# AI START HERE — Classic Grid

[AGENTS.md](AGENTS.md) defines agent behavior. This file routes the current task to relevant documents; it does not grant implementation, trading or acceptance authority.

## Start every task

1. Read [AGENTS.md](AGENTS.md) and [CURRENT_STATUS.md](docs/CURRENT_STATUS.md).
2. Identify the current operator objective, allowed paths, required checks and whether the task is read-only or authorizes implementation.
3. Record actual branch, HEAD/tree, worktree, relevant candidate refs and available toolchain. Compare expected identities before changes. Report inaccessible state; do not infer local configuration from GitHub or claim remote refs were checked by an offline command.

Keep frozen R1, the separate R2-A review candidate and the documentation/tooling branch distinct. A descendant's new files do not inherit prior acceptance.

## Read according to impact

| Task impact | Additional required reading |
| --- | --- |
| Documentation, navigation or formatting | Affected documents and references, plus the contract statements being described. |
| Verification tooling, audits or evidence | [Local verification guide](docs/CURRENT_STATUS.md#local-verification), [current tooling evidence](docs/IMPLEMENTATION_EVIDENCE.md), the existing command implementations, and affected security/test contracts. |
| R2-A Extended sandbox boundary | [R2-A scope and evidence](docs/classic-v0.2-r2a-extended-sepolia-sandbox-boundary.md), its referenced boundaries and the relevant source/tests. |
| Execution, risk, recovery or persistence | Applicable sections/versions of [experiment-spec.md](experiment-spec.md), [v0.2 implementation contract](docs/classic-v0.2-implementation-contract.md), current checkpoint/R2-A contracts and fault evidence. |
| Credentials, dependencies or repository protection | [SECURITY.md](SECURITY.md), [repository protection guidance](docs/REPOSITORY_PROTECTION.md), current bounded-dependency scope and affected policy files. |

Explicit task/gate reading requirements remain mandatory. If impact is uncertain, expand read-only investigation before editing. Read the affected semantics fully; selecting fewer unrelated documents does not relax a contract. Resolve material conflicts through review rather than interpreting an old phase or README example as current authorization.

## Execute and validate

For authorized implementation, finish the objective end to end using the autonomy rules in AGENTS.md. Fix ordinary in-scope errors without requesting another prompt, but stop affected operations that require new scope, permissions or contract decisions.

Use the documented verification entrypoints and their actual prerequisites. Preserve offline isolation, fail-fast behavior, tests, manifests and dependency baselines. A missing registry/audit input or IPC capability remains a reported blocker. Do not execute the historical README trading commands as validation or remove a guard to make them run.

## Handoff

Perform final diff/counterexample self-review and deliver the applicable checkpoint evidence with exact identities, changed paths, real command results and remaining blockers. Distinguish unrun checks from failures and successes; do not certify runtime safety from documentation checks. Commit/push only where authorized on the task feature branch, preserve frozen refs and historical evidence, and stop. No self-acceptance, automatic next phase, exchange access, merge or deployment follows.
