import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_CANARY_PACKAGES = [
  "@n1xyz/nord-ts",
  "@n1xyz/proton",
  "@solana/web3.js",
  "@solana/buffer-layout-utils",
  "@solana/spl-token",
  "@nadohq/client",
  "@nadohq/shared",
  "@nadohq/engine-client",
  "@nadohq/indexer-client",
  "@nadohq/mobile-client",
  "@nadohq/trigger-client",
  "axios",
  "bigint-buffer",
  "viem",
] as const;

export const FORBIDDEN_NESTED_WS_PATH = "node_modules/viem/node_modules/ws";

export function normalizeModuleSpecifier(specifier: string): string {
  let value = specifier.trim();
  if (/^file:/i.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      value = value.replace(/^file:\/\//i, "");
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep undecodable file URL tail */
      }
    }
  } else {
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep original when percent-encoding is malformed */
    }
  }
  value = value.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  return path.posix.normalize(value);
}

function specifierMatchesForbiddenPackage(normalized: string, name: string): boolean {
  return (
    normalized === name
    || normalized.startsWith(`${name}/`)
    || normalized === `node_modules/${name}`
    || normalized.startsWith(`node_modules/${name}/`)
    || normalized.includes(`/node_modules/${name}/`)
    || normalized.endsWith(`/node_modules/${name}`)
  );
}

export function isForbiddenModuleSpecifier(specifier: string): boolean {
  const raw = specifier.replaceAll("\\", "/");
  const normalized = normalizeModuleSpecifier(specifier);
  const candidates = new Set([specifier, raw, normalized]);
  for (const candidate of candidates) {
    for (const name of FORBIDDEN_CANARY_PACKAGES) {
      if (specifierMatchesForbiddenPackage(candidate, name) || candidate.startsWith(`${name}/`)) {
        return true;
      }
    }
    if (candidate.includes("viem/node_modules/ws") || candidate.includes("/viem/node_modules/ws")) {
      return true;
    }
  }
  return false;
}
