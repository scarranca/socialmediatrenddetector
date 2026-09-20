# Contributing

Thanks for helping out. This is a small project; the bar is "it works, it's tested where it's pure, and it reads like the code around it."

## Setup

```bash
npm install
npm test          # node:test suites — no API keys needed
npm run typecheck
npm run ui        # dashboard at http://localhost:4173 (open /test for the recorded demo run)
```

You only need `APIFY_TOKEN` / `ANTHROPIC_API_KEY` (see `.env.example`) to run the real pipeline. `npm run sample` skips Apify and uses `fixtures/sample-videos.json`, but still calls Claude.

## Where things live

| Area | File | Notes |
|---|---|---|
| Apify Actors → one `Video` shape | `src/collect.ts` | One normalizer per platform. Build Actor inputs from the Actor's input schema (append `.md` to its Store URL), never from memory. |
| Scoring / clustering | `src/analyze.ts` | Pure functions — add a test in `test/analyze.test.ts` with any change. |
| Claude calls | `src/llm.ts` | Structured outputs via zod schemas in `src/types.ts`. Prompts are exported consts so they can be tuned. |
| Live UI events | `src/events.ts` | If you add a pipeline step, emit an event and handle it in `ui/live.js`. |
| Dashboard | `ui/` | Vanilla JS/CSS, no build step. Design context is in `PRODUCT.md`. |

## Adding a platform

1. Pick an Actor on the [Apify Store](https://apify.com/store) and read its input schema + output sample.
2. Add it to `ACTORS` and `buildInput` in `src/collect.ts`, write a `normalize<Platform>` function, and add the platform to the `Platform` type and `ProfileSchema`.
3. Always pass `maxTotalChargeUsd` in the call options — every run must be spend-capped.
4. Add normalizer tests with a trimmed real output item (scrub anything personal).

## Pull requests

- Keep PRs focused; describe what you ran to verify.
- `npm test` and `npm run typecheck` must pass — run them locally before opening the PR.
- Never commit `.env`, `config/profile.json`, or anything under `data/` / `output/`.
- Found an Actor quirk (wrong enum, odd output)? Note it in a code comment next to the workaround and consider reporting it on the Actor's Issues tab.
