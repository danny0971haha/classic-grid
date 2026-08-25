import fs from "node:fs";
import path from "node:path";
import { repoRootFromHere, verifyExtendedCanary } from "./extended-canary-boundary.js";
import { sanitizeForArtifact } from "./audit-policy.js";

const root = repoRootFromHere();
const result = verifyExtendedCanary(root);
const outDir = path.join(root, "artifacts", "security");
fs.mkdirSync(outDir, { recursive: true });
const payload = `${JSON.stringify(result, null, 2)}\n`;
fs.writeFileSync(
  path.join(outDir, "extended-canary-verification.json"),
  sanitizeForArtifact(payload, root),
);
process.stdout.write(payload);
if (!result.ok) process.exit(1);
