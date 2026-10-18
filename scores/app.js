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
  const SETTINGS_KEY = "scoreline.alertSettings";
  const REMIND_KEY = "scoreline.reminders";

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
  const panelEl = $("panel");
  const tabbarEl = $("tabbar");
  const videoDialog = $("video-dialog");
  const toastEl = $("toast");
  const alertsDialog = $("alerts-dialog");
  const alertsBody = $("alerts-body");

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
    leagueClocks: {}, // "nhl:TOR@BOS" -> { secs, running, period, at }
    tab: "scores", // scores | standings | videos | news
    tabLeague: { standings: "nfl", videos: "home", news: "home" },
    tabVariant: {}, // "standings:nfl" -> "division" | "conference"
    tabData: {}, // "tab:league:variant" -> { data, error, at, loading }
    alerts: loadAlerts(),
    alertSettings: loadJSON(SETTINGS_KEY, {}),
    reminders: new Map(loadJSON(REMIND_KEY, []).map((r) => [r.key, r])), // event key -> { key, league, id, date, name }
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

  function loadJSON(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable; lasts for this visit only */
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
    await syncLeagueClocks();
    if (seq !== state.seq) return;

    syncOpenGame();
    syncClocks();
    // Scores keep updating behind the other tabs; only redraw what's on screen.
    if (state.tab === "scores") render();
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
    if (!state.alerts || (!state.favorites.size && !state.reminders.size)) return false;
    const soon = Date.now() + 30 * 60 * 1000;
    return alertEvents().some((ev) => gameState(ev) === "in" || (gameState(ev) === "pre" && new Date(ev.date).getTime() < soon));
  }

  // Games the app can alert about while it's open: your teams' and the ones you set reminders for.
  function alertEvents() {
    const seen = new Map();
    for (const ev of [...state.home.events, ...currentEvents()]) {
      if (isFavGame(ev) || state.reminders.has(ev._key)) seen.set(ev._key, ev);
    }
    return [...seen.values()];
  }

  // ---- alert settings ----

  const DEFAULT_SETTINGS = { start: true, scores: "all", close: true, redzone: false, finals: true, live: false, quiet: null };
  const alertSettings = () => ({ ...DEFAULT_SETTINGS, ...state.alertSettings });
  const timeZone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  };

  function setAlertSetting(key, value) {
    state.alertSettings = { ...alertSettings(), [key]: value };
    saveJSON(SETTINGS_KEY, state.alertSettings);
    schedulePushSync();
  }

  function inQuietHours() {
    const q = alertSettings().quiet;
    if (!q) return false;
    const d = new Date();
    const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return q.from <= q.to ? t >= q.from && t < q.to : t >= q.from || t < q.to;
  }

  const CLOSE_MARGIN = { football: 8, basketball: 10, baseball: 2, hockey: 1 };

  // ---- game reminders ----

  function saveReminders() {
    saveJSON(REMIND_KEY, [...state.reminders.values()]);
  }

  // Drop reminders for games that finished a while ago.
  function pruneReminders() {
    const cutoff = Date.now() - 12 * 3600000;
    let changed = false;
    for (const [k, r] of state.reminders) {
      if (Date.parse(r.date) < cutoff) {
        state.reminders.delete(k);
        changed = true;
      }
    }
    if (changed) saveReminders();
  }

  async function toggleReminder(key) {
    if (state.reminders.has(key)) {
      state.reminders.delete(key);
      saveReminders();
      toast("Reminder removed");
      schedulePushSync();
      return;
    }
    const ev = findEvent(key);
    if (!ev) return;
    const { away, home } = sides(ev.competitions?.[0]);
    state.reminders.set(key, {
      key,
      league: ev._league,
      id: String(ev.id),
      date: ev.date,
      name: `${away?.team?.abbreviation || "Away"} at ${home?.team?.abbreviation || "Home"}`,
    });
    saveReminders();
    // Reminders need alerts on; turn them on now if they aren't.
    if (!state.alerts) {
      await toggleAlerts(true);
      if (!state.alerts) {
        state.reminders.delete(key);
        saveReminders();
        return;
      }
    } else schedulePushSync();
    toast(`We'll let you know when ${state.reminders.get(key).name} starts`);
  }

  function remindButton(ev) {
    const on = state.reminders.has(ev._key);
    return `<button class="remind-btn${on ? " on" : ""}" data-remind="${esc(ev._key)}" aria-pressed="${on}"
      aria-label="${on ? "Remove reminder" : "Remind me when this game starts"}">${BELL_SVG}</button>`;
  }

  function checkAlerts() {
    // When the alerts server is sending alerts, the app doesn't send its own copies.
    const notifyOK = state.alerts && !state.pushActive && alertsSupported() && Notification.permission === "granted" && !inQuietHours();
    const set = alertSettings();
    for (const ev of alertEvents()) {
      const reminded = state.reminders.has(ev._key);
      const followed = isFavGame(ev);
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

      const sport = byKey[ev._league]?.sport;
      const close = Math.abs(now.a - now.h) <= (CLOSE_MARGIN[sport] ?? 8);
      const wantScores = set.scores === "all" || (set.scores === "close" && close);

      if (prev.st === "pre" && st === "in" && (reminded || (followed && set.start))) {
        notify(ev, `${name(away)} at ${name(home)} has started`, status);
      }
      for (const [c, before, after] of [
        [away, prev.a, now.a],
        [home, prev.h, now.h],
      ]) {
        // Baskets come too fast to announce one by one.
        if (fav(c) && after > before && wantScores && sport !== "basketball") {
          const last = comp.situation?.lastPlay?.text;
          notify(ev, `${name(c)} score!`, [`${line} · ${status}`, last].filter(Boolean).join("\n"));
        }
      }
      if (prev.st === "in" && st === "post" && followed && set.finals) {
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

  // ---- push alerts from the alerts server (work with the app closed) ----

  const ALERTS_SERVER = String(window.SCORELINE_CONFIG?.alertsServer || "").replace(/\/$/, "");
  const pushSupported = () => !!ALERTS_SERVER && "PushManager" in window && "serviceWorker" in navigator;

  const BELL_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1Z"/></svg>';

  const fromB64url = (str) => {
    const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  };

  async function postServer(path, body) {
    const res = await fetch(`${ALERTS_SERVER}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Sign this phone up with the alerts server and tell it which teams to watch.
  async function syncPush() {
    if (!pushSupported() || !state.alerts || Notification.permission !== "granted") return false;
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch(`${ALERTS_SERVER}/vapid`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const key = fromB64url((await res.json()).publicKey);
    let sub = await reg.pushManager.getSubscription();
    // A subscription made for a different server key can't receive our alerts; replace it.
    const current = sub?.options?.applicationServerKey;
    if (sub && current && !new Uint8Array(current).every((b, i) => b === key[i])) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const teams = [...state.favorites.values()].map((f) => ({ league: f.league, id: f.id }));
    pruneReminders();
    const reminders = [...state.reminders.values()].map((r) => ({ league: r.league, id: r.id, date: r.date }));
    await postServer("/subscribe", { subscription: sub.toJSON(), teams, reminders, settings: { ...alertSettings(), tz: timeZone() } });
    state.pushActive = true;
    return sub;
  }

  async function stopPush() {
    state.pushActive = false;
    if (!pushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      await postServer("/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    } catch {
      /* nothing left to undo */
    }
  }

  // Following or unfollowing a team updates the server's list, a moment later.
  let pushSyncTimer = null;
  function schedulePushSync() {
    if (!state.alerts || !pushSupported()) return;
    clearTimeout(pushSyncTimer);
    pushSyncTimer = setTimeout(() => syncPush().catch(() => {}), 1500);
  }

  async function toggleAlerts(turnOn = !state.alerts) {
    if (!turnOn) {
      state.alerts = false;
      saveAlerts();
      renderAlertsBtn();
      toast("Score alerts off");
      stopPush();
      renderAlertSettings();
      return;
    }
    if (state.alerts) return;
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.");
      return;
    }
    state.alerts = true;
    saveAlerts();
    renderAlertsBtn();
    renderAlertSettings();
    refresh();
    if (!pushSupported()) {
      toast(state.favorites.size ? "Score alerts on for your teams" : "Score alerts on. Follow some teams to get them.");
      return;
    }
    toast("Turning on score alerts…");
    try {
      const sub = await syncPush();
      // A test alert proves the whole path works, end to end.
      await postServer("/test", { endpoint: sub.endpoint });
      toast("Score alerts on. A test alert is on its way.");
    } catch {
      toast("Couldn't reach the alerts server, so alerts will only come while the app is open.");
    }
  }

  function renderAlertsBtn() {
    alertsBtn.hidden = !alertsSupported();
    alertsBtn.classList.toggle("on", state.alerts);
    alertsBtn.setAttribute("aria-pressed", state.alerts);
    alertsBtn.setAttribute("aria-label", state.alerts ? "Score alerts on" : "Score alerts off");
    alertsBtn.title = state.alerts ? "Score alerts on" : "Turn on score alerts";
  }

  // The Alerts sheet: what to be told about, quiet hours and reminders.
  function openAlertSettings() {
    if (!alertsDialog.open) alertsDialog.showModal();
    renderAlertSettings();
  }

  function renderAlertSettings() {
    if (!alertsDialog.open) return;
    const set = alertSettings();
    const on = state.alerts;
    const sw = (key, checked, label, desc = "", disabled = !on) => `
      <label class="set-row${disabled ? " off" : ""}">
        <span class="set-text"><span class="set-label">${label}</span>${desc ? `<span class="set-desc">${desc}</span>` : ""}</span>
        <input type="checkbox" class="switch" data-setting="${key}"${checked ? " checked" : ""}${disabled ? " disabled" : ""} />
      </label>`;
    const seg = (key, value, options) => `
      <div class="seg" role="radiogroup">
        ${options.map(([v, label]) => `<button role="radio" aria-checked="${v === value}" class="${v === value ? "on" : ""}" data-seg="${key}" data-value="${v}"${on ? "" : " disabled"}>${label}</button>`).join("")}
      </div>`;
    const reminders = [...state.reminders.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const when = (r) =>
      new Date(r.date).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    alertsBody.innerHTML = `
      <div class="set-group">
        ${sw("alerts", on, "Score alerts", state.favorites.size ? `For your ${state.favorites.size} team${state.favorites.size === 1 ? "" : "s"}, even when the app is closed` : "Follow some teams to get alerts", false)}
      </div>
      <h3 class="set-head">Tell me about</h3>
      <div class="set-group">
        ${sw("start", set.start, "Game starts")}
        <div class="set-row${on ? "" : " off"}">
          <span class="set-text"><span class="set-label">Scores</span><span class="set-desc">Basketball sends quarter scores instead of every basket</span></span>
        </div>
        <div class="set-row seg-row">${seg("scores", set.scores, [["all", "Every score"], ["close", "Close games"], ["off", "Off"]])}</div>
        ${sw("close", set.close, "Close finishes", "One alert when a game is close near the end")}
        ${sw("redzone", set.redzone, "Red zone", "When your team gets inside the 20 (football)")}
        ${sw("finals", set.finals, "Final scores")}
      </div>
      <h3 class="set-head">Live score</h3>
      <div class="set-group">
        ${sw("live", set.live, "Live score notification", "One notification per game that updates quietly as it's played, like a Live Activity")}
      </div>
      <h3 class="set-head">Quiet hours</h3>
      <div class="set-group">
        ${sw("quiet", !!set.quiet, "Quiet hours", "No alert sounds at these times. The live score still updates.")}
        ${
          set.quiet
            ? `<div class="set-row time-row${on ? "" : " off"}">
                <label>From <input type="time" data-quiet="from" value="${esc(set.quiet.from)}"${on ? "" : " disabled"} /></label>
                <label>To <input type="time" data-quiet="to" value="${esc(set.quiet.to)}"${on ? "" : " disabled"} /></label>
              </div>`
            : ""
        }
      </div>
      <h3 class="set-head">Reminders</h3>
      <div class="set-group">
        ${
          reminders.length
            ? reminders
                .map(
                  (r) => `<div class="set-row">
                    <span class="set-text"><span class="set-label">${esc(r.name)}</span><span class="set-desc">${esc(byKey[r.league]?.name || "")} · ${esc(when(r))}</span></span>
                    <button class="pill-btn" data-unremind="${esc(r.key)}">Remove</button>
                  </div>`
                )
                .join("")
            : `<p class="set-row set-desc">Tap the bell on any upcoming game to get an alert when it starts.</p>`
        }
      </div>
      ${on && pushSupported() ? `<button class="pill-btn test-btn" data-test-alert>Send a test alert</button>` : ""}`;
  }

  alertsBody.addEventListener("change", (e) => {
    const key = e.target.dataset.setting;
    if (key === "alerts") {
      toggleAlerts(e.target.checked);
      return;
    }
    if (key === "quiet") {
      setAlertSetting("quiet", e.target.checked ? { from: "22:00", to: "08:00" } : null);
    } else if (key) {
      setAlertSetting(key, e.target.checked);
    }
    const q = e.target.dataset.quiet;
    if (q && /^\d\d:\d\d$/.test(e.target.value)) setAlertSetting("quiet", { ...alertSettings().quiet, [q]: e.target.value });
    renderAlertSettings();
  });

  alertsBody.addEventListener("click", async (e) => {
    const seg = e.target.closest("[data-seg]");
    if (seg) {
      setAlertSetting(seg.dataset.seg, seg.dataset.value);
      renderAlertSettings();
      return;
    }
    const un = e.target.closest("[data-unremind]");
    if (un) {
      await toggleReminder(un.dataset.unremind);
      renderAlertSettings();
      render();
      return;
    }
    if (e.target.closest("[data-test-alert]")) {
      try {
        const sub = await syncPush();
        await postServer("/test", { endpoint: sub.endpoint });
        toast("A test alert is on its way");
      } catch {
        toast("Couldn't reach the alerts server");
      }
    }
  });

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
  // says so: a whistle-type play came in (incomplete pass, foul, icing), another
  // part of the game moved on while the clock didn't, or the clock sat still for
  // well over this game's normal gap between ESPN updates.
  const DEFAULT_FEED_GAP = 10; // seconds between clock changes until we've measured this game's
  // We usually learn of a stoppage a few seconds after it, by which time our
  // clock has run past it. For small overshoots, hold the clock where it is
  // instead of jumping back up, and let the real clock catch up once play resumes.
  const HOLD_MAX = 8;
  const debugClock = new URLSearchParams(location.search).has("debug");

  // Plays after which the clock is stopped until the feed shows it moving again.
  const STOP_PLAYS = {
    football:
      /incomplete|time ?out|out of bounds|touchdown|field goal|extra point|two-point|penalty|kicks? off|kickoff|punts?\b|two-minute warning|end of (the )?(quarter|half|game)|injur|challenge|review|intercept|fumble|spiked?|safety|no play/i,
    basketball: /foul|free throw|time ?out|violation|jump ball|end of|review|challenge|substitution|out of bounds/i,
    hockey: /stoppage|icing|offside|penalty|time ?out|end of|goal scored|scores?\b|puck (in|over)|hand pass|review|challenge/i,
  };

  // Breaks between periods, however the feed words them ("END QUARTER 3",
  // "End of the 2nd Period", "Halftime", "End of Game").
  const PERIOD_BREAK = /\bend (of )?(the )?(\d\w* )?(quarter|half|game|period|regulation|overtime)|\bhalf ?time|\bend (quarter|period)\b|\bstart of|\bbeginning of|\bdelay|\breview|\btime ?out/i;

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

  const median = (xs) => {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // How long this game's clock normally goes between changes in the feed.
  const feedGap = (c) => median(c?.gaps || []) ?? DEFAULT_FEED_GAP;
  // Unchanged this long while running means the clock has really stopped.
  const staleAfter = (c) => Math.min(45, Math.max(12, feedGap(c) * 2.2));

  function syncClocks() {
    const now = Date.now();
    const events = [...currentEvents()];
    if (state.openGame) events.push(state.openGame.event);
    if (state.alerts) events.push(...state.home.events);
    const seen = new Set();
    for (const ev of events) {
      if (gameState(ev) !== "in" || seen.has(ev._key)) continue;
      seen.add(ev._key);
      // The NHL's own feed says outright whether the clock is running: use it as is.
      const lc = leagueClockFor(ev);
      if (lc?.running != null) {
        const prev = state.clocks.get(ev._key);
        if (!prev || prev.feedAt !== lc.at) {
          // Same rule as elsewhere: a stop that lands just behind what we showed holds, not bounces.
          const shown = prev ? clockSeconds(ev._key) : null;
          const hold = !lc.running && prev?.period === lc.period && shown != null && lc.secs > shown && lc.secs - shown <= HOLD_MAX ? shown : null;
          state.clocks.set(ev._key, { reported: lc.secs, anchor: lc.secs, anchorAt: lc.at, changedAt: lc.at, running: lc.running, period: lc.period, tenths: false, gaps: [], sig: "", feedAt: lc.at, official: true, hold: hold ?? (lc.running && prev?.hold != null && lc.secs > prev.hold ? prev.hold : null) });
        }
        continue;
      }
      // The NBA's own clock is fresher than ESPN's; read it through the usual rules.
      const p = lc ? { secs: lc.secs, tenths: lc.tenths } : parseClock(ev.status?.displayClock);
      if (!p) {
        state.clocks.delete(ev._key);
        continue;
      }
      const period = lc ? lc.period : ev.status?.period;
      const sig = playSignature(ev);
      const prev = state.clocks.get(ev._key);
      const sport = byKey[ev._league]?.sport;

      if (!prev || period > prev.period) {
        // First look at this clock: rather than waiting to see it move, guess
        // from the last play. A wrong guess runs at most HOLD_MAX seconds and
        // is corrected (held, not bounced) on the next update.
        const last = ev.competitions?.[0]?.situation?.lastPlay?.text || "";
        const detail = ev.status?.type?.detail || "";
        // A new period, or a clock still at a full period (15:00, 12:00, 20:00...),
        // hasn't started yet: that waits for the kickoff, tip or faceoff.
        const notStarted = !!prev || (p.secs >= 300 && p.secs % 60 === 0);
        const guess =
          !notStarted && p.secs > 0 && !!STOP_PLAYS[sport] && !STOP_PLAYS[sport].test(last) && !PERIOD_BREAK.test(last) && !PERIOD_BREAK.test(detail);
        state.clocks.set(ev._key, { reported: p.secs, anchor: p.secs, anchorAt: now, changedAt: now, running: guess, guessed: guess, period, tenths: p.tenths, sig, gaps: prev?.gaps || [] });
        continue;
      }

      // ESPN serves the same game from several places (the scoreboard, the game
      // summary, different servers), and some lag behind others. A clock only
      // counts down, so a reading from an earlier period or with more time left
      // is an older copy: skip it, unless it sticks (officials do add time back).
      if (period < prev.period || p.secs > prev.reported) {
        if (!prev.higherSince) state.clocks.set(ev._key, { ...prev, higherSince: now });
        else if (now - prev.higherSince > 20000 && period === prev.period) {
          state.clocks.set(ev._key, { ...prev, reported: p.secs, anchor: p.secs, anchorAt: now, changedAt: now, running: false, higherSince: null, sig });
        }
        continue;
      }

      const newPlay = sig !== prev.sig;
      const lastText = ev.competitions?.[0]?.situation?.lastPlay?.text || "";
      const whistle = newPlay && (!!STOP_PLAYS[sport]?.test(lastText) || PERIOD_BREAK.test(lastText));

      // The clock shown right now, to hold at if this update says it stopped.
      const holdAt = (secs) => {
        const shown = clockSeconds(ev._key);
        return prev.running && shown != null && secs > shown && secs - shown <= HOLD_MAX ? shown : prev.hold ?? null;
      };

      if (p.secs === prev.reported) {
        // A guessed-running clock that the next update shows unmoved was really stopped.
        const guessWrong = prev.guessed && now - prev.changedAt > feedGap(prev) * 1200;
        if (prev.running && (whistle || newPlay || guessWrong || now - prev.changedAt > staleAfter(prev) * 1000)) {
          state.clocks.set(ev._key, { ...prev, running: false, anchor: p.secs, anchorAt: now, sig, higherSince: null, hold: holdAt(p.secs) });
        } else if (newPlay || prev.higherSince) {
          state.clocks.set(ev._key, { ...prev, sig, higherSince: null });
        }
        continue;
      }

      // The clock moved down.
      const elapsed = (now - prev.changedAt) / 1000;
      const drop = prev.reported - p.secs;
      const gaps = prev.gaps.slice(-7);
      // While it was running, the time between changes is how often ESPN updates this game.
      if (prev.running && elapsed > 1 && Math.abs(elapsed - drop) < 4) gaps.push(elapsed);

      let running = p.secs > 0 && !whistle;
      // If the clock dropped much less than the real time since its last
      // change, it stopped somewhere in between; wait for the next change.
      const slack = Math.max(6, feedGap(prev) * 0.6);
      if (running && prev.running && elapsed - drop > slack && drop < elapsed * 0.5) running = false;
      let anchor = p.secs;
      if (running && prev.running) {
        // The feed lags real time, so it often reads a little behind our running
        // clock. Don't jump backwards for that; only correct real differences.
        const shown = clockSeconds(ev._key);
        if (shown != null && p.secs >= shown && p.secs - shown <= 3) anchor = shown;
      }
      // Stopping: maybe hold where we are. Resuming: keep any hold until the real clock passes it.
      const hold = !running ? holdAt(p.secs) : prev.hold != null && p.secs > prev.hold ? prev.hold : null;
      state.clocks.set(ev._key, { reported: p.secs, anchor, anchorAt: now, changedAt: now, running, period, tenths: p.tenths, sig, gaps, higherSince: null, hold });
    }
    const anyRunning = debugClock || [...state.clocks.values()].some((c) => c.running);
    if (anyRunning && !state.clockTimer) state.clockTimer = setInterval(tickClocks, 100);
    if (!anyRunning && state.clockTimer) {
      clearInterval(state.clockTimer);
      state.clockTimer = null;
    }
  }

  function clockSeconds(key) {
    const c = state.clocks.get(key);
    if (!c) return null;
    if (c.official) {
      // Straight from the league: run while it says running, up to a little past its next refresh.
      const elapsed = c.running ? Math.min((Date.now() - c.anchorAt) / 1000, 40) : 0;
      const secs = Math.max(0, c.anchor - elapsed);
      if (c.hold != null) {
        if (c.running && secs < c.hold) c.hold = null;
        else return c.hold;
      }
      return secs;
    }
    let secs = c.anchor;
    if (c.running) {
      // Never run further past the last change than the feed would normally take
      // to update, and only a few seconds on a guess.
      const elapsed = Math.min((Date.now() - c.anchorAt) / 1000, c.guessed ? HOLD_MAX : staleAfter(c) + 3);
      secs = Math.max(0, c.anchor - elapsed);
    }
    if (c.hold != null) {
      if (c.running && secs < c.hold) c.hold = null; // the real clock has caught up
      else return c.hold;
    }
    return secs;
  }

  // ---- league clock feeds (NHL, NBA) ----

  // ESPN and the leagues spell a few team codes differently.
  const LEAGUE_ABBR = {
    nhl: { NJD: "NJ", LAK: "LA", SJS: "SJ", TBL: "TB", UTA: "UTAH" },
    nba: { GSW: "GS", NYK: "NY", NOP: "NO", SAS: "SA", UTA: "UTAH", WAS: "WSH" },
  };
  const LEAGUE_CLOCK_TTL = 60 * 1000; // ignore a league reading older than this

  // "PT05M32.00S" -> 332
  function isoClock(text) {
    const m = /^PT(\d+)M([\d.]+)S$/.exec(text || "");
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  async function syncLeagueClocks() {
    if (!ALERTS_SERVER || demoMode) return;
    const live = [...currentEvents(), ...(state.openGame ? [state.openGame.event] : []), ...(state.alerts ? state.home.events : [])].filter(
      (ev) => gameState(ev) === "in"
    );
    const leagues = [...new Set(live.map((ev) => ev._league))].filter((l) => l === "nhl" || l === "nba");
    await Promise.allSettled(leagues.map(fetchLeagueClock));
  }

  async function fetchLeagueClock(league) {
    const path = league === "nhl" ? "/nhl/v1/score/now" : "/nba/static/json/liveData/scoreboard/todaysScoreboard_00.json";
    const started = Date.now();
    const res = await fetch(`${ALERTS_SERVER}${path}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    // When the league's copy was taken: now, less its age and half the trip.
    const at = Date.now() - (Number(res.headers.get("X-Data-Age")) || 0) * 1000 - (Date.now() - started) / 2;
    const fix = (code) => LEAGUE_ABBR[league][code] || code;
    const games = league === "nhl" ? data.games || [] : data.scoreboard?.games || [];
    for (const g of games) {
      let entry;
      if (league === "nhl") {
        if (!g.clock || g.gameState !== "LIVE" && g.gameState !== "CRIT") continue;
        entry = {
          teams: [fix(g.awayTeam?.abbrev), fix(g.homeTeam?.abbrev)],
          secs: g.clock.secondsRemaining,
          running: !!g.clock.running && !g.clock.inIntermission,
          period: g.periodDescriptor?.number ?? g.period,
        };
      } else {
        const secs = isoClock(g.gameClock);
        if (g.gameStatus !== 2 || secs == null) continue;
        entry = { teams: [fix(g.awayTeam?.teamTricode), fix(g.homeTeam?.teamTricode)], secs, tenths: secs < 60, running: null, period: g.period };
      }
      state.leagueClocks[`${league}:${entry.teams.join("@")}`] = { ...entry, at };
    }
  }

  function leagueClockFor(ev) {
    if (ev._league !== "nhl" && ev._league !== "nba") return null;
    const { away, home } = sides(ev.competitions?.[0]);
    const lc = state.leagueClocks[`${ev._league}:${away?.team?.abbreviation}@${home?.team?.abbreviation}`];
    return lc && Date.now() - lc.at < LEAGUE_CLOCK_TTL ? lc : null;
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
    // With ?debug, show what the clock logic is seeing, to tune it against real games.
    document.querySelectorAll("[data-clockdbg]").forEach((el) => {
      const c = state.clocks.get(el.dataset.clockdbg);
      if (!c) return;
      const ago = Math.round((Date.now() - c.changedAt) / 1000);
      el.textContent = `ESPN ${formatClock(c.reported)} · changed ${ago}s ago · updates ~${Math.round(feedGap(c))}s (${c.gaps.length}) · ${c.running ? "running" : "stopped"}`;
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
      const dbg = debugClock && long ? `<small class="clock-dbg" data-clockdbg="${esc(ev._key)}"></small>` : "";
      return `<span class="clock${running ? "" : " stopped"}" data-clock="${esc(ev._key)}">${formatClock(secs, state.clocks.get(ev._key)?.tenths)}</span> <span>${esc(rest)}</span>${dbg}`;
    }
    return esc(detail);
  }

  // ---------- rendering: shell ----------

  function render() {
    for (const b of tabbarEl.querySelectorAll("[data-tab]")) {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-current", on ? "page" : "false");
    }
    const scores = state.tab === "scores";
    gamesEl.hidden = !scores;
    statusEl.hidden = !scores;
    panelEl.hidden = scores;
    if (!scores) {
      emptyEl.hidden = true;
      renderTabShell();
      return;
    }
    renderNav();
    keepActiveChipInView();
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
            ${st === "pre" && alertsSupported() ? remindButton(ev) : ""}
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
    ensureGameFeeds(ev._league);
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

  // How far along a game is, from its status: later period, or less time left.
  function progress(status) {
    const p = parseClock(status?.displayClock);
    return (Number(status?.period) || 0) * 100000 - (p ? p.secs : 0);
  }

  function mergeSummaryStatus(ev, summary) {
    const hc = summary?.header?.competitions?.[0];
    if (!hc || gameState(ev) === "post") return;
    // Only take the summary's status and score when it's at least as current as what we have.
    if (!hc.status?.type || progress(hc.status) < progress(ev.status)) return;
    ev.status = { ...ev.status, ...hc.status };
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
    const clips = gameHighlights(ev, summary);
    state.gameClips = clips;
    const tabs = [
      { key: "stats", label: "Stats", html: stats + loading },
      ...(clips.length ? [{ key: "highlights", label: "Highlights", html: highlightsHTML(clips) }] : []),
      {
        key: "plays",
        label: "Plays",
        html: plays || loading || `<p class="loading">${st === "pre" ? "Plays will show up here once the game starts." : "No plays yet."}</p>`,
      },
    ];
    const standings = standingsCard(summary, ev);
    if (standings) tabs.push({ key: "standings", label: "Standings", html: standings });
    return tabs;
  }

  // ---- game highlights ----

  // Clips for one game: ESPN's own game clips (college football and others; the
  // NFL keeps its video off ESPN's feed), plus league YouTube videos and ESPN
  // video stories from around game time that name either team.
  function gameHighlights(ev, summary) {
    const { away, home } = sides(ev.competitions?.[0]);
    const words = [away, home]
      .flatMap((c) => [c?.team?.shortDisplayName, c?.team?.displayName, c?.team?.name])
      .filter((w) => w && w.length >= 4)
      .map((w) => w.toLowerCase());
    const ids = [String(away?.team?.id), String(home?.team?.id)];
    const mentions = (text) => {
      const t = String(text || "").toLowerCase();
      return words.some((w) => t.includes(w));
    };
    const since = new Date(ev.date).getTime() - 24 * 3600 * 1000;
    const recent = (iso) => new Date(iso).getTime() >= since;
    const out = [];
    const titles = new Set();
    const add = (item) => {
      const t = String(item.title || "").toLowerCase();
      if (!item.title || titles.has(t)) return;
      titles.add(t);
      out.push(item);
    };

    for (const v of summary?.videos || []) {
      add({
        kind: "clip",
        title: v.headline,
        thumb: v.thumbnail,
        duration: v.duration,
        src: v.links?.source?.HD?.href || v.links?.source?.href,
        href: v.links?.web?.href || v.links?.mobile?.alert?.href,
        published: v.originalPublishDate || v.lastModified,
      });
    }
    for (const v of state.tabData[tabDataKey("videos", ev._league, "")]?.data || []) {
      if (recent(v.published) && mentions(v.title)) add({ kind: "yt", id: v.id, title: v.title, thumb: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, published: v.published, league: ev._league });
    }
    for (const a of state.tabData[tabDataKey("news", ev._league, "")]?.data || []) {
      if (a.type !== "Media" || !recent(a.published)) continue;
      if (mentions(a.headline) || storyTeams(a).some((id) => ids.includes(id))) {
        add({ kind: "link", title: a.headline, thumb: a.images?.[0]?.url, published: a.published, href: a.links?.web?.href });
      }
    }
    return out.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  }

  // The league's highlight videos and news, shared with the Highlights and News tabs.
  function ensureGameFeeds(league) {
    for (const tab of ["videos", "news"]) {
      const key = tabDataKey(tab, league, "");
      const have = state.tabData[key];
      if (have && (have.loading || Date.now() - have.at < TAB_FRESH)) continue;
      state.tabData[key] = { ...(have || {}), loading: true };
      fetchTab(tab, league, "")
        .then(
          (data) => (state.tabData[key] = { data, at: Date.now(), loading: false }),
          (error) => (state.tabData[key] = { data: have?.data, error, at: Date.now(), loading: false })
        )
        .then(() => {
          if (state.openGame?.event._league === league) renderDetail();
        });
    }
  }

  const clipLength = (secs) => (secs ? `${Math.floor(secs / 60)}:${pad(Math.round(secs % 60))}` : "");

  function highlightsHTML(items) {
    return `<div class="hl-grid">${items
      .map((h, i) => {
        const href = h.kind === "yt" ? watchURL(h.id) : h.href || "#";
        const where = h.kind === "yt" && noEmbed[h.league] ? "YouTube" : h.kind === "link" ? "ESPN" : "";
        return `
          <a class="hl-card" href="${esc(href)}" target="_blank" rel="noopener" data-hl="${h.kind}" data-index="${i}"
            data-src="${esc(h.src || "")}" data-id="${esc(h.id || "")}" data-league="${esc(h.league || "")}" data-title="${esc(h.title)}" data-poster="${esc(h.thumb || "")}">
            <span class="thumb">${h.thumb ? `<img src="${esc(h.thumb)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}<span class="play" aria-hidden="true"></span>${
              h.duration ? `<span class="hl-time">${clipLength(h.duration)}</span>` : ""
            }</span>
            <span class="hl-title">${esc(h.title)}</span>
            <span class="meta-line">${esc([where, h.published ? timeAgo(h.published) : ""].filter(Boolean).join(" · "))}</span>
          </a>`;
      })
      .join("")}</div>`;
  }

  // ---- the player's "More highlights" list ----

  const canPlayHere = (h) => (h.kind === "clip" && !!h.src) || (h.kind === "yt" && !noEmbed[h.league]);
  const itemHref = (h) => (h.kind === "yt" ? watchURL(h.id) : h.href || h.src || "#");

  // Play item i of a list in the app's player, with the rest listed underneath.
  function playFrom(items, i) {
    state.playlist = { items, index: i };
    const h = items[i];
    if (h.kind === "clip") openClip(h.src, h.title, h.href, h.thumb);
    else openVideo(h.id, h.title, h.league);
  }

  function renderMore() {
    const pl = state.playlist;
    const box = $("video-more");
    if (!pl || pl.items.length < 2) {
      box.innerHTML = "";
      videoDialog.classList.remove("has-more");
      return;
    }
    videoDialog.classList.add("has-more");
    box.innerHTML = `
      <h3>More highlights</h3>
      ${pl.items
        .map((h, i) => {
          const here = canPlayHere(h);
          const where = here ? "" : h.kind === "yt" ? "YouTube" : "ESPN";
          return `
            <a class="more-row${i === pl.index ? " playing" : ""}" href="${esc(itemHref(h))}" target="_blank" rel="noopener" data-more="${i}"${i === pl.index ? ' aria-current="true"' : ""}>
              <span class="more-thumb">${h.thumb ? `<img src="${esc(h.thumb)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}${
                h.duration ? `<span class="hl-time">${clipLength(h.duration)}</span>` : ""
              }</span>
              <span class="more-text">
                <span class="more-title">${esc(h.title)}</span>
                <span class="meta-line">${esc([i === pl.index ? "Now playing" : where, h.published ? timeAgo(h.published) : ""].filter(Boolean).join(" · "))}</span>
              </span>
            </a>`;
        })
        .join("")}`;
    box.querySelector(".playing")?.scrollIntoView({ block: "nearest" });
  }

  // When a clip ends, go on to the next one that plays in the app.
  function playNext() {
    const pl = state.playlist;
    if (!pl) return;
    for (let i = pl.index + 1; i < pl.items.length; i++) {
      if (canPlayHere(pl.items[i])) return playFrom(pl.items, i);
    }
  }

  // ESPN clips are plain video files, so they play in the app's own player.
  function openClip(src, title, href, poster) {
    $("video-title").textContent = title;
    const link = $("video-link");
    link.textContent = "Open on ESPN";
    link.href = href || src;
    $("video-box").innerHTML = `<video src="${esc(src)}" ${poster ? `poster="${esc(poster)}"` : ""} controls autoplay playsinline></video>`;
    $("video-box").querySelector("video").addEventListener("ended", playNext);
    if (!videoDialog.open) videoDialog.showModal();
    renderMore();
  }

  // ---- where to watch ----

  // The app that carries a game, from the channel names ESPN lists. Streaming
  // services come first so "ESPN+" isn't mistaken for the ESPN channel.
  // `android` is the app's package name. On Android the button asks that app
  // to open a link it handles (Chrome won't launch an app any other way from a
  // web page): its web address, or for ESPN, its own sportscenter:// links.
  // Without the app installed, the website opens instead.
  const WATCH_SERVICES = {
    yttv: { label: "YouTube TV", url: "https://tv.youtube.com/" },
    prime: { label: "Prime Video", url: "https://www.primevideo.com/", android: "com.amazon.avod.thirdpartyclient" },
    peacock: { label: "Peacock", url: "https://www.peacocktv.com/", android: "com.peacocktv.peacockandroid" },
    netflix: { label: "Netflix", url: "https://www.netflix.com/", android: "com.netflix.mediaclient" },
    appletv: { label: "Apple TV", url: "https://tv.apple.com/" },
    espnapp: { label: "ESPN", url: "https://www.espn.com/watch/", android: "com.espn.score_center", appLink: "sportscenter://x-callback-url/showWatch" },
    max: { label: "Max", url: "https://www.max.com/", android: "com.wbd.stream" },
    youtube: { label: "YouTube", url: "https://www.youtube.com/", android: "com.google.android.youtube" },
  };

  const isAndroid = /Android/i.test(navigator.userAgent);

  function watchHref(svc) {
    if (!isAndroid || !svc.android) return svc.url;
    const link = new URL(svc.appLink || svc.url);
    const scheme = link.protocol.replace(":", "");
    const rest = svc.appLink ? svc.appLink.slice(scheme.length + 3) : `${link.host}${link.pathname}`;
    return `intent://${rest}#Intent;scheme=${scheme};package=${svc.android};S.browser_fallback_url=${encodeURIComponent(svc.url)};end`;
  }
  const WATCH_RULES = [
    [/prime/, "prime"],
    [/peacock/, "peacock"],
    [/netflix/, "netflix"],
    [/apple/, "appletv"],
    [/espn\+|espn plus/, "espnapp"],
    [/^(hbo )?max$/, "max"],
    [/^youtube$/, "youtube"],
    // Channels in YouTube TV's lineup.
    [/^(cbs|fox|nbc|abc|espn|fs1|fs2|fox sports|nfl net|nfln|nba tv|tnt|tbs|trutv|mlb net|nhl net|btn|big ten|sec ?n|acc ?n|usa|golf)/, "yttv"],
  ];

  function watchButtons(comp) {
    const names = (comp.broadcasts || []).flatMap((b) => b.names || []);
    const services = [];
    for (const name of names) {
      const n = String(name).toLowerCase().trim();
      const hit = WATCH_RULES.find(([re]) => re.test(n));
      if (hit && !services.includes(hit[1])) services.push(hit[1]);
    }
    // YouTube TV first when the game is on regular TV, then any streaming option.
    services.sort((a, b) => Number(b === "yttv") - Number(a === "yttv"));
    if (!services.length) return "";
    return `<div class="gd-watch">${services
      .slice(0, 2)
      .map((k) => {
        const svc = WATCH_SERVICES[k];
        return `<a class="watch-btn" href="${esc(watchHref(svc))}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>Watch on ${esc(svc.label)}</a>`;
      })
      .join("")}</div>`;
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
        ${st !== "post" ? watchButtons(comp) : ""}
        ${
          st === "pre" && alertsSupported()
            ? `<button class="remind-pill${state.reminders.has(ev._key) ? " on" : ""}" data-remind="${esc(ev._key)}">${BELL_SVG}${
                state.reminders.has(ev._key) ? "Reminder set" : "Remind me"
              }</button>`
            : ""
        }
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
    schedulePushSync();
  }

  function teamInfoFromEvent(key) {
    const [league, id] = key.split(":");
    const ev = state.openGame?.event;
    const c = ev?.competitions?.[0]?.competitors?.find((x) => String(x.team?.id) === id);
    if (!c) return null;
    const t = c.team;
    return { key, league, id, abbr: t.abbreviation, name: t.displayName, short: t.shortDisplayName, logo: t.logo || "", color: t.color || "" };
  }

  // ---------- standings, highlights and news tabs ----------

  const TAB_TITLES = { standings: "Standings", videos: "Highlights", news: "News" };
  const TAB_FRESH = 5 * 60 * 1000; // reload a tab's data when it's older than this

  // ESPN feeds and YouTube lists come through the alerts server, which can
  // reach them when the browser can't; without one, try ESPN directly.
  async function serverJSON(path) {
    if (demoMode) return window.SCORES_DEMO.feed(path);
    if (ALERTS_SERVER) {
      try {
        return await fetchJSON(`${ALERTS_SERVER}${path}`);
      } catch (err) {
        if (!path.startsWith("/espn/")) throw err;
      }
    }
    if (!path.startsWith("/espn/")) throw new Error("highlights need the alerts server");
    return fetchJSON(`https://site.api.espn.com${path.slice("/espn".length)}`);
  }

  function timeAgo(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (!Number.isFinite(mins)) return "";
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const favLeagues = () => [...new Set([...state.favorites.values()].map((f) => f.league))].filter((l) => byKey[l]);

  function tabChoices(tab) {
    const leagues = LEAGUES.map((l) => ({ key: l.key, label: shortName(l) }));
    return tab === "standings" ? leagues : [{ key: "home", label: "★ My Teams" }, ...leagues];
  }

  function tabLeague(tab) {
    let key = state.tabLeague[tab];
    if (!tabChoices(tab).some((c) => c.key === key)) key = tabChoices(tab)[0].key;
    // "My Teams" with no teams followed has nothing to show; start on a league instead.
    if (key === "home" && !state.favorites.size) key = "nfl";
    return key;
  }

  // Standings come in two layouts; college football has polls instead.
  function tabVariants(tab, league) {
    if (tab !== "standings") return null;
    if (league === "cfb") return [{ key: "ap", label: "AP Top 25" }, { key: "coaches", label: "Coaches Poll" }];
    if (league === "wnba") return null;
    return [{ key: "division", label: "Division" }, { key: "conference", label: "Conference" }];
  }

  const tabVariant = (tab, league) => {
    const vs = tabVariants(tab, league);
    if (!vs) return "";
    const v = state.tabVariant[`${tab}:${league}`];
    return vs.some((x) => x.key === v) ? v : vs[0].key;
  };

  const tabDataKey = (tab, league, variant) => `${tab}:${league}:${variant}`;

  async function loadTab(force = false) {
    const tab = state.tab;
    if (tab === "scores") return;
    const league = tabLeague(tab);
    const variant = tabVariant(tab, league);
    const key = tabDataKey(tab, league, variant);
    const have = state.tabData[key];
    if (!force && have && (have.loading || Date.now() - have.at < TAB_FRESH)) return;
    state.tabData[key] = { ...(have || {}), loading: true };
    render();
    let data = null;
    let error = null;
    try {
      data = await fetchTab(tab, league, variant);
    } catch (err) {
      error = err;
    }
    state.tabData[key] = { data: data ?? have?.data, error, at: Date.now(), loading: false };
    if (state.tab === tab) render();
  }

  async function fetchTab(tab, league, variant) {
    if (tab === "standings") {
      const path = byKey[league].path;
      if (league === "cfb") return serverJSON(`/espn/apis/site/v2/sports/${path}/rankings`);
      return serverJSON(`/espn/apis/v2/sports/${path}/standings${variant === "division" ? "?level=3" : ""}`);
    }
    const leagues = league === "home" ? favLeagues() : [league];
    if (tab === "news") {
      const lists = await Promise.allSettled(
        leagues.map((l) => serverJSON(`/espn/apis/site/v2/sports/${byKey[l].path}/news?limit=50`).then((d) => (d.articles || []).map((a) => ({ ...a, _league: l }))))
      );
      if (lists.every((r) => r.status === "rejected")) throw lists[0].reason;
      return lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    }
    const lists = await Promise.allSettled(leagues.map((l) => serverJSON(`/videos?league=${l}`).then((d) => (d.items || []).map((v) => ({ ...v, _league: l })))));
    if (lists.every((r) => r.status === "rejected")) throw lists[0].reason;
    return lists.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  function renderTabShell() {
    const tab = state.tab;
    const league = tabLeague(tab);
    titleEl.textContent = TAB_TITLES[tab];
    liveEl.hidden = true;
    navEl.innerHTML = tabChoices(tab)
      .map((c) => `<button class="chip${c.key === league ? " active" : ""}" data-tab-league="${c.key}" aria-current="${c.key === league}">${esc(c.label)}</button>`)
      .join("");
    const variants = tabVariants(tab, league);
    toolbarEl.hidden = !variants;
    if (variants) {
      const v = tabVariant(tab, league);
      toolbarEl.innerHTML = `<div class="segmented" role="tablist">${variants
        .map((x) => `<button class="seg${x.key === v ? " active" : ""}" data-variant="${x.key}" aria-selected="${x.key === v}">${esc(x.label)}</button>`)
        .join("")}</div>`;
    }

    const variant = tabVariant(tab, league);
    const entry = state.tabData[tabDataKey(tab, league, variant)];
    let html;
    if (!entry?.data) {
      html = entry?.error
        ? `<p class="loading">Couldn't load ${TAB_TITLES[tab].toLowerCase()} (${esc(entry.error.message)}). <button class="link-btn" data-retry>Try again</button></p>`
        : '<p class="loading">Loading…</p>';
    } else if (tab === "standings") {
      html = league === "cfb" ? rankingsHTML(entry.data, variant) : standingsHTML(entry.data, league, variant);
    } else if (tab === "news") {
      html = newsHTML(entry.data, league);
    } else {
      html = videosHTML(entry.data, league);
    }
    panelEl.innerHTML = html;
    keepActiveChipInView();
  }

  function keepActiveChipInView() {
    const chip = navEl.querySelector(".chip.active");
    if (chip) navEl.scrollLeft = Math.max(0, chip.offsetLeft - navEl.offsetLeft - 16);
  }

  // ---- standings ----

  const STANDING_COLUMNS = {
    football: [["wins", "W"], ["losses", "L"], ["ties", "T"], ["winPercent", "PCT"], ["pointDifferential", "DIFF"], ["streak", "STRK"]],
    basketball: [["wins", "W"], ["losses", "L"], ["winPercent", "PCT"], ["gamesBehind", "GB"], ["Last Ten Games", "L10"], ["streak", "STRK"]],
    baseball: [["wins", "W"], ["losses", "L"], ["winPercent", "PCT"], ["gamesBehind", "GB"], ["Last Ten Games", "L10"], ["streak", "STRK"]],
    hockey: [["gamesPlayed", "GP"], ["wins", "W"], ["losses", "L"], ["otLosses", "OTL"], ["points", "PTS"], ["streak", "STRK"]],
  };

  const statMap = (entry) => Object.fromEntries((entry.stats || []).map((s) => [s.name, s]));

  // Every group in the tree that has its own table (divisions, or conferences when there are none).
  function standingGroups(node, parent = "", out = []) {
    if (node?.standings?.entries?.length) out.push({ title: node.name, parent, entries: node.standings.entries });
    for (const kid of node?.children || []) standingGroups(kid, node.abbreviation || "", out);
    return out;
  }

  function standingsHTML(data, league, variant) {
    const sport = byKey[league].sport;
    const groups = standingGroups(data);
    if (!groups.length) return '<p class="loading">No standings available right now.</p>';
    const num = (s) => Number(s?.value ?? s?.displayValue) || 0;
    const seed = (s) => num(s.playoffSeed) || 99;
    const allTies = groups.every((g) => g.entries.every((e) => !num(statMap(e).ties)));
    const cols = STANDING_COLUMNS[sport].filter(([n]) => !(n === "ties" && allTies));

    return groups
      .map((g) => {
        const rows = g.entries
          .map((e) => ({ e, s: statMap(e) }))
          .sort((a, b) =>
            sport === "hockey"
              ? num(b.s.points) - num(a.s.points) || num(b.s.wins) - num(a.s.wins)
              : variant === "conference" && (a.s.playoffSeed || b.s.playoffSeed)
                ? seed(a.s) - seed(b.s)
                : num(b.s.winPercent) - num(a.s.winPercent) || seed(a.s) - seed(b.s)
          )
          .map(({ e, s }, i) => {
            const t = e.team || {};
            const mine = state.favorites.has(`${league}:${t.id}`);
            const clinch = s.clincher?.displayValue && s.clincher.displayValue !== "-" ? `<sup class="clinch">${esc(s.clincher.displayValue)}</sup>` : "";
            return `<tr class="${mine ? "mine" : ""}">
              <td class="st-rank">${i + 1}</td>
              <th scope="row"><span class="st-team">${logo({ logo: t.logos?.[0]?.href, color: t.color }, "xs")}<span class="st-name">${esc(t.shortDisplayName || t.displayName || t.abbreviation)}</span>${clinch}</span></th>
              ${cols.map(([n]) => `<td>${esc(s[n]?.displayValue ?? "")}</td>`).join("")}
            </tr>`;
          })
          .join("");
        return `
          <section class="st-card">
            <h3>${esc(g.title)}</h3>
            <div class="table-scroll">
              <table class="st-table">
                <thead><tr><th></th><th></th>${cols.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </section>`;
      })
      .join("");
  }

  function rankingsHTML(data, variant) {
    const polls = data.rankings || [];
    const poll = (variant === "coaches" ? polls.find((p) => /coach/i.test(p.name)) : polls.find((p) => /^AP/i.test(p.name))) || polls[0];
    if (!poll?.ranks?.length) return '<p class="loading">No rankings available right now.</p>';
    const rows = poll.ranks
      .map((r) => {
        const t = r.team || {};
        const mine = state.favorites.has(`cfb:${t.id}`);
        const moved = r.previous ? r.previous - r.current : 0;
        const trend = !r.previous ? '<span class="trend new">NEW</span>' : moved ? `<span class="trend ${moved > 0 ? "up" : "down"}">${moved > 0 ? "▲" : "▼"}${Math.abs(moved)}</span>` : '<span class="trend">–</span>';
        return `<tr class="${mine ? "mine" : ""}">
          <td class="st-rank">${esc(r.current)}</td>
          <th scope="row"><span class="st-team">${logo({ logo: t.logos?.[0]?.href || t.logo, color: t.color }, "xs")}<span class="st-name">${esc(t.location || t.nickname || t.name)}</span></span></th>
          <td>${esc(r.recordSummary || "")}</td>
          <td>${trend}</td>
          <td class="st-pts">${r.points ? esc(Math.round(r.points)) : ""}${r.firstPlaceVotes ? ` <small>(${esc(r.firstPlaceVotes)})</small>` : ""}</td>
        </tr>`;
      })
      .join("");
    return `
      <section class="st-card">
        <h3>${esc(poll.name)}</h3>
        <div class="table-scroll">
          <table class="st-table">
            <thead><tr><th></th><th></th><th>REC</th><th></th><th>PTS</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }

  // ---- highlights ----

  // Words that mark a video or story as being about one of your teams.
  function teamWords() {
    return [...state.favorites.values()].flatMap((f) => [f.short, f.name].filter((w) => w && w.length >= 4).map((w) => ({ league: f.league, w: w.toLowerCase() })));
  }

  const aboutMyTeams = (text, league) => {
    const t = String(text || "").toLowerCase();
    return teamWords().some((x) => (!league || x.league === league) && t.includes(x.w));
  };

  const watchURL = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

  // Some leagues don't allow their videos to play inside other apps (the NFL
  // never does). Those open in YouTube instead; we learn the rest as we go.
  const NO_EMBED_KEY = "scoreline.noEmbed";
  function loadNoEmbed() {
    try {
      return { nfl: true, ...JSON.parse(localStorage.getItem(NO_EMBED_KEY) || "{}") };
    } catch {
      return { nfl: true };
    }
  }
  const noEmbed = loadNoEmbed();
  function markNoEmbed(league) {
    noEmbed[league] = true;
    try {
      localStorage.setItem(NO_EMBED_KEY, JSON.stringify(noEmbed));
    } catch {
      /* remembered for this visit only */
    }
  }

  // Every card is a real YouTube link; leagues that allow it play in the app instead.
  function videoCard(v, index) {
    return `
      <a class="video-card" href="${esc(watchURL(v.id))}" target="_blank" rel="noopener" data-video="${esc(v.id)}" data-index="${index}" data-league="${esc(v._league)}">
        <span class="thumb"><img src="${esc(v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`)}" alt="" loading="lazy" onerror="this.remove()" /><span class="play" aria-hidden="true"></span></span>
        <span class="video-title">${esc(v.title)}</span>
        <span class="meta-line">${esc([state.tabLeague.videos === "home" ? shortName(byKey[v._league]) : "", noEmbed[v._league] ? "YouTube" : "", timeAgo(v.published)].filter(Boolean).join(" · "))}</span>
      </a>`;
  }

  function videosHTML(items, league) {
    const sorted = items.slice().sort((a, b) => new Date(b.published) - new Date(a.published));
    if (!sorted.length) return '<p class="loading">No highlights right now.</p>';
    const mine = league === "home" ? sorted.filter((v) => aboutMyTeams(v.title, v._league)) : [];
    const rest = sorted.filter((v) => !mine.includes(v));
    // The player's "More highlights" list follows the same order as the page.
    state.tabClips = [...mine, ...rest].map((v) => ({
      kind: "yt",
      id: v.id,
      title: v.title,
      thumb: v.thumbnail || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      published: v.published,
      league: v._league,
    }));
    const card = (v) => videoCard(v, state.tabClips.findIndex((c) => c.id === v.id));
    if (league !== "home") return `<div class="video-grid">${rest.map(card).join("")}</div>`;
    return `
      ${mine.length ? `<h2 class="panel-h">Your teams</h2><div class="video-grid">${mine.map(card).join("")}</div>` : '<p class="panel-note">No new videos about your teams yet. Here\'s the latest from their leagues.</p>'}
      <h2 class="panel-h">Latest</h2>
      <div class="video-grid">${rest.map(card).join("")}</div>`;
  }

  let ytAPI = null;
  function loadYouTubeAPI() {
    ytAPI ||= new Promise((resolve, reject) => {
      if (window.YT?.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => reject(new Error("YouTube didn't load"));
      document.head.appendChild(script);
      setTimeout(() => reject(new Error("YouTube took too long")), 8000);
    }).catch((err) => {
      ytAPI = null;
      throw err;
    });
    return ytAPI;
  }

  let player = null;
  function openVideo(id, title, league) {
    $("video-title").textContent = title;
    $("video-link").textContent = "Open in YouTube";
    $("video-link").href = watchURL(id);
    const box = $("video-box");
    box.innerHTML = '<div id="video-player"></div>';
    if (!videoDialog.open) videoDialog.showModal();
    renderMore();
    loadYouTubeAPI()
      .then((YT) => {
        if (!videoDialog.open) return;
        player = new YT.Player("video-player", {
          videoId: id,
          host: "https://www.youtube-nocookie.com",
          playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
          events: {
            // 101 and 150: the owner doesn't allow playing it outside YouTube.
            onError: (e) => {
              if (e.data !== 101 && e.data !== 150) return;
              markNoEmbed(league);
              renderMore();
              box.innerHTML = `
                <div class="video-blocked">
                  <p>${esc(byKey[league]?.name || "This league")} only lets this video play on YouTube.</p>
                  <a class="primary-btn" href="${esc(watchURL(id))}" target="_blank" rel="noopener">Watch on YouTube</a>
                </div>`;
            },
          },
        });
      })
      .catch(() => {
        // Without YouTube's player script, a plain embed still plays most videos.
        box.innerHTML = `<iframe title="Highlight video" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
      });
  }

  // ---- news ----

  // ESPN tags stories with the teams they're about.
  function storyTeams(a) {
    return (a.categories || []).filter((c) => c.type === "team").map((c) => String(c.teamId ?? c.team?.id ?? ""));
  }

  const isMyStory = (a) =>
    storyTeams(a).some((id) => state.favorites.has(`${a._league}:${id}`)) || aboutMyTeams(`${a.headline} ${a.description}`, a._league);

  function storyCard(a) {
    const img = a.images?.[0]?.url;
    const href = a.links?.web?.href || a.links?.mobile?.href || "#";
    const label = a.type === "Media" ? "Video" : a.type === "Recap" ? "Recap" : "";
    return `
      <a class="story" href="${esc(href)}" target="_blank" rel="noopener">
        ${img ? `<span class="story-img"><img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()" />${a.type === "Media" ? '<span class="play" aria-hidden="true"></span>' : ""}</span>` : ""}
        <span class="story-text">
          <span class="story-head">${esc(a.headline)}</span>
          ${a.description ? `<span class="story-desc">${esc(a.description)}</span>` : ""}
          <span class="meta-line">${esc([state.tabLeague.news === "home" ? shortName(byKey[a._league]) : "", label, timeAgo(a.published)].filter(Boolean).join(" · "))}</span>
        </span>
      </a>`;
  }

  function newsHTML(items, league) {
    const seen = new Set();
    const sorted = items
      .filter((a) => a.headline && !seen.has(a.id ?? a.headline) && seen.add(a.id ?? a.headline))
      .sort((a, b) => new Date(b.published) - new Date(a.published));
    if (!sorted.length) return '<p class="loading">No news right now.</p>';
    if (league !== "home") return `<div class="stories">${sorted.map(storyCard).join("")}</div>`;
    const mine = sorted.filter(isMyStory);
    return `
      ${mine.length ? `<h2 class="panel-h">Your teams</h2><div class="stories">${mine.map(storyCard).join("")}</div>` : '<p class="panel-note">No recent stories about your teams. Here\'s the latest from their leagues.</p>'}
      <h2 class="panel-h">Latest</h2>
      <div class="stories">${sorted.filter((a) => !mine.includes(a)).slice(0, 30).map(storyCard).join("")}</div>`;
  }

  function setTab(tab) {
    if (!["scores", "standings", "videos", "news"].includes(tab)) tab = "scores";
    state.tab = tab;
    syncHash();
    window.scrollTo(0, 0);
    render();
    if (tab === "scores") refresh();
    else loadTab();
  }

  function syncHash() {
    const want = state.tab === "scores" ? `#${state.view}` : `#${state.tab}/${tabLeague(state.tab)}`;
    if (location.hash !== want) history.replaceState(null, "", want);
  }

  // "#nba" is a scores view; "#standings/nfl", "#news/home" and the like pick a tab.
  function readHash() {
    const [a, b] = location.hash.slice(1).split("/");
    if (TAB_TITLES[a]) {
      state.tab = a;
      if (b && tabChoices(a).some((c) => c.key === b)) state.tabLeague[a] = b;
    } else {
      state.tab = "scores";
      state.view = byKey[a] ? a : "home";
    }
  }

  // ---------- navigation ----------

  function setView(view) {
    if (view !== "home" && !byKey[view]) view = "home";
    if (state.view === view && state.seq) return;
    state.view = view;
    syncHash();
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
    const pick = e.target.closest("[data-tab-league]");
    if (pick) {
      state.tabLeague[state.tab] = pick.dataset.tabLeague;
      syncHash();
      render();
      loadTab();
    }
  });

  tabbarEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tab]");
    if (btn) setTab(btn.dataset.tab);
  });

  panelEl.addEventListener("click", (e) => {
    const video = e.target.closest("[data-video]");
    // Leagues that block in-app playback just follow the link to YouTube.
    if (video && !noEmbed[video.dataset.league]) {
      e.preventDefault();
      playFrom(state.tabClips, Number(video.dataset.index));
    }
    if (e.target.closest("[data-retry]")) loadTab(true);
  });

  $("close-video").addEventListener("click", () => videoDialog.close());
  $("video-more").addEventListener("click", (e) => {
    const row = e.target.closest("[data-more]");
    const pl = state.playlist;
    if (!row || !pl) return;
    const i = Number(row.dataset.more);
    // Videos that only play elsewhere just follow their link.
    if (!canPlayHere(pl.items[i])) return;
    e.preventDefault();
    playFrom(pl.items, i);
  });
  videoDialog.addEventListener("click", (e) => {
    if (e.target === videoDialog) videoDialog.close();
  });
  // Stop playback when the player closes.
  videoDialog.addEventListener("close", () => {
    try {
      player?.destroy();
    } catch {
      /* already gone */
    }
    player = null;
    $("video-box").innerHTML = "";
    state.playlist = null;
    renderMore();
  });

  toolbarEl.addEventListener("click", (e) => {
    const variant = e.target.closest("[data-variant]");
    if (variant) {
      state.tabVariant[`${state.tab}:${tabLeague(state.tab)}`] = variant.dataset.variant;
      render();
      loadTab();
      return;
    }
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

  gamesEl.addEventListener("click", async (e) => {
    const bell = e.target.closest("[data-remind]");
    if (bell) {
      e.stopPropagation();
      await toggleReminder(bell.dataset.remind);
      render();
      return;
    }
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
    const hl = e.target.closest("[data-hl]");
    if (hl) {
      const i = Number(hl.dataset.index);
      const clips = state.gameClips || [];
      if (clips[i] && canPlayHere(clips[i])) {
        e.preventDefault();
        playFrom(clips, i);
      }
      return;
    }
    const bell = e.target.closest("[data-remind]");
    if (bell) {
      toggleReminder(bell.dataset.remind).then(() => {
        renderDetail();
        render();
      });
      return;
    }
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

  window.addEventListener("hashchange", () => {
    const before = `${state.tab}:${state.view}`;
    readHash();
    if (`${state.tab}:${state.view}` === before && state.tab === "scores") return;
    render();
    if (state.tab === "scores") refresh();
    else loadTab();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.tab !== "scores") loadTab();
    if (!document.hidden) refresh();
    else if (!alertsWatching()) clearTimeout(state.timer);
  });

  alertsBtn.addEventListener("click", openAlertSettings);
  $("close-alerts").addEventListener("click", () => alertsDialog.close());
  alertsDialog.addEventListener("click", (e) => {
    if (e.target === alertsDialog) alertsDialog.close();
  });

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
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker
      .register("sw.js", { updateViaCache: "none" })
      .then((reg) => {
        // Look for a new version whenever the app comes back to the front.
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) reg.update().catch(() => {});
        });
      })
      .catch(() => {});
    // A new version took over: reload once so it's what you're looking at.
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
  }

  // ---------- start ----------

  readHash();
  renderAlertsBtn();
  render();
  refresh();
  if (state.tab !== "scores") loadTab();
  // Keep the server's copy of your teams current, and renew the sign-up if the browser dropped it.
  if (state.alerts) syncPush().catch(() => {});
})();
