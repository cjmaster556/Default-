// Scoreline alerts server. Every minute it checks ESPN for games involving
// the teams people follow (or games they asked to be reminded about) and
// sends push notifications, as each phone's alert settings ask: game starts,
// scores, red zone trips, close finishes, finals, and a live score
// notification that updates in place, so alerts arrive with the app closed. It also fetches standings, news and league highlight videos
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
  if (request.method === "GET" && url.pathname === "/diag") {
    const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'diag'").first();
    return json(row ? JSON.parse(row.v) : []);
  }
  if (request.method === "GET" && url.pathname === "/logo") return logoImage(url.searchParams.get("src"));
  if (request.method !== "POST") return json({ error: "Not found" }, 404);

  const body = await request.json();
  if (url.pathname === "/subscribe") return subscribe(env, body);
  if (url.pathname === "/unsubscribe") {
    await forget(env, checkEndpoint(body.endpoint));
    return json({ ok: true });
  }
  if (url.pathname === "/test") return sendTest(env, body);
  if (url.pathname === "/diag") {
    // Phones report how drawing the notification picture went; keep the latest few.
    const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'diag'").first();
    const list = row ? JSON.parse(row.v) : [];
    list.unshift({ at: new Date().toISOString(), ...Object.fromEntries(Object.entries(body || {}).slice(0, 12).map(([k, v]) => [k, String(v).slice(0, 300)])) });
    await env.DB.prepare("INSERT INTO config (k, v) VALUES ('diag', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(list.slice(0, 20))).run();
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

async function forget(env, endpoint) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(endpoint),
    env.DB.prepare("DELETE FROM prefs WHERE endpoint = ?").bind(endpoint),
  ]);
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
  const reminders = (Array.isArray(body.reminders) ? body.reminders : [])
    .filter((r) => LEAGUES[r?.league] && /^\d+$/.test(String(r.id)) && Date.parse(r.date) > Date.now() - 86400000)
    .slice(0, 100)
    .map((r) => ({ key: `${r.league}:${r.id}`, league: r.league, id: String(r.id), date: new Date(r.date).toISOString() }));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO subs (endpoint, p256dh, auth, teams, created) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, teams = excluded.teams`
    ).bind(endpoint, p256dh, auth, JSON.stringify(teams), Date.now()),
    env.DB.prepare(
      `INSERT INTO prefs (endpoint, settings, reminders) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET settings = excluded.settings, reminders = excluded.reminders`
    ).bind(endpoint, JSON.stringify(cleanSettings(body.settings)), JSON.stringify(reminders)),
  ]);
  return json({ ok: true, teams: teams.length, reminders: reminders.length });
}

// What each phone wants to hear about. Missing values fall back to these.
const DEFAULT_SETTINGS = { start: true, scores: "all", close: true, redzone: false, finals: true, live: false, quiet: null, tz: "UTC" };

function cleanSettings(raw) {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return s;
  for (const k of ["start", "close", "redzone", "finals", "live"]) if (typeof raw[k] === "boolean") s[k] = raw[k];
  if (["all", "close", "off"].includes(raw.scores)) s.scores = raw.scores;
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (raw.quiet && hhmm.test(raw.quiet.from) && hhmm.test(raw.quiet.to)) s.quiet = { from: raw.quiet.from, to: raw.quiet.to };
  try {
    if (typeof raw.tz === "string") {
      new Intl.DateTimeFormat("en-US", { timeZone: raw.tz });
      s.tz = raw.tz;
    }
  } catch {}
  return s;
}

// True during this phone's quiet hours, in its own time zone.
function isQuiet(settings, now = new Date()) {
  const q = settings.quiet;
  if (!q) return false;
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: settings.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return q.from <= q.to ? local >= q.from && local < q.to : local >= q.from || local < q.to;
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
    // A sample scoreboard picture, to check how game alerts will look.
    card: {
      league: "NFL",
      st: "in",
      status: "Q4 · 2:00",
      line: "Bills: 1st & 10 at KC 25",
      rz: false,
      poss: "h",
      a: { abbr: "KC", score: "24", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png", color: "e31837", alt: "ffb612" },
      h: { abbr: "BUF", score: "21", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/buf.png", color: "00338d", alt: "d50a0a" },
    },
  });
  return json({ ok: status < 300, status });
}

// ---------- ESPN pass-through ----------

// Only the read-only ESPN feeds the app uses, with how long browsers may reuse each.
const ESPN_FEEDS = [
  { re: /^\/apis\/v2\/sports\/[a-z-]+\/[a-z-]+\/standings$/, ttl: 300 },
  { re: /^\/apis\/site\/v2\/sports\/[a-z-]+\/[a-z-]+\/(news|rankings)$/, ttl: 300 },
  { re: /^\/apis\/site\/v2\/sports\/[a-z-]+\/[a-z-]+\/teams$/, ttl: 3600 },
  { re: /^\/apis\/site\/v2\/sports\/[a-z-]+\/[a-z-]+\/teams\/\d+(\/schedule|\/roster)?$/, ttl: 600 },
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

// ---------- team logos ----------

// ESPN's logo images don't allow other sites to draw them into a picture, so
// the app's share cards fetch them through here.
async function logoImage(src) {
  let u;
  try {
    u = new URL(src || "");
  } catch {
    return json({ error: "Bad logo address" }, 400);
  }
  if (u.protocol !== "https:" || !/(^|\.)espncdn\.com$/.test(u.hostname)) return json({ error: "Not an ESPN logo" }, 404);
  const res = await fetch(u.href);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("content-type") || "image/png", "Cache-Control": "public, max-age=86400" },
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

async function deliver(env, sub, message, opts) {
  let status;
  try {
    status = await sendPush(sub, message, await vapidKeys(env), SUBJECT, opts);
  } catch {
    return 0;
  }
  // The browser dropped this subscription (app uninstalled, notifications reset).
  if (status === 404 || status === 410) await forget(env, sub.endpoint);
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
  await env.DB.batch([
    env.DB.prepare("DELETE FROM games WHERE updated < ?").bind(Date.now() - 3 * 86400000),
    env.DB.prepare("DELETE FROM gamex WHERE updated < ?").bind(Date.now() - 3 * 86400000),
  ]);
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

const SPORT = { nfl: "football", cfb: "football", nba: "basketball", wnba: "basketball", mlb: "baseball", nhl: "hockey" };

// Is the game close enough that a score is worth an alert in "close games only" mode?
function isClose(league, margin) {
  return margin <= { football: 8, basketball: 10, baseball: 2, hockey: 1 }[SPORT[league]];
}

// Late in a close game: the moment worth one heads-up alert.
function isLateClose(league, status, margin) {
  const period = status?.period || 0;
  const clock = Number(status?.clock ?? Infinity);
  switch (SPORT[league]) {
    case "football":
      return period >= 4 && clock <= 300 && margin <= 8;
    case "basketball":
      return period >= 4 && clock <= 300 && margin <= 6;
    case "hockey":
      return period >= 3 && clock <= 600 && margin <= 1;
    case "baseball":
      return period >= 8 && margin <= 2;
  }
  return false;
}

const LEAGUE_LABEL = { nfl: "NFL", cfb: "College Football", nba: "NBA", wnba: "WNBA", mlb: "MLB", nhl: "NHL" };

// What the phone needs to draw a scoreboard picture for the notification.
function scoreCardData(league, ev, comp, away, home) {
  const st = ev.status?.type?.state || "pre";
  const sport = SPORT[league];
  const period = ev.status?.period || 0;
  const clock = ev.status?.displayClock;
  const name = ev.status?.type?.name || "";
  let status = ev.status?.type?.shortDetail || "";
  if (st === "in" && clock && !/HALFTIME|END_PERIOD|DELAYED/.test(name) && (sport === "football" || sport === "basketball" || sport === "hockey")) {
    const p = sport === "hockey" ? (period > 3 ? "OT" : `P${period}`) : period > 4 ? "OT" : `Q${period}`;
    status = `${p} · ${clock}`;
  }
  const sit = comp.situation || {};
  let line = "";
  if (st === "in" && sport === "football" && sit.downDistanceText) {
    const poss = [away, home].find((c) => String(c.team.id) === String(sit.possession));
    line = `${poss ? `${teamName(poss)}: ` : ""}${sit.downDistanceText}`;
  } else if (st === "in" && sport === "baseball" && sit.outs != null) {
    line = `${sit.outs} out${sit.outs === 1 ? "" : "s"}${sit.balls != null ? ` · ${sit.balls}-${sit.strikes}` : ""}`;
  } else if (st === "post") {
    line = comp.notes?.[0]?.headline || "";
  }
  const side = (c) => ({
    abbr: c.team.abbreviation || "",
    score: st === "pre" ? "" : String(num(c.score)),
    logo: c.team.logo || "",
    color: c.team.color || "",
    alt: c.team.alternateColor || "",
    won: st === "post" && !!c.winner,
  });
  return {
    league: LEAGUE_LABEL[league] || "",
    st,
    status,
    line,
    rz: !!sit.isRedZone,
    poss: sport === "football" && st === "in" ? (String(sit.possession) === String(away.team.id) ? "a" : String(sit.possession) === String(home.team.id) ? "h" : "") : "",
    a: side(away),
    h: side(home),
  };
}

const ordinal = (n) => n + ({ 1: "st", 2: "nd", 3: "rd" }[n] || "th");

async function checkOnce(env) {
  const subs =
    (
      await env.DB.prepare(
        "SELECT s.endpoint, s.p256dh, s.auth, s.teams, p.settings, p.reminders FROM subs s LEFT JOIN prefs p ON p.endpoint = s.endpoint"
      ).all()
    ).results || [];
  if (!subs.length) return false;
  const now = Date.now();
  for (const s of subs) {
    s.follows = new Set(JSON.parse(s.teams || "[]").map((t) => t.key));
    s.settings = cleanSettings(JSON.parse(s.settings || "{}"));
    s.reminders = JSON.parse(s.reminders || "[]");
    s.reminds = new Set(s.reminders.map((r) => r.key));
    s.quiet = isQuiet(s.settings);
  }
  const leagues = new Set(subs.flatMap((s) => [...s.follows].map((k) => k.split(":")[0])));
  // A reminded game's league only needs watching around its start time.
  for (const s of subs) {
    for (const r of s.reminders) {
      const t = Date.parse(r.date);
      if (t - now < 20 * 60000 && now - t < 8 * 3600000) leagues.add(r.league);
    }
  }
  for (const l of leagues) if (!LEAGUES[l]) leagues.delete(l);
  const known = new Map(((await env.DB.prepare("SELECT key, a, h, st FROM games").all()).results || []).map((g) => [g.key, g]));
  const extras = new Map(((await env.DB.prepare("SELECT key, x FROM gamex").all()).results || []).map((g) => [g.key, JSON.parse(g.x)]));

  let busy = false;
  const sends = [];
  const writes = [];

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
      const key = `${league}:${ev.id}`;
      const followers = subs.filter((s) => s.follows.has(ka) || s.follows.has(kh) || s.reminds.has(key));
      if (!followers.length) continue;

      const st = ev.status?.type?.state || "pre";
      if (st === "in" || (st === "pre" && new Date(ev.date).getTime() - now < 10 * 60000)) busy = true;
      const cur = { a: num(away.score), h: num(home.score), st };
      const prev = known.get(key);
      const x0 = extras.get(key) || {};
      const sit = comp.situation || {};
      const detail = ev.status?.type?.shortDetail || "";
      const x = {
        detail,
        period: ev.status?.period || 0,
        rz: SPORT[league] === "football" && sit.isRedZone ? String(sit.possession || "") : "",
        close: !!x0.close,
      };
      const scoreChanged = !prev || prev.a !== cur.a || prev.h !== cur.h || prev.st !== cur.st;
      const margin = Math.abs(cur.a - cur.h);
      const seen = "detail" in x0;
      // Raise the close-game flag once; the first look only notes it.
      const lateClose = st === "in" && !x.close && isLateClose(league, ev.status, margin);
      if (lateClose) x.close = true;
      const extraChanged = x.detail !== x0.detail || x.period !== x0.period || x.rz !== x0.rz || x.close !== !!x0.close;
      if (!scoreChanged && !extraChanged) continue;

      if (scoreChanged) {
        writes.push(
          env.DB.prepare(
            `INSERT INTO games (key, a, h, st, updated) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET a = excluded.a, h = excluded.h, st = excluded.st, updated = excluded.updated`
          ).bind(key, cur.a, cur.h, cur.st, now)
        );
        known.set(key, { key, ...cur });
      }
      if (extraChanged) {
        writes.push(
          env.DB.prepare(
            `INSERT INTO gamex (key, x, updated) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET x = excluded.x, updated = excluded.updated`
          ).bind(key, JSON.stringify(x), now)
        );
        extras.set(key, x);
      }
      // The first look at a game only sets the baseline.
      if (!prev) continue;

      const line = `${away.team.abbreviation} ${cur.a} – ${cur.h} ${home.team.abbreviation}`;
      // Tapping the notification opens this game's screen.
      const url = `${SUBJECT}#${league}/${ev.id}`;
      const card = scoreCardData(league, ev, comp, away, home);
      const last = sit.lastPlay?.text;
      // Each alert says who it's for: followers of these teams whose settings want it.
      const alerts = [];
      const both = [ka, kh];
      if (prev.st === "pre" && cur.st === "in") {
        alerts.push({ to: both, want: (s) => s.settings.start, reminder: true, title: `${teamName(away)} at ${teamName(home)} has started`, body: detail });
      }
      if (SPORT[league] === "basketball") {
        // Baskets come too fast to announce one by one; sum up each quarter instead.
        if (seen && x.period > x0.period && x0.period > 0 && cur.st === "in") {
          const n = x0.period;
          const label = n === 2 ? "Halftime" : n <= 4 ? `End of the ${ordinal(n)}` : "End of overtime";
          alerts.push({ to: both, want: (s) => s.settings.scores === "all" || (s.settings.scores === "close" && isClose(league, margin)), title: label, body: line });
        }
      } else {
        for (const [c, k, before, after] of [
          [away, ka, prev.a, cur.a],
          [home, kh, prev.h, cur.h],
        ]) {
          if (after > before && cur.st !== "post") {
            alerts.push({
              to: [k],
              want: (s) => s.settings.scores === "all" || (s.settings.scores === "close" && isClose(league, margin)),
              title: `${teamName(c)} score!`,
              body: [`${line} · ${detail}`, last].filter(Boolean).join("\n"),
            });
          }
        }
      }
      if (seen && x.rz && x.rz !== x0.rz && cur.st === "in") {
        const c = [away, home].find((t) => String(t.team.id) === x.rz);
        if (c) {
          alerts.push({
            to: [`${league}:${c.team.id}`],
            want: (s) => s.settings.redzone,
            title: `${teamName(c)} in the red zone`,
            body: [`${line} · ${detail}`, sit.downDistanceText].filter(Boolean).join("\n"),
          });
        }
      }
      if (seen && lateClose) {
        alerts.push({ to: both, want: (s) => s.settings.close, title: "Close game", body: `${line} · ${detail}` });
      }
      const final = prev.st !== "post" && cur.st === "post";
      if (final) {
        const winner = comp.competitors?.find((c) => c.winner);
        alerts.push({ to: both, want: (s) => s.settings.finals, title: winner ? `Final: ${teamName(winner)} win` : "Final", body: line });
      }

      for (const s of followers) {
        const follows = both.some((k) => s.follows.has(k));
        const reminded = s.reminds.has(key);
        const mine = alerts.filter((m) => (m.reminder && reminded) || (m.to.some((k) => s.follows.has(k)) && m.want(s)));
        const live = s.settings.live && (follows || reminded) && (cur.st === "in" || final);
        let message = null;
        if (mine.length && !(s.quiet && !mine.some((m) => m.reminder && reminded))) {
          // One notification per game: an alert replaces that game's live notification.
          const m = mine[mine.length - 1];
          message = { title: m.title, body: m.body };
        } else if (live) {
          // The live notification: same tag, so it updates in place without a sound.
          message = { title: line, body: [detail, last].filter(Boolean).join("\n"), silent: true };
        }
        if (!message) continue;
        sends.push(deliver(env, s, { ...message, tag: key, url, card }, message.silent ? { ttl: 60, urgency: "normal" } : undefined));
      }
    }
  }

  if (writes.length) await env.DB.batch(writes);
  await Promise.all(sends);
  return busy;
}
