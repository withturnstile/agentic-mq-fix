// Runs the fix agent in the checked-out repo and writes result.json + fix.patch to TU_OUT.
// Always writes result.json, even on failure, so the app can close out the attempt.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ALLOWED_TOOLS, buildPrompt, checkTool } from "./lib.mjs";

const payload = JSON.parse(process.env.TU_PAYLOAD ?? "null");
const out = process.env.TU_OUT;
const root = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const result = { attempt_id: payload?.attempt_id ?? null, token: payload?.token ?? null, outcome: "error", summary: "", cost_usd: null };
const touched = new Set();

async function main() {
  if (!payload?.attempt_id || !payload.token || !payload.base_sha) throw new Error("missing client_payload; trigger this workflow with repository_dispatch from known-broken-gate");
  const head = git("rev-parse", "HEAD").trim();
  if (head !== payload.base_sha) throw new Error(`checked out ${head}, expected ${payload.base_sha}; check out github.event.client_payload.base_sha`);

  const guard = async (input) => {
    const decision = checkTool(root, input.tool_name, input.tool_input);
    if (!decision.allow) {
      console.log(`  denied ${input.tool_name}: ${decision.reason}`);
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } };
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
  };
  const track = async (input) => {
    if (input.tool_name === "Edit" || input.tool_name === "Write") {
      const decision = checkTool(root, input.tool_name, input.tool_input);
      if (decision.allow && decision.rel) touched.add(decision.rel);
    }
    return {};
  };

  let final = null;
  for await (const m of query({
    prompt: buildPrompt(payload),
    options: {
      cwd: root,
      model: process.env.TU_MODEL || "claude-opus-5-5",
      maxTurns: Number(process.env.TU_MAX_TURNS || 60),
      maxBudgetUsd: payload.max_budget_usd,
      permissionMode: "dontAsk",
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: ["WebFetch", "WebSearch"],
      // Repo settings and hooks must not change what the agent may do.
      settingSources: [],
      hooks: { PreToolUse: [{ hooks: [guard] }], PostToolUse: [{ hooks: [track] }] },
    },
  })) {
    if (m.type === "assistant") {
      for (const b of m.message.content) {
        if (b.type === "text" && b.text.trim()) console.log(b.text.trim());
        if (b.type === "tool_use") console.log(`→ ${b.name} ${JSON.stringify(b.input).slice(0, 200)}`);
      }
    } else if (m.type === "result") {
      result.cost_usd = m.total_cost_usd ?? null;
      if (m.subtype === "success" && !m.is_error) final = m.result;
      else throw new Error(m.subtype === "success" ? m.result : `agent stopped: ${m.subtype}${m.errors?.length ? ` (${m.errors.join("; ")})` : ""}`);
    }
  }

  // Only files the agent edited with its tools go into the patch; anything else in the tree
  // (build output, test reports, Bash side effects) is left out.
  const files = [...touched];
  let patch = "";
  if (files.length) {
    git("add", "--all", "--", ...files);
    patch = git("diff", "--cached", "--no-renames", "--no-color", "--", ...files);
  }
  writeFileSync(path.join(out, "fix.patch"), patch);
  result.outcome = patch.trim() ? "changed" : "no_change";
  result.summary = final ?? "";
  console.log(`\noutcome: ${result.outcome}, files: ${files.join(", ") || "none"}, est. cost: $${(result.cost_usd ?? 0).toFixed(2)}`);
}

mkdirSync(out, { recursive: true });
try {
  await main();
} catch (err) {
  result.outcome = "error";
  result.error = err instanceof Error ? err.message : String(err);
  console.error(`fix agent failed: ${result.error}`);
} finally {
  writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));
}
