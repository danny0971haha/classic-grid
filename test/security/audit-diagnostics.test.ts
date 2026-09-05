import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runNpmAudit } from "../../scripts/security/audit-baseline.js";

// A local fake npm exercises subprocess capture without a registry or credentials.
function capture(status: number, stdout: string, stderr: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-diagnostic-"));
  const previousPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(root, "npm"),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(stdout)});\n` +
      `process.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${status});\n`,
      { mode: 0o700 });
    process.env.PATH = root;
    const result = runNpmAudit(root, "out");
    const diagnostic = JSON.parse(fs.readFileSync(path.join(root, "out/audit-command.json"), "utf8"));
    return { result, diagnostic };
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
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
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = root;
    const result = runNpmAudit(root, "out");
    const diagnostic = JSON.parse(fs.readFileSync(path.join(root, "out/audit-command.json"), "utf8"));
    assert.equal(result.ok, false);
    assert.equal(diagnostic.status, null);
    assert.match(diagnostic.error, /ENOENT/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
