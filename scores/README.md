# Scoreline

Live scores for the NFL, college football, NBA, WNBA, MLB and NHL, in the style of Apple Sports. It's a static web app that you can install on Android (or any phone or desktop) from the browser. There's no build step or API key.

- **My Teams:** follow teams across leagues. Their live games, today's results and next games show up together.
- **League views:** browse by week (football) or by day (everything else), with a shortcut to the next day that has games.
- **Live details:** running game clocks; football down and distance, red zone and a field graphic; baseball bases, count, outs and the pitcher/batter matchup; last play.
- **Standings:** division or conference tables for every league, college football's AP and Coaches polls, with your teams highlighted.
- **Playoffs:** the seeding race with the cut line and clinch marks, and a bracket of every series once the postseason starts.
- **Team pages:** tap a team's logo or name (or its standings row) for its schedule and results, roster, news and highlights.
- **Highlights:** the latest videos from each league's official YouTube channel, played right in the app, with your teams' videos first.
- **News:** ESPN headlines per league, or just stories about your teams.
- **Game sheet:** tap a game for the line score, win probability chart, scoring plays, drives or latest plays, leaders, team stats and game info. Share any game as a score card picture in the teams' colors.
- **Score alerts:** tap the bell to choose what you hear about: game starts, every score or close games only, close finishes, red zone trips, finals, quiet hours, and a live score notification that updates in place. Tap the bell on any upcoming game for a reminder when it starts. With the alerts server (`alerts-worker/`) set up, alerts arrive even when the app is closed; otherwise they come while the app is open.
- **Auto-refresh:** every 5s while games are live, every minute near start time, every 5 minutes otherwise. It pauses while the app is in the background.

Scores come from ESPN's public site API, called from the browser.

## Install on Android

Open the GitHub Pages link in Chrome, then tap **Install** in the app's header (or ⋮ → **Add to Home screen**).

## Run locally

    python3 -m http.server --directory scores 8000

Then open http://localhost:8000. Add `?demo` to see sample games in every league.
