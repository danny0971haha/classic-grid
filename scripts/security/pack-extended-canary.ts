import { packExtendedCanary, repoRootFromHere } from "./extended-canary-boundary.js";

const packed = packExtendedCanary(repoRootFromHere());
process.stdout.write(
  `${JSON.stringify({ tarballPath: packed.tarballPath, sha256: packed.tarballSha256, lockfileSha256: packed.lockfileSha256, contentManifestSha256: packed.contentManifestSha256 }, null, 2)}\n`,
);
