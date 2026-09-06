import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runNpmAudit } from "../../scripts/security/audit-baseline.js";

// A local fake npm exercises subprocess capture without a registry or credentials.
function capture(status: number, stdout: string, stderr: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-diagnostic-"));
  try {
    fs.writeFileSync(path.join(root, "npm"),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)});\n` +
      `process.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${status});\n`,
      { mode: 0o700 });
    const result = runNpmAudit(root, "out", { executable: path.join(root, "npm"), env: {} });
    const diagnostic = JSON.parse(fs.readFileSync(path.join(root, "out/audit-command.json"), "utf8"));
    return { result, diagnostic };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("audit exit 1 preserves vulnerability JSON and remains available to policy", () => {
  const raw = '{"auditReportVersion":2,"vulnerabilities":{"example":{}}}\n';
  const { result, diagnostic } = capture(1, raw, "registry diagnostic\n");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.raw, raw);
  assert.equal(diagnostic.status, 1);
  assert.equal(diagnostic.stdout, raw);
  assert.equal(diagnostic.stderr, "registry diagnostic\n");
  assert.equal(diagnostic.authorizationGranted, false);
});

test("command failure preserves registry error stdout instead of dropping it", () => {
  const raw = '{"error":{"code":"E503","summary":"registry unavailable"}}';
  const { result, diagnostic } = capture(2, raw, "unavailable");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "AUDIT_COMMAND_FAILED");
  assert.equal(diagnostic.status, 2);
  assert.equal(diagnostic.stdout, raw);
});

test("malformed stdout remains visible and is not replaced with an empty audit", () => {
  const { result, diagnostic } = capture(0, "<html>registry error</html>", "");
  assert.equal(result.ok, true); // Existing parser, not capture, rejects this input.
  assert.equal(diagnostic.stdout, "<html>registry error</html>");
});

test("sanitization keeps artifact JSON parseable and removes diagnostic secrets", () => {
  const { diagnostic } = capture(2, "Authorization: Bearer fake-secret\nnext line\n",
    "https://fake-user:fake-password@registry.invalid/ token=fake-token");
  const dumped = JSON.stringify(diagnostic);
  assert.equal(dumped.includes("fake-secret"), false);
  assert.equal(dumped.includes("fake-password"), false);
  assert.equal(dumped.includes("fake-token"), false);
  assert.equal(diagnostic.stdout.includes("next line"), true);
});

test("spawn failure records null status and the actual error without a success", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-diagnostic-"));
  try {
    const result = runNpmAudit(root, "out", { executable: path.join(root, "npm"), env: {} });
    const diagnostic = JSON.parse(fs.readFileSync(path.join(root, "out/audit-command.json"), "utf8"));
    assert.equal(result.ok, false);
    assert.equal(diagnostic.status, null);
    assert.match(diagnostic.error, /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("signal termination retains capture time, signal, and both streams", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-signal-"));
  try {
    const result = runNpmAudit(root, "out", {
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("before signal"); process.stderr.write("signal diagnostic"); process.kill(process.pid, "SIGTERM");'],
      cwd: root,
      env: {},
    });
    const diagnostic = JSON.parse(fs.readFileSync(path.join(root, "out/audit-command.json"), "utf8"));
    assert.equal(result.ok, false);
    assert.equal(diagnostic.status, null);
    assert.equal(diagnostic.signal, "SIGTERM");
    assert.equal(diagnostic.stdout, "before signal");
    assert.equal(diagnostic.stderr, "signal diagnostic");
    assert.equal(diagnostic.error, null);
    assert.ok(Number.isFinite(Date.parse(diagnostic.capturedAt)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const empty = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-output-"));
  const root = path.join(temp, "repo");
  fs.mkdirSync(root);
  fs.cpSync(path.join(source, "scripts/security"), path.join(root, "scripts/security"), { recursive: true });
  fs.cpSync(path.join(source, ".github"), path.join(root, ".github"), { recursive: true });
  fs.copyFileSync(path.join(source, "package-lock.json"), path.join(root, "package-lock.json"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(source, "node_modules"), path.join(root, "node_modules"), "dir");
  for (const args of [["init", "-q"], ["add", ".github"]]) {
    assert.equal(spawnSync("git", args, { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8" }).status, 0);
  }
  const bin = path.join(temp, "bin"); fs.mkdirSync(bin);
  const marker = path.join(temp, "npm-called");
  fs.writeFileSync(path.join(bin, "npm"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'called');process.stderr.write('fixture subprocess failure');process.exit(2);\n`, { mode: 0o700 });
  const invoke = (args: string[]) => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(root, "scripts/security/audit-baseline.ts"), ...args], {
    cwd: temp, encoding: "utf8", timeout: 10000,
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: temp, TMPDIR: temp },
  });
  return { temp, root, marker, invoke };
}

for (const mode of ["absolute", "relative", "default"] as const) {
  for (const scenario of ["normal", "policy", "missing", "malformed", "subprocess"] as const) {
    test(`audit ${scenario} uses ${mode} output contract without stray reports`, () => {
      const f = fixture();
      try {
        const outArg = mode === "absolute" ? path.join(f.temp, "external") : "relative-output";
        const expected = mode === "absolute" ? outArg : path.join(f.root, mode === "default" ? "artifacts/security" : outArg);
        const input = path.join(f.temp, "input.json");
        if (scenario !== "missing") fs.writeFileSync(input, scenario === "malformed" ? "{" : JSON.stringify(scenario === "policy" ? {
          ...empty, vulnerabilities: { example: { name: "example", severity: "critical", isDirect: true, range: "*", nodes: ["node_modules/example"], via: [{ source: 123, name: "example", severity: "critical", range: "*", url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }], fixAvailable: false } },
          metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 } },
        } : empty));
        const args = scenario === "subprocess" ? [] : ["--audit-json", input];
        if (mode !== "default") args.push("--out-dir", outArg);
        const result = f.invoke(args);
        assert.equal(result.error, undefined);
        assert.equal(result.status, scenario === "normal" ? 0 : 1, result.stderr);
        const verification = JSON.parse(fs.readFileSync(path.join(expected, "audit-baseline-verification.json"), "utf8"));
        assert.equal(verification.overallPolicyOk, scenario === "normal");
        const files = ["action-pin-inventory.json", "audit-baseline-verification.json"];
        if (scenario === "subprocess") files.push("audit-command.json");
        else if (scenario !== "missing") files.push("audit.json", "package-lock.sha256");
        assert.deepEqual(fs.readdirSync(expected).sort(), files.sort());
        if (mode === "absolute") assert.equal(fs.existsSync(path.join(f.root, outArg)), false);
        if (mode !== "default") assert.equal(fs.existsSync(path.join(f.root, "artifacts/security")), false);
        if (mode === "relative") assert.equal(fs.existsSync(path.join(f.temp, outArg)), false);
        assert.equal(fs.existsSync(f.marker), scenario === "subprocess");
      } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
    });
  }
}

for (const args of [["--unknown"], ["positional"], ["--audit-json"], ["--out-dir"], ["--audit-json", "--out-dir", "x"], ["--out-dir", "x", "--unknown"], ["--out-dir", "x", "--out-dir", "y"], ["sanitize-log", "--unknown"], ["--audit-json=x"]]) {
  test(`rejects ${JSON.stringify(args)} before any report or npm invocation`, () => {
    const f = fixture();
    try {
      const before = fs.readdirSync(f.root, { recursive: true }).sort();
      const result = f.invoke(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /AUDIT_ARGUMENT_/);
      assert.equal(fs.existsSync(f.marker), false);
      assert.deepEqual(fs.readdirSync(f.root, { recursive: true }).sort(), before);
    } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
  });
}
