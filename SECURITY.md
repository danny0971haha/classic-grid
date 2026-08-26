# Security Policy

- Never commit `.env`, `secrets/`, `data/`, private keys, API secrets, or Telegram tokens/chat IDs.
- Only commit `.env.example` with **empty** secret values. Fill real keys on your machine after `cp .env.example .env`.
- If you find a secret in this repository, open an issue **without pasting the secret**, and rotate the credential immediately.
- README dashboard image is a UI screenshot (no tokens/addresses). Never paste live credentials into Issues/PRs.
- GitHub Actions must use the exact approved SHA allowlist recorded in `docs/security-audit-baseline.md`. Tags, branches, shortened SHAs, other 40-hex SHAs, Docker Actions, and remote reusable workflows are rejected.
- Production `npm audit --omit=dev` highs are a live-release blocker. Matching the committed baseline is not a security clearance.
- The Extended-only canary artifact is a separate dependency boundary. A zero-High canary lockfile is not global repository clearance.

```text
GLOBAL_DEPENDENCY_SECURITY_CLEARANCE=NO
DEPENDENCY_SECURITY_CLEARANCE=NO
LIVE_RELEASE_BLOCKED=YES
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
REAL_FUND_TESTING_AUTHORIZED=NO
```
