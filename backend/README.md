# Brain backend (Supabase edge functions)

The server side of the pages in this repo (`brief.html`, `act.html`, `gems.html`). Each folder is one Supabase
edge function, written for Deno. This is a **backup and a place to read the code**, not something GitHub Pages runs.
Functions are deployed to the Brain's Supabase project by pasting the files in (dashboard or MCP) or with the CLI.

## What each function does

| Folder | What it does | Files |
|---|---|---|
| `morning-brief` | The 5:30 AM brief: picks and ranks the day, emails it, and serves the brief page its data (check off, add, move, snooze, Drop filtering) | `index.ts` |
| `brief-pastdue` | The "Past due" review on the brief: keep, snooze, drop, undo | `index.ts` |
| `brief-markets` | The Markets cards: TSP brief, Hard Asset brief, RSOTC card, and the "by bet" view | `index.ts`, `board.ts`, `bets.ts`, `parse.ts` |
| `brief-fromdoreen` | The "From Doreen" hand-off lane (accept, push back, done) | `index.ts`, `handoff.ts` |
| `brief-videos` | Saved-videos card: turns what he watched into tasks and filing suggestions | `index.ts` |
| `brief-ask` | The "Ask the Brain" box on the brief | `index.ts` |
| `brief-lanes` | The Calm view: projects with gates, quick wins, thank-yous, coming up, categories, Sunday view | `index.ts`, `lanes.ts`, `focus.ts` |
| `brief-focus` | Pinned and Your day (focus) cards | `index.ts`, `focus.ts` |
| `hn-gems` | Hacker News "Overlooked gems" tool behind `gems.html` | `index.ts`, `hn.ts`, `search.ts`, `taste.ts`, `topics.ts` |
| `rsotc-act` | The Act page: RSOTC setups, size, ETF stand-ins | `index.ts`, `quotes.ts`, `size.ts`, `vehicles.ts` |
| `rsotc-ladders` | Small helper for Act: Randy's stop/entry/T1-T3 line and the date he first called each setup | `index.ts` |

All of them are `verify_jwt = false` and check a `?key=` value against the `BRIEF_PAGE_KEY` secret instead.

## Secrets and settings

No secrets are in this repo. They live in Supabase, under the project's function secrets:

- everywhere: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BRIEF_PAGE_KEY` (optional `BRIEF_OWNER`, default `dave`)
- AI calls (`morning-brief`, `brief-ask`, `brief-videos`): `ANTHROPIC_API_KEY`, `BRIEF_MODEL`, `ASK_MODEL`, `OPENROUTER_API_KEY`
- `morning-brief` only: `BRIEF_TO`, `BRIEF_PAGE_URL`, `BRIEF_TRIGGER_KEY`, `RECAP_TRIGGER_KEY`, `GCAL_ICS_URL`, `JEV_API_KEY`, `JEV_API_URL`, `JEV_MODEL`, `POSTMARK_SERVER_TOKEN`
- `brief-markets` only: `DIDS_ADMIN_URL`

## Differences from what is deployed

Four lines were changed or blanked here because this repo is public. The deployed functions keep the real values.

1. `brief-markets/index.ts`: the default for `DIDS_ADMIN_URL` is empty (the real admin link is a private URL).
2. `morning-brief/index.ts`: the default for `BRIEF_TO` is empty (the deployed copy has the real address as its default).
3. `brief-lanes/lanes.ts`: the category guess for "health" uses a short generic word list. The deployed one also has condition-specific words.
4. `brief-videos/index.ts`: the `PROFILE` paragraph that tells the AI about the owner and his projects is replaced by a placeholder.

Also, a few deployed functions carry shorter header comments than the files here (the code is the same): `brief-lanes`
(which also bundles a trimmed `focus.ts` with only the helpers it uses) and `rsotc-ladders`. `morning-brief` was
byte-identical to the deployed copy (v37) before the changes above.

## Deploying

With the Supabase CLI, from this folder: `supabase functions deploy <folder> --no-verify-jwt --project-ref <your project ref>`.
Without it: paste each file of the folder into a function with the same name in the dashboard (the entry point is `index.ts`).
Put the real values back for the four lines above first, or set the secrets and let the code read them.

## Not here

- The database: tables and SQL functions these use (`thoughts`, `market_briefs`, `brief_state`, `rsotc_setups`, `rsotc_posts`, `rsotc_my_trades`,
  `hn_gems`, `act_plans`, `act_settings`, `daily_briefs`, `fitness_logs`, `video_digest`, `youtube_videos`; functions `rsotc_board`, `rsotc_act_extras`,
  `rsotc_act_etf_ladders`, `match_thoughts`) live in Supabase and are not dumped here.
- The test suites and real-data fixtures (they hold real task and trade rows).
- Older, unrelated functions in the same project (`open-brain-mcp`, `notes-api`, the transcript and video ones, and so on).
- Two temporary test copies, `brief-focus-test` and `brief-lanes-test`. They were deleted from Supabase on Nov 23, 2026.
- `brain-priorities` and `quick-capture` (the old Priorities and Capture pages' functions) were also deleted from Supabase on Nov 23, 2026, after the two pages were removed. Their source was not kept here.
