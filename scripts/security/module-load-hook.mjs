import fs from "node:fs";

export async function resolve(specifier, context, nextResolve) {
  const logPath = process.env.MODULE_LOAD_LOG;
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `${specifier}\n`);
    } catch {
      /* probe must not crash the canary on log I/O */
    }
  }
  return nextResolve(specifier, context);
}
