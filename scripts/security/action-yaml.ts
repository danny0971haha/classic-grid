import { createRequire } from "node:module";
import type {
  Document,
  LineCounter as LineCounterType,
  Pair,
  YAMLMap,
  YAMLSeq,
} from "./vendor/yaml/dist/index.js";

const require = createRequire(import.meta.url);
const YAML = require("./vendor/yaml/dist/index.js") as typeof import("./vendor/yaml/dist/index.js");

const CORE_TAGS = new Set([
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
]);

export type YamlIssueCode =
  | "ACTION_YAML_MALFORMED"
  | "ACTION_YAML_DUPLICATE_KEY"
  | "ACTION_YAML_ALIAS"
  | "ACTION_YAML_UNSUPPORTED_TAG";

export type ParsedYaml =
  | {
    ok: true;
    doc: Document.Parsed;
    lineCounter: LineCounterType;
    lineOf: (node: { range?: [number, number, number] | null }) => number | null;
  }
  | { ok: false; codes: YamlIssueCode[] };

export function parseStrictYaml(source: string): ParsedYaml {
  const lineCounter = new YAML.LineCounter();
  const docs = YAML.parseAllDocuments(source, {
    lineCounter,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    version: "1.2",
    schema: "core",
    merge: false,
    resolveKnownTags: false,
    logLevel: "silent",
    keepSourceTokens: true,
    intAsBigInt: false,
  });
  if ("empty" in docs || docs.length !== 1) {
    return { ok: false, codes: ["ACTION_YAML_MALFORMED"] };
  }
  const doc = docs[0]!;
  const codes = new Set<YamlIssueCode>();
  for (const error of doc.errors) {
    codes.add(error.code === "DUPLICATE_KEY" ? "ACTION_YAML_DUPLICATE_KEY" : "ACTION_YAML_MALFORMED");
  }
  for (const warning of doc.warnings) {
    codes.add(warning.code === "DUPLICATE_KEY" ? "ACTION_YAML_DUPLICATE_KEY" : "ACTION_YAML_MALFORMED");
  }
  if (!doc.contents) codes.add("ACTION_YAML_MALFORMED");

  YAML.visit(doc, {
    Node(_, node) {
      if (YAML.isAlias(node)) {
        codes.add("ACTION_YAML_ALIAS");
        return;
      }
      if ("anchor" in node && typeof node.anchor === "string" && node.anchor.length > 0) {
        codes.add("ACTION_YAML_ALIAS");
      }
      if (typeof node.tag === "string" && node.tag.length > 0 && !CORE_TAGS.has(node.tag)) {
        codes.add("ACTION_YAML_UNSUPPORTED_TAG");
      }
    },
  });

  if (codes.size > 0) return { ok: false, codes: [...codes] };
  return {
    ok: true,
    doc,
    lineCounter,
    lineOf(node) {
      const start = node.range?.[0];
      if (typeof start !== "number") return null;
      const pos = lineCounter.linePos(start);
      return pos.line > 0 ? pos.line : 1;
    },
  };
}

export function isYamlAlias(node: unknown): boolean {
  return YAML.isAlias(node);
}

export function isYamlMap(node: unknown): node is YAMLMap {
  return YAML.isMap(node);
}

export function isYamlSeq(node: unknown): node is YAMLSeq {
  return YAML.isSeq(node);
}

export function isYamlScalar(node: unknown): node is { value: unknown; type?: string; range?: [number, number, number] | null; tag?: string } {
  return YAML.isScalar(node);
}

export function isYamlPair(node: unknown): node is Pair {
  return YAML.isPair(node);
}

export function mapGet(map: YAMLMap, key: string): unknown {
  return map.get(key, true);
}

export function mapHas(map: YAMLMap, key: string): boolean {
  return map.has(key);
}

export function pairKeyName(pair: Pair): string | null {
  if (!YAML.isScalar(pair.key) || typeof pair.key.value !== "string") return null;
  return pair.key.value;
}
