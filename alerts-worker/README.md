# Scoreline alerts server

A small Cloudflare Worker (free plan) that sends push notifications when a team
you follow scores, or when its game starts or ends, even with the app closed.

- Every minute it checks ESPN for games involving followed teams, and looks again
  30 seconds later while one of those games is on.
- It signs and encrypts Web Push messages itself (`src/push.js`); no libraries.
- Its push signing keys are made on first run and kept in its database, not in this repo.
- State lives in a D1 database (`schema.sql`): sign-ups, last seen scores, settings.

## One-time setup

1. Create a free account at https://dash.cloudflare.com/sign-up.
2. Open **Workers & Pages** in the dashboard once, so Cloudflare sets up your
   `workers.dev` subdomain. Note the **Account ID** shown there.
3. **My Profile → API Tokens → Create Token**, use the **Edit Cloudflare Workers**
   template, add the permission **Account · D1 · Edit**, then create it and copy the token.
4. In this GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**,
   add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. Run the **Deploy alerts server** workflow (or push a change under `alerts-worker/`).
   It creates the database, sets up the tables and deploys.
6. Put the Worker's address (`https://scoreline-alerts.<subdomain>.workers.dev`) in
   `scores/config.js` as `alertsServer`.

## Endpoints

- `GET /vapid`: the public key browsers subscribe with
- `POST /subscribe`: `{ subscription, teams: [{ league, id }], reminders: [{ league, id, date }], settings: { start, scores, close, redzone, finals, live, quiet: { from, to }, tz } }`
- `POST /unsubscribe`: `{ endpoint }`
- `POST /test`: `{ endpoint }`, sends a test alert
- `GET /logo?src=`: an espncdn.com team logo, served so the app can draw it into share pictures
