# PLAYGO (self-hosted)

Docker setup for [PLAYGO Web IPTV Player](https://github.com/Jeremias0618/PLAYGO-Web-IPTV-Player),
a PHP web player for Xtream Codes / Xtream UI IPTV services. The image pulls upstream at a pinned
commit, and the settings come from `.env`, so you never edit PHP.

> Upstream marks this PHP version as legacy and no longer maintained. Its license is CC BY-NC
> (personal, non-commercial use).

## What you need

- A machine that stays on with Docker installed (home server, NAS, Raspberry Pi 4+, VPS)
- An IPTV subscription that gives you an **Xtream Codes** server URL, username and password
- Optional: a free [TMDB API key](https://www.themoviedb.org/settings/api) for posters and descriptions

## Run it

```bash
git clone <this repo> && cd <repo>/playgo
cp .env.example .env
nano .env            # set XTREAM_URL (with http:// and port) and TMDB_API_KEY
docker compose up -d --build
```

Open `http://<machine-ip>:8080` and sign in with your **IPTV provider's** username and password.
PLAYGO has no separate accounts.

Playlists, history and watch progress are kept in Docker volumes, so they survive rebuilds.

## Update / change settings

- Settings changed in `.env`: `docker compose up -d`
- Newer upstream code: change `PLAYGO_REF` in the `Dockerfile` (or `--build-arg PLAYGO_REF=main`), then `docker compose up -d --build`

## Security notes

- The app stores your IPTV password **in a plain browser cookie** and talks to your provider over
  whatever scheme `XTREAM_URL` uses. Keep it on your LAN, or put it behind HTTPS and an auth layer
  (a reverse proxy, Tailscale, Cloudflare Access) before you expose it to the internet.
- Streams play straight from the provider's server in your browser. If your provider only serves
  `http://` and you load PLAYGO over `https://`, the browser may block the video (mixed content).
