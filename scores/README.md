# Scoreline

Live scores for the NFL, college football, NBA, WNBA, MLB and NHL, in the style of Apple Sports. It's a static web app that you can install on Android (or any phone or desktop) from the browser. There's no build step or API key.

- **My Teams:** follow teams across leagues. Their live games, today's results and next games show up together.
- **League views:** browse by week (football) or by day (everything else), with a shortcut to the next day that has games.
- **Live details:** running game clocks; football down and distance, red zone and a field graphic; baseball bases, count, outs and the pitcher/batter matchup; last play.
- **Game sheet:** tap a game for the line score, scoring plays, drives or latest plays, leaders, team stats and game info.
- **Score alerts:** tap the bell to get a notification when a team you follow scores, when its game starts and when it ends. Alerts work while the app is open or recently in the background; there is no push server.
- **Auto-refresh:** every 10s while games are live, every minute near start time, every 5 minutes otherwise. It pauses while the app is in the background.

Scores come from ESPN's public site API, called from the browser.

## Install on Android

Open the GitHub Pages link in Chrome, then tap **Install** in the app's header (or ⋮ → **Add to Home screen**).

## Run locally

    python3 -m http.server --directory scores 8000

Then open http://localhost:8000. Add `?demo` to see sample games in every league.
