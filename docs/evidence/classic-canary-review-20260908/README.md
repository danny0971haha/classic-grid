# Historical canary review evidence: lossless package

This directory packages the original 2026-09-08 review packet without rewriting its logs, JSON, Markdown, results, timestamps, exits, identities or hashes. It is a delivery-format correction for whitespace validation. It grants no dependency clearance, acceptance, merge or trading authority.

The source is [commit 40223bb5e106668e2d5a2c8971579b41e7a9dbfa](https://github.com/danny0971haha/classic-grid/commit/40223bb5e106668e2d5a2c8971579b41e7a9dbfa), tree `c99180aab2b4cf9b4abb40780c7d2192686d9eec`. The [original expanded packet](https://github.com/danny0971haha/classic-grid/tree/40223bb5e106668e2d5a2c8971579b41e7a9dbfa/docs/evidence/classic-canary-review-20260908) remains in that historical commit and PR #14's reference. This package belongs to the new CI correction branch. The distinct `classic-canary-linux-20260909` evidence is unchanged.

## Contents and path mapping

- [original-evidence.tar.gz](original-evidence.tar.gz): all 47 original Git-tracked files, 313,383 uncompressed file bytes, each mode `100644` (restored filesystem mode `0644`). Members use their exact original repository-relative paths under `docs/evidence/classic-canary-review-20260908/`.
- [archive-manifest.json](archive-manifest.json): exact 47-file original path, Git blob, SHA256, size and mode inventory bound to the source commit/tree.
- [verify_archive.py](verify_archive.py): standalone Python standard-library verification and restoration. It rejects unsafe paths, links, special members, duplicates, inventory differences, mode/size/hash/blob differences, and invalid original checksums. It can compare every restored byte with the original Git object.
- [SHA256SUMS](SHA256SUMS): checksums of these four package files, excluding itself. The original unchanged `SHA256SUMS` is inside the archive at its original path.

The original 45-entry manifest verifies 45 original files. It does not cover itself or `identity-after-packet.txt`; both are covered by the new 47-file manifest. Existing `../classic-canary-linux-20260909/local/original-evidence-hashes.json` separately binds all 47 originals and remains unchanged. Historical absolute execution paths and relative document links remain unchanged inside the archive. Restoring the complete packet preserves the relative links.

## Why these original files are packaged

PR #14 root CI run `34257856432`, attempt `2`, job `102329823123`, reported the following in its raw whitespace step (log lines 6166–6173). The workflow's original diff checks remain unchanged.

| Original path relative to this directory | Actual error | Historical use | Original Git blob |
| --- | --- | --- | --- |
| `classic-canary-review-handoff.md` | trailing whitespace at lines 18, 54, 55 | Review packet, identity and result navigation | `825e2cb7ded352b3f1035cb5f06f0319a8b0567b` |
| `offline/unavailable-venue.txt` | new blank EOF line 17 | Raw `CANARY_VENUE_UNAVAILABLE:nado` rejection output | `7677e85b2bc388eab3204e6e8c0e48f14dc97191` |
| `registry/canary-audit.json` | new blank EOF line 23 | Original scoped npm audit output | `43e8bcf78fac694d0c94ead5f768ebfd479bcc50` |

Original SHA256 values:

```text
47d8ceb2580f3aefe612b2e837efd4146835386de8522615c7b029f2931e7370  classic-canary-review-handoff.md
78cd70515ea9ec4363aa29d5ff8a935822a382f53a90307357a2ca08f09c8d00  offline/unavailable-venue.txt
7c6369d5621583356a634c6f2e2ccb5205b991720df5801cbccb180685f0a3f0  registry/canary-audit.json
7633b30eaac2fc047cbdcfa792a31691de35f5f8810efeef8450698fb670efa8  SHA256SUMS
```

The original manifest references the three affected files on lines 2, 30 and 35. The unchanged Linux packet's `local/original-evidence-hashes.json` references them on lines 4, 33 and 38. The historical handoff links the raw audit at line 90 and other packet files throughout. Packaging the entire packet preserves that reference closure and the original manifest rather than leaving a partial expanded packet with missing manifest targets. No inspected contract requires these historical files to remain expanded in the current tree.

## Verify and restore

From the repository root, verify both package checksums and original Git bytes:

```sh
python3 docs/evidence/classic-canary-review-20260908/verify_archive.py verify --git-source .
```

To verify a downloaded package without the source repository, omit `--git-source`; all archive SHA256, Git blob, mode, inventory and original manifest checks still run. This checks internal integrity; authenticating the source commit independently remains a separate operation.

Restore into a new, nonexistent directory outside the working tree:

```sh
python3 docs/evidence/classic-canary-review-20260908/verify_archive.py restore \
  --git-source . --destination /tmp/classic-review-evidence-restored
```

The restored handoff is `/tmp/classic-review-evidence-restored/docs/evidence/classic-canary-review-20260908/classic-canary-review-handoff.md`. Every archived path maps identically beneath the chosen destination; no stripping or renaming occurs. The CLI refuses an existing destination, verifies the archive before writing, and checks every restored byte, mode and exact file inventory afterward. The original manifest can also be checked from that restored packet directory with `shasum -a 256 -c SHA256SUMS`. Restoration outside the checkout does not affect whitespace checks.

## Preservation and scan boundary

The packaging preflight compared all 47 original files to their source Git blobs before packing. The package was restored and compared before removing any expanded originals. Original logs and the audit JSON were not trimmed or reserialized. A bounded scan of the 47 originals and 36 regular files inside the original canary tarball found no private-key, GitHub-token, AWS-access-key or long assigned-secret pattern matches. Values were not printed. This pattern scan is not a universal guarantee that no secret exists. The original nested tarball's 44 entries had no unsafe paths, links or special file types.

This archive preserves historical scope and outcomes. Scoped canary zero vulnerabilities do not clear the root dependency blocker. The new manifest and package checksums establish preservation; they do not replace original security verifiers or their judgments.
