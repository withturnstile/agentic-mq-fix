// Pure helpers for the fix agent (fix.mjs): the prompt, the tool-use guard and the agent's limits.
import path from "node:path";

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_MAX_TURNS = 60;

const positive = (v) => {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * The model and limits the agent runs with: the Turnstile fix session's (passed by action.yml as
 * TU_MODEL, TU_MAX_TURNS and TU_MAX_BUDGET_USD), falling back to the dispatch payload's budget.
 */
export function agentLimits(env, payload) {
  return {
    model: env.TU_MODEL || DEFAULT_MODEL,
    maxTurns: Math.floor(positive(env.TU_MAX_TURNS) ?? DEFAULT_MAX_TURNS),
    maxBudgetUsd: positive(env.TU_MAX_BUDGET_USD) ?? payload?.max_budget_usd,
  };
}

/** Tools the agent may use. Bash is allowed: this runs on the repo's own CI runner. */
export const ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"];
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Edit", "Write"]);
// Mirrors the app's patch checks; failing early lets the agent choose another approach.
const PROTECTED = [/^\.github(\/|$)/, /^\.gitmodules$/, /(^|\/)\.git(\/|$)/];

/** The path a file tool acts on, relative to the repo root, or an error string. */
export function repoPath(root, input) {
  const raw = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (raw == null || raw === "") return { rel: "" };
  const abs = path.resolve(root, String(raw));
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { error: `${raw} is outside the repository` };
  return { rel: rel.split(path.sep).join("/") };
}

/** Decide one tool call: { allow: true, rel? } or { allow: false, reason }. */
export function checkTool(root, toolName, input) {
  if (!ALLOWED_TOOLS.includes(toolName)) return { allow: false, reason: `${toolName} is not available to the fix agent` };
  if (!FILE_TOOLS.has(toolName)) return { allow: true };
  const { rel, error } = repoPath(root, input);
  if (error) return { allow: false, reason: error };
  if (WRITE_TOOLS.has(toolName) && PROTECTED.some((re) => re.test(rel))) {
    return { allow: false, reason: `fixes may not change ${rel}: CI config, workflows and git internals are off limits` };
  }
  return { allow: true, rel };
}

function block(text) {
  return "```\n" + String(text).replace(/```/g, "ʼʼʼ") + "\n```";
}

export function buildPrompt(p) {
  const failures = p.failures
    .map((f) => {
      const name = [f.workflow, f.job, f.test].filter(Boolean).join(" › ");
      const detail = f.failure ? `\n  Failure on main (normalized: numbers, paths and ids may show as placeholders):\n${block(f.failure)}` : "";
      return `- ${name}${f.run_url ? ` (${f.run_url})` : ""}${detail}`;
    })
    .join("\n");
  const c = p.culprit;
  const history = [
    p.last_green_sha ? `- Last passing on main: ${p.last_green_sha}` : "- Last passing commit: unknown (these may never have passed)",
    c ? `- Started failing with: ${c.sha}${c.pr ? ` (PR #${c.pr}${c.title ? `: ${c.title}` : ""})` : ""}` : null,
    `- Main now: ${p.base_sha} (checked out)`,
    p.last_green_sha ? `- Changes in between: \`git log --oneline ${p.last_green_sha}..${p.base_sha}\`` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `The default branch of this repository is broken. These failures started with a recent change and are confirmed: they failed on consecutive commits with the same error.

## Failing
${failures}

## History
${history}

## What usually causes this
Most of these are semantic merge conflicts: two changes that each passed CI on their own branch but break once both are on main. For example, one renames, moves or changes the signature or behavior of something, and another adds a new use of the old form, or relies on the old default. Find both sides (the change named above and the one it conflicts with), then make the smallest change that reconciles them so both intents survive.

## How to work
1. Reproduce: run the failing tests if you can. The repo's dependencies were installed by the workflow.
2. Diagnose using git history and the code.
3. Fix with the Edit and Write tools only. Changes made through Bash (sed, redirects, generated files) are discarded.
4. Re-run the failing tests and closely related ones.

## Rules
- Keep the change minimal and focused: no refactors, reformatting or unrelated cleanups.
- Never skip, delete or weaken tests or assertions to get them passing. Change a test only when the test itself became wrong because of the other change, and say so.
- Don't edit .github/, CI config or dependency manifests, and don't commit or push.
- If you can't find a fix you're confident in, make no changes and explain what you found.

Finish with a short summary for the pull request description: the root cause (name the commits or PRs that conflict), what you changed, and how you verified it.`;
}
