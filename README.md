# agentic-mq-fix

The fix agent for **Turnstile** (the known-broken gate). When a failure is confirmed broken on your default branch, the Turnstile GitHub App asks this workflow to fix it. A Claude agent runs **in your CI**, on your runner, with your dependencies, and uploads a patch. Turnstile checks the patch and opens the pull request:
- **Small fixes** (under 20 changed lines by default) get auto-merge, so they merge once `known-broken-gate` passes.
- **Larger fixes** stay open, and Turnstile comments tagging the author of the change that broke main.

The agent focuses on semantic merge conflicts: two changes that each passed CI on their own but break once both are on main.

You don't need an Anthropic API key. The agent's model calls go through Turnstile, which runs them on its own key with a spend limit per fix.

## Setup

1. Add this workflow to your default branch as `.github/workflows/turnstile-fix.yml`:

   ```yaml
   # turnstile: enable repairs
   name: Turnstile fix
   on:
     repository_dispatch:
       types: [known-broken-fix]
   permissions:
     contents: read
     id-token: write   # lets the run prove its identity to Turnstile; nothing else
   jobs:
     fix:
       uses: withturnstile/agentic-mq-fix/.github/workflows/fix.yml@v2
       with:
         node-version: "22"     # optional
         setup: npm ci          # optional: install deps so the agent can run tests
   ```

   `id-token: write` only lets the run request a GitHub OIDC token, a signed statement of which repository, workflow and run it is. Turnstile checks it before it opens a model session for the fix. It grants no access to your repository, and no secret is stored anywhere.

   Reference the workflow by a release tag (`@v2` or a full tag such as `@v2.0.0`). Turnstile only accepts runs of this workflow at a tag, so a branch or commit SHA ref won't get a session.

2. If your organization restricts which Actions may run, allow `withturnstile/agentic-mq-fix/*`.
3. Turn on **Allow auto-merge** in the repo settings.
4. Turn repairs on. Without a `.github/turnstile.yml`, the first line of the workflow above (`# turnstile: enable repairs`) does it, and every fix stays open for review. With a config file, set:

   ```yaml
   fix:
     enabled: true
     auto_merge_under_lines: 20   # smaller fixes auto-merge; larger ones tag the culprit
   ```

**Workflow inputs:** `setup`, `node-version`, `python-version`, `runs-on` (for example, a self-hosted runner, which needs Node.js 18 or later on its `PATH`) and `turnstile-url` (default `https://app.withturnstile.com`).

**Custom setup:** if your dependencies need more than a shell command, put it in `setup` (it runs in bash and can call scripts in your repo), or choose a self-hosted runner with `runs-on`. Turnstile only opens model sessions for this reusable workflow, so a job that uses the Action directly can't get one.

### Upgrading from v1

v1 (`@v1`) still works and still takes your own key through the `anthropic-api-key` secret. To move to v2, change the ref to `@v2`, add `id-token: write` to `permissions`, drop the `secrets:` block and the `model` input, and delete the `ANTHROPIC_API_KEY` secret if nothing else uses it.

## What runs where

- **Your runner:** the agent reads your code, runs commands and tests, and edits files. Its checkout has no push credentials.
- **Turnstile:** the agent's model requests (which include what it reads) pass through Turnstile on their way to Anthropic. Turnstile records which fix each request belongs to and its token usage, not the content. It also receives the patch (the changed lines with a few lines of context) and the agent's summary. Your repository is never cloned to Turnstile's servers.
- **Anthropic:** receives the model requests, under Turnstile's API key.

## Guardrails

- The agent can only read and edit files inside the checkout. It cannot edit `.github/`, `.gitmodules` or `.git/`, and it has no web access.
- Only files the agent edits with its own Edit and Write tools go into the patch. Build output, test reports and Bash side effects are left out.
- Turnstile re-checks every patch before committing it. The patch must carry the dispatch's one-time token and apply cleanly to the dispatched commit. It must not include binary files or `.github/` changes.
- The model session is for one fix attempt and one model. It is claimed by the first step of the run, before your code is checked out, and only that run can use it. It ends when the attempt finishes or times out, or when Turnstile is uninstalled. Turnstile enforces a spend limit per attempt on its server.
- The session token is masked in logs and passed only to the agent step, not to your `setup` commands.

## Development

```bash
npm test
```

`fix.mjs` runs the agent with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). `lib.mjs` holds the prompt, the tool guard and the agent's limits. `.github/workflows/fix.yml` opens the fix session (`POST /api/fix/session`) and `action.yml` points the SDK at Turnstile's model proxy (`/anthropic`). The dispatch payload, the result format and the session API are defined by the Turnstile app (`src/fix/contract.ts` and `src/fix/proxy.ts`). Change them in both places.
