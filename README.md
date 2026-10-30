# agentic-mq-fix

The fix agent for **agentic-mq** (the known-broken gate). When a failure is confirmed broken on your default branch, the agentic-mq GitHub App asks this workflow to fix it. A Claude agent runs **in your CI**, on your runner, with your dependencies, and uploads a patch. The app checks the patch and opens the pull request:
- **Small fixes** (under 20 changed lines by default) get auto-merge, so they merge once `known-broken-gate` passes.
- **Larger fixes** stay open, and the app comments tagging the author of the change that broke main.

The agent focuses on semantic merge conflicts: two changes that each passed CI on their own but break once both are on main.

## Setup

1. Add an `ANTHROPIC_API_KEY` Actions secret to the repo (or the org).
2. Add this workflow to your default branch:

   ```yaml
   # .github/workflows/agentic-mq-fix.yml
   name: agentic-mq fix
   on:
     repository_dispatch:
       types: [known-broken-fix]
   jobs:
     fix:
       uses: ajhrkr/agentic-mq-fix/.github/workflows/fix.yml@v1
       with:
         node-version: "22"     # optional
         setup: npm ci          # optional: install deps so the agent can run tests
       secrets:
         anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
   ```

3. Turn on **Allow auto-merge** in the repo settings.
4. Set `fix.enabled: true` in `.github/known-broken.yml`:

   ```yaml
   fix:
     enabled: true
     auto_merge_under_lines: 20   # smaller fixes auto-merge; larger ones tag the culprit
     max_budget_usd: 5            # per agent run
   ```

**Workflow inputs:** `setup`, `node-version`, `python-version`, `runs-on` (for example, a self-hosted runner) and `model` (default `claude-opus-5-5`).

**Custom setup:** if your setup needs more than a shell command, write your own job and use the Action directly. Check out `${{ github.event.client_payload.base_sha }}` with `fetch-depth: 200`, then run `uses: ajhrkr/agentic-mq-fix@v1` with `anthropic-api-key`.

## What runs where

- **Your runner:** the agent reads your code, runs commands and tests, and edits files. Its checkout has no push credentials.
- **Anthropic:** receives what the agent reads, under your API key.
- **The agentic-mq app:** receives only the patch (the changed lines with a few lines of context) and the agent's summary. Your repository is never copied to agentic-mq's servers.

## Guardrails

- The agent can only read and edit files inside the checkout. It cannot edit `.github/`, `.gitmodules` or `.git/`, and it has no web access.
- Only files the agent edits with its own Edit and Write tools go into the patch. Build output, test reports and Bash side effects are left out.
- The app re-checks every patch before committing it. The patch must carry the dispatch's one-time token and apply cleanly to the dispatched commit. It must not include binary files or `.github/` changes.
- Spend is capped by `fix.max_budget_usd` per run.

## Development

```bash
npm test
```

`fix.mjs` runs the agent with the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). `lib.mjs` holds the prompt and the tool guard. The dispatch payload and result format are defined by the app (`src/fix/contract.ts` in agentic-mq). Change them in both places.
