# Daily auto-generation — setup (Phase 2b)

A GitHub Action (`.github/workflows/daily-playbook.yml`) generates one playbook a
day with our keys, validates it, and **opens a PR**. Merging the PR publishes it
(the app syncs it to Pro users on next open). Close the PR to discard. Nothing
reaches customers without a human merge.

## One-time setup (in this repo's GitHub settings)

1. **Add secrets** — Settings → Secrets and variables → Actions → *New repository secret*:
   - `ANTHROPIC_API_KEY` — our Anthropic key (the generation/token cost lands here).
   - `TAVILY_API_KEY` — our Tavily key (optional; without it, it generates without
     web grounding).
   - (optional) Variable `MODEL` — defaults to `claude-sonnet-4-6`.

2. **Allow Actions to open PRs** — Settings → Actions → General → *Workflow
   permissions* → enable **"Allow GitHub Actions to create and approve pull
   requests"** (and "Read and write permissions"). Without this the PR step fails.

3. Done. It runs daily at 14:00 UTC. To run on demand: Actions → *Daily playbook*
   → *Run workflow* (optionally force a `topics.json` index).

## Cost & cadence
- ~1 playbook/day (12 cards, Sonnet) ≈ **$0.20–0.30/day**, regardless of how many
  subscribers receive it (generate-once, distribute-to-many).
- Topic rotates by day-of-year through `tools/topics.json` — edit that list to
  change what gets generated. Add/remove freely.

## Quality gate
- `tools/generate.mjs` validates the output (every card needs principle + counter +
  script; exact card count) and **fails the run** if it doesn't pass — so a bad
  generation never opens a PR.
- The PR itself is the human review gate. Skim the diff, merge to ship.

## Going fully hands-off (optional, later)
To auto-publish without review, replace the "Open PR" step with a direct commit to
`main` (`git commit && git push`). Not recommended until the generator has a track
record — AI content + Google Play policy + brand voice all argue for keeping the
merge gate.

## Keeping the brand prompt in sync
`tools/system-prompt.txt` is a verbatim copy of the app's `SYSTEM_PROMPT`
(`src/services/aiService.ts`). If you change the app's prompt, re-copy it here.
