# Fixed-target Extended-only Route B qualification materials

This is a bounded implementation collaboration self-check, not formal independent acceptance. Repository: `danny0971haha/classic-grid`. The current review performed downloaded-evidence and Git-object reconciliation only; it did not run registry installation, exchange access, trading, or new CI.

## Result and exact subject

`SCOPED_EVIDENCE_SUFFICIENT_FOR_OWNER_QUALIFICATION_REVIEW` for the captured Extended-only artifact and specified historical offline execution. `NO_NEW_CODE_CHANGE_REQUIRED` within this review. This is neither owner adoption nor root/global dependency clearance, testnet qualification, merge permission, deployment permission, or live authorization. It does not qualify PR15 as the tested runtime artifact.

| Identity | Observed |
| --- | --- |
| Scoped run | [34257856526 attempt 3](https://github.com/danny0971haha/classic-grid/actions/runs/34257856526/attempts/3) |
| Job | [102349201604](https://github.com/danny0971haha/classic-grid/actions/runs/34257856526/job/102349201604) |
| Workflow | `.github/workflows/classic-canary-scoped.yml` |
| Tool HEAD/tree | `40223bb5e106668e2d5a2c8971579b41e7a9dbfa` / `c99180aab2b4cf9b4abb40780c7d2192686d9eec` |
| Target HEAD/tree | `fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf` / `7f14f66eac518c4427076f18fbcfdc7d935c79d8` |
| Artifact | [10089752885](https://github.com/danny0971haha/classic-grid/actions/runs/34257856526/artifacts/10089752885), 385134 bytes |
| Downloaded ZIP SHA-256 | `3b6fab4cd627471b2033ea8d23fc988fee919944b20d56103b68b5eeadb201f8` |
| Retained canary tgz SHA-256 | `00edfb9bf682b6e7e1047e832a58c30dacef2dc613720b8c10286a1e6f805ad5` |
| Content manifest SHA-256 | `2510544ff839caa5ae82e972ffc2d583a864112eb0e6b86fa1d0a983461d1e84` |
| Canary package.json SHA-256 | `963b107843569df257e22f24bf55f9598c024b787f3e1601855fb791dc874e76` |
| Source file-manifest.json SHA-256 | `3d6c083d41e76489981733721fcc389aa5b1985dbd655ffc557acac40ee16690` |
| Canary lockfile SHA-256 | `f66f1a14e91ca293d499b74420b1c669c9b11d0806cf87830d3ca59e64763f99` |
| Extended-only entrypoint SHA-256 | `3301e908c8558317794d66837842aa67c7993429b964fe105d38f91f4b3f6d16` |

Before/after target and tool identities are identical, clean, and match local Git objects. The run metadata, raw job log and archived bootstrap agree on tool, target, attempt and artifact. Driver summary is `COMPLETED`, exit 0, with all recorded step exits 0. Workflow original outcomes (including upload in the raw settlement log) are `success`; job/workflow conclusions are also `success`. These are observed execution statuses only.

The earlier evidence worktree's `FINAL_HANDOFF.md` describes artifact `10068650245`, ZIP `0d33a833...`, tgz `e1065cf...`, and 2026-09-08 UTC execution. Those are different evidence identities and were not substituted for attempt 3. Attempt 3 executed 2026-09-09 05:28–05:29 UTC.

## Downloaded artifact and source boundaries

Independent byte reconciliation of the newly downloaded ZIP found no mismatch:

- GitHub archive digest matches the downloaded 385134-byte ZIP.
- Bundle `SHA256SUMS`: 249 entries; nested scoped `SHA256SUMS`: 216 entries. All 465 checksum records match; coverage and unique paths also match. These are overlapping coverage counts, not 465 distinct files.
- Scoped `artifact-manifest.json`: 215 exact path/size/SHA records verified. All 38 per-command stream metadata files have matching stdout/stderr hashes.
- Actual tgz: 44 members, comprising 36 regular files and 8 directories. No duplicate paths, links, or special entries. The archived tar listing equals actual members.
- The embedded content-manifest bytes equal the separately retained manifest. Its 35 named source/package files match exact tar bytes/modes and exact target Git bytes/modes; the generated content manifest is the 36th file. No additional files exist in the tar.
- Root `package.json`, root lockfile and `src/cli/run.ts` are not this product's package inputs or entrypoint. Package-level README/package/lock/file-manifest map to `packages/extended-canary/`; all other payload source paths map directly to the fixed target Git tree.
- Extended-only `src/cli/run-extended-canary.ts` injects `createExtendedCanaryExecutor` and unavailable official-statistics bindings. The preserved file manifest excludes root entrypoint, `src/officialStats.ts`, other venue adapters including `src/venues/n1.ts`, and `vendor/risex`.

The attempt records second-pack tgz SHA `3b5ecc53f0707151026f5fe611add59e077d4fdeaaf70cbe87adc4b6fd01e2a7`, which differs from the retained first tgz. The existing target pack contract compares **content-manifest** identity across two packs, not gzip/tar container-byte reproducibility. Both packs' verification commands completed; only the first tgz is retained. This review verifies the retained first artifact's contents against Git and does not claim independently rechecked second-tgz bytes or diagnose its unretained container differences. This observation is not a reproduced violation of the existing contract and does not justify changing code or repacking history.

## Installed and loaded boundary evidence

Retained nested raw commands record two fresh canary `npm ci --omit=dev --no-fund --ignore-scripts` installations, each exit 0, in distinct lock-install and tarball-install directories. Tar extraction precedes the latter. The installed-name inventory agrees with both pre/post recursive installed-graph scanners and the captured lockfile package records:

| Installed package | Locked version |
| --- | --- |
| `@esbuild/linux-x64` | `0.28.2` |
| `esbuild` | `0.28.2` |
| `tsx` | `4.23.12` |
| `undici` | `6.28.0` |
| `ws` | `8.21.3` |

The 192 retained module graph records resolve to 95 canary-install paths, 96 Node builtins, and 1 explicitly allowed target verifier bootstrap (`canary-offline-probe.ts`). No other resolution exists in that recorded execution. Runtime-owned resolution remains within the canary install; root npm dependencies serve verifier preparation and do not appear as runtime graph resolutions. The retained graph contains the installed `src/cli/run-extended-canary.ts` import. `toml`, `@n1xyz/nord-ts`, other original forbidden packages, added `@n1xyz/*` and `@coral-xyz/anchor`, and prohibited source paths do not enter these package/install/load/artifact boundaries. This conclusion combines exact packed-file verification, installed metadata traversal, lock package membership, raw installation outputs, and resolved module records; it is not based on a missing grep match.

The temporary `node_modules` trees were intentionally excluded from publication. This review independently reconciles the retained installed-graph evidence with raw commands and the lockfile; it does not claim to possess or byte-replay the original installed dependency trees. The graph describes the actual dry-run `--once` path, not every dormant code path or future workload. Artifact-level source inclusion/exclusion has broader static coverage, with its own 122-test boundary/source/manifest/content suite.

## Network separation, kernel evidence and counterexamples

Actual tools are Node `v22.23.2` and npm `10.9.8`. The workflow bootstrap records official Node archive SHA-256 `d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307`, matching its expected pin. Runner observation is Linux x86_64, kernel `6.17.0-1022-azure`.

Public Git/tool bootstrap and registry preparation are separate network-enabled phases. Driver child environment uses a narrow allowlist, fresh HOME/TMPDIR and empty separate npm configurations, without inheriting exchange keys, Node injection options or npm tokens. Root `npm ci --ignore-scripts --no-audit --no-fund` prepares existing verifier dependencies; it is not a root audit or root clearance.

The captured canary audit ran in lock-install on 2026-09-09 05:28:23.683–05:28:24.062 UTC with command `npm audit --omit=dev --json`, exit 0 and all vulnerability counts 0. This is a historical captured registry result for the bounded graph and that time. It neither refreshes advisories today nor clears root TOML findings.

Four mandatory Linux reports (preflight, tests, probe and post-scan) each record the fixed target's `deny_network()` filter actually loaded, full AF_UNIX bind/listen/connect/data/socketpair functionality, AF_INET/AF_INET6/AF_PACKET socket and socketpair EPERM, and an exec child's inherited AF_INET denial. Tests/probe/post-scan run inside their own checked filter; offline child configuration additionally sets npm offline mode. The userspace probe deliberately retains `USERSPACE_PROBE_ONLY_NOT_LINUX_SECCOMP`; its enclosing `probe-isolation.json` supplies the separate kernel evidence. No filter capability is inferred from userspace hooks alone.

The attempt's 25 driver regressions preserve failed isolation exit 78 with no child execution, wrong target/publication/pins rejection, missing or stale install rejection, malformed/missing graph rejection, forbidden-package rejection, and scan-failure dependency blocking. These are fixture/tooling regressions, not independent live canary executions. The attempt separately records 122 existing canary tests with 0 failures, skipped or cancelled tests.

The installed canary probe exits 0; forbiddenLoaded, unexpectedNetwork and moduleGraphHits are empty, with moduleGraphError null. Its raw stderr shows `HALT_FAILED` for absent durable risk-state/ACK inputs. `[extended] connected` is dry-run output, not exchange-connection proof. Non-Extended `VENUES=nado` actually exits 1 with `CANARY_VENUE_UNAVAILABLE:nado`. Source-level selection rejects every venue other than Extended; that broader rule is not claimed as a real exchange test.

The kernel network denial, narrow environment, credential removal and exact safe probe inputs substantiate this scoped non-trading execution. The probe's `liveExchangeWrite=false` and `productionCredentialUsed=false` fields are instrumentation observations, not standalone global security proofs. No credentials were loaded or exchange connectivity/write exercised by the present reconciliation.

## Owner decision still required

The owner must explicitly decide whether to adopt Route B's **separate Extended-only artifact boundary** as a publication/qualification unit while root/global dependency clearance remains blocked. Any adoption record should name the fixed target HEAD/tree above, package entrypoint, canary lock and content-manifest digests, retained tgz digest, and supporting tool HEAD/tree plus run/attempt/artifact. PR15 HEAD is a different engineering-delivery identity and cannot replace this target by implication.

The decision must state that non-Extended venues, root entrypoint/root graph, credentialed execution, testnet/mainnet access and future releases/targets are outside the demonstrated scope. It must preserve required checks and audit policy, require future product changes to be rebound to their actual bytes, and require a separate independent review and explicit authorization for any later phase. This review recommends submitting these materials for that bounded decision; it records no owner adoption.

No new reproducible driver or canary-boundary verification defect was found by this scoped subreview. The documented limitations do not leave a missing execution required for this bounded historical qualification-materials review; no rerun is needed. PR15 inventory/archive closeout is separately handled by the integration reviewer. No corrective branch, code edit, dependency/policy change, registry rerun, CI rerun, merge, deployment, or trading action was performed. Implementation collaboration self-check and formal independent acceptance remain separate.

## Evidence navigation and verification record

- `scoped-analysis.json` records exact reviewed tool/target source hashes, source-to-tar mappings, all downloaded evidence hashes, 465 checksum results, metadata checks, installed versions, loaded-graph classification and zero reconciliation failures.
- `unpacked/scoped/scoped/identities{,-after}.json`, `pins.json`, `summary.json`, `registry/`, `offline/`, `nested/`, `logs/`, and `unpacked/scoped/bootstrap/` are the unmodified downloaded packet contents.
- `remote/scoped-run.json`, `remote/scoped-jobs.json`, `remote/scoped-artifacts.json`, and `remote/scoped-job.log` bind remote execution identity and raw GitHub settlement/upload observations.
- `downloads/scoped.zip` is the original downloaded attempt 3 packet. Historical evidence remains unmodified in its existing evidence worktree.
