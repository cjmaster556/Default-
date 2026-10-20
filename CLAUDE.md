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
  Swiping sideways on the page moves between the top chips (`swipeChip`): the page follows the finger, vertical scroll is locked once a
  swipe is sideways (non-passive touchmove), and it slides off/on. `overscroll-behavior-x: none` stops Chrome's swipe-back.
  `#nfl/401…` (notification links) opens that game after the league loads (`pendingGame`).
- **Game sheet**: Apple-style hero (team-color split gradient from `vividColor`), Stats / Highlights / Plays / Standings tabs,
  odds (summary `pickcenter`), team stat bars, box score (`boxscore.players`), Watch buttons, swipe between games.
- **Highlights**: ESPN summary `videos` are mp4 clips that play in-app. They arrive after games end, and there are none for Prime Video (TNF) games.
  League YouTube videos come from the Worker. The NFL blocks YouTube embedding, so `noEmbed.nfl` makes NFL videos open in YouTube.
  Other leagues play through the YouTube IFrame API; error 101/150 marks that league as no-embed.
- **Rotation**: the manifest allows any orientation (it was locked to portrait, which blocked sideways video). Turning the phone
  sideways with a video open makes the player fill the screen (CSS, landscape media query); a player's own full-screen button also
  locks landscape (`fullscreenchange` + `screen.orientation.lock`). An installed app picks up manifest changes only when Chrome
  refreshes it (can take a day or so).
- **Watch buttons**: map ESPN broadcast names to apps. On Android they use `intent://` links with the app package and a
  web fallback. Chrome only opens apps through links the app registered. `sportscenter://` (ESPN) fell back to the website on the
  user's phone, so ESPN now asks the app to open the game's espn.com page (`espnGamePage`); unverified whether the app takes it.
- **Game clock** (the most-tuned part; see `// ---------- game clock ----------`):
  - ESPN's NFL `displayClock` is the clock at the snap of the last logged play, published 30 seconds to 2 minutes late (measured via play `wallclock`).
  - The user chose to keep a **ticking estimate** for football. Rules: run locally from the last change; ignore readings older than ones
    already seen (scoreboard and summary disagree); learn each game's ESPN update gap; stop on whistle plays (`STOP_PLAYS`) and period breaks
    (`PERIOD_BREAK`); on the first look, guess running from the last play (capped at `HOLD_MAX`); never jump back up for overshoots of
    8 seconds or less (hold instead); a new period waits for the clock to move.
  - Add `?debug` to the URL to show what the clock logic sees.
- **Alerts**: the bell opens the Alerts sheet (`renderAlertSettings`). Its switch subscribes to Web Push through the Worker
  (`config.js` has the server URL), with in-app notifications as a fallback. Settings (`scoreline.alertSettings`): start, scores
  (all / close / off), close finishes, red zone, finals, live score notification, quiet hours. Reminders (`scoreline.reminders`)
  come from the bell on upcoming game cards and the "Remind me" button in the game hero. `syncPush` sends teams, settings
  (with the phone's time zone) and reminders to `/subscribe`.
- **Team pages** (`openTeam`): any element with `teamLink(league, team)` attributes (`data-team-page`) opens one: game hero logo/name,
  standings and playoff rows, bracket teams. Schedule, roster (football is grouped), team news (filtered by category teamId), highlights.
  Schedule rows open the game via `openGameById`, which builds an event from the summary `header` when it isn't on a loaded
  scoreboard (kept in `state.extraEvents`); notification links use it too. Opening a game from a team page re-raises the game sheet.
- **Win probability** (`winProbCard`): summary `winprobability` (`homeWinPercentage` per `playId`); periods come from play ids in drives/plays.
- **Playoffs** (Standings → Playoffs): `PLAYOFF_SPOTS` cut lines for the seeding race; bracket from postseason scoreboards.
  ESPN's scoreboard rejects day ranges but takes whole months (`dates=202610`) or single days, so `postseasonMonths` fetches each.
  With a month, ESPN ignores `seasontype=3` and caps at 300 games, so events are filtered on `season.type === 3`, and MLB's
  late-September Wild Card days are fetched one by one (September is mostly regular season).
  Round names come from `notes[0].headline` (series.title is just "Playoff Series"); "If Necessary" placeholder games and TBD teams are skipped.
- **Golf** (PGA, LPGA; `isGolf`, mode "event"): one tournament per scoreboard; the calendar lists the season's tournaments
  (toolbar select; `goToTournament` asks for `dates=` a day inside one; verified, `event=` is ignored by ESPN). Competitors are golfers
  (`c.id`, `c.athlete`, `c.score` to par, `c.order`, `c.linescores` per round, holes inside during play). `golfField` computes ties,
  today and thru. `golfCard` shows the top 5 plus followed golfers; the game sheet becomes a leaderboard (`renderGolfDetail`),
  tap a golfer for rounds and holes, and follow them there or in the picker (`fetchGolfers`: this week's field plus recent weeks').
  Followed golfers are pinned in a "Your golfers" section atop the leaderboard. Share uses `golfShareCard` (top 5 + yours).
  Golf standings via the Worker's `/golf-rankings?league=`: PGA = the Official World Golf Ranking (OWGR's public API; its
  `gender=F` is ignored, so no women's list there). LPGA = ESPN core-API season standings sorted by points. That service
  answers 403 to Cloudflare, so `.github/workflows/golf-standings.yml` (daily) builds the top 40 with names and stores it in
  D1 config `lpga-race`, which `lpgaRace` serves.
  Switching tabs from a league's scores opens the new tab on that league (`setTab`). Server: `golfAlerts` (followed golfer takes, ties, or goes clear in the lead; final
  result), with `golfCardData` so the service worker draws a mini leaderboard picture (`drawGolfCard`).
- **Logos**: `logo()` uses ESPN's dark-background variant (`/500-dark/`, via `darkLogo`) since the app is dark (the Rams' navy logo
  vanished on blue), falling back to the regular logo, then a team-colored dot. The share card and notification pictures do the same.
- **Share card** (`scoreCard`): 1080×1080 canvas in team colors; logos load through the Worker's `/logo` so the canvas can be exported.
- **Service worker** (`sw.js`): network-first with `cache: "no-cache"`. **Bump `CACHE` (scoreline-vN) with each release.**
  The app reloads itself when a new version takes over.
- **Demo mode**: `?demo` uses `demo.js` sample data shaped like the real feeds. Use it for local testing, because this sandbox can't reach ESPN or YouTube.

## Alerts server (`alerts-worker/`)

Cloudflare Worker on the free plan, with a D1 database (`schema.sql`: subs, games, config, videos, prefs, gamex). Its cron runs every minute.
`schema.sql` only uses CREATE IF NOT EXISTS, so new columns need a new table (that's why prefs and gamex exist).

- Push alerts follow each phone's settings (`prefs` table, `cleanSettings`): start, scores (basketball sends quarter summaries instead
  of every basket), close finishes (`isLateClose`), red zone, finals, quiet hours (`isQuiet`, in the phone's time zone), reminders (start alert).
  The live score notification is a silent push with the game's tag, sent when the status line changes, so it updates in place; alerts use
  the same tag and replace it. Every game push carries `card` (`scoreCardData`): the service worker draws a Google-style scoreboard
  picture from it (`drawCard`, OffscreenCanvas, logos via `/logo`, cached in the `scoreline-logos` cache) and sets it as the
  notification `image` (shown only when expanded; Android's rule). Collapsed, the `icon` is a square of both logos (`drawIcon`).
  The status bar `badge` must be white-on-transparent (`icons/badge-96.png`); Android uses only its shape, so an opaque icon shows as a white box.
  Phones report to `/diag` (latest 20, printed by the deploy check): test alerts, failed pictures, and once per service worker version.
  The service worker calls `registration.update()` on each push, but a phone may still need the app opened once to pick up a new version.
  The card's bottom line falls back to the venue; "END QUARTER n" style last plays are left out of the text. `sw.js` loads `config.js` (which sets `self.SCORELINE_CONFIG`) for the server URL. `gamex` remembers per-game status line, period, red zone and the close-game flag. A second pass runs 28 seconds later while a game is live. Web Push is hand-rolled (`src/push.js`, WebCrypto).
  VAPID keys are generated on first run and stored in D1.
- `/espn/...` passes through allowed ESPN feeds (including team schedule/roster). `/logo?src=` proxies espncdn.com logos with CORS for the share card. `/videos?league=` serves league YouTube videos, with channel IDs resolved from handles and cached.
  Videos are saved for 3 days because the RSS feed only holds 15.
- `/nhl/...` and `/nba/...` pass through the leagues' own live feeds (`api-web.nhle.com/v1/score/now`, `cdn.nba.com` liveData scoreboard), with an `X-Data-Age` header.
- **Deploys**: `.github/workflows/alerts-worker.yml` runs on any push touching `alerts-worker/` or the workflow (Node 22, wrangler 4.145.0).
  Secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set.
  The **"Check the live server"** step logs real ESPN, YouTube, NHL and NBA data shapes, and is the way to see live data, because this sandbox can't reach those hosts.
  Read it with the GitHub MCP tools (actions_list, then get_job_logs).

## Android app (`android-app/`)

The "middle path" toward an APK (user asked to pace it a little each day): a Capacitor 8 shell that loads the live site
(`server.url` in `capacitor.config.json`), so web changes reach it without a new APK. Native extras get added in `android/`.
- `.github/workflows/android.yml` builds a signed release APK on pushes touching `android-app/` and uploads it to the
  `android-latest` GitHub release (always the same download link). `versionCode` = the run number, so each build updates.
- Signed with `android/app/scoreline.keystore` (password `scoreline`), committed on purpose so updates install over each
  other; fine for a personal sideloaded app, replace it for any Play Store release.
- Alerts in the APK use Firebase Cloud Messaging (Web Push doesn't work in a WebView). Firebase project `scoreline-b9db8`;
  `android/app/google-services.json` (not secret) is committed. `@capacitor/push-notifications` registers; the web app detects
  the native shell (`nativePush()`), signs up with `{ fcm: token }` (stored as endpoint `fcm:<token>`), and creates channels
  "alerts" (buzz) and "live" (quiet). Tapping an alert routes via `pushNotificationActionPerformed`.
  The Worker sends through FCM HTTP v1 (`src/fcm.js`, service-account JWT signed with WebCrypto) using the `FCM_SERVICE_ACCOUNT`
  Worker secret, which the deploy workflow copies from the GitHub secret of the same name. Status bar icon: `ic_stat_scoreline`.
- Back button: `@capacitor/app`'s `backButton` (`setUpBackButton`) leaves full screen, closes the top sheet (opening order tracked
  with a MutationObserver), returns to Scores, then minimizes (confirmed on the phone). Without it the shell's default back exits the app.
- Installing: Chrome's direct download of the APK stalled at 100% (its safety scan); long-pressing scoreline.apk on the
  release page (github.com/cjmaster556/Default-/releases/tag/android-latest) and choosing "Download link" worked.
  The user has the FCM build installed; alerts work in both the APK and the home-screen web app (confirmed with a test alert).
  GitHub's secret scanning flagged the Firebase API key in google-services.json; that key is meant to ship inside apps, so it's fine.
- Plan, in order: 1) shell + build (done), 2) FCM push so alerts work in the APK (done, confirmed on the phone), 3) native live score notification
  (ongoing, custom layout), 4) home screen widget, 5) Watch buttons through native intents.

## Testing

- Serve locally with `python3 -m http.server 8766` from the repo root, run in the background (sandbox resets kill `&` jobs).
- Use Playwright with `executablePath: '/opt/pw-browsers/chromium'`. Save screenshots to the scratchpad, never the repo, because the stop hook flags untracked files.
- Simulate ESPN with `page.route('https://site.api.espn.com/**', ...)` for clock tests.
- Worker logic can be tested locally with `wrangler dev --local --test-scheduled --var ESPN_BASE:http://localhost:9301/sports`,
  a mock ESPN + push endpoint (decrypting with `http_ece`), and `/__scheduled` to run the cron. The scratchpad copy is not kept between sessions.

## In progress / ideas

- **League clocks** (done, see `// ---- league clock feeds`): NHL games use the NHL's clock and its `running`/`inIntermission`
  flags directly (no guessing). NBA games feed the NBA's `gameClock` (ISO, e.g. PT05M32.00S) into the usual rules. Games are matched
  to ESPN events by team code (`LEAGUE_ABBR` fixes differences). Verify against a real NBA game once the season is
  under way; there was no live NBA data to check against when this was built.
- Built from the user's "what could make this better" list: live score notification, reminders, alert settings, team pages,
  win probability, playoffs/brackets, share cards. Not wanted (for now): more leagues, moving to the main branch or a custom domain.
- Unverified on a real phone: the Watch button's ESPN app link, the live score notification's silent updates, sharing the image file.
