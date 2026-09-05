# Repository protection recommendations

This document recommends operator-managed GitHub protection. It neither changes repository settings nor claims that protection is currently enforced.

- Protect frozen candidate branches against force pushes and deletion, including `experiment/classic-v0.2-100u-safety`.
- Keep frozen R1 HEAD `990a790706e17b52e04d0d1957505cdad5d45862` and tree `c544b6e9d8f8e33a59d12a7d6e1eeeecd0c6cbb8` immutable. New work belongs on descendant feature branches; never amend, rebase or rewrite a frozen candidate.
- Require PR-only updates for mutable candidate branches, with independent review. A frozen branch itself must not advance as a side effect of that policy.
- Preserve existing required CI context names and exact SHA/tree governance checks. Identify the current contexts from the reviewed workflow/configuration before configuring protection; do not substitute a new local verifier for a trusted gate.
- Restrict bypass permissions and retain the exact candidate identity in review evidence. Check the remote ref before and after any separately authorized branch operation.

Any settings change requires separate operator authorization and a repository-settings capability. This task does not perform it. Protection configuration, a green required context, PR approval, or branch existence does not itself grant merge, deployment, testnet, real-fund, or live-trading authorization.

See [current status](CURRENT_STATUS.md) for the bounded R2-A artifact and unauthorized actions.
