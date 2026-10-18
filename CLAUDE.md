# Project notes

Personal projects for cjmaster556. The main one is **Scoreline**, an Apple Sports–style live scores app.
Everything is developed on branch `ccr-c573c5ba-jzz2cp`; GitHub Pages serves that branch.

- `scores/`: Scoreline web app (installable PWA). Live at https://cjmaster556.github.io/Default-/scores/
- `alerts-worker/`: Cloudflare Worker for push alerts plus data pass-through. Live at https://scoreline-alerts.cjmaster556.workers.dev
- `nfl-tracker/`: the first, NFL-only version. Still works; superseded by `scores/`.
- `chore-tracker/`: unrelated chore app.

The user follows along on an Android phone, sends screenshots, and compares against Apple Sports.
Keep explanations non-technical.

## Scoreline app (`scores/`)

Plain HTML/CSS/JS, no build step. `app.js` is one IIFE (about 3,000 lines), organized in `// ----------` sections.

- **Data**: ESPN's unofficial site API (`site.api.espn.com`), called from the browser for scoreboards and game summaries.
  Standings, news, rankings and teams go through the Worker (`/espn/...`), because some ESPN feeds fail from the phone's browser.
- **Leagues**: `LEAGUES` (nfl, cfb with `groups=80`, nba, wnba, mlb, nhl). Football is week-based; the others are day-based.
- **Tabs**: Scores | Standings | Highlights | News (bottom bar). Routing uses the hash: `#nfl` for scores, `#standings/nhl`, `#news/home`.
- **Game sheet**: Apple-style hero (team-color split gradient from `vividColor`), Stats / Highlights / Plays / Standings tabs,
  odds (summary `pickcenter`), team stat bars, box score (`boxscore.players`), Watch buttons, swipe between games.
- **Highlights**: ESPN summary `videos` are mp4 clips that play in-app. They arrive after games end, and there are none for Prime Video (TNF) games.
  League YouTube videos come from the Worker. The NFL blocks YouTube embedding, so `noEmbed.nfl` makes NFL videos open in YouTube.
  Other leagues play through the YouTube IFrame API; error 101/150 marks that league as no-embed.
- **Watch buttons**: map ESPN broadcast names to apps. On Android they use `intent://` links with the app package and a
  web fallback; ESPN uses `sportscenter://`. Chrome only opens apps through links the app registered.
- **Game clock** (the most-tuned part; see `// ---------- game clock ----------`):
  - ESPN's NFL `displayClock` is the clock at the snap of the last logged play, published 30 seconds to 2 minutes late (measured via play `wallclock`).
  - The user chose to keep a **ticking estimate** for football. Rules: run locally from the last change; ignore readings older than ones
    already seen (scoreboard and summary disagree); learn each game's ESPN update gap; stop on whistle plays (`STOP_PLAYS`) and period breaks
    (`PERIOD_BREAK`); on the first look, guess running from the last play (capped at `HOLD_MAX`); never jump back up for overshoots of
    8 seconds or less (hold instead); a new period waits for the clock to move.
  - Add `?debug` to the URL to show what the clock logic sees.
- **Alerts**: the bell subscribes to Web Push through the Worker (`config.js` has the server URL), with in-app notifications as a fallback.
- **Service worker** (`sw.js`): network-first with `cache: "no-cache"`. **Bump `CACHE` (scoreline-vN) with each release.**
  The app reloads itself when a new version takes over.
- **Demo mode**: `?demo` uses `demo.js` sample data shaped like the real feeds. Use it for local testing, because this sandbox can't reach ESPN or YouTube.

## Alerts server (`alerts-worker/`)

Cloudflare Worker on the free plan, with a D1 database (`schema.sql`: subs, games, config, videos). Its cron runs every minute.

- Push alerts: followed team scores, game start, final. A second pass runs 28 seconds later while a game is live. Web Push is hand-rolled (`src/push.js`, WebCrypto).
  VAPID keys are generated on first run and stored in D1.
- `/espn/...` passes through allowed ESPN feeds. `/videos?league=` serves league YouTube videos, with channel IDs resolved from handles and cached.
  Videos are saved for 3 days because the RSS feed only holds 15.
- `/nhl/...` and `/nba/...` pass through the leagues' own live feeds (in progress, see below), with an `X-Data-Age` header.
- **Deploys**: `.github/workflows/alerts-worker.yml` runs on any push touching `alerts-worker/` or the workflow (Node 22, wrangler 4.145.0).
  Secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set.
  The **"Check the live server"** step logs real ESPN, YouTube, NHL and NBA data shapes, and is the way to see live data, because this sandbox can't reach those hosts.
  Read it with the GitHub MCP tools (actions_list, then get_job_logs).

## Testing

- Serve locally with `python3 -m http.server 8766` from the repo root, run in the background (sandbox resets kill `&` jobs).
- Use Playwright with `executablePath: '/opt/pw-browsers/chromium'`. Save screenshots to the scratchpad, never the repo, because the stop hook flags untracked files.
- Simulate ESPN with `page.route('https://site.api.espn.com/**', ...)` for clock tests.

## In progress / ideas

- **NHL and NBA clocks from the leagues' own feeds** (user approved; football stays on the ESPN ticking estimate).
  The NHL feed (`api-web.nhle.com/v1/score/now`) has a clock with running/intermission flags. The NBA uses `cdn.nba.com` liveData.
  Match games to ESPN events by team abbreviation.
- Ideas the user hasn't asked for yet: game-start reminders, choosing which alerts to get, moving the app to the main branch.
