# NFL Live

A static web app for following NFL games live. No build step or API key.

- Scoreboard for any week of the season (regular season and playoffs)
- Live game state: score, quarter and clock, possession, down and distance, red zone, timeouts, last play, and a field showing the ball and first-down line
- Auto-refresh: every 10s while games are live, every minute near kickoff, every 5 minutes otherwise; pauses while the tab is hidden
- Scoring changes flash the card
- Tap a game for line score, scoring plays, drives, leaders and team stats
- Star teams to pin their games to the top and filter to them (saved in the browser)

Data comes from ESPN's public scoreboard and summary endpoints, called from the browser.

## Run

Open `index.html` through any static server, e.g.

    python3 -m http.server --directory nfl-tracker 8000

then visit http://localhost:8000. Add `?demo` to the URL to see sample data with a live game in progress.
