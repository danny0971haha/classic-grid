import fs from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const logPath = process.env.MODULE_LOAD_LOG;
  if (logPath) {
    try {
      fs.appendFileSync(
        logPath,
        `${JSON.stringify({
          schemaVersion: "classic-v0.2-extended-canary-module-graph/1",
          specifier: String(specifier),
          parentURL: context.parentURL ?? null,
          resolvedURL: result.url,
        })}\n`,
      );
    } catch {
      /* probe must not crash the canary on log I/O */
    }
  }
  return result;
}
