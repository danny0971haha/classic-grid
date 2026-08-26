import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isForbiddenModuleSpecifier } from "./forbidden-specifiers.js";
import {
  SOURCE_POLICY_SCHEMA,
  assertCanonicalRelPath,
  isScannedExecutable,
  type ApprovedDynamicImport,
  type ApprovedInjectedFallback,
  type ApprovedStaticImport,
  type CanaryFileManifest,
} from "./canary-manifest-schema.js";

export type SourcePolicyFinding = {
  schemaVersion: typeof SOURCE_POLICY_SCHEMA;
  file: string;
  code: string;
  detail: string;
};

type BindingKind =
  | "require"
  | "eval"
  | "function-ctor"
  | "createRequire"
  | "getBuiltin"
  | "module-load"
  | "module-require"
  | "import-meta-resolve"
  | "reflect-construct"
  | "process-binding"
  | "process-dlopen"
  | "main-module"
  | "path-ns"
  | "named-url"
  | "const-string"
  | "unresolved"
  | "other";

type Binding = {
  kind: BindingKind;
  value?: string;
  importedName?: string;
  module?: string;
  functionId: number;
  constDecl: boolean;
  init?: ts.Expression;
};

type Scope = {
  parent?: Scope;
  kind: "module" | "function" | "block";
  functionId: number;
  functionName?: string;
  bindings: Map<string, Binding>;
};

const FORBIDDEN_ESCAPE_MODULES = [
  "node:child_process",
  "child_process",
  "node:vm",
  "vm",
  "node:worker_threads",
  "worker_threads",
] as const;

const FORBIDDEN_NETWORK_MODULES = [
  "node:tls",
  "tls",
  "node:dgram",
  "dgram",
  "node:https",
  "https",
] as const;

const FUNCTION_CTOR_NAMES = new Set([
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
]);

const DANGEROUS_CALLABLE_KINDS = new Set<BindingKind>([
  "require",
  "eval",
  "function-ctor",
  "createRequire",
  "getBuiltin",
  "module-load",
  "module-require",
  "import-meta-resolve",
  "reflect-construct",
  "process-binding",
  "process-dlopen",
  "main-module",
]);

const SENSITIVE_ROOT_NAMES = new Set(["globalThis", "global", "process", "module", "Module", "Reflect"]);

function isDangerousCallableKind(kind: BindingKind | undefined): kind is BindingKind {
  return kind !== undefined && DANGEROUS_CALLABLE_KINDS.has(kind);
}

function finding(file: string, code: string, detail: string): SourcePolicyFinding {
  return { schemaVersion: SOURCE_POLICY_SCHEMA, file, code, detail };
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  if (file.endsWith(".mjs") || file.endsWith(".js") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.Unknown;
}

export function parseExecutableSource(file: string, source: string): ts.SourceFile {
  if (!isScannedExecutable(file)) {
    throw new Error(`UNSUPPORTED_EXTENSION:${file}`);
  }
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, scriptKindFor(file));
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const errors = diags.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    const first = errors[0]!;
    throw new Error(`PARSE_DIAGNOSTIC:${file}:${ts.flattenDiagnosticMessageText(first.messageText, "\n")}`);
  }
  return sf;
}

function lookup(scope: Scope, name: string): Binding | undefined {
  return scope.bindings.get(name) ?? (scope.parent ? lookup(scope.parent, name) : undefined);
}

function setBinding(scope: Scope, name: string, binding: Binding): void {
  scope.bindings.set(name, binding);
}

function enclosingFunction(scope: Scope): Scope {
  let cur: Scope | undefined = scope;
  while (cur && cur.kind !== "function" && cur.kind !== "module") cur = cur.parent;
  return cur ?? scope;
}

function isTypeContext(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isTypeNode(cur) || ts.isTypeAliasDeclaration(cur) || ts.isInterfaceDeclaration(cur)) return true;
    if (ts.isTypeParameterDeclaration(cur) || ts.isHeritageClause(cur)) return true;
    if (ts.isParameter(cur) && cur.type && nodePosIn(node, cur.type)) return true;
    if ((ts.isVariableDeclaration(cur) || ts.isPropertyDeclaration(cur) || ts.isPropertySignature(cur))
      && cur.type && nodePosIn(node, cur.type)) {
      return true;
    }
    if (ts.isFunctionLike(cur) && cur.type && nodePosIn(node, cur.type)) return true;
    cur = cur.parent;
  }
  return false;
}

function nodePosIn(node: ts.Node, range: ts.Node): boolean {
  return node.getStart() >= range.getStart() && node.getEnd() <= range.getEnd();
}

function foldedString(node: ts.Expression, scope: Scope): string | undefined {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return foldedString(node.expression, scope);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldedString(node.left, scope);
    const right = foldedString(node.right, scope);
    if (left !== undefined && right !== undefined) return left + right;
  }
  if (ts.isIdentifier(node)) {
    const b = lookup(scope, node.text);
    if (b?.kind === "const-string") return b.value;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const part = foldedString(span.expression, scope);
      if (part === undefined) return undefined;
      out += part + span.literal.text;
    }
    return out;
  }
  return undefined;
}

function isImportCall(node: ts.CallExpression): boolean {
  return node.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function specifierForbidden(spec: string): string | undefined {
  if (isForbiddenModuleSpecifier(spec)) return `package:${spec}`;
  for (const name of FORBIDDEN_ESCAPE_MODULES) {
    if (spec === name || spec.startsWith(`${name}/`)) return `escape:${spec}`;
  }
  for (const name of FORBIDDEN_NETWORK_MODULES) {
    if (spec === name || spec.startsWith(`${name}/`)) return `network:${spec}`;
  }
  return undefined;
}

function matchesApprovedStatic(
  file: string,
  spec: string,
  names: string[],
  approved: ApprovedStaticImport[],
): boolean {
  return approved.some(
    (row) =>
      row.file === file
      && row.kind === "named-import"
      && row.specifier === spec
      && row.names.length === names.length
      && row.names.every((name, i) => name === names[i]),
  );
}

function importModuleName(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  if (!node.moduleSpecifier || !ts.isStringLiteralLike(node.moduleSpecifier)) return undefined;
  return node.moduleSpecifier.text;
}

function namedImportNames(clause: ts.ImportClause): string[] {
  if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return [];
  return clause.namedBindings.elements.map((el) => (el.propertyName ?? el.name).text);
}

function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../");
}

function resolvedLocalCandidate(fromFile: string, spec: string): string {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return joined.endsWith(".js") ? joined.slice(0, -3) + ".ts" : joined;
}

function isForbiddenLocalSpec(fromFile: string, spec: string, forbidden: string[]): boolean {
  if (!isLocalSpecifier(spec)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const asTs = resolvedLocalCandidate(fromFile, spec);
  return forbidden.some((row) => row === resolved || row === asTs || resolved.startsWith(`${row}/`) || asTs.startsWith(`${row}/`));
}

export function resolveLocalSourcePath(fromFile: string, spec: string, root: string): string {
  const fromDir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  if (joined.startsWith("../") || joined === ".." || path.posix.isAbsolute(joined)) {
    throw new Error(`PATH_ESCAPE:${fromFile}:${spec}`);
  }
  const candidates = [joined];
  if (joined.endsWith(".js")) {
    candidates.push(joined.slice(0, -3) + ".ts", joined.slice(0, -3) + ".tsx");
  }
  if (joined.endsWith(".mjs")) candidates.push(joined.slice(0, -4) + ".mts");
  if (joined.endsWith(".cjs")) candidates.push(joined.slice(0, -4) + ".cts");
  for (const candidate of candidates) {
    const full = path.join(root, candidate);
    if (fs.existsSync(full) && fs.lstatSync(full).isFile()) return candidate.replaceAll("\\", "/");
  }
  throw new Error(`UNRESOLVED_LOCAL:${fromFile}:${spec}`);
}

function isExactVendorInitializer(
  expr: ts.Expression,
  scope: Scope,
  expectedLiteral: string,
): boolean {
  if (!ts.isCallExpression(expr)) return false;
  if (!ts.isPropertyAccessExpression(expr.expression)) return false;
  if (expr.expression.name.text !== "resolve") return false;
  if (!ts.isIdentifier(expr.expression.expression)) return false;
  const pathBind = lookup(scope, expr.expression.expression.text);
  if (!pathBind || pathBind.kind !== "path-ns" || pathBind.module !== "node:path") return false;
  if (expr.arguments.length !== 2) return false;
  const dirnameCall = expr.arguments[0];
  const literal = expr.arguments[1];
  if (!literal || !ts.isStringLiteralLike(literal) || literal.text !== expectedLiteral) return false;
  if (!dirnameCall || !ts.isCallExpression(dirnameCall)) return false;
  if (!ts.isPropertyAccessExpression(dirnameCall.expression)) return false;
  if (dirnameCall.expression.name.text !== "dirname") return false;
  if (!ts.isIdentifier(dirnameCall.expression.expression)) return false;
  const pathBind2 = lookup(scope, dirnameCall.expression.expression.text);
  if (pathBind2 !== pathBind) return false;
  if (dirnameCall.arguments.length !== 1) return false;
  const ftpCall = dirnameCall.arguments[0];
  if (!ftpCall || !ts.isCallExpression(ftpCall)) return false;
  if (!ts.isIdentifier(ftpCall.expression)) return false;
  const ftp = lookup(scope, ftpCall.expression.text);
  if (!ftp || ftp.kind !== "named-url" || ftp.importedName !== "fileURLToPath" || ftp.module !== "node:url") {
    return false;
  }
  if (ftpCall.arguments.length !== 1) return false;
  const meta = ftpCall.arguments[0];
  if (!meta || !ts.isPropertyAccessExpression(meta)) return false;
  if (meta.name.text !== "url") return false;
  if (!ts.isMetaProperty(meta.expression)) return false;
  return meta.expression.keywordToken === ts.SyntaxKind.ImportKeyword && meta.expression.name.text === "meta";
}

function isApprovedVendorImportCall(
  node: ts.CallExpression,
  scope: Scope,
  file: string,
  approved: ApprovedDynamicImport[],
  repoRoot: string | undefined,
  runtimeFiles: Set<string>,
): ApprovedDynamicImport | undefined {
  const row = approved.find((item) => item.file === file && item.kind === "import()");
  if (!row || !isImportCall(node) || node.arguments.length !== 1) return undefined;
  const arg = node.arguments[0];
  if (!arg || !ts.isPropertyAccessExpression(arg) || arg.name.text !== "href") return undefined;
  if (!ts.isCallExpression(arg.expression)) return undefined;
  if (!ts.isIdentifier(arg.expression.expression)) return undefined;
  const ptf = lookup(scope, arg.expression.expression.text);
  if (!ptf || ptf.kind !== "named-url" || ptf.importedName !== "pathToFileURL" || ptf.module !== "node:url") {
    return undefined;
  }
  if (arg.expression.arguments.length !== 1) return undefined;
  const vendorId = arg.expression.arguments[0];
  if (!vendorId || !ts.isIdentifier(vendorId)) return undefined;
  const vendor = lookup(scope, vendorId.text);
  const fn = enclosingFunction(scope);
  if (!vendor || !vendor.constDecl || vendor.functionId !== fn.functionId || !vendor.init) return undefined;
  if (!isExactVendorInitializer(vendor.init, scope, row.relativePathLiteral)) return undefined;
  if (node.parent && (ts.isIfStatement(node.parent) || ts.isConditionalExpression(node.parent))) return undefined;
  const fromDir = path.posix.dirname(file);
  const resolved = path.posix.normalize(path.posix.join(fromDir, row.relativePathLiteral));
  if (resolved !== row.resolvedTarget) return undefined;
  if (!runtimeFiles.has(row.resolvedTarget)) return undefined;
  if (repoRoot) {
    const full = path.join(repoRoot, row.resolvedTarget);
    if (!fs.existsSync(full) || !fs.lstatSync(full).isFile() || fs.lstatSync(full).isSymbolicLink()) {
      return undefined;
    }
  }
  return row;
}

function isApprovedFallbackCall(
  node: ts.CallExpression,
  scope: Scope,
  file: string,
  spec: string,
  approved: ApprovedInjectedFallback[],
): ApprovedInjectedFallback | undefined {
  const fn = enclosingFunction(scope);
  if (fn.kind !== "function") return undefined;
  return approved.find(
    (row) =>
      row.file === file
      && row.enclosingFunction === fn.functionName
      && row.specifier === spec
      && isImportCall(node),
  );
}

function unwrapExpr(expr: ts.Expression): ts.Expression {
  while (true) {
    if (ts.isParenthesizedExpression(expr)) {
      expr = expr.expression;
      continue;
    }
    if (ts.isAwaitExpression(expr)) {
      expr = expr.expression;
      continue;
    }
    if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) {
      expr = expr.expression;
      continue;
    }
    if (expr.kind === ts.SyntaxKind.TypeAssertionExpression) {
      expr = (expr as ts.TypeAssertion).expression;
      continue;
    }
    break;
  }
  return expr;
}

function followsAliasInit(expr: ts.Expression, scope: Scope, seen: Set<string>): ts.Expression {
  expr = unwrapExpr(expr);
  if (ts.isIdentifier(expr)) {
    if (seen.has(expr.text)) return expr;
    const b = lookup(scope, expr.text);
    if (b?.init) {
      seen.add(expr.text);
      return followsAliasInit(b.init, scope, seen);
    }
  }
  return expr;
}

function isImportMeta(expr: ts.Expression, scope: Scope): boolean {
  expr = followsAliasInit(expr, scope, new Set());
  return ts.isMetaProperty(expr)
    && expr.keywordToken === ts.SyntaxKind.ImportKeyword
    && expr.name.text === "meta";
}

function isNamedRoot(expr: ts.Expression, scope: Scope, names: Set<string>): boolean {
  expr = followsAliasInit(expr, scope, new Set());
  return ts.isIdentifier(expr) && names.has(expr.text);
}

function isGlobalThis(expr: ts.Expression, scope?: Scope): boolean {
  if (!scope) {
    expr = unwrapExpr(expr);
    return ts.isIdentifier(expr) && (expr.text === "globalThis" || expr.text === "global");
  }
  return isNamedRoot(expr, scope, new Set(["globalThis", "global"]));
}

function isProcessObject(expr: ts.Expression, scope: Scope): boolean {
  if (isNamedRoot(expr, scope, new Set(["process"]))) return true;
  expr = followsAliasInit(expr, scope, new Set());
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const name = ts.isPropertyAccessExpression(expr)
      ? expr.name.text
      : foldedString(expr.argumentExpression, scope);
    if (name === "process" && isGlobalThis(expr.expression, scope)) return true;
  }
  return false;
}

function isModuleObject(expr: ts.Expression, scope: Scope): boolean {
  return isNamedRoot(expr, scope, new Set(["module"]));
}

function isModuleCtor(expr: ts.Expression, scope: Scope): boolean {
  return isNamedRoot(expr, scope, new Set(["Module"]));
}

function isReflectObject(expr: ts.Expression, scope: Scope): boolean {
  return isNamedRoot(expr, scope, new Set(["Reflect"]));
}

function isSensitiveDispatchRoot(expr: ts.Expression, scope: Scope): boolean {
  if (isImportMeta(expr, scope)) return true;
  if (isProcessObject(expr, scope)) return true;
  return isNamedRoot(expr, scope, SENSITIVE_ROOT_NAMES);
}

function accessPropertyName(
  expr: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  scope: Scope,
): string | undefined {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return foldedString(expr.argumentExpression, scope);
}

function memberKind(obj: ts.Expression, name: string | undefined, scope: Scope): BindingKind | undefined {
  obj = unwrapExpr(obj);
  if (name === undefined) {
    return isSensitiveDispatchRoot(obj, scope) ? "unresolved" : undefined;
  }
  if (name === "constructor") return "function-ctor";
  if (FUNCTION_CTOR_NAMES.has(name) && isGlobalThis(obj, scope)) return "function-ctor";
  if (name === "require" && isModuleObject(obj, scope)) return "module-require";
  if (name === "require" && isGlobalThis(obj, scope)) return "require";
  if (name === "eval" && isGlobalThis(obj, scope)) return "eval";
  if (name === "_load" && isModuleCtor(obj, scope)) return "module-load";
  if (name === "createRequire" && isModuleObject(obj, scope)) return "createRequire";
  if (name === "resolve" && isImportMeta(obj, scope)) return "import-meta-resolve";
  if (name === "construct" && isReflectObject(obj, scope)) return "reflect-construct";
  if (name === "getBuiltinModule" && isProcessObject(obj, scope)) return "getBuiltin";
  if (name === "binding" && isProcessObject(obj, scope)) return "process-binding";
  if (name === "dlopen" && isProcessObject(obj, scope)) return "process-dlopen";
  if (name === "mainModule" && isProcessObject(obj, scope)) return "main-module";
  if (ts.isIdentifier(obj)) {
    const b = lookup(scope, obj.text);
    if (b?.kind === "require" && name === "resolve") return "require";
    if (b?.kind === "createRequire") return "createRequire";
  }
  return undefined;
}

function destructuredPropertyName(el: ts.BindingElement, scope: Scope): string | undefined {
  if (!el.propertyName) {
    return ts.isIdentifier(el.name) ? el.name.text : undefined;
  }
  if (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName) || ts.isPrivateIdentifier(el.propertyName)) {
    return el.propertyName.text;
  }
  if (ts.isComputedPropertyName(el.propertyName)) {
    return foldedString(el.propertyName.expression, scope);
  }
  return undefined;
}

function calleeKind(expr: ts.Expression, scope: Scope): BindingKind | undefined {
  expr = unwrapExpr(expr);
  if (ts.isIdentifier(expr)) {
    const b = lookup(scope, expr.text);
    if (b && (isDangerousCallableKind(b.kind) || b.kind === "unresolved")) return b.kind;
    if (b) return undefined;
    if (expr.text === "require") return "require";
    if (expr.text === "eval") return "eval";
    if (FUNCTION_CTOR_NAMES.has(expr.text)) return "function-ctor";
    return undefined;
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return memberKind(expr.expression, accessPropertyName(expr, scope), scope);
  }
  if (ts.isCallExpression(expr)) {
    const inner = calleeKind(expr.expression, scope);
    if (inner === "createRequire") return "require";
    if (inner === "function-ctor" || inner === "unresolved") return inner;
  }
  return undefined;
}

function loaderArgumentIsLiteral(arg: ts.Expression, scope: Scope): string | undefined {
  return foldedString(arg, scope);
}

function bindImportDecl(
  node: ts.ImportDeclaration,
  scope: Scope,
  file: string,
  findings: SourcePolicyFinding[],
  manifest: CanaryFileManifest,
): string | undefined {
  const specNode = node.moduleSpecifier;
  if (!ts.isStringLiteralLike(specNode)) {
    findings.push(finding(file, "UNRESOLVED_LOADER", "non-literal-import-declaration"));
    return undefined;
  }
  const spec = specNode.text;
  const typeOnly = Boolean(node.importClause?.isTypeOnly);
  if (typeOnly) return spec;
  const names = node.importClause ? namedImportNames(node.importClause) : [];
  const forbidden = specifierForbidden(spec);
  if (forbidden) {
    if (matchesApprovedStatic(file, spec, names, manifest.approvedStaticImports) && names.length > 0 && !node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      const els = node.importClause.namedBindings.elements;
      if (els.every((el) => !el.isTypeOnly && !el.propertyName && names.includes(el.name.text))) {
        return spec;
      }
    }
    findings.push(finding(file, "FORBIDDEN_SPECIFIER", forbidden));
    return spec;
  }
  if (isForbiddenLocalSpec(file, spec, manifest.forbiddenSourcePaths)) {
    findings.push(finding(file, "FORBIDDEN_SPECIFIER", spec));
    return spec;
  }
  if (!node.importClause) return spec;
  const moduleName = spec === "path" ? "node:path" : spec === "url" ? "node:url" : spec;
  if (node.importClause.name) {
    if (moduleName === "node:path") {
      setBinding(scope, node.importClause.name.text, {
        kind: "path-ns",
        module: "node:path",
        functionId: scope.functionId,
        constDecl: true,
      });
    }
  }
  if (node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
    if (moduleName === "node:path") {
      setBinding(scope, node.importClause.namedBindings.name.text, {
        kind: "path-ns",
        module: "node:path",
        functionId: scope.functionId,
        constDecl: true,
      });
    }
  }
  if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
    for (const el of node.importClause.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      const local = el.name.text;
      if (imported === "createRequire" || local === "createRequire") {
        findings.push(finding(file, "FORBIDDEN_PRIMITIVE", "createRequire"));
        setBinding(scope, local, { kind: "createRequire", functionId: scope.functionId, constDecl: true });
      }
      if (moduleName === "node:url" && (imported === "pathToFileURL" || imported === "fileURLToPath")) {
        setBinding(scope, local, {
          kind: "named-url",
          importedName: imported,
          module: "node:url",
          functionId: scope.functionId,
          constDecl: true,
        });
      }
    }
  }
  return spec;
}

function bindPattern(
  name: ts.BindingName,
  init: ts.Expression | undefined,
  scope: Scope,
  constDecl: boolean,
  file: string,
  findings: SourcePolicyFinding[],
): void {
  if (ts.isIdentifier(name)) {
    const kind = init ? expressionBindingKind(init, scope, file, findings) : "other";
    const value = init ? foldedString(init, scope) : undefined;
    const keepKind = isDangerousCallableKind(kind) || kind === "unresolved";
    setBinding(scope, name.text, {
      kind: value !== undefined && constDecl && !keepKind ? "const-string" : kind,
      value,
      functionId: enclosingFunction(scope).functionId,
      constDecl,
      init,
    });
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      if (!ts.isIdentifier(el.name) && !ts.isObjectBindingPattern(el.name) && !ts.isArrayBindingPattern(el.name)) {
        continue;
      }
      if (el.dotDotDotToken) {
        if (init && isSensitiveDispatchRoot(init, scope)) {
          findings.push(finding(file, "UNRESOLVED_COMPUTED_DISPATCH", "destructure-rest"));
          if (ts.isIdentifier(el.name)) {
            setBinding(scope, el.name.text, {
              kind: "unresolved",
              functionId: enclosingFunction(scope).functionId,
              constDecl,
            });
          }
        } else if (ts.isIdentifier(el.name)) {
          bindPattern(el.name, undefined, scope, constDecl, file, findings);
        }
        continue;
      }
      const propName = destructuredPropertyName(el, scope);
      if (init) {
        const kind = memberKind(init, propName, scope);
        if (kind === "unresolved" || isDangerousCallableKind(kind)) {
          findings.push(
            finding(
              file,
              kind === "unresolved" ? "UNRESOLVED_COMPUTED_DISPATCH" : "FORBIDDEN_PRIMITIVE",
              kind === "unresolved" ? `destructure:${el.getText()}` : String(kind),
            ),
          );
          if (ts.isIdentifier(el.name)) {
            setBinding(scope, el.name.text, {
              kind,
              functionId: enclosingFunction(scope).functionId,
              constDecl,
            });
          } else {
            bindPattern(el.name, undefined, scope, constDecl, file, findings);
          }
          continue;
        }
      }
      const imported = propName
        ?? (ts.isIdentifier(el.name) ? el.name.text : undefined);
      if (imported === "createRequire") {
        findings.push(finding(file, "FORBIDDEN_PRIMITIVE", "createRequire"));
        if (ts.isIdentifier(el.name)) {
          setBinding(scope, el.name.text, {
            kind: "createRequire",
            functionId: enclosingFunction(scope).functionId,
            constDecl,
          });
          continue;
        }
      }
      bindPattern(el.name, undefined, scope, constDecl, file, findings);
    }
  }
}

function expressionBindingKind(
  expr: ts.Expression,
  scope: Scope,
  file: string,
  findings: SourcePolicyFinding[],
): BindingKind {
  expr = unwrapExpr(expr);
  if (ts.isIdentifier(expr)) {
    const b = lookup(scope, expr.text);
    if (b) return b.kind;
    if (expr.text === "require") return "require";
    if (expr.text === "eval") return "eval";
    if (FUNCTION_CTOR_NAMES.has(expr.text)) return "function-ctor";
    return "other";
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const kind = calleeKind(expr, scope);
    if (kind && (isDangerousCallableKind(kind) || kind === "unresolved")) return kind;
    const name = accessPropertyName(expr, scope);
    if (name && FUNCTION_CTOR_NAMES.has(name) && isGlobalThis(expr.expression, scope)) return "function-ctor";
    if (name === "require" && isGlobalThis(expr.expression, scope)) return "require";
    if (name === "eval" && isGlobalThis(expr.expression, scope)) return "eval";
  }
  if (ts.isCallExpression(expr) && isImportCall(expr)) {
    const spec = expr.arguments[0] ? foldedString(expr.arguments[0], scope) : undefined;
    if (spec === "node:module" || spec === "module") {
      return "other";
    }
  }
  void file;
  void findings;
  return "other";
}

type WalkCtx = {
  file: string;
  sourceFile: ts.SourceFile;
  manifest: CanaryFileManifest;
  repoRoot?: string;
  findings: SourcePolicyFinding[];
  usedVendor: Set<ApprovedDynamicImport>;
  usedFallback: Set<ApprovedInjectedFallback>;
  usedStatic: Set<ApprovedStaticImport>;
  localSpecs: string[];
  literalDynamic: string[];
  runLoopCalls: Array<{ bindings: string[]; node: ts.CallExpression }>;
  functionSeq: number;
};

function walk(node: ts.Node, scope: Scope, ctx: WalkCtx): void {
  if (ts.isImportDeclaration(node)) {
    const spec = bindImportDecl(
      node,
      scope,
      ctx.file,
      ctx.findings,
      ctx.manifest,
    );
    if (spec && isLocalSpecifier(spec) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      const allType = Boolean(
        clause?.namedBindings
        && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((el) => el.isTypeOnly)
        && !clause.name,
      );
      if (!allType) ctx.localSpecs.push(spec);
    }
    if (spec && ctx.manifest.approvedStaticImports.some((row) => row.file === ctx.file && row.specifier === spec)) {
      const hit = ctx.manifest.approvedStaticImports.find((row) => row.file === ctx.file && row.specifier === spec);
      if (hit) ctx.usedStatic.add(hit);
    }
    ts.forEachChild(node, (child) => walk(child, scope, ctx));
    return;
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    if (!ts.isStringLiteralLike(node.moduleSpecifier)) {
      ctx.findings.push(finding(ctx.file, "UNRESOLVED_LOADER", "non-literal-export-from"));
    } else if (!node.isTypeOnly) {
      const spec = node.moduleSpecifier.text;
      const forbidden = specifierForbidden(spec);
      if (forbidden) ctx.findings.push(finding(ctx.file, "FORBIDDEN_SPECIFIER", forbidden));
      if (isLocalSpecifier(spec)) ctx.localSpecs.push(spec);
    }
    ts.forEachChild(node, (child) => walk(child, scope, ctx));
    return;
  }
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
    ctx.functionSeq += 1;
    const child: Scope = {
      parent: scope,
      kind: "function",
      functionId: ctx.functionSeq,
      functionName: functionNameOf(node),
      bindings: new Map(),
    };
    ts.forEachChild(node, (n) => walk(n, child, ctx));
    return;
  }
  if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) {
    const child: Scope = {
      parent: scope,
      kind: "block",
      functionId: enclosingFunction(scope).functionId,
      functionName: enclosingFunction(scope).functionName,
      bindings: new Map(),
    };
    ts.forEachChild(node, (n) => walk(n, child, ctx));
    return;
  }
  if (ts.isVariableStatement(node)) {
    const constDecl = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of node.declarationList.declarations) {
      bindPattern(decl.name, decl.initializer, scope, constDecl, ctx.file, ctx.findings);
    }
  }
  if (ts.isCallExpression(node)) classifyCall(node, scope, ctx);
  if (ts.isNewExpression(node)) classifyNew(node, scope, ctx);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    if (!isTypeContext(node)) {
      const kind = calleeKind(node, scope);
      if (kind === "unresolved") {
        ctx.findings.push(finding(ctx.file, "UNRESOLVED_COMPUTED_DISPATCH", node.getText(ctx.sourceFile)));
      } else if (isDangerousCallableKind(kind)) {
        const name = accessPropertyName(node, scope);
        if (!(kind === "function-ctor" && name === "constructor")) {
          ctx.findings.push(finding(ctx.file, "FORBIDDEN_PRIMITIVE", String(kind)));
        }
      }
    }
  }
  ts.forEachChild(node, (child) => walk(child, scope, ctx));
}

function functionNameOf(
  node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration,
): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (ts.isArrowFunction(node) && node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return undefined;
}

function classifyNew(node: ts.NewExpression, scope: Scope, ctx: WalkCtx): void {
  if (!node.expression) return;
  const kind = calleeKind(node.expression, scope);
  if (kind === "unresolved") {
    ctx.findings.push(finding(ctx.file, "UNRESOLVED_COMPUTED_DISPATCH", node.expression.getText(ctx.sourceFile)));
    return;
  }
  if (kind === "function-ctor") {
    ctx.findings.push(finding(ctx.file, "FORBIDDEN_PRIMITIVE", "Function"));
  }
}

function classifyCall(node: ts.CallExpression, scope: Scope, ctx: WalkCtx): void {
  if (ts.isIdentifier(node.expression) && node.expression.text === "runLoop") {
    const bindings: string[] = [];
    const arg = node.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) bindings.push(prop.name.text);
        if (ts.isShorthandPropertyAssignment(prop)) bindings.push(prop.name.text);
      }
    }
    ctx.runLoopCalls.push({ bindings, node });
  }
  if (isImportCall(node)) {
    const arg = node.arguments[0];
    if (!arg) {
      ctx.findings.push(finding(ctx.file, "UNRESOLVED_LOADER", "import()"));
      return;
    }
    const vendor = isApprovedVendorImportCall(
      node,
      scope,
      ctx.file,
      ctx.manifest.approvedDynamicImports,
      ctx.repoRoot,
      new Set(ctx.manifest.runtimeFiles),
    );
    if (vendor) {
      ctx.usedVendor.add(vendor);
      ctx.literalDynamic.push(vendor.resolvedTarget);
      return;
    }
    const spec = loaderArgumentIsLiteral(arg, scope);
    if (spec === undefined) {
      ctx.findings.push(finding(ctx.file, "UNRESOLVED_LOADER", `import(${arg.getText(ctx.sourceFile)})`));
      return;
    }
    const fallback = isApprovedFallbackCall(node, scope, ctx.file, spec, ctx.manifest.approvedInjectedFallbacks);
    if (fallback) {
      ctx.usedFallback.add(fallback);
      return;
    }
    if (isForbiddenLocalSpec(ctx.file, spec, ctx.manifest.forbiddenSourcePaths)) {
      ctx.findings.push(finding(ctx.file, "FORBIDDEN_SPECIFIER", spec));
      return;
    }
    const forbidden = specifierForbidden(spec);
    if (forbidden) {
      ctx.findings.push(finding(ctx.file, "FORBIDDEN_SPECIFIER", forbidden));
      return;
    }
    if (isLocalSpecifier(spec)) ctx.localSpecs.push(spec);
    else ctx.literalDynamic.push(spec);
    return;
  }
  const kind = calleeKind(node.expression, scope);
  if (kind === "unresolved") {
    ctx.findings.push(finding(ctx.file, "UNRESOLVED_COMPUTED_DISPATCH", node.expression.getText(ctx.sourceFile)));
    return;
  }
  if (kind === "require" || kind === "module-require") {
    const arg = node.arguments[0];
    const spec = arg ? loaderArgumentIsLiteral(arg, scope) : undefined;
    if (spec === undefined) {
      ctx.findings.push(finding(ctx.file, "UNRESOLVED_LOADER", `require(${arg?.getText(ctx.sourceFile) ?? ""})`));
      return;
    }
    const forbidden = specifierForbidden(spec);
    if (forbidden) ctx.findings.push(finding(ctx.file, "FORBIDDEN_SPECIFIER", forbidden));
    else if (isLocalSpecifier(spec)) ctx.localSpecs.push(spec);
    return;
  }
  if (kind === "eval" || kind === "function-ctor" || kind === "createRequire" || kind === "getBuiltin" || kind === "module-load" || kind === "import-meta-resolve" || kind === "process-binding" || kind === "process-dlopen") {
    ctx.findings.push(finding(ctx.file, "FORBIDDEN_PRIMITIVE", String(kind)));
    return;
  }
  if (kind === "reflect-construct") {
    const first = node.arguments[0];
    if (first && calleeKind(first, scope) === "function-ctor") {
      ctx.findings.push(finding(ctx.file, "FORBIDDEN_PRIMITIVE", "Reflect.construct(Function)"));
    }
  }
}

export type AnalyzedFile = {
  findings: SourcePolicyFinding[];
  localSpecs: string[];
  runLoopCalls: Array<{ bindings: string[] }>;
  usedVendor: ApprovedDynamicImport[];
  usedFallback: ApprovedInjectedFallback[];
};

export function analyzeSourceText(p: {
  file: string;
  source: string;
  manifest: CanaryFileManifest;
  repoRoot?: string;
}): AnalyzedFile {
  const findings: SourcePolicyFinding[] = [];
  let sourceFile: ts.SourceFile;
  try {
    sourceFile = parseExecutableSource(p.file, p.source);
  } catch (err) {
    return {
      findings: [finding(p.file, "PARSE_DIAGNOSTIC", String(err))],
      localSpecs: [],
      runLoopCalls: [],
      usedVendor: [],
      usedFallback: [],
    };
  }
  const moduleScope: Scope = {
    kind: "module",
    functionId: 0,
    bindings: new Map(),
  };
  const ctx: WalkCtx = {
    file: p.file,
    sourceFile,
    manifest: p.manifest,
    repoRoot: p.repoRoot,
    findings,
    usedVendor: new Set(),
    usedFallback: new Set(),
    usedStatic: new Set(),
    localSpecs: [],
    literalDynamic: [],
    runLoopCalls: [],
    functionSeq: 0,
  };
  walk(sourceFile, moduleScope, ctx);
  return {
    findings,
    localSpecs: ctx.localSpecs,
    runLoopCalls: ctx.runLoopCalls.map((row) => ({ bindings: row.bindings })),
    usedVendor: [...ctx.usedVendor],
    usedFallback: [...ctx.usedFallback],
  };
}

export function analyzeCanarySourcePolicy(
  root: string,
  manifest: CanaryFileManifest,
  overrides?: Map<string, string>,
): SourcePolicyFinding[] {
  const findings: SourcePolicyFinding[] = [];
  const analyzed = new Map<string, AnalyzedFile>();
  for (const rel of manifest.runtimeFiles) {
    if (!isScannedExecutable(rel)) {
      findings.push(finding(rel, "UNSUPPORTED_EXTENSION", rel));
      continue;
    }
    const source = overrides?.get(rel) ?? fs.readFileSync(path.join(root, rel), "utf8");
    const result = analyzeSourceText({ file: rel, source, manifest, repoRoot: root });
    analyzed.set(rel, result);
    findings.push(...result.findings);
  }
  for (const row of manifest.approvedDynamicImports) {
    const used = [...analyzed.values()].some((file) => file.usedVendor.includes(row));
    if (!used) findings.push(finding(row.file, "STALE_EXCEPTION", `${row.purpose}:${row.resolvedTarget}`));
  }
  for (const row of manifest.approvedInjectedFallbacks) {
    const used = [...analyzed.values()].some((file) => file.usedFallback.includes(row));
    if (!used) findings.push(finding(row.file, "STALE_EXCEPTION", `fallback:${row.specifier}`));
  }
  for (const row of manifest.approvedStaticImports) {
    const file = analyzed.get(row.file);
    const source = overrides?.get(row.file) ?? fs.readFileSync(path.join(root, row.file), "utf8");
    const ok = source.includes(`from "${row.specifier}"`) || source.includes(`from '${row.specifier}'`);
    if (!file || !ok) findings.push(finding(row.file, "STALE_EXCEPTION", `static:${row.specifier}`));
  }
  const extraFallbacks = analyzed.get("src/loop.ts")?.usedFallback.length ?? 0;
  if (extraFallbacks !== manifest.approvedInjectedFallbacks.length) {
    /* matched set size already compared via stale + unmatched import() findings */
  }
  findings.push(...assertEntrypointBindings(analyzed, manifest));
  findings.push(...assertLocalClosure(root, manifest, analyzed));
  return findings;
}

function assertEntrypointBindings(
  analyzed: Map<string, AnalyzedFile>,
  manifest: CanaryFileManifest,
): SourcePolicyFinding[] {
  const out: SourcePolicyFinding[] = [];
  const required = [...REQUIRED_ENTRYPOINT_BINDINGS_LOCAL];
  const entry = manifest.entrypoints[0] ?? "";
  for (const [file, result] of analyzed) {
    for (const call of result.runLoopCalls) {
      const missing = required.filter((name) => !call.bindings.includes(name));
      if (file === entry) {
        if (missing.length) out.push(finding(file, "ENTRYPOINT_BINDING", `missing:${missing.join(",")}`));
      } else if (missing.length) {
        out.push(finding(file, "ENTRYPOINT_BINDING", `secondary-runLoop:${file}`));
      }
    }
  }
  const entryResult = analyzed.get(entry);
  if (!entryResult || entryResult.runLoopCalls.length !== 1) {
    out.push(finding(entry, "ENTRYPOINT_BINDING", "missing-runLoop"));
  }
  return out;
}

const REQUIRED_ENTRYPOINT_BINDINGS_LOCAL = [
  "createExecutor",
  "refreshOfficialStats",
  "getOfficialCache",
];

function assertLocalClosure(
  root: string,
  manifest: CanaryFileManifest,
  analyzed: Map<string, AnalyzedFile>,
): SourcePolicyFinding[] {
  const out: SourcePolicyFinding[] = [];
  const runtime = new Set(manifest.runtimeFiles);
  const excluded = new Set(
    manifest.approvedInjectedFallbacks.map((row) => {
      try {
        return resolveLocalSourcePath(row.file, row.specifier, root);
      } catch {
        return row.specifier;
      }
    }),
  );
  const seen = new Set<string>();
  const queue = [...manifest.entrypoints];
  for (const row of manifest.approvedDynamicImports) queue.push(row.resolvedTarget);
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const result = analyzed.get(rel);
    if (!result) continue;
    for (const spec of result.localSpecs) {
      let resolved: string;
      try {
        resolved = resolveLocalSourcePath(rel, spec, root);
        assertCanonicalRelPath(resolved, "closure");
      } catch (err) {
        out.push(finding(rel, "UNRESOLVED_LOCAL", String(err)));
        continue;
      }
      if (excluded.has(resolved) || [...excluded].some((item) => item.endsWith(spec.replace(/^\.\//, "")))) {
        continue;
      }
      const fallbackHit = manifest.approvedInjectedFallbacks.some(
        (row) => row.file === rel && row.specifier === spec,
      );
      if (fallbackHit) continue;
      if (!runtime.has(resolved)) {
        out.push(finding(rel, "UNLISTED_LOCAL", `${spec}->${resolved}`));
        continue;
      }
      queue.push(resolved);
    }
  }
  return out;
}

export function sourcePolicyHits(findings: SourcePolicyFinding[]): string[] {
  return findings.map((row) => `${row.file}:${row.code}:${row.detail}`);
}
