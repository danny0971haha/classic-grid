import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { test } from "node:test";
import { parseStrictYaml } from "../../scripts/security/action-yaml.js";

const parsed = parseStrictYaml(fs.readFileSync(".github/workflows/ci.yml", "utf8"));
assert.equal(parsed.ok, true);
if (!parsed.ok) throw new Error("CI_YAML_INVALID");
const workflow = parsed.doc.toJS();
const steps = workflow.jobs["compiler-and-tests"].steps as Array<Record<string, any>>;
const aggregate = steps.at(-1)!;
const required = steps.slice(0, -1);

function runAggregation(outcomes: Record<string, { outcome: string; conclusion?: string }>) {
  return spawnSync("bash", ["-c", aggregate.run], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, EVENT_NAME: "pull_request", REQUIRED_RESULTS: JSON.stringify(outcomes) },
  });
}

test("CI cannot convert a failed or absent required check into a successful job", () => {
  assert.equal(aggregate.if, "always()");
  const results = Object.fromEntries(required.map(step => [step.id, { outcome: "success", conclusion: "success" }]));
  assert.equal(runAggregation(results).status, 0);
  for (const step of required) {
    const failed = { ...results, [step.id]: { outcome: "failure", conclusion: "success" } };
    assert.equal(runAggregation(failed).status, 1, step.name ?? step.run ?? step.id);
    const missing = { ...results };
    delete missing[step.id];
    assert.equal(runAggregation(missing).status, 1, `missing ${step.id}`);
  }
});

test("live audit is controlled and evidence uploads remain available after failure", () => {
  const audit = required.find(step => step.run === "npm run test:audit-live")!;
  assert.ok(audit);
  assert.equal(audit["continue-on-error"], true);
  assert.ok(audit["timeout-minutes"] > 0);
  for (const step of required.filter(step => step.uses?.startsWith("actions/upload-artifact@"))) {
    assert.equal(step.if, "always()");
    assert.equal(step.with["if-no-files-found"], "error");
  }
  assert.ok(required.some(step => step.run === "npm run test:canary-live"));
});
