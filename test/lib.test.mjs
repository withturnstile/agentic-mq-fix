import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentLimits, buildPrompt, checkTool } from "../lib.mjs";

const root = "/work/repo";

describe("tool guard", () => {
  it("allows reading and editing inside the repo", () => {
    assert.deepEqual(checkTool(root, "Read", { file_path: "/work/repo/src/app.ts" }), { allow: true, rel: "src/app.ts" });
    assert.deepEqual(checkTool(root, "Edit", { file_path: "src/app.ts" }), { allow: true, rel: "src/app.ts" });
    assert.deepEqual(checkTool(root, "Grep", { pattern: "x" }), { allow: true, rel: "" });
    assert.deepEqual(checkTool(root, "Bash", { command: "npm test" }), { allow: true });
  });

  it("denies paths outside the repo, protected files and unknown tools", () => {
    assert.equal(checkTool(root, "Read", { file_path: "/home/runner/.ssh/id_rsa" }).allow, false);
    assert.equal(checkTool(root, "Read", { file_path: "../other/secret" }).allow, false);
    assert.equal(checkTool(root, "Write", { file_path: ".github/workflows/ci.yml" }).allow, false);
    assert.equal(checkTool(root, "Edit", { file_path: "packages/a/.git/config" }).allow, false);
    assert.equal(checkTool(root, "WebFetch", { url: "https://example.com" }).allow, false);
    // Reading workflows is fine; only writing them is off limits.
    assert.equal(checkTool(root, "Read", { file_path: ".github/workflows/ci.yml" }).allow, true);
  });
});

describe("prompt", () => {
  it("names the failures, the culprit and the commit range to inspect", () => {
    const prompt = buildPrompt({
      attempt_id: 1,
      token: "t",
      base_sha: "ccc",
      failures: [{ workflow: ".github/workflows/ci.yml", job: "test", test: "test::total", failure: "TypeError: computeTotal is not a function", run_url: "https://x/run/1" }],
      last_green_sha: "aaa",
      culprit: { sha: "bbb", pr: 12, title: "Rename computeTotal to sum" },
      max_budget_usd: 5,
    });
    assert.match(prompt, /\.github\/workflows\/ci\.yml › test › test::total \(https:\/\/x\/run\/1\)/);
    assert.match(prompt, /computeTotal is not a function/);
    assert.match(prompt, /Started failing with: bbb \(PR #12: Rename computeTotal to sum\)/);
    assert.match(prompt, /git log --oneline aaa\.\.ccc/);
    assert.match(prompt, /semantic merge conflicts/);
  });
});

describe("agent limits", () => {
  it("uses the Turnstile session's model, turns and budget", () => {
    const env = { KBG_MODEL: "claude-opus-5-5", KBG_MAX_TURNS: "40", KBG_MAX_BUDGET_USD: "2.5" };
    assert.deepEqual(agentLimits(env, { max_budget_usd: 5 }), { model: "claude-opus-5-5", maxTurns: 40, maxBudgetUsd: 2.5 });
  });

  it("falls back to the payload's budget and the default model and turns", () => {
    assert.deepEqual(agentLimits({}, { max_budget_usd: 5 }), { model: "claude-opus-5-5", maxTurns: 60, maxBudgetUsd: 5 });
    assert.deepEqual(agentLimits({ KBG_MODEL: "", KBG_MAX_TURNS: "", KBG_MAX_BUDGET_USD: "" }, { max_budget_usd: 3 }), { model: "claude-opus-5-5", maxTurns: 60, maxBudgetUsd: 3 });
    for (const bad of ["0", "-1", "abc", "NaN"]) {
      assert.equal(agentLimits({ KBG_MAX_BUDGET_USD: bad, KBG_MAX_TURNS: bad }, { max_budget_usd: 4 }).maxBudgetUsd, 4);
      assert.equal(agentLimits({ KBG_MAX_TURNS: bad }, {}).maxTurns, 60);
    }
    assert.equal(agentLimits({}, null).maxBudgetUsd, undefined);
  });
});
