// Scoreline alerts server. Every minute it checks ESPN for games involving
// the teams people follow and sends a push notification when one of those
// teams scores, or when their game starts or ends, so alerts arrive with the
// app closed. It also fetches standings, news and league highlight videos
// for the app, which browsers can't always load from ESPN and YouTube directly.

import { generateVapidKeys, sendPush } from "./push.js";

const LEAGUES = {
  nfl: { path: "football/nfl" },
  cfb: { path: "football/college-football", params: { groups: "80" } },
  nba: { path: "basketball/nba" },
  wnba: { path: "basketball/wnba" },
  mlb: { path: "baseball/mlb" },
  nhl: { path: "hockey/nhl" },
};

const SUBJECT = "https://cjmaster556.github.io/Default-/scores/";

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      const res = await route(request, env);
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    } catch (err) {
      return json({ error: err.message || "Something went wrong" }, 400, headers);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },
};

// ---------- HTTP ----------

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-Data-Age",
    Vary: "Origin",
  };
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return new Response("Scoreline alerts server is running.\n", { headers: { "Content-Type": "text/plain" } });
  }
  if (request.method === "GET" && url.pathname === "/vapid") {
    const keys = await vapidKeys(env);
    return json({ publicKey: keys.publicKey });
  }
  if (request.method === "GET" && url.pathname.startsWith("/espn/")) return proxyEspn(url);
  if (request.method === "GET" && /^\/(nhl|nba)\//.test(url.pathname)) return proxyLeague(url);
  if (request.method === "GET" && url.pathname === "/videos") return videos(env, url.searchParams.get("league"));
  if (request.method !== "POST") return json({ error: "Not found" }, 404);

  const body = await request.json();
  if (url.pathname === "/subscribe") return subscribe(env, body);
  if (url.pathname === "/unsubscribe") {
    await env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(checkEndpoint(body.endpoint)).run();
    return json({ ok: true });
  }
  if (url.pathname === "/test") return sendTest(env, body);
  return json({ error: "Not found" }, 404);
}

function checkEndpoint(endpoint) {
  const u = new URL(String(endpoint || ""));
  if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) throw new Error("Push endpoint must be https");
  return u.href;
}

async function subscribe(env, body) {
  const sub = body.subscription || {};
  const endpoint = checkEndpoint(sub.endpoint);
  const p256dh = String(sub.keys?.p256dh || "");
  const auth = String(sub.keys?.auth || "");
  if (!/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth)) throw new Error("Subscription keys are missing");
  const teams = (Array.isArray(body.teams) ? body.teams : [])
    .slice(0, 200)
    .filter((t) => LEAGUES[t?.league] && /^\w+$/.test(String(t.id)))
    .map((t) => ({ key: `${t.league}:${t.id}`, league: t.league, id: String(t.id) }));
  await env.DB.prepare(
    `INSERT INTO subs (endpoint, p256dh, auth, teams, created) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, teams = excluded.teams`
  )
    .bind(endpoint, p256dh, auth, JSON.stringify(teams), Date.now())
    .run();
  return json({ ok: true, teams: teams.length });
}

async function sendTest(env, body) {
  const endpoint = checkEndpoint(body.endpoint);
  const sub = await env.DB.prepare("SELECT endpoint, p256dh, auth, teams FROM subs WHERE endpoint = ?").bind(endpoint).first();
  if (!sub) throw new Error("Not subscribed");
  const count = JSON.parse(sub.teams || "[]").length;
  const status = await deliver(env, sub, {
    title: "Score alerts are on",
    body: count
      ? `You'll get alerts for your ${count} team${count === 1 ? "" : "s"}, even when the app is closed.`
      : "Follow some teams to start getting alerts.",
    tag: "scoreline-test",
    url: SUBJECT,
  });
  return json({ ok: status < 300, status });
}

// ---------- ESPN pass-through ----------

// Only the read-only ESPN feeds the app uses, with how long browsers may reuse each.
const ESPN_FEEDS = [
  { re: /^\/apis\/v2\/sports\/[a-z-]+\/[a-z-]+\/standings$/, ttl: 300 },
  { re: /^\/apis\/site\/v2\/sports\/[a-z-]+\/[a-z-]+\/(news|rankings)$/, ttl: 300 },
  { re: /^\/apis\/site\/v2\/sports\/[a-z-]+\/[a-z-]+\/teams$/, ttl: 3600 },
];

async function proxyEspn(url) {
  const path = url.pathname.slice("/espn".length);
  const feed = ESPN_FEEDS.find((f) => f.re.test(path));
  if (!feed || url.search.length > 300) return json({ error: "Not an allowed ESPN feed" }, 404);
  const res = await fetch(`https://site.api.espn.com${path}${url.search}`, { headers: { "User-Agent": "Scoreline" } });
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${feed.ttl}` },
  });
}

// ---------- league clock feeds ----------

// The NHL's and NBA's own live feeds carry a better game clock than ESPN's
// (the NHL's says whether it's running). Browsers can't read them directly.
const LEAGUE_FEEDS = {
  nhl: { origin: "https://api-web.nhle.com", re: /^\/v1\/(score\/now|score\/\d{4}-\d{2}-\d{2}|gamecenter\/\d+\/(landing|play-by-play))$/ },
  nba: {
    origin: "https://cdn.nba.com",
    re: /^\/static\/json\/liveData\/(scoreboard\/todaysScoreboard_00|playbyplay\/playbyplay_\d+|boxscore\/boxscore_\d+)\.json$/,
    headers: { Referer: "https://www.nba.com/", Origin: "https://www.nba.com" },
  },
};

async function proxyLeague(url) {
  const [, league, ...rest] = url.pathname.split("/");
  const feed = LEAGUE_FEEDS[league];
  const path = `/${rest.join("/")}`;
  if (!feed || !feed.re.test(path)) return json({ error: "Not an allowed feed" }, 404);
  const res = await fetch(`${feed.origin}${path}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Scoreline)", Accept: "application/json", ...(feed.headers || {}) },
  });
  // How old the league's cached copy is, so the app can run the clock from the right moment.
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Data-Age": res.headers.get("age") || "0" },
  });
}

// ---------- highlight videos ----------

// Each league's official YouTube channel, by handle; the channel ID is looked up once and kept.
const CHANNELS = { nfl: "@NFL", nba: "@NBA", wnba: "@WNBA", mlb: "@MLB", nhl: "@NHL", cfb: "@espncfb" };

const decodeXml = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

async function channelId(env, league) {
  const handle = CHANNELS[league];
  const key = `yt:${handle}`;
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = ?").bind(key).first();
  if (row) return row.v;
  const page = await (await fetch(`https://www.youtube.com/${handle}`, { headers: { "Accept-Language": "en-US" } })).text();
  const m = page.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) || page.match(/"channelId":"(UC[\w-]{22})"/);
  if (!m) throw new Error(`Couldn't find the ${handle} channel`);
  await env.DB.prepare("INSERT OR REPLACE INTO config (k, v) VALUES (?, ?)").bind(key, m[1]).run();
  return m[1];
}

// YouTube's feed only lists a channel's newest 15 videos, which on a busy
// Sunday is under an hour. Save every video we see for a few days so a game's
// highlights stay findable after newer videos push them off the feed.
const KEEP_VIDEOS_MS = 3 * 86400000;

async function refreshVideos(env, league) {
  const id = await channelId(env, league);
  const xml = await (await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`)).text();
  const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, e]) => {
      const pick = (re) => decodeXml((e.match(re) || [])[1] || "");
      return {
        id: pick(/<yt:videoId>([^<]+)<\/yt:videoId>/),
        title: pick(/<title>([\s\S]*?)<\/title>/),
        published: pick(/<published>([^<]+)<\/published>/),
        thumbnail: pick(/<media:thumbnail url="([^"]+)"/),
      };
    })
    .filter((v) => v.id);
  if (items.length) {
    // Only new videos are written; ones already saved are skipped.
    await env.DB.batch(
      items.map((v) =>
        env.DB.prepare("INSERT OR IGNORE INTO videos (id, league, title, published, thumbnail) VALUES (?, ?, ?, ?, ?)").bind(v.id, league, v.title, v.published, v.thumbnail)
      )
    );
  }
}

async function videos(env, league) {
  if (!CHANNELS[league]) return json({ error: "Unknown league" }, 404);
  try {
    await refreshVideos(env, league);
  } catch {
    /* serve what's saved */
  }
  const since = new Date(Date.now() - KEEP_VIDEOS_MS).toISOString();
  const rows = await env.DB.prepare("SELECT id, title, published, thumbnail FROM videos WHERE league = ? AND published >= ? ORDER BY published DESC LIMIT 80")
    .bind(league, since)
    .all();
  return new Response(JSON.stringify({ league, channel: CHANNELS[league], items: rows.results || [] }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}

// ---------- keys and delivery ----------

async function vapidKeys(env) {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'vapid'").first();
  if (row) return JSON.parse(row.v);
  // First run: make this server's own key pair. It stays in the database, never in the code.
  const keys = await generateVapidKeys();
  await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('vapid', ?)").bind(JSON.stringify(keys)).run();
  const saved = await env.DB.prepare("SELECT v FROM config WHERE k = 'vapid'").first();
  return JSON.parse(saved.v);
}

async function deliver(env, sub, message) {
  let status;
  try {
    status = await sendPush(sub, message, await vapidKeys(env), SUBJECT);
  } catch {
    return 0;
  }
  // The browser dropped this subscription (app uninstalled, notifications reset).
  if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(sub.endpoint).run();
  return status;
}

// ---------- watching games ----------

async function runChecks(env) {
  const busy = await checkOnce(env);
  // While one of your teams is playing, look again half a minute later so
  // alerts arrive within about 30 seconds instead of a minute.
  if (busy) {
    await new Promise((r) => setTimeout(r, Number(env.SECOND_PASS_MS ?? 28000)));
    await checkOnce(env);
  }
  await env.DB.prepare("DELETE FROM games WHERE updated < ?").bind(Date.now() - 3 * 86400000).run();
  // Every five minutes, save any new league videos, and drop old ones.
  if (new Date().getUTCMinutes() % 5 === 0) {
    await Promise.allSettled(Object.keys(CHANNELS).map((league) => refreshVideos(env, league)));
    await env.DB.prepare("DELETE FROM videos WHERE published < ?").bind(new Date(Date.now() - KEEP_VIDEOS_MS).toISOString()).run();
  }
}

function scoreboardURL(env, league) {
  const l = LEAGUES[league];
  const params = new URLSearchParams(l.params || {});
  params.set("limit", "300");
  const base = env.ESPN_BASE || "https://site.api.espn.com/apis/site/v2/sports";
  return `${base}/${l.path}/scoreboard?${params}`;
}

function sides(comp) {
  const list = comp?.competitors || [];
  return { away: list.find((c) => c.homeAway === "away") || list[0], home: list.find((c) => c.homeAway === "home") || list[1] };
}

const num = (v) => Number(typeof v === "object" ? v?.value : v) || 0;
const teamName = (c) => c?.team?.shortDisplayName || c?.team?.abbreviation || "";

async function checkOnce(env) {
  const subs = (await env.DB.prepare("SELECT endpoint, p256dh, auth, teams FROM subs").all()).results || [];
  if (!subs.length) return false;
  for (const s of subs) s.follows = new Set(JSON.parse(s.teams || "[]").map((t) => t.key));
  const leagues = new Set(subs.flatMap((s) => [...s.follows].map((k) => k.split(":")[0])).filter((l) => LEAGUES[l]));
  const known = new Map(((await env.DB.prepare("SELECT key, a, h, st FROM games").all()).results || []).map((g) => [g.key, g]));

  let busy = false;
  const sends = [];
  const writes = [];
  const now = Date.now();

  const boards = await Promise.all(
    [...leagues].map(async (league) => {
      try {
        const res = await fetch(scoreboardURL(env, league), { headers: { "User-Agent": "Scoreline alerts" } });
        return res.ok ? [league, await res.json()] : null;
      } catch {
        return null;
      }
    })
  );

  for (const entry of boards) {
    if (!entry) continue;
    const [league, data] = entry;
    for (const ev of data.events || []) {
      const comp = ev.competitions?.[0];
      const { away, home } = sides(comp);
      if (!away?.team || !home?.team) continue;
      const ka = `${league}:${away.team.id}`;
      const kh = `${league}:${home.team.id}`;
      const followers = subs.filter((s) => s.follows.has(ka) || s.follows.has(kh));
      if (!followers.length) continue;

      const st = ev.status?.type?.state || "pre";
      if (st === "in" || (st === "pre" && new Date(ev.date).getTime() - now < 10 * 60000)) busy = true;
      const cur = { a: num(away.score), h: num(home.score), st };
      const key = `${league}:${ev.id}`;
      const prev = known.get(key);
      if (prev && prev.a === cur.a && prev.h === cur.h && prev.st === cur.st) continue;
      writes.push(
        env.DB.prepare(
          `INSERT INTO games (key, a, h, st, updated) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET a = excluded.a, h = excluded.h, st = excluded.st, updated = excluded.updated`
        ).bind(key, cur.a, cur.h, cur.st, now)
      );
      known.set(key, { key, ...cur });
      // The first look at a game only sets the baseline.
      if (!prev) continue;

      const line = `${away.team.abbreviation} ${cur.a} – ${cur.h} ${home.team.abbreviation}`;
      const status = ev.status?.type?.shortDetail || "";
      const url = `${SUBJECT}#${league}`;
      const messages = [];
      if (prev.st === "pre" && cur.st === "in") {
        messages.push({ to: [ka, kh], title: `${teamName(away)} at ${teamName(home)} has started`, body: status });
      }
      for (const [c, k, before, after] of [
        [away, ka, prev.a, cur.a],
        [home, kh, prev.h, cur.h],
      ]) {
        if (after > before && cur.st !== "post") {
          const last = comp.situation?.lastPlay?.text;
          messages.push({ to: [k], title: `${teamName(c)} score!`, body: [`${line} · ${status}`, last].filter(Boolean).join("\n") });
        }
      }
      if (prev.st !== "post" && cur.st === "post") {
        const winner = comp.competitors?.find((c) => c.winner);
        messages.push({ to: [ka, kh], title: winner ? `Final: ${teamName(winner)} win` : "Final", body: line });
      }
      for (const m of messages) {
        for (const s of followers) {
          if (m.to.some((k) => s.follows.has(k))) sends.push(deliver(env, s, { title: m.title, body: m.body, tag: key, url }));
        }
      }
    }
  }

  if (writes.length) await env.DB.batch(writes);
  await Promise.all(sends);
  return busy;
}
