# Extended-only 100U canary artifact

This package is the production-shaped dependency boundary for the Extended 100U safety canary.

It is **not** a global repository security clearance. Root/legacy venue SDKs remain in the main lockfile with known High findings.

## Properties

- Installable in a clean directory without the repository root `node_modules`
- Production lockfile contains only Extended runtime + shared safety-core dependencies
- Starting this entrypoint does not statically import N1, Phoenix, Nado, or PopDEX adapters
- Selecting an uninstalled venue fails closed with `CANARY_VENUE_UNAVAILABLE:<id>`
- Live exchange writes, production credentials, merge, and real-fund testing are not authorized

## Start

```text
DRY_RUN=1 EXPERIMENT_MODE=1 EXPERIMENT_SPEC_VERSION=0.2.0 npm run start:once
```
