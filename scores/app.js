(() => {
  "use strict";

  const API = "https://site.api.espn.com/apis/site/v2/sports";

  const LEAGUES = [
    { key: "nfl", name: "NFL", sport: "football", path: "football/nfl", mode: "week" },
    { key: "cfb", name: "College Football", short: "CFB", sport: "football", path: "football/college-football", mode: "week", params: { groups: "80" } },
    { key: "nba", name: "NBA", sport: "basketball", path: "basketball/nba", mode: "day" },
    { key: "wnba", name: "WNBA", sport: "basketball", path: "basketball/wnba", mode: "day" },
    { key: "mlb", name: "MLB", sport: "baseball", path: "baseball/mlb", mode: "day" },
    { key: "nhl", name: "NHL", sport: "hockey", path: "hockey/nhl", mode: "day" },
  ];
  const byKey = Object.fromEntries(LEAGUES.map((l) => [l.key, l]));
  const shortName = (l) => l.short || l.name;

  const FAV_KEY = "scoreline.favorites";
  const ALERTS_KEY = "scoreline.alerts";

  // Refresh cadence: fast while games are live, slower near start time, lazy otherwise.
  const REFRESH_LIVE = 5 * 1000;
  const REFRESH_SOON = 60 * 1000;
  const REFRESH_IDLE = 5 * 60 * 1000;
  // A followed team's "next game" (when it isn't on today's board) changes rarely.
  const NEXT_TTL = 15 * 60 * 1000;

  const demoMode = new URLSearchParams(location.search).has("demo");

  const $ = (id) => document.getElementById(id);
  const gamesEl = $("games");
  const emptyEl = $("empty-state");
  const statusEl = $("status-line");
  const liveEl = $("live-indicator");
  const titleEl = $("view-title");
  const navEl = $("league-nav");
  const toolbarEl = $("toolbar");
  const gameDialog = $("game-dialog");
  const detailEl = $("game-detail");
  const teamsDialog = $("teams-dialog");
  const teamListEl = $("team-list");
  const searchEl = $("team-search");
  const pickerNavEl = $("picker-leagues");
  const installBtn = $("install-btn");
  const alertsBtn = $("alerts-btn");
  const toastEl = $("toast");

  const state = {
    view: "home",
    leagues: {}, // key -> { cursor, events, weeks, days, lastUpdated, error }
    home: { events: [], lastUpdated: null, error: null },
    nexts: new Map(), // favorite key -> { event, at }
    favorites: loadFavorites(), // favorite key -> team info
    teams: {}, // league key -> team list for the picker
    pickerLeague: "nfl",
    lastScores: new Map(),
    clocks: new Map(),
    openGame: null, // { key, event, summary }
    detailTab: "stats",
    alerts: loadAlerts(),
    alertSeen: new Map(), // event key -> { a, h, st } as of the last check
    seq: 0,
    timer: null,
    clockTimer: null,
  };

  // ---------- storage ----------

  function loadFavorites() {
    try {
      const list = JSON.parse(localStorage.getItem(FAV_KEY)) || [];
      return new Map(list.map((f) => [f.key, f]));
    } catch {
      return new Map();
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites.values()]));
    } catch {
      /* storage unavailable; follows last for this visit only */
    }
  }

  function loadAlerts() {
    try {
      return localStorage.getItem(ALERTS_KEY) === "on";
    } catch {
      return false;
    }
  }

  function saveAlerts() {
    try {
      localStorage.setItem(ALERTS_KEY, state.alerts ? "on" : "off");
    } catch {
      /* ignore */
    }
  }

  // ---------- dates ----------

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const parseYmd = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  const today = () => ymd(new Date());

  function addDays(s, n) {
    const d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function dayLabel(s) {
    const t = today();
    if (s === t) return "Today";
    if (s === addDays(t, -1)) return "Yesterday";
    if (s === addDays(t, 1)) return "Tomorrow";
    return parseYmd(s).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function startText(ev, long = false) {
    const d = new Date(ev.date);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const sameDay = ymd(d) === today();
    const day = sameDay && !long ? "" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (ev.timeValid === false) return day || "Today";
    return [day, time].filter(Boolean).join(" · ");
  }

  // ---------- data ----------

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  const leagueState = (key) =>
    (state.leagues[key] ||= { cursor: null, events: [], weeks: [], days: [], lastUpdated: null, error: null });

  function scoreboardURL(league, cursor) {
    const params = new URLSearchParams(league.params || {});
    params.set("limit", "300");
    if (league.mode === "day") {
      params.set("dates", cursor?.date || today());
    } else if (cursor) {
      params.set("seasontype", cursor.seasonType);
      params.set("week", cursor.week);
      if (cursor.season) params.set("dates", cursor.season);
    }
    return `${API}/${league.path}/scoreboard?${params}`;
  }

  async function fetchScoreboard(key, cursor) {
    const league = byKey[key];
    const data = demoMode ? window.SCORES_DEMO.scoreboard(key, cursor) : await fetchJSON(scoreboardURL(league, cursor));
    for (const ev of data.events || []) tagEvent(ev, key);
    return data;
  }

  async function fetchSummary(key, id) {
    if (demoMode) return window.SCORES_DEMO.summary(key, id);
    return fetchJSON(`${API}/${byKey[key].path}/summary?event=${encodeURIComponent(id)}`);
  }

  const teamInfo = (key, team) => ({
    key: `${key}:${team.id}`,
    league: key,
    id: String(team.id),
    abbr: team.abbreviation,
    name: team.displayName,
    short: team.shortDisplayName || team.name || team.displayName,
    logo: team.logos?.[0]?.href || team.logo || "",
    color: team.color || "",
    alternateColor: team.alternateColor || "",
  });

  async function fetchTeams(key) {
    const league = byKey[key];
    let list = [];
    if (demoMode) {
      list = (window.SCORES_DEMO.teams(key).sports?.[0]?.leagues?.[0]?.teams || []).map(({ team }) => teamInfo(key, team));
    } else {
      try {
        const params = new URLSearchParams(league.params || {});
        params.set("limit", "1000");
        const data = await fetchJSON(`${API}/${league.path}/teams?${params}`);
        list = (data.sports?.[0]?.leagues?.[0]?.teams || []).map(({ team }) => teamInfo(key, team));
      } catch {
        /* some browsers can't reach the teams list; build it from scoreboards instead */
      }
      if (!list.length) list = await teamsFromScoreboards(key);
    }
    if (!list.length) throw new Error("no teams found");
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Collect every team that appears across a spread of weeks or game days.
  async function teamsFromScoreboards(key) {
    const league = byKey[key];
    const first = await fetchScoreboard(key, null);
    const cursors = [];
    const calendar = first.leagues?.[0]?.calendar || [];
    if (league.mode === "week") {
      const regular = calendar.find((c) => c.value === "2")?.entries?.map((e) => Number(e.value)) || [];
      const cur = first.season?.type === 2 ? first.week?.number : null;
      const picks = cur != null ? [cur + 1, cur - 1, cur + 2, cur - 2] : regular.slice(-3);
      for (const w of picks.filter((w) => regular.includes(w)).slice(0, 3)) {
        cursors.push({ season: first.season?.year, seasonType: 2, week: w });
      }
    } else {
      const days = calendar.filter((d) => typeof d === "string").map((d) => d.slice(0, 10).replace(/-/g, ""));
      const n = Math.min(6, days.length);
      for (let i = 0; i < n; i++) cursors.push({ date: days[Math.round((i * (days.length - 1)) / Math.max(1, n - 1))] });
    }
    const boards = [first, ...(await Promise.allSettled(cursors.map((c) => fetchScoreboard(key, c)))).filter((r) => r.status === "fulfilled").map((r) => r.value)];
    const teams = new Map();
    for (const b of boards) {
      for (const ev of b.events || []) {
        for (const c of ev.competitions?.[0]?.competitors || []) {
          if (c.team?.id && !teams.has(c.team.id)) teams.set(c.team.id, teamInfo(key, c.team));
        }
      }
    }
    return [...teams.values()];
  }

  async function fetchTeamNext(fav) {
    const data = demoMode
      ? window.SCORES_DEMO.team(fav.league, fav.id)
      : await fetchJSON(`${API}/${byKey[fav.league].path}/teams/${encodeURIComponent(fav.id)}`);
    const ev = data.team?.nextEvent?.[0];
    if (!ev) return null;
    normalizeEvent(ev);
    tagEvent(ev, fav.league);
    return ev;
  }

  // Team endpoints shape events a little differently from the scoreboard; bring them in line.
  function normalizeEvent(ev) {
    const comp = ev.competitions?.[0];
    if (!comp) return;
    if (!ev.status && comp.status) ev.status = comp.status;
    for (const c of comp.competitors || []) {
      if (c.score && typeof c.score === "object") c.score = c.score.displayValue ?? String(c.score.value ?? "");
      if (c.team && !c.team.logo && c.team.logos?.[0]) c.team.logo = c.team.logos[0].href;
      if (!c.records && Array.isArray(c.record)) c.records = c.record;
    }
  }

  function tagEvent(ev, key) {
    ev._league = key;
    ev._key = `${key}:${ev.id}`;
    // Fill missing colors/logos from what we know about followed teams.
    for (const c of ev.competitions?.[0]?.competitors || []) {
      const fav = c.team && state.favorites.get(`${key}:${c.team.id}`);
      if (!fav) continue;
      c.team.color ||= fav.color;
      c.team.alternateColor ||= fav.alternateColor;
      c.team.logo ||= fav.logo;
    }
  }

  function applyLeague(key, data) {
    const ls = leagueState(key);
    const league = byKey[key];
    ls.events = data.events || [];
    ls.error = null;
    ls.lastUpdated = new Date();
    const calendar = data.leagues?.[0]?.calendar;

    if (league.mode === "week") {
      ls.cursor = {
        season: data.season?.year ?? ls.cursor?.season,
        seasonType: data.season?.type ?? ls.cursor?.seasonType,
        week: data.week?.number ?? ls.cursor?.week,
      };
      if (Array.isArray(calendar) && calendar.length && typeof calendar[0] === "object") {
        ls.weeks = [];
        for (const type of calendar) {
          // Season type 4 is the off-season; nothing to show there.
          if (!Array.isArray(type.entries) || type.value === "4") continue;
          for (const entry of type.entries) {
            ls.weeks.push({
              seasonType: Number(type.value),
              week: Number(entry.value),
              label: type.value === "2" ? entry.label : `${type.label}: ${entry.label}`,
            });
          }
        }
      }
    } else {
      ls.cursor ||= { date: today() };
      if (Array.isArray(calendar) && typeof calendar[0] === "string") {
        ls.days = calendar.map((s) => s.slice(0, 10).replace(/-/g, "")).sort();
      }
    }
  }

  const teamIds = (ev) => (ev.competitions?.[0]?.competitors || []).map((c) => `${ev._league}:${c.team?.id}`);
  const isFavGame = (ev) => teamIds(ev).some((k) => state.favorites.has(k));

  async function fetchHome() {
    const favs = [...state.favorites.values()].filter((f) => byKey[f.league]);
    const keys = [...new Set(favs.map((f) => f.league))];
    const boards = await Promise.allSettled(keys.map((k) => fetchScoreboard(k, null)));

    const events = [];
    let failed = 0;
    boards.forEach((r) => {
      if (r.status !== "fulfilled") {
        failed++;
        return;
      }
      for (const ev of r.value.events || []) if (isFavGame(ev)) events.push(ev);
    });

    const covered = new Set(events.flatMap(teamIds));
    const now = Date.now();
    const need = favs.filter((f) => !covered.has(f.key) && !(state.nexts.get(f.key)?.at > now - NEXT_TTL));
    const nexts = await Promise.allSettled(need.map(fetchTeamNext));

    if (keys.length && failed === keys.length) throw new Error(boards.find((r) => r.reason)?.reason?.message || "Network error");
    return {
      events,
      covered,
      nexts: need.map((f, i) => [f.key, nexts[i].status === "fulfilled" ? nexts[i].value : null]),
    };
  }

  function applyHome(res) {
    const now = Date.now();
    for (const [k, ev] of res.nexts) state.nexts.set(k, { event: ev, at: now });
    const seen = new Set(res.events.map((e) => e._key));
    const events = [...res.events];
    for (const fav of state.favorites.values()) {
      if (res.covered.has(fav.key)) continue;
      const ev = state.nexts.get(fav.key)?.event;
      if (ev && !seen.has(ev._key)) {
        seen.add(ev._key);
        events.push(ev);
      }
    }
    state.home = { events, lastUpdated: new Date(), error: null };
  }

  async function refresh() {
    clearTimeout(state.timer);
    const view = state.view;
    const seq = ++state.seq;
    let result;
    let error = null;
    try {
      if (view === "home") result = state.favorites.size ? await fetchHome() : null;
      else result = await fetchScoreboard(view, leagueState(view).cursor);
    } catch (err) {
      error = err;
    }
    // A newer request (different view, day or week) has started; let it win.
    if (seq !== state.seq) return;

    if (view === "home") {
      if (error) state.home.error = error;
      else if (result) applyHome(result);
      else state.home = { events: [], lastUpdated: null, error: null };
    } else if (error) {
      leagueState(view).error = error;
    } else {
      applyLeague(view, result);
    }

    // Alerts need your teams' games even while you're looking at another league.
    if (state.alerts && view !== "home" && state.favorites.size) {
      try {
        const res = await fetchHome();
        if (seq === state.seq) applyHome(res);
      } catch {
        /* try again next tick */
      }
      if (seq !== state.seq) return;
    }
    checkAlerts();

    syncOpenGame();
    syncClocks();
    render();
    if (state.openGame) refreshDetail();
    schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (document.hidden && !alertsWatching()) return;
    state.timer = setTimeout(refresh, nextDelay());
  }

  function nextDelay() {
    const events = state.alerts ? [...currentEvents(), ...state.home.events] : currentEvents();
    if (currentError()) return REFRESH_SOON;
    if (state.openGame && gameState(state.openGame.event) === "in") return REFRESH_LIVE;
    const now = Date.now();
    let delay = REFRESH_IDLE;
    for (const ev of events) {
      const s = gameState(ev);
      if (s === "in") return REFRESH_LIVE;
      if (s === "pre" && new Date(ev.date).getTime() - now < 30 * 60 * 1000) delay = REFRESH_SOON;
    }
    return delay;
  }

  const currentEvents = () => (state.view === "home" ? state.home.events : leagueState(state.view).events);
  const currentError = () => (state.view === "home" ? state.home.error : leagueState(state.view).error);

  // ---------- helpers ----------

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const gameState = (ev) => ev?.status?.type?.state || ev?.competitions?.[0]?.status?.type?.state || "pre";

  function sides(comp) {
    const list = comp?.competitors || [];
    return {
      away: list.find((c) => c.homeAway === "away") || list[0],
      home: list.find((c) => c.homeAway === "home") || list[1],
    };
  }

  function teamColor(team) {
    return /^[0-9a-f]{6}$/i.test(team?.color || "") ? `#${team.color}` : "#3a3a3c";
  }

  // The color to paint a team with. A few teams' primary is a near-black that
  // turns to mud on screen (the Browns' brown, the Raiders' and Steelers'
  // black); use their secondary then. Dark navies and purples (Bears, Ravens)
  // still read as themselves, so they stay.
  function vividColor(team) {
    const ok = (h) => /^[0-9a-f]{6}$/i.test(h || "");
    const hsl = (h) => {
      const n = parseInt(h, 16);
      const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => v / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      let hue = 0;
      if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return { h: (hue * 60 + 360) % 360, s: sat, l };
    };
    const muddy = (h) => {
      const c = hsl(h);
      return c.l < 0.14 && (c.s < 0.2 || (c.h >= 10 && c.h <= 60));
    };
    const c = team?.color;
    const alt = team?.alternateColor;
    if (ok(c)) {
      if (muddy(c) && ok(alt) && hsl(alt).l >= 0.15 && hsl(alt).l <= 0.8) return `#${alt}`;
      return `#${c}`;
    }
    return ok(alt) ? `#${alt}` : "#3a3a3c";
  }

  function logo(team, size = "md") {
    const blank = `<span class="logo logo-${size} logo-blank" style="--team:${teamColor(team)}"></span>`;
    if (!team?.logo) return blank;
    // If the logo can't load, swap in a team-colored dot rather than a broken image.
    return `<img class="logo logo-${size}" src="${esc(team.logo)}" alt="" loading="lazy" onerror="this.outerHTML=this.dataset.fallback" data-fallback="${esc(blank)}" />`;
  }

  const recordText = (c) => c?.records?.[0]?.summary || c?.records?.[0]?.displayValue || "";
  const rank = (c) => {
    const r = c?.curatedRank?.current;
    return r && r <= 25 ? r : null;
  };
  const broadcasts = (comp) => [...new Set((comp.broadcasts || []).flatMap((b) => b.names || []))].join(", ");
  const note = (comp) => comp.notes?.[0]?.headline || comp.series?.summary || "";

  function sortEvents(events) {
    const order = { in: 0, pre: 1, post: 2 };
    return events.slice().sort((a, b) => {
      const st = order[gameState(a)] - order[gameState(b)];
      if (st) return st;
      if (state.view !== "home") {
        const fav = Number(isFavGame(b)) - Number(isFavGame(a));
        if (fav) return fav;
      }
      const t = new Date(a.date) - new Date(b.date);
      return gameState(a) === "post" ? -t : t;
    });
  }

  // ---------- score alerts ----------

  const alertsSupported = () => "Notification" in window && "serviceWorker" in navigator;

  // Keep checking in the background while one of your teams is playing or about to.
  function alertsWatching() {
    if (!state.alerts || !state.favorites.size) return false;
    const soon = Date.now() + 30 * 60 * 1000;
    return state.home.events.some((ev) => gameState(ev) === "in" || (gameState(ev) === "pre" && new Date(ev.date).getTime() < soon));
  }

  function checkAlerts() {
    const notifyOK = state.alerts && alertsSupported() && Notification.permission === "granted";
    for (const ev of state.home.events) {
      if (!isFavGame(ev)) continue;
      const comp = ev.competitions?.[0] || {};
      const { away, home } = sides(comp);
      if (!away || !home) continue;
      const st = gameState(ev);
      const now = { a: Number(away.score) || 0, h: Number(home.score) || 0, st };
      const prev = state.alertSeen.get(ev._key);
      state.alertSeen.set(ev._key, now);
      // The first look at a game only sets the baseline.
      if (!prev || !notifyOK) continue;

      const line = `${away.team.abbreviation} ${now.a} – ${now.h} ${home.team.abbreviation}`;
      const status = ev.status?.type?.shortDetail || "";
      const fav = (c) => state.favorites.has(`${ev._league}:${c.team?.id}`);
      const name = (c) => c.team?.shortDisplayName || c.team?.abbreviation;

      if (prev.st === "pre" && st === "in") {
        notify(ev, `${name(away)} at ${name(home)} has started`, status);
      }
      for (const [c, before, after] of [
        [away, prev.a, now.a],
        [home, prev.h, now.h],
      ]) {
        if (fav(c) && after > before) {
          const last = comp.situation?.lastPlay?.text;
          notify(ev, `${name(c)} score!`, [`${line} · ${status}`, last].filter(Boolean).join("\n"));
        }
      }
      if (prev.st === "in" && st === "post") {
        const winner = comp.competitors?.find((c) => c.winner);
        notify(ev, winner ? `Final: ${name(winner)} win` : "Final", line);
      }
    }
  }

  async function notify(ev, title, body) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body,
        tag: ev._key,
        renotify: true,
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        data: { url: `${location.origin}${location.pathname}${location.search}#home` },
      });
    } catch {
      /* notification couldn't be shown; nothing else to do */
    }
  }

  async function toggleAlerts() {
    if (state.alerts) {
      state.alerts = false;
      saveAlerts();
      renderAlertsBtn();
      toast("Score alerts off");
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.");
      return;
    }
    state.alerts = true;
    saveAlerts();
    renderAlertsBtn();
    toast(state.favorites.size ? "Score alerts on for your teams" : "Score alerts on. Follow some teams to get them.");
    refresh();
  }

  function renderAlertsBtn() {
    alertsBtn.hidden = !alertsSupported();
    alertsBtn.classList.toggle("on", state.alerts);
    alertsBtn.setAttribute("aria-pressed", state.alerts);
    alertsBtn.setAttribute("aria-label", state.alerts ? "Score alerts on" : "Score alerts off");
    alertsBtn.title = state.alerts ? "Score alerts on" : "Turn on score alerts";
  }

  let toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
  }

  // ---------- game clock ----------

  // The feed only gives snapshots of the clock, and ESPN doesn't refresh it on
  // every request, so an unchanged clock doesn't mean a stopped one. We run the
  // clock locally from the last change and call it stopped only when the feed
  // says so: another part of the game moved on (a new play, a score) while the
  // clock didn't, or the clock sat still for longer than ESPN's update lag.
  const STALE_CLOCK = 15 * 1000; // unchanged this long while running: clock has stopped
  const MAX_RUN = 25; // never run more than this many seconds past the last change

  function parseClock(text) {
    let m = /^(\d{1,2}):(\d{2})(?:\.(\d))?$/.exec(text || "");
    if (m) return { secs: Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0), tenths: !!m[3] };
    m = /^(\d{1,2})\.(\d)$/.exec(text || ""); // basketball shows "45.2" in the last minute
    if (m) return { secs: Number(m[1]) + Number(m[2]) / 10, tenths: true };
    return null;
  }

  // Everything but the clock that changes when a play happens.
  function playSignature(ev) {
    const comp = ev.competitions?.[0] || {};
    const sit = comp.situation || {};
    const scores = (comp.competitors || []).map((c) => c.score).join("-");
    return [scores, sit.lastPlay?.text || sit.lastPlay?.id || "", sit.downDistanceText || "", sit.balls, sit.strikes, sit.outs].join("|");
  }

  function syncClocks() {
    const now = Date.now();
    const events = [...currentEvents()];
    if (state.openGame) events.push(state.openGame.event);
    if (state.alerts) events.push(...state.home.events);
    const seen = new Set();
    for (const ev of events) {
      if (gameState(ev) !== "in" || seen.has(ev._key)) continue;
      seen.add(ev._key);
      const p = parseClock(ev.status?.displayClock);
      if (!p) {
        state.clocks.delete(ev._key);
        continue;
      }
      const period = ev.status?.period;
      const sig = playSignature(ev);
      const prev = state.clocks.get(ev._key);

      if (!prev || prev.period !== period) {
        state.clocks.set(ev._key, { reported: p.secs, anchor: p.secs, anchorAt: now, changedAt: now, running: false, period, tenths: p.tenths, sig });
        continue;
      }

      if (p.secs === prev.reported) {
        const playHappened = sig !== prev.sig;
        if (prev.running && (playHappened || now - prev.changedAt > STALE_CLOCK)) {
          state.clocks.set(ev._key, { ...prev, running: false, anchor: p.secs, anchorAt: now, sig });
        } else if (playHappened) {
          state.clocks.set(ev._key, { ...prev, sig });
        }
        continue;
      }

      let running = p.secs < prev.reported && p.secs > 0;
      // If the clock dropped much less than the real time since its last
      // change, it stopped somewhere in between; wait for the next change.
      const elapsed = (now - prev.changedAt) / 1000;
      const drop = prev.reported - p.secs;
      if (running && prev.running && elapsed - drop > 6 && drop < elapsed * 0.5) running = false;
      let anchor = p.secs;
      if (running && prev.running) {
        // The feed lags real time, so it often reads a little behind our running
        // clock. Don't jump backwards for that; only correct real differences.
        const shown = clockSeconds(ev._key);
        if (shown != null && p.secs >= shown && p.secs - shown <= 3) anchor = shown;
      }
      state.clocks.set(ev._key, { reported: p.secs, anchor, anchorAt: now, changedAt: now, running, period, tenths: p.tenths, sig });
    }
    const anyRunning = [...state.clocks.values()].some((c) => c.running);
    if (anyRunning && !state.clockTimer) state.clockTimer = setInterval(tickClocks, 100);
    if (!anyRunning && state.clockTimer) {
      clearInterval(state.clockTimer);
      state.clockTimer = null;
    }
  }

  function clockSeconds(key) {
    const c = state.clocks.get(key);
    if (!c) return null;
    if (!c.running) return c.anchor;
    const elapsed = Math.min((Date.now() - c.anchorAt) / 1000, MAX_RUN);
    return Math.max(0, c.anchor - elapsed);
  }

  function formatClock(secs, tenths) {
    if (tenths && secs < 60) return (Math.floor(secs * 10) / 10).toFixed(1);
    const whole = Math.ceil(secs - 0.001);
    return `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
  }

  function tickClocks() {
    document.querySelectorAll("[data-clock]").forEach((el) => {
      const key = el.dataset.clock;
      const secs = clockSeconds(key);
      if (secs == null) return;
      const c = state.clocks.get(key);
      const text = formatClock(secs, c?.tenths);
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle("stopped", !c?.running);
    });
  }

  // Status like "7:42 - 3rd" with the clock split out so it can run.
  function statusHTML(ev, long = false) {
    const st = gameState(ev);
    if (st === "pre") return esc(startText(ev, long));
    const type = ev.status?.type || {};
    const detail = (long ? type.detail : type.shortDetail) || type.detail || type.shortDetail || "";
    const display = ev.status?.displayClock || "";
    const secs = st === "in" ? clockSeconds(ev._key) : null;
    if (secs != null && display && detail.startsWith(display)) {
      const rest = detail.slice(display.length).replace(/^\s*-\s*/, "");
      const running = state.clocks.get(ev._key)?.running;
      return `<span class="clock${running ? "" : " stopped"}" data-clock="${esc(ev._key)}">${formatClock(secs, state.clocks.get(ev._key)?.tenths)}</span> <span>${esc(rest)}</span>`;
    }
    return esc(detail);
  }

  // ---------- rendering: shell ----------

  function render() {
    renderNav();
    renderToolbar();

    const events = sortEvents(currentEvents());
    liveEl.hidden = !events.some((ev) => gameState(ev) === "in");
    titleEl.textContent = state.view === "home" ? "My Teams" : byKey[state.view].name;

    gamesEl.innerHTML = events.map(card).join("");
    renderEmpty(events);
    renderStatus();

    // Remember scores so the next refresh can flash the cards that changed.
    for (const ev of events) {
      const { away, home } = sides(ev.competitions?.[0]);
      state.lastScores.set(ev._key, `${away?.score}-${home?.score}`);
    }
  }

  function renderNav() {
    const items = [{ key: "home", label: "★ My Teams" }, ...LEAGUES.map((l) => ({ key: l.key, label: shortName(l) }))];
    navEl.innerHTML = items
      .map(
        (i) =>
          `<button class="chip${i.key === state.view ? " active" : ""}" data-view="${i.key}" aria-current="${i.key === state.view}">${esc(i.label)}</button>`
      )
      .join("");
  }

  function renderToolbar() {
    if (state.view === "home") {
      toolbarEl.hidden = true;
      return;
    }
    toolbarEl.hidden = false;
    const league = byKey[state.view];
    const ls = leagueState(state.view);

    if (league.mode === "day") {
      const date = ls.cursor?.date || today();
      toolbarEl.innerHTML = `
        <button class="icon-btn" data-step="-1" aria-label="Previous day">&#8249;</button>
        <button class="day-label" data-today>${esc(dayLabel(date))}</button>
        <button class="icon-btn" data-step="1" aria-label="Next day">&#8250;</button>`;
      return;
    }

    const current = ls.cursor ? `${ls.cursor.seasonType}-${ls.cursor.week}` : "";
    let weeks = ls.weeks;
    if (!weeks.length && ls.cursor?.week != null) weeks = [{ seasonType: ls.cursor.seasonType, week: ls.cursor.week, label: `Week ${ls.cursor.week}` }];
    const idx = weeks.findIndex((w) => `${w.seasonType}-${w.week}` === current);
    toolbarEl.innerHTML = `
      <button class="icon-btn" data-step="-1" aria-label="Previous week"${idx <= 0 ? " disabled" : ""}>&#8249;</button>
      <select id="week-select" aria-label="Week">
        ${weeks
          .map((w, i) => `<option value="${i}"${`${w.seasonType}-${w.week}` === current ? " selected" : ""}>${esc(w.label)}</option>`)
          .join("")}
      </select>
      <button class="icon-btn" data-step="1" aria-label="Next week"${idx < 0 || idx >= weeks.length - 1 ? " disabled" : ""}>&#8250;</button>`;
  }

  function renderEmpty(events) {
    if (events.length) {
      emptyEl.hidden = true;
      emptyEl.innerHTML = "";
      return;
    }
    emptyEl.hidden = false;
    const error = currentError();
    if (state.view === "home" && !state.favorites.size) {
      emptyEl.innerHTML = `
        <p class="empty-title">Follow your teams</p>
        <p>Their live games, results and next games will show up here.</p>
        <button class="primary-btn" data-open-teams>Choose teams</button>`;
      return;
    }
    if (error) {
      emptyEl.innerHTML = `<p>Couldn't load games (${esc(error.message)}). Retrying shortly.</p><p><a href="?demo">View demo data</a></p>`;
      return;
    }
    if (state.view === "home") {
      emptyEl.innerHTML = state.home.lastUpdated
        ? "<p>No games scheduled for your teams.</p>"
        : '<p class="loading">Loading…</p>';
      return;
    }
    const league = byKey[state.view];
    const ls = leagueState(state.view);
    if (!ls.lastUpdated) {
      emptyEl.innerHTML = '<p class="loading">Loading…</p>';
      return;
    }
    if (league.mode === "day") {
      const date = ls.cursor?.date || today();
      const next = ls.days.find((d) => d > date);
      emptyEl.innerHTML = `<p>No ${esc(league.name)} games ${dayLabel(date) === "Today" ? "today" : `on ${esc(dayLabel(date))}`}.</p>${
        next ? `<button class="primary-btn" data-goto-day="${next}">Next games: ${esc(dayLabel(next))}</button>` : ""
      }`;
    } else {
      emptyEl.innerHTML = "<p>No games this week.</p>";
    }
  }

  function renderStatus() {
    const parts = [];
    if (demoMode) parts.push("Demo data");
    const updated = state.view === "home" ? state.home.lastUpdated : leagueState(state.view).lastUpdated;
    const error = currentError();
    if (error && currentEvents().length) parts.push(`Update failed (${error.message}), retrying`);
    if (updated) parts.push(`Updated ${updated.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}`);
    statusEl.textContent = parts.join(" · ");
  }

  // ---------- rendering: cards ----------

  function card(ev) {
    const league = byKey[ev._league];
    const comp = ev.competitions?.[0] || {};
    const { away, home } = sides(comp);
    const st = gameState(ev);
    const sit = comp.situation || {};
    const changed = state.lastScores.has(ev._key) && state.lastScores.get(ev._key) !== `${away?.score}-${home?.score}`;
    const tv = broadcasts(comp);
    const headline = note(comp);

    const label = [state.view === "home" ? shortName(league) : "", headline].filter(Boolean).join(" · ");

    return `
      <article class="card state-${st}${changed ? " scored" : ""}" data-key="${esc(ev._key)}" tabindex="0"
        aria-label="${esc(ev.name || ev.shortName)}" style="--away:${vividColor(away?.team)};--home:${vividColor(home?.team)}">
        ${label ? `<div class="card-label">${esc(label)}</div>` : ""}
        <div class="matchup">
          ${side(away, comp, league, st, sit)}
          ${scoreCell(away, comp, league, st, sit)}
          <div class="mid">
            <span class="status${st === "in" ? " live" : ""}">${statusHTML(ev)}</span>
            ${tv && st !== "post" ? `<span class="tv">${esc(tv)}</span>` : ""}
          </div>
          ${scoreCell(home, comp, league, st, sit)}
          ${side(home, comp, league, st, sit)}
        </div>
        ${cardExtra(league, comp, st, sit, away, home)}
      </article>`;
  }

  function side(c, comp, league, st) {
    const team = c?.team || {};
    const r = rank(c);
    const lost = st === "post" && comp.competitors?.some((o) => o !== c && o.winner);
    return `
      <div class="side${lost ? " lost" : ""}">
        ${logo(team)}
        <span class="abbr">${r ? `<span class="rank">${r}</span>` : ""}${esc(team.abbreviation || team.shortDisplayName || "")}</span>
        <span class="rec">${esc(recordText(c))}</span>
      </div>`;
  }

  function scoreCell(c, comp, league, st, sit) {
    if (st === "pre" || !c) return '<span class="score"></span>';
    const lost = st === "post" && comp.competitors?.some((o) => o !== c && o.winner);
    const ball = league.sport === "football" && st === "in" && sit.possession && String(sit.possession) === String(c.team?.id);
    return `<span class="score${lost ? " lost" : ""}${c.homeAway === "home" ? " home" : " away"}">${
      ball ? '<span class="ball-dot" title="Has the ball"></span>' : ""
    }${esc(c.score ?? "")}</span>`;
  }

  function cardExtra(league, comp, st, sit, away, home) {
    if (st === "in") {
      if (league.sport === "football") {
        const dd = sit.downDistanceText || sit.shortDownDistanceText || "";
        const last = sit.lastPlay?.text || "";
        if (!dd && !last) return "";
        return `<div class="extra">
          ${dd ? `<div class="situation${sit.isRedZone ? " redzone" : ""}">${esc(dd)}${sit.isRedZone ? ' <span class="rz">Red Zone</span>' : ""}</div>` : ""}
          ${miniField(sit, away, home)}
          ${last ? `<div class="last-play">${esc(last)}</div>` : ""}
        </div>`;
      }
      if (league.sport === "baseball") return baseballSituation(sit);
      const last = sit.lastPlay?.text;
      return last ? `<div class="extra"><div class="last-play">${esc(last)}</div></div>` : "";
    }
    if (st === "pre") {
      const bits = [];
      if (league.sport === "baseball") {
        const p = (c) => c?.probables?.[0]?.athlete?.shortName || c?.probables?.[0]?.athlete?.displayName;
        if (p(away) || p(home)) bits.push(`${p(away) || "TBD"} vs ${p(home) || "TBD"}`);
      }
      const odds = comp.odds?.[0];
      if (odds?.details) bits.push(odds.details);
      if (odds?.overUnder) bits.push(`O/U ${odds.overUnder}`);
      return bits.length ? `<div class="extra"><div class="meta">${esc(bits.join(" · "))}</div></div>` : "";
    }
    return "";
  }

  function baseballSituation(sit, big = false) {
    const on = (b) => (sit[b] ? " on" : "");
    const outs = Math.max(0, Math.min(3, Number(sit.outs) || 0));
    const hasCount = sit.balls != null || sit.strikes != null;
    const pitcher = sit.pitcher?.athlete?.shortName || sit.pitcher?.athlete?.displayName;
    const batter = sit.batter?.athlete?.shortName || sit.batter?.athlete?.displayName;
    const last = sit.lastPlay?.text;
    if (!hasCount && sit.outs == null && !pitcher && !last) return "";
    return `<div class="extra${big ? " big" : ""}">
      <div class="diamond-row">
        <svg class="diamond" viewBox="0 0 44 30" role="img" aria-label="Runners: ${["onFirst", "onSecond", "onThird"].filter((b) => sit[b]).map((b) => b.slice(2)).join(", ") || "none"}">
          <rect class="base${on("onSecond")}" x="17" y="2" width="10" height="10" transform="rotate(45 22 7)" />
          <rect class="base${on("onFirst")}" x="29" y="14" width="10" height="10" transform="rotate(45 34 19)" />
          <rect class="base${on("onThird")}" x="5" y="14" width="10" height="10" transform="rotate(45 10 19)" />
        </svg>
        <div class="count">
          ${hasCount ? `<span class="bs">${esc(sit.balls ?? 0)}-${esc(sit.strikes ?? 0)}</span>` : ""}
          <span class="outs" aria-label="${outs} out">${[0, 1, 2].map((i) => `<i class="${i < outs ? "on" : ""}"></i>`).join("")}</span>
        </div>
        ${pitcher || batter ? `<div class="matchup-names">${pitcher ? `<span>P: ${esc(pitcher)}</span>` : ""}${batter ? `<span>AB: ${esc(batter)}</span>` : ""}</div>` : ""}
      </div>
      ${big && last ? `<div class="last-play">${esc(last)}</div>` : ""}
    </div>`;
  }

  // Ball spot as 0–100 from the away end zone (left) to the home end zone (right).
  function ballSpot(sit, away, home) {
    const text = (sit?.possessionText || "").trim();
    const m = text.match(/^([A-Z&]{2,5})\s+(\d{1,2})$/);
    if (m) {
      const yd = Number(m[2]);
      if (m[1] === home?.team?.abbreviation) return 100 - yd;
      if (m[1] === away?.team?.abbreviation) return yd;
    }
    if (/^(50|[A-Z&]{2,5} 50)$/.test(text)) return 50;
    return null;
  }

  function miniField(sit, away, home) {
    const spot = ballSpot(sit, away, home);
    if (spot == null) return "";
    const poss = String(sit.possession);
    const dir = poss === String(away?.team?.id) ? 1 : poss === String(home?.team?.id) ? -1 : 0;
    const togo = Number(sit.distance) || 0;
    const first = dir ? Math.max(0, Math.min(100, spot + dir * togo)) : null;
    return `
      <div class="field" aria-hidden="true">
        <div class="endzone" style="--team:${vividColor(away?.team)}"></div>
        <div class="turf">
          ${first != null ? `<div class="first-line" style="left:${first}%"></div>` : ""}
          <div class="ball" style="left:${spot}%"></div>
        </div>
        <div class="endzone" style="--team:${vividColor(home?.team)}"></div>
      </div>`;
  }

  // ---------- rendering: game detail ----------

  function findEvent(key) {
    return (
      currentEvents().find((e) => e._key === key) ||
      Object.values(state.leagues).flatMap((l) => l.events).find((e) => e._key === key) ||
      state.home.events.find((e) => e._key === key)
    );
  }

  function syncOpenGame() {
    if (!state.openGame) return;
    const fresh = findEvent(state.openGame.key);
    if (fresh) state.openGame.event = fresh;
  }

  // The games you can swipe between: the list you opened this one from.
  const gameOrder = () => sortEvents(currentEvents()).map((e) => e._key);

  function openGame(key, dir = 0) {
    const ev = findEvent(key);
    if (!ev) return;
    const same = state.openGame?.key === key;
    state.openGame = { key, event: ev, summary: same ? state.openGame.summary : null };
    renderDetail();
    if (!gameDialog.open) gameDialog.showModal();
    if (!same) detailEl.scrollTop = 0;
    if (dir) {
      detailEl.classList.remove("from-left", "from-right");
      void detailEl.offsetWidth; // restart the animation
      detailEl.classList.add(dir > 0 ? "from-right" : "from-left");
    }
    refreshDetail();
    // Keep the open game fresh even when it isn't on the current view's list.
    if (gameState(ev) === "in") schedule();
  }

  function stepGame(dir) {
    const keys = gameOrder();
    const next = keys[keys.indexOf(state.openGame?.key) + dir];
    if (next) openGame(next, dir);
  }

  async function refreshDetail() {
    const og = state.openGame;
    if (!og) return;
    try {
      og.summary = await fetchSummary(og.event._league, og.event.id);
      // The summary header carries the freshest status and score for this game.
      mergeSummaryStatus(og.event, og.summary);
    } catch {
      /* keep whatever we had */
    }
    if (state.openGame !== og) return;
    syncClocks();
    renderDetail();
  }

  function mergeSummaryStatus(ev, summary) {
    const hc = summary?.header?.competitions?.[0];
    if (!hc || gameState(ev) === "post") return;
    if (hc.status?.type) ev.status = { ...ev.status, ...hc.status };
    const comp = ev.competitions?.[0];
    for (const c of hc.competitors || []) {
      const mine = comp?.competitors?.find((x) => String(x.team?.id) === String(c.team?.id ?? c.id));
      if (mine && c.score != null) mine.score = typeof c.score === "object" ? c.score.displayValue : c.score;
    }
    if (summary.situation && comp) comp.situation = { ...comp.situation, ...summary.situation };
  }

  function renderDetail() {
    const og = state.openGame;
    if (!og) return;
    const ev = og.event;
    const { away, home } = sides(ev.competitions?.[0]);
    gameDialog.style.setProperty("--away", vividColor(away?.team));
    gameDialog.style.setProperty("--home", vividColor(home?.team));
    $("game-league").textContent = byKey[ev._league].name;
    const keys = gameOrder();
    const i = keys.indexOf(og.key);
    $("prev-game").disabled = i <= 0;
    $("next-game").disabled = i < 0 || i >= keys.length - 1;

    const tabs = detailTabs(ev, og.summary);
    if (!tabs.some((t) => t.key === state.detailTab)) state.detailTab = tabs[0].key;
    const tab = tabs.find((t) => t.key === state.detailTab);
    const scroll = detailEl.scrollTop;
    detailEl.innerHTML = `
      ${hero(ev)}
      <div class="gd-sticky">
        ${miniScore(ev)}
        <nav class="gd-tabs" role="tablist">
          ${tabs.map((t) => `<button class="gd-tab${t === tab ? " active" : ""}" role="tab" data-tab="${t.key}" aria-selected="${t === tab}">${t.label}</button>`).join("")}
        </nav>
      </div>
      <div class="gd-panel">${tab.html}</div>`;
    detailEl.scrollTop = scroll;
    updateStuck();
  }

  // The small scoreboard that stays pinned above the tabs once the big one scrolls away.
  function miniScore(ev) {
    const comp = ev.competitions?.[0] || {};
    const { away, home } = sides(comp);
    const st = gameState(ev);
    const sit = comp.situation || {};
    const ball = (c) => byKey[ev._league].sport === "football" && st === "in" && String(sit.possession) === String(c?.team?.id);
    const side = (c, flip) => `
      <span class="gm-side${flip ? " flip" : ""}">${logo(c?.team, "sm")}${ball(c) ? '<i class="gm-ball"></i>' : ""}<b>${st === "pre" ? "" : esc(c?.score)}</b></span>`;
    return `<div class="gd-mini" aria-hidden="true">${side(away)}<span class="gm-status">${statusHTML(ev)}</span>${side(home, true)}</div>`;
  }

  function updateStuck() {
    const hero = detailEl.querySelector(".gd-hero");
    gameDialog.classList.toggle("stuck", !!hero && detailEl.scrollTop > hero.offsetHeight - 8);
  }

  function detailTabs(ev, summary) {
    const league = byKey[ev._league];
    const st = gameState(ev);
    const loading = summary ? "" : '<p class="loading">Loading game details…</p>';
    const box = boxScoreCards(summary, ev, league);
    const stats = [oddsCard(ev, summary), teamStatsCard(summary, league), box || leadersCard(summary, ev), infoCard(ev)].join("");
    let plays = "";
    if (summary) {
      if (league.sport === "football" || league.sport === "hockey") plays += scoringCard(summary, league);
      plays += league.sport === "football" ? drivesCard(summary) : playsCard(summary, league);
    }
    const tabs = [
      { key: "stats", label: "Stats", html: stats + loading },
      {
        key: "plays",
        label: "Play-by-Play",
        html: plays || loading || `<p class="loading">${st === "pre" ? "Plays will show up here once the game starts." : "No plays yet."}</p>`,
      },
    ];
    const standings = standingsCard(summary, ev);
    if (standings) tabs.push({ key: "standings", label: "Standings", html: standings });
    return tabs;
  }

  function hero(ev) {
    const league = byKey[ev._league];
    const comp = ev.competitions?.[0] || {};
    const { away, home } = sides(comp);
    const st = gameState(ev);
    const sit = comp.situation || {};
    const tv = broadcasts(comp);
    const tvLine = tv ? `${st === "in" ? "Live on" : st === "pre" ? "On" : "Aired on"} ${tv}` : "";

    const side = (c) => {
      const team = c?.team || {};
      const key = `${ev._league}:${team.id}`;
      const on = state.favorites.has(key);
      const lost = st === "post" && comp.competitors?.some((o) => o !== c && o.winner);
      const hasBall = league.sport === "football" && st === "in" && String(sit.possession) === String(team.id);
      const timeouts = league.sport === "football" && st === "in" ? (c?.homeAway === "home" ? sit.homeTimeouts : sit.awayTimeouts) : null;
      return `
        <div class="gd-side${lost ? " lost" : ""}">
          ${st === "pre" ? "" : `<span class="gd-score">${esc(c?.score)}</span>`}
          ${
            timeouts != null
              ? `<span class="gd-timeouts" aria-label="${timeouts} timeouts left">${[0, 1, 2].map((i) => `<i class="${i < timeouts ? "on" : ""}"></i>`).join("")}</span>`
              : ""
          }
          <span class="gd-logo">${logo(team, "lg")}${hasBall ? '<span class="gd-ball" title="Has the ball"></span>' : ""}</span>
          <span class="gd-name">${rank(c) ? `<span class="rank">${rank(c)}</span>` : ""}${esc(team.shortDisplayName || team.abbreviation)}</span>
          <span class="gd-rec">${esc(recordText(c))}</span>
          <button class="follow-btn${on ? " on" : ""}" data-follow="${esc(key)}" aria-pressed="${on}">${on ? "★ Following" : "☆ Follow"}</button>
        </div>`;
    };

    let now = "";
    if (st === "in") {
      if (league.sport === "football" && (sit.downDistanceText || sit.lastPlay?.text || sit.possessionText)) {
        now = `
          ${sit.downDistanceText ? `<p class="situation${sit.isRedZone ? " redzone" : ""}">${esc(sit.downDistanceText)}${sit.isRedZone ? ' <span class="rz">Red Zone</span>' : ""}</p>` : ""}
          ${heroField(sit, away, home)}
          ${sit.lastPlay?.text ? `<p class="last-play">${esc(sit.lastPlay.text)}</p>` : ""}`;
      } else if (league.sport === "baseball") {
        now = baseballSituation(sit, true);
      } else if (sit.lastPlay?.text) {
        now = `<p class="last-play">${esc(sit.lastPlay.text)}</p>`;
      }
    }

    return `
      <div class="gd-hero">
        <div class="gd-teams">
          ${side(away)}
          <div class="gd-mid">
            <span class="gd-status${st === "in" ? " live" : ""}">${statusHTML(ev, true)}</span>
            ${note(comp) ? `<span class="gd-note">${esc(note(comp))}</span>` : ""}
          </div>
          ${side(home)}
        </div>
        ${st !== "pre" ? lineScore(league, away, home, st) : ""}
        ${now ? `<div class="gd-now">${now}</div>` : ""}
        ${tvLine ? `<p class="gd-tv">${esc(tvLine)}</p>` : ""}
      </div>`;
  }

  // A light, tilted field with yard numbers, like Apple's.
  function heroField(sit, away, home) {
    const spot = ballSpot(sit, away, home);
    if (spot == null) return "";
    const poss = String(sit.possession);
    const dir = poss === String(away?.team?.id) ? 1 : poss === String(home?.team?.id) ? -1 : 0;
    const togo = Number(sit.distance) || 0;
    const first = dir && togo ? Math.max(0, Math.min(100, spot + dir * togo)) : null;
    const nums = [10, 20, 30, 40, 50, 40, 30, 20, 10];
    return `
      <div class="hfield" aria-label="Ball on ${esc(sit.possessionText)}">
        <div class="hf-turf">
          <span class="hf-ez" style="--team:${vividColor(away?.team)}"></span>
          <div class="hf-play">
            ${first != null ? `<i class="hf-first" style="left:${first}%"></i>` : ""}
            <i class="hf-ball" style="left:${spot}%"></i>
          </div>
          <span class="hf-ez" style="--team:${vividColor(home?.team)}"></span>
        </div>
        <div class="hf-nums"><span></span><div>${nums.map((n, i) => `<b style="left:${(i + 1) * 10}%">${n}</b>`).join("")}</div><span></span></div>
      </div>`;
  }

  function periodHeads(league, n) {
    return Array.from({ length: n }, (_, i) => {
      if (league.sport === "baseball") return i + 1;
      const reg = league.sport === "hockey" ? 3 : 4;
      if (i < reg) return i + 1;
      return i === reg ? "OT" : `${i - reg + 1}OT`;
    });
  }

  function lineScore(league, away, home, st) {
    const min = league.sport === "baseball" ? 9 : league.sport === "hockey" ? 3 : 4;
    const n = Math.max(min, away?.linescores?.length || 0, home?.linescores?.length || 0);
    const heads = periodHeads(league, n);
    const baseball = league.sport === "baseball";
    const val = (c, i) => {
      const l = c?.linescores?.[i];
      const v = l ? (l.displayValue ?? l.value) : null;
      // Periods not played yet show a dash, as on a scoreboard.
      return v == null || v === "" ? (st === "post" && baseball ? "x" : "–") : v;
    };
    const row = (c) => `
      <tr>
        <th scope="row">${esc(c?.team?.abbreviation)}</th>
        ${heads.map((_, i) => `<td>${esc(val(c, i))}</td>`).join("")}
        <td class="total">${esc(c?.score)}</td>
        ${baseball ? `<td>${esc(c?.hits ?? "")}</td><td>${esc(c?.errors ?? "")}</td>` : ""}
      </tr>`;
    return `
      <div class="table-scroll gd-lines">
        <table class="linescore">
          <thead><tr><th></th>${heads.map((h) => `<th>${h}</th>`).join("")}<th>${baseball ? "R" : "T"}</th>${baseball ? "<th>H</th><th>E</th>" : ""}</tr></thead>
          <tbody>${row(away)}${row(home)}</tbody>
        </table>
      </div>`;
  }

  const gcard = (title, body, extra = "") => `<section class="gcard${extra}">${title ? `<h3>${esc(title)}</h3>` : ""}${body}</section>`;

  // ---- odds ----

  // Odds come in two shapes (the scoreboard's and the summary's pick center);
  // read whichever is there.
  function oddsData(ev, summary) {
    const comp = ev.competitions?.[0] || {};
    const o = summary?.pickcenter?.[0] || comp.odds?.[0];
    if (!o) return null;
    const { away, home } = sides(comp);
    const american = (v) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      if (Number.isFinite(n)) return n > 0 ? `+${n}` : `${n}`.replace("-", "\u2212");
      return String(v).replace(/^-/, "\u2212");
    };

    let spread = { away: o.pointSpread?.away?.close?.line ?? null, home: o.pointSpread?.home?.close?.line ?? null };
    if (spread.home == null) {
      const m = /^([A-Z&]{2,5})\s+([-+]?\d+(?:\.\d+)?)$/.exec(o.details || "");
      if (m) {
        const v = Number(m[2]);
        const homeFav = m[1] === home?.team?.abbreviation;
        spread = { away: homeFav ? -v : v, home: homeFav ? v : -v };
      } else if (/^(even|pk)/i.test(o.details || "")) {
        spread = { away: "PK", home: "PK" };
      }
    }
    const spreadOdds = (s) => o.pointSpread?.[s]?.close?.odds ?? o[`${s}TeamOdds`]?.spreadOdds;
    const moneyline = (s) => o.moneyline?.[s]?.close?.odds ?? o[`${s}TeamOdds`]?.moneyLine;
    const total = (k) => {
      const line = o.total?.[k]?.close?.line;
      return {
        line: line ? String(line).replace(/^o/i, "O ").replace(/^u/i, "U ") : o.overUnder != null ? `${k === "over" ? "O" : "U"} ${o.overUnder}` : null,
        odds: american(o.total?.[k]?.close?.odds ?? o[`${k}Odds`]),
      };
    };
    const rows = [
      { team: away?.team, spread: american(spread.away), spreadOdds: american(spreadOdds("away")), total: total("over"), ml: american(moneyline("away")) },
      { team: home?.team, spread: american(spread.home), spreadOdds: american(spreadOdds("home")), total: total("under"), ml: american(moneyline("home")) },
    ];
    if (!rows.some((r) => r.spread || r.total.line || r.ml)) return null;
    return { provider: o.provider?.name, rows };
  }

  function oddsCard(ev, summary) {
    const d = oddsData(ev, summary);
    if (!d) return "";
    const cell = (main, sub) => `<td>${main ? `<span class="odd-main">${esc(main)}</span>` : "–"}${sub ? `<span class="odd-sub">${esc(sub)}</span>` : ""}</td>`;
    return gcard(
      "Betting Odds",
      `<table class="odds">
        <thead><tr><th>Team</th><th>Spread</th><th>Total</th><th>Moneyline</th></tr></thead>
        <tbody>
          ${d.rows
            .map((r) => `<tr><th scope="row">${esc(r.team?.abbreviation)}</th>${cell(r.spread, r.spreadOdds)}${cell(r.total.line, r.total.odds)}${cell(r.ml)}</tr>`)
            .join("")}
        </tbody>
      </table>
      ${d.provider ? `<p class="gcard-foot">Odds provided by ${esc(d.provider)}</p>` : ""}`
    );
  }

  // ---- team stats ----

  const FOOTBALL_STATS = [
    ["totalOffensivePlays", "Plays"],
    ["totalYards", "Yards"],
    ["yardsPerPlay", "Yards per Play"],
    ["netPassingYards", "Passing Yards"],
    ["rushingYards", "Rushing Yards"],
    ["firstDowns", "1st Downs"],
    ["thirdDownEff", "3rd Down Efficiency"],
    ["fourthDownEff", "4th Down Efficiency"],
    ["fumblesLost", "Fumbles Lost"],
    ["interceptions", "Interceptions"],
    ["turnovers", "Turnovers"],
    ["penalties", "Penalties"],
    ["penaltyYards", "Penalty Yards"],
    ["possessionTime", "Time of Possession"],
  ];

  // A number to size the bars by: "21:40" -> seconds, "4/10" -> 0.4, "47.5" -> 47.5.
  function statNumber(v) {
    const s = String(v ?? "");
    const r = /^(\d+)\/(\d+)$/.exec(s);
    if (r) return Number(r[2]) ? Number(r[1]) / Number(r[2]) : 0;
    const t = /^(\d+):(\d{2})$/.exec(s);
    if (t) return Number(t[1]) * 60 + Number(t[2]);
    const m = /\d+(?:\.\d+)?/.exec(s);
    return m ? parseFloat(m[0]) : null;
  }

  function teamStatsCard(summary, league) {
    const teams = summary?.boxscore?.teams;
    if (!Array.isArray(teams) || teams.length !== 2) return "";
    const byName = (t) => {
      const out = Object.fromEntries((t.statistics || []).filter((s) => s.displayValue != null).map((s) => [s.name, s]));
      // "2-10" penalties become a count and yards, and efficiencies read "4/10", as Apple shows them.
      const pen = /^(\d+)-(\d+)$/.exec(out.totalPenaltiesYards?.displayValue || "");
      if (pen) {
        out.penalties = { displayValue: pen[1] };
        out.penaltyYards = { displayValue: pen[2] };
      }
      for (const n of ["thirdDownEff", "fourthDownEff"]) {
        if (out[n]) out[n] = { ...out[n], displayValue: String(out[n].displayValue).replace("-", "/") };
      }
      if (out.fumblesLost || out.interceptions) delete out.turnovers;
      return out;
    };
    // Box score lists teams away first, but don't rely on it.
    const awayId = sides(state.openGame?.event?.competitions?.[0]).away?.team?.id;
    const ordered = String(teams[1].team?.id) === String(awayId) ? [teams[1], teams[0]] : teams;
    const [a, b] = ordered.map(byName);
    const list =
      league.sport === "football"
        ? FOOTBALL_STATS.filter(([n]) => a[n] || b[n])
        : Object.keys(a)
            .filter((n) => b[n])
            .slice(0, 10)
            .map((n) => [n, a[n].label || n]);
    if (!list.length) return "";
    const rows = list
      .map(([n, label]) => {
        const av = a[n]?.displayValue ?? "–";
        const bv = b[n]?.displayValue ?? "–";
        const an = statNumber(av);
        const bn = statNumber(bv);
        const bars =
          an != null && bn != null
            ? `<div class="sbar-track"><i class="away" style="flex-grow:${an + bn ? an : 1}"></i><i class="home" style="flex-grow:${an + bn ? bn : 1}"></i></div>`
            : "";
        return `<div class="sbar"><div class="sbar-top"><span class="sv">${esc(av)}</span><span class="sl">${esc(label)}</span><span class="sv">${esc(bv)}</span></div>${bars}</div>`;
      })
      .join("");
    return gcard("Team Stats", `<div class="sbar-head"><span>${esc(ordered[0].team?.abbreviation)}</span><span>${esc(ordered[1].team?.abbreviation)}</span></div>${rows}`);
  }

  // ---- leaders ----

  function leadersCard(summary, ev) {
    const comp = ev.competitions?.[0] || {};
    const awayId = String(sides(comp).away?.team?.id);
    const groups = (summary?.leaders || []).filter((g) => g.leaders?.length);
    groups.sort((x, y) => Number(String(y.team?.id) === awayId) - Number(String(x.team?.id) === awayId));
    if (groups.length === 2) {
      const cats = groups[0].leaders.slice(0, 3);
      const rows = cats
        .map((cat) => {
          const cells = groups.map((g) => {
            const l = g.leaders.find((x) => x.name === cat.name)?.leaders?.[0];
            return `<div class="leader">${
              l ? `<span class="leader-name">${esc(l.athlete?.shortName || l.athlete?.displayName)}</span><span class="leader-line">${esc(l.displayValue)}</span>` : ""
            }</div>`;
          });
          return `<div class="leader-row"><span class="leader-cat">${esc(cat.shortDisplayName || cat.displayName || cat.name)}</span>${cells.join("")}</div>`;
        })
        .join("");
      return gcard("Leaders", `<div class="leader-row head"><span></span>${groups.map((g) => `<span>${esc(g.team?.abbreviation)}</span>`).join("")}</div>${rows}`);
    }
    const flat = comp.leaders;
    if (Array.isArray(flat) && flat.length) {
      return gcard(
        "Leaders",
        flat
          .map((cat) => {
            const l = cat.leaders?.[0];
            if (!l) return "";
            return `<div class="leader-row flat"><span class="leader-cat">${esc(cat.shortDisplayName || cat.displayName)}</span><div class="leader"><span class="leader-name">${esc(l.athlete?.shortName || l.athlete?.displayName)}</span><span class="leader-line">${esc(l.displayValue)}</span></div></div>`;
          })
          .join("")
      );
    }
    return "";
  }

  // ---- box score ----

  // Columns worth showing on a phone, by sport; anything else falls back to the first six.
  const BOX_COLUMNS = {
    basketball: ["MIN", "PTS", "REB", "AST", "FG", "3PT"],
    hockey: ["G", "A", "+/-", "SOG", "HT", "TOI", "SA", "GA", "SV", "SV%"],
    baseball: ["AB", "R", "H", "RBI", "BB", "K", "IP", "ER", "ERA"],
  };

  const titleCase = (s) => String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

  function boxScoreCards(summary, ev, league) {
    const players = summary?.boxscore?.players;
    if (!Array.isArray(players) || !players.length) return "";
    const awayId = String(sides(ev.competitions?.[0]).away?.team?.id);
    const ordered = players.slice().sort((x, y) => Number(String(y.team?.id) === awayId) - Number(String(x.team?.id) === awayId));
    const cards = ordered.map((tp) => {
      const sections = (tp.statistics || [])
        .map((cat) => {
          const labels = cat.labels || [];
          const athletes = (cat.athletes || []).filter((a) => a.stats?.length && !a.didNotPlay);
          if (!labels.length || !athletes.length) return "";
          const pref = (BOX_COLUMNS[league.sport] || []).map((l) => labels.indexOf(l)).filter((i) => i >= 0);
          const cols = pref.length >= 3 ? pref.slice(0, 6) : labels.map((_, i) => i).slice(0, 6);
          const title = cat.text || titleCase(cat.name) || "Players";
          return `
            <table class="box">
              <thead><tr><th>${esc(title)}</th>${cols.map((i) => `<th>${esc(labels[i])}</th>`).join("")}</tr></thead>
              <tbody>
                ${athletes
                  .map((a) => {
                    const at = a.athlete || {};
                    return `<tr><th scope="row"><span class="box-name">${esc(at.shortName || at.displayName)}</span>${
                      at.position?.abbreviation ? ` <span class="box-pos">${esc(at.position.abbreviation)}</span>` : ""
                    }</th>${cols.map((i) => `<td>${esc(a.stats[i] ?? "")}</td>`).join("")}</tr>`;
                  })
                  .join("")}
              </tbody>
            </table>`;
        })
        .join("");
      if (!sections) return "";
      const team = tp.team || {};
      return `<section class="gcard box-card"><h3 class="box-team">${logo(team, "xs")}${esc(team.shortDisplayName || team.displayName || team.abbreviation)}</h3>${sections}</section>`;
    });
    return cards.join("");
  }

  function infoCard(ev) {
    const comp = ev.competitions?.[0] || {};
    const info = [
      ["Start", startText(ev, true)],
      ["Venue", [comp.venue?.fullName, comp.venue?.address?.city, comp.venue?.address?.state].filter(Boolean).join(", ")],
      ["TV", broadcasts(comp)],
    ].filter(([, v]) => v);
    if (!info.length) return "";
    return gcard("Game Info", `<dl class="info">${info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`);
  }

  // ---- plays ----

  function periodLabel(p, league) {
    if (p?.period?.displayValue && league.sport === "baseball") return p.period.displayValue;
    const n = p?.period?.number;
    if (!n) return "";
    const prefix = league.sport === "hockey" ? "P" : "Q";
    const reg = league.sport === "hockey" ? 3 : 4;
    return n > reg ? "OT" : `${prefix}${n}`;
  }

  function scoringCard(summary, league) {
    const plays = summary.scoringPlays || [];
    if (!plays.length) return "";
    return gcard(
      "Scoring",
      `<ol class="plays">
        ${plays
          .map(
            (p) => `
          <li>
            <span class="play-when">${esc(periodLabel(p, league))} ${esc(p.clock?.displayValue || "")}</span>
            <span class="play-team">${logo(p.team, "xs")}${esc(p.team?.abbreviation || "")}</span>
            <span class="play-score">${esc(p.awayScore)}–${esc(p.homeScore)}</span>
            <span class="play-text">${esc(p.text)}</span>
          </li>`
          )
          .join("")}
      </ol>`
    );
  }

  function drivesCard(summary) {
    const current = summary.drives?.current;
    const drives = [...(summary.drives?.previous || [])];
    if (current && !drives.some((d) => d.id && d.id === current.id)) drives.push({ ...current, inProgress: true });
    if (!drives.length) return "";
    return gcard(
      "Drives",
      `<ol class="drives">
        ${drives
          .reverse()
          .map(
            (d) => `
          <li${d.inProgress ? ' class="current"' : ""}>
            <span class="play-team">${logo(d.team, "xs")}${esc(d.team?.abbreviation || "")}</span>
            <span class="drive-result">${esc(d.inProgress ? "In progress" : d.displayResult || d.result || "")}</span>
            <span class="drive-desc">${esc(d.description || "")}</span>
          </li>`
          )
          .join("")}
      </ol>`
    );
  }

  function playsCard(summary, league) {
    const plays = (summary.plays || []).filter((p) => p.text);
    if (!plays.length) return "";
    const teamsById = {};
    for (const t of summary.boxscore?.teams || []) if (t.team) teamsById[t.team.id] = t.team;
    return gcard(
      "Latest Plays",
      `<ol class="plays recent">
        ${plays
          .slice(-25)
          .reverse()
          .map((p) => {
            const team = p.team?.id ? teamsById[p.team.id] : null;
            return `
          <li${p.scoringPlay ? ' class="scoring"' : ""}>
            <span class="play-when">${esc(periodLabel(p, league))} ${league.sport === "baseball" ? "" : esc(p.clock?.displayValue || "")}</span>
            <span class="play-team">${team ? `${logo(team, "xs")}${esc(team.abbreviation || "")}` : ""}</span>
            <span class="play-score">${p.awayScore != null ? `${esc(p.awayScore)}–${esc(p.homeScore)}` : ""}</span>
            <span class="play-text">${esc(p.text)}</span>
          </li>`;
          })
          .join("")}
      </ol>`
    );
  }

  // ---- standings ----

  const STANDING_COLS = [
    ["wins", "W"],
    ["losses", "L"],
    ["ties", "T"],
    ["otLosses", "OTL"],
    ["winPercent", "PCT"],
    ["gamesBehind", "GB"],
  ];

  function standingsCard(summary, ev) {
    const groups = (summary?.standings?.groups || []).filter((g) => g.standings?.entries?.length);
    if (!groups.length) return "";
    const comp = ev.competitions?.[0] || {};
    const ids = new Set((comp.competitors || []).map((c) => String(c.team?.id)));
    const names = new Set((comp.competitors || []).map((c) => c.team?.displayName));
    return groups
      .map((g) => {
        const entries = g.standings.entries;
        const statsOf = (e) => Object.fromEntries((e.stats || []).map((s) => [s.name || s.type, s.displayValue ?? s.value]));
        const cols = STANDING_COLS.filter(([n]) => entries.some((e) => statsOf(e)[n] != null && !(n === "ties" && entries.every((x) => Number(statsOf(x).ties) === 0))));
        const rows = entries
          .map((e) => {
            const name = typeof e.team === "string" ? e.team : e.team?.displayName || e.team?.name || "";
            const mine = ids.has(String(e.id ?? e.team?.id)) || names.has(name);
            const s = statsOf(e);
            const lg = e.logo?.[0]?.href || e.team?.logos?.[0]?.href;
            return `<tr${mine ? ' class="mine"' : ""}><th scope="row">${lg ? `<img class="logo logo-xs" src="${esc(lg)}" alt="" loading="lazy" />` : ""}${esc(name)}</th>${cols
              .map(([n]) => `<td>${esc(s[n] ?? "")}</td>`)
              .join("")}</tr>`;
          })
          .join("");
        return gcard(
          g.header || g.name || "Standings",
          `<div class="table-scroll"><table class="standings"><thead><tr><th></th>${cols.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`
        );
      })
      .join("");
  }

  // ---------- team picker ----------

  function openTeams(leagueKey) {
    if (leagueKey) state.pickerLeague = leagueKey;
    else if (state.view !== "home") state.pickerLeague = state.view;
    searchEl.value = "";
    renderPicker();
    if (!teamsDialog.open) teamsDialog.showModal();
    loadPickerTeams();
  }

  async function loadPickerTeams() {
    const key = state.pickerLeague;
    if (state.teams[key]) return;
    try {
      state.teams[key] = await fetchTeams(key);
    } catch (err) {
      state.teams[key] = null;
      if (state.pickerLeague === key) teamListEl.innerHTML = `<p class="loading">Couldn't load teams (${esc(err.message)}).</p>`;
      return;
    }
    if (state.pickerLeague === key) renderPicker();
  }

  function renderPicker() {
    const key = state.pickerLeague;
    pickerNavEl.innerHTML = LEAGUES.map((l) => {
      const count = [...state.favorites.values()].filter((f) => f.league === l.key).length;
      return `<button class="chip${l.key === key ? " active" : ""}" data-picker="${l.key}">${esc(shortName(l))}${count ? ` <span class="count">${count}</span>` : ""}</button>`;
    }).join("");

    const teams = state.teams[key];
    if (!teams) {
      teamListEl.innerHTML = '<p class="loading">Loading teams…</p>';
      return;
    }
    const q = searchEl.value.trim().toLowerCase();
    const list = teams.filter((t) => !q || `${t.name} ${t.abbr}`.toLowerCase().includes(q));
    // Followed teams first so they're easy to find and unfollow.
    list.sort((a, b) => Number(state.favorites.has(b.key)) - Number(state.favorites.has(a.key)));
    teamListEl.innerHTML = list.length
      ? list
          .map((t) => {
            const on = state.favorites.has(t.key);
            return `
          <button class="team-item${on ? " on" : ""}" data-team="${esc(t.key)}" aria-pressed="${on}">
            ${logo({ logo: t.logo, color: t.color })}
            <span class="team-item-name">${esc(t.name)}</span>
            <span class="check">${on ? "✓" : "+"}</span>
          </button>`;
          })
          .join("")
      : '<p class="loading">No teams match.</p>';
  }

  function toggleFavorite(key, info) {
    if (state.favorites.has(key)) state.favorites.delete(key);
    else if (info) state.favorites.set(key, info);
    state.nexts.delete(key);
    saveFavorites();
  }

  function teamInfoFromEvent(key) {
    const [league, id] = key.split(":");
    const ev = state.openGame?.event;
    const c = ev?.competitions?.[0]?.competitors?.find((x) => String(x.team?.id) === id);
    if (!c) return null;
    const t = c.team;
    return { key, league, id, abbr: t.abbreviation, name: t.displayName, short: t.shortDisplayName, logo: t.logo || "", color: t.color || "" };
  }

  // ---------- navigation ----------

  function setView(view) {
    if (view !== "home" && !byKey[view]) view = "home";
    if (state.view === view && state.seq) return;
    state.view = view;
    if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
    render();
    refresh();
  }

  function stepDay(n) {
    const ls = leagueState(state.view);
    ls.cursor = { date: addDays(ls.cursor?.date || today(), n) };
    goTo();
  }

  function goToDay(date) {
    leagueState(state.view).cursor = { date };
    goTo();
  }

  function goToWeek(idx) {
    const ls = leagueState(state.view);
    const w = ls.weeks[idx];
    if (!w) return;
    ls.cursor = { season: ls.cursor?.season, seasonType: w.seasonType, week: w.week };
    goTo();
  }

  function goTo() {
    const ls = leagueState(state.view);
    ls.events = [];
    ls.lastUpdated = null;
    ls.error = null;
    render();
    refresh();
  }

  // ---------- events ----------

  navEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) setView(btn.dataset.view);
  });

  toolbarEl.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (step && !step.disabled) {
      const n = Number(step.dataset.step);
      if (byKey[state.view].mode === "day") stepDay(n);
      else {
        const ls = leagueState(state.view);
        const idx = ls.weeks.findIndex((w) => w.seasonType === ls.cursor?.seasonType && w.week === ls.cursor?.week);
        goToWeek(idx + n);
      }
      return;
    }
    if (e.target.closest("[data-today]")) goToDay(today());
  });

  toolbarEl.addEventListener("change", (e) => {
    if (e.target.id === "week-select") goToWeek(Number(e.target.value));
  });

  gamesEl.addEventListener("click", (e) => {
    const c = e.target.closest(".card");
    if (c) openGame(c.dataset.key);
  });

  gamesEl.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) {
      e.preventDefault();
      openGame(e.target.dataset.key);
    }
  });

  emptyEl.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-teams]")) openTeams("nfl");
    const day = e.target.closest("[data-goto-day]");
    if (day) goToDay(day.dataset.gotoDay);
  });

  detailEl.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      state.detailTab = tab.dataset.tab;
      renderDetail();
      return;
    }
    const btn = e.target.closest("[data-follow]");
    if (!btn) return;
    toggleFavorite(btn.dataset.follow, teamInfoFromEvent(btn.dataset.follow));
    renderDetail();
    if (state.view === "home") refresh();
    else render();
  });

  $("teams-btn").addEventListener("click", () => openTeams());
  $("close-teams").addEventListener("click", () => teamsDialog.close());
  $("close-game").addEventListener("click", () => gameDialog.close());
  $("prev-game").addEventListener("click", () => stepGame(-1));
  $("next-game").addEventListener("click", () => stepGame(1));

  detailEl.addEventListener("scroll", updateStuck, { passive: true });

  // Share the score: the phone's share sheet where there is one, otherwise copy it.
  $("share-game").addEventListener("click", async () => {
    const ev = state.openGame?.event;
    if (!ev) return;
    const { away, home } = sides(ev.competitions?.[0]);
    const st = gameState(ev);
    const text =
      st === "pre"
        ? `${away?.team?.abbreviation} at ${home?.team?.abbreviation} · ${startText(ev, true)}`
        : `${away?.team?.abbreviation} ${away?.score} – ${home?.score} ${home?.team?.abbreviation} · ${ev.status?.type?.shortDetail || ""}`;
    const url = `${location.origin}${location.pathname}#${ev._league}`;
    try {
      if (navigator.share) await navigator.share({ title: ev.name || "Scoreline", text, url });
      else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        toast("Score copied");
      }
    } catch {
      /* share sheet dismissed */
    }
  });

  // Swipe sideways between games, like flipping through cards.
  let touch = null;
  detailEl.addEventListener(
    "touchstart",
    (e) => {
      const t = e.touches[0];
      touch = e.target.closest(".table-scroll, .gd-tabs, .box-card") ? null : { x: t.clientX, y: t.clientY };
    },
    { passive: true }
  );
  detailEl.addEventListener(
    "touchend",
    (e) => {
      if (!touch) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) stepGame(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );
  gameDialog.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") stepGame(1);
    if (e.key === "ArrowLeft") stepGame(-1);
  });

  pickerNavEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-picker]");
    if (!btn) return;
    state.pickerLeague = btn.dataset.picker;
    renderPicker();
    loadPickerTeams();
  });

  searchEl.addEventListener("input", renderPicker);

  teamListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-team]");
    if (!btn) return;
    const key = btn.dataset.team;
    const info = state.teams[state.pickerLeague]?.find((t) => t.key === key);
    toggleFavorite(key, info);
    renderPicker();
  });

  for (const d of [gameDialog, teamsDialog]) {
    d.addEventListener("click", (e) => {
      if (e.target === d) d.close();
    });
  }

  gameDialog.addEventListener("close", () => {
    state.openGame = null;
  });

  teamsDialog.addEventListener("close", () => {
    if (state.view === "home") refresh();
    else render();
  });

  window.addEventListener("hashchange", () => setView(location.hash.slice(1) || "home"));

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
    else if (!alertsWatching()) clearTimeout(state.timer);
  });

  alertsBtn.addEventListener("click", toggleAlerts);

  // ---------- install ----------

  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    installBtn.hidden = true;
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // ---------- start ----------

  const initial = location.hash.slice(1);
  state.view = byKey[initial] ? initial : "home";
  if (!initial && !state.favorites.size) state.view = "home";
  renderAlertsBtn();
  render();
  refresh();
})();
