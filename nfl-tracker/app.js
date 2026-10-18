(() => {
  "use strict";

  const API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
  const FAV_KEY = "nfl-tracker.favorites";
  const FILTER_KEY = "nfl-tracker.filter";

  // Refresh cadence depends on what's happening: fast while games are live,
  // slower when a kickoff is near, and lazy otherwise.
  const REFRESH_LIVE = 10 * 1000;
  const REFRESH_SOON = 60 * 1000;
  const REFRESH_IDLE = 5 * 60 * 1000;

  const demoMode = new URLSearchParams(location.search).has("demo");

  const gamesEl = document.getElementById("games");
  const emptyEl = document.getElementById("empty-state");
  const statusEl = document.getElementById("status-line");
  const liveEl = document.getElementById("live-indicator");
  const weekSelect = document.getElementById("week-select");
  const prevBtn = document.getElementById("prev-week");
  const nextBtn = document.getElementById("next-week");
  const dialog = document.getElementById("game-dialog");
  const detailEl = document.getElementById("game-detail");

  const state = {
    season: null,
    seasonType: null,
    week: null,
    weeks: [], // [{ seasonType, week, label }]
    events: [],
    filter: loadFilter(),
    favorites: loadFavorites(),
    lastScores: new Map(),
    openGameId: null,
    timer: null,
    lastUpdated: null,
    error: null,
  };

  // ---------- storage ----------

  function loadFavorites() {
    try {
      return new Set(JSON.parse(localStorage.getItem(FAV_KEY)) || []);
    } catch {
      return new Set();
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
    } catch {
      /* storage unavailable; favorites last for this visit only */
    }
  }

  function loadFilter() {
    try {
      return localStorage.getItem(FILTER_KEY) || "all";
    } catch {
      return "all";
    }
  }

  function saveFilter() {
    try {
      localStorage.setItem(FILTER_KEY, state.filter);
    } catch {
      /* ignore */
    }
  }

  // ---------- data ----------

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function scoreboardURL() {
    const params = new URLSearchParams();
    if (state.week != null) {
      params.set("seasontype", state.seasonType);
      params.set("week", state.week);
      if (state.season) params.set("dates", state.season);
    }
    const qs = params.toString();
    return `${API}/scoreboard${qs ? `?${qs}` : ""}`;
  }

  async function loadScoreboard() {
    if (demoMode) return window.NFL_DEMO.scoreboard();
    return fetchJSON(scoreboardURL());
  }

  async function loadSummary(id) {
    if (demoMode) return window.NFL_DEMO.summary(id);
    return fetchJSON(`${API}/summary?event=${encodeURIComponent(id)}`);
  }

  function applyScoreboard(data) {
    state.season = data.season?.year ?? state.season;
    state.seasonType = data.season?.type ?? state.seasonType;
    state.week = data.week?.number ?? state.week;
    state.events = data.events || [];

    const calendar = data.leagues?.[0]?.calendar;
    if (Array.isArray(calendar) && calendar.length) {
      state.weeks = [];
      for (const type of calendar) {
        // Season type 4 is the off-season; nothing to show there.
        if (!Array.isArray(type.entries) || type.value === "4") continue;
        for (const entry of type.entries) {
          state.weeks.push({
            seasonType: Number(type.value),
            week: Number(entry.value),
            label: type.value === "2" ? entry.label : `${type.label}: ${entry.label}`,
          });
        }
      }
    }
  }

  async function refresh() {
    clearTimeout(state.timer);
    try {
      applyScoreboard(await loadScoreboard());
      state.error = null;
      state.lastUpdated = new Date();
    } catch (err) {
      state.error = err;
    }
    render();
    if (state.openGameId) refreshDetail();
    schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (document.hidden) return;
    state.timer = setTimeout(refresh, nextDelay());
  }

  function nextDelay() {
    if (state.error) return REFRESH_SOON;
    const now = Date.now();
    let delay = REFRESH_IDLE;
    for (const ev of state.events) {
      const s = gameState(ev);
      if (s === "in") return REFRESH_LIVE;
      if (s === "pre" && new Date(ev.date).getTime() - now < 30 * 60 * 1000) {
        delay = REFRESH_SOON;
      }
    }
    return delay;
  }

  // ---------- helpers ----------

  const esc = (v) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const gameState = (ev) => ev.status?.type?.state || ev.competitions?.[0]?.status?.type?.state || "pre";

  function sides(comp) {
    const list = comp?.competitors || [];
    return {
      away: list.find((c) => c.homeAway === "away") || list[0],
      home: list.find((c) => c.homeAway === "home") || list[1],
    };
  }

  function isFavGame(ev) {
    const { away, home } = sides(ev.competitions?.[0]);
    return state.favorites.has(away?.team?.abbreviation) || state.favorites.has(home?.team?.abbreviation);
  }

  function kickoffText(date) {
    const d = new Date(date);
    const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return `${day} · ${time}`;
  }

  function teamColor(team) {
    return /^[0-9a-f]{6}$/i.test(team?.color || "") ? `#${team.color}` : "var(--muted)";
  }

  function logo(team, size = "sm") {
    const blank = `<span class="logo logo-${size} logo-blank" style="--team:${teamColor(team)}"></span>`;
    if (!team?.logo) return blank;
    // If the logo can't load, swap in a team-colored dot rather than a broken image.
    return `<img class="logo logo-${size}" src="${esc(team.logo)}" alt="" loading="lazy" onerror="this.outerHTML=this.dataset.fallback" data-fallback="${esc(blank)}" />`;
  }

  // Ball spot as 0–100 from the away end zone (left) to the home end zone (right).
  function ballSpot(situation, away, home) {
    const text = situation?.possessionText || "";
    const m = text.match(/^([A-Z]{2,4})\s+(\d{1,2})$/);
    if (m) {
      const yd = Number(m[2]);
      if (m[1] === home?.team?.abbreviation) return 100 - yd;
      if (m[1] === away?.team?.abbreviation) return yd;
    }
    if (/^50$/.test(text.trim())) return 50;
    return null;
  }

  // ---------- rendering: scoreboard ----------

  function render() {
    renderWeeks();
    renderFilters();
    renderStatus();

    const live = state.events.some((ev) => gameState(ev) === "in");
    liveEl.hidden = !live;

    const order = { in: 0, pre: 1, post: 2 };
    const games = state.events
      .filter((ev) => {
        if (state.filter === "all") return true;
        if (state.filter === "fav") return isFavGame(ev);
        return gameState(ev) === state.filter;
      })
      .sort((a, b) => {
        const fav = Number(isFavGame(b)) - Number(isFavGame(a));
        if (fav) return fav;
        const st = order[gameState(a)] - order[gameState(b)];
        if (st) return st;
        return new Date(a.date) - new Date(b.date);
      });

    gamesEl.innerHTML = games.map(gameCard).join("");

    if (!games.length) {
      emptyEl.hidden = false;
      if (state.error && !state.events.length) {
        emptyEl.innerHTML = `Couldn't load games (${esc(state.error.message)}). Retrying shortly. <a href="?demo">View demo data</a>`;
      } else if (state.filter === "fav") {
        emptyEl.textContent = state.favorites.size
          ? "None of your teams play this week."
          : "Tap the ☆ next to a team to follow it.";
      } else if (state.events.length) {
        emptyEl.textContent = "No games match this filter.";
      } else {
        emptyEl.textContent = "No games scheduled this week.";
      }
    } else {
      emptyEl.hidden = true;
    }

    // Remember scores so the next refresh can flash the cards that changed.
    for (const ev of state.events) {
      const { away, home } = sides(ev.competitions?.[0]);
      state.lastScores.set(ev.id, `${away?.score}-${home?.score}`);
    }
  }

  function renderWeeks() {
    const current = `${state.seasonType}-${state.week}`;
    if (!state.weeks.length && state.week != null) {
      state.weeks = [{ seasonType: state.seasonType, week: state.week, label: `Week ${state.week}` }];
    }
    weekSelect.innerHTML = state.weeks
      .map((w) => {
        const val = `${w.seasonType}-${w.week}`;
        return `<option value="${val}"${val === current ? " selected" : ""}>${esc(w.label)}</option>`;
      })
      .join("");
    const idx = state.weeks.findIndex((w) => `${w.seasonType}-${w.week}` === current);
    prevBtn.disabled = idx <= 0;
    nextBtn.disabled = idx < 0 || idx >= state.weeks.length - 1;
  }

  function renderFilters() {
    const counts = { in: 0, pre: 0, post: 0 };
    for (const ev of state.events) counts[gameState(ev)]++;
    document.querySelectorAll(".filter").forEach((btn) => {
      const f = btn.dataset.filter;
      btn.classList.toggle("active", f === state.filter);
      btn.setAttribute("aria-selected", f === state.filter);
      const base = btn.dataset.label || (btn.dataset.label = btn.textContent);
      btn.textContent = counts[f] ? `${base} ${counts[f]}` : base;
    });
  }

  function renderStatus() {
    const parts = [];
    if (demoMode) parts.push("Demo data");
    if (state.error && state.events.length) parts.push(`Update failed (${state.error.message}), retrying`);
    if (state.lastUpdated) {
      parts.push(`Updated ${state.lastUpdated.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" })}`);
    }
    statusEl.textContent = parts.join(" · ");
  }

  function gameCard(ev) {
    const comp = ev.competitions?.[0] || {};
    const { away, home } = sides(comp);
    const st = gameState(ev);
    const sit = comp.situation || {};
    const changed =
      state.lastScores.has(ev.id) && state.lastScores.get(ev.id) !== `${away?.score}-${home?.score}`;

    let statusText;
    if (st === "pre") statusText = kickoffText(ev.date);
    else statusText = ev.status?.type?.shortDetail || ev.status?.type?.detail || "";

    const broadcast = (comp.broadcasts || []).flatMap((b) => b.names || []).join(", ");
    const odds = comp.odds?.[0];

    let footer = "";
    if (st === "in") {
      const dd = sit.downDistanceText || sit.shortDownDistanceText || "";
      const last = sit.lastPlay?.text || "";
      footer = `
        ${dd ? `<div class="situation${sit.isRedZone ? " redzone" : ""}">${esc(dd)}${sit.isRedZone ? ' <span class="rz">Red Zone</span>' : ""}</div>` : ""}
        ${miniField(sit, away, home)}
        ${last ? `<div class="last-play">${esc(last)}</div>` : ""}`;
    } else if (st === "pre") {
      const bits = [broadcast, odds?.details, odds?.overUnder ? `O/U ${odds.overUnder}` : ""].filter(Boolean);
      if (bits.length) footer = `<div class="meta">${esc(bits.join(" · "))}</div>`;
    }

    return `
      <article class="game-card state-${st}${changed ? " scored" : ""}" data-id="${esc(ev.id)}" tabindex="0" aria-label="${esc(ev.name)}">
        <div class="card-top">
          <span class="game-status${st === "in" ? " live" : ""}">${esc(statusText)}</span>
          ${st !== "pre" && broadcast ? `<span class="network">${esc(broadcast)}</span>` : ""}
        </div>
        ${teamRow(away, comp, st, sit)}
        ${teamRow(home, comp, st, sit)}
        ${footer}
      </article>`;
  }

  function teamRow(c, comp, st, sit) {
    if (!c) return "";
    const team = c.team || {};
    const abbr = team.abbreviation || "";
    const fav = state.favorites.has(abbr);
    const record = c.records?.[0]?.summary || "";
    const hasBall = st === "in" && sit.possession && String(sit.possession) === String(team.id);
    const winner = st === "post" && c.winner;
    const loser = st === "post" && comp.competitors?.some((o) => o !== c && o.winner);
    const timeouts = st === "in" ? (c.homeAway === "home" ? sit.homeTimeouts : sit.awayTimeouts) : null;

    return `
      <div class="team-row${winner ? " winner" : ""}${loser ? " loser" : ""}" style="--team:${teamColor(team)}">
        <button class="fav-btn${fav ? " on" : ""}" data-fav="${esc(abbr)}" aria-label="${fav ? "Unfollow" : "Follow"} ${esc(team.displayName)}" aria-pressed="${fav}">${fav ? "★" : "☆"}</button>
        ${logo(team)}
        <span class="team-name">
          <span class="team-short">${esc(team.shortDisplayName || team.displayName || abbr)}</span>
          <span class="team-record">${esc(record)}${timeouts != null ? ` · ${timeoutDots(timeouts)}` : ""}</span>
        </span>
        ${hasBall ? '<span class="possession" title="Has the ball" aria-label="Has the ball">●</span>' : ""}
        <span class="score">${st === "pre" ? "" : esc(c.score ?? "")}</span>
      </div>`;
  }

  function timeoutDots(n) {
    const left = Math.max(0, Math.min(3, Number(n) || 0));
    return `<span class="timeouts" aria-label="${left} timeouts left">${"▮".repeat(left)}<span class="used">${"▮".repeat(3 - left)}</span></span>`;
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
        <div class="endzone left" style="--team:${teamColor(away?.team)}"></div>
        <div class="turf">
          ${first != null ? `<div class="first-line" style="left:${first}%"></div>` : ""}
          <div class="ball" style="left:${spot}%"></div>
        </div>
        <div class="endzone right" style="--team:${teamColor(home?.team)}"></div>
      </div>`;
  }

  // ---------- rendering: game detail ----------

  async function openGame(id) {
    state.openGameId = id;
    const ev = state.events.find((e) => e.id === id);
    detailEl.innerHTML = ev ? detailHeader(ev) + '<p class="loading">Loading game details…</p>' : '<p class="loading">Loading…</p>';
    if (!dialog.open) dialog.showModal();
    refreshDetail();
  }

  async function refreshDetail() {
    const id = state.openGameId;
    if (!id) return;
    const ev = state.events.find((e) => e.id === id);
    let summary = null;
    try {
      summary = await loadSummary(id);
    } catch {
      /* fall back to scoreboard data alone */
    }
    if (state.openGameId !== id) return;
    const scroll = detailEl.scrollTop;
    detailEl.innerHTML = ev ? detailHeader(ev) + detailBody(ev, summary) : '<p class="loading">Game not found.</p>';
    detailEl.scrollTop = scroll;
  }

  function detailHeader(ev) {
    const comp = ev.competitions?.[0] || {};
    const { away, home } = sides(comp);
    const st = gameState(ev);
    const status = st === "pre" ? kickoffText(ev.date) : ev.status?.type?.detail || "";
    const side = (c) => `
      <div class="dh-team" style="--team:${teamColor(c?.team)}">
        ${logo(c?.team, "lg")}
        <span class="dh-abbr">${esc(c?.team?.abbreviation)}</span>
        <span class="dh-record">${esc(c?.records?.[0]?.summary || "")}</span>
      </div>`;
    return `
      <div class="detail-header">
        ${side(away)}
        <div class="dh-score">
          <span class="dh-nums">${st === "pre" ? "vs" : `${esc(away?.score)} – ${esc(home?.score)}`}</span>
          <span class="dh-status${st === "in" ? " live" : ""}">${esc(status)}</span>
        </div>
        ${side(home)}
      </div>`;
  }

  function detailBody(ev, summary) {
    const comp = ev.competitions?.[0] || {};
    const { away, home } = sides(comp);
    const st = gameState(ev);
    const out = [];

    if (st === "in" && comp.situation) {
      const sit = comp.situation;
      out.push(`
        <section class="d-section">
          <h3>On the field</h3>
          ${sit.downDistanceText ? `<p class="situation${sit.isRedZone ? " redzone" : ""}">${esc(sit.downDistanceText)}${sit.isRedZone ? ' <span class="rz">Red Zone</span>' : ""}</p>` : ""}
          ${miniField(sit, away, home)}
          ${sit.lastPlay?.text ? `<p class="last-play">${esc(sit.lastPlay.text)}</p>` : ""}
        </section>`);
    }

    if (st !== "pre") out.push(lineScore(away, home));

    const scoring = summary?.scoringPlays || [];
    if (scoring.length) {
      out.push(`
        <section class="d-section">
          <h3>Scoring</h3>
          <ol class="plays">
            ${scoring
              .map(
                (p) => `
              <li>
                <span class="play-when">Q${esc(p.period?.number)} ${esc(p.clock?.displayValue || "")}</span>
                <span class="play-team">${logo(p.team, "xs")}${esc(p.team?.abbreviation || "")}</span>
                <span class="play-text">${esc(p.text)}</span>
                <span class="play-score">${esc(p.awayScore)}–${esc(p.homeScore)}</span>
              </li>`
              )
              .join("")}
          </ol>
        </section>`);
    }

    const drives = summary?.drives?.previous || [];
    if (drives.length) {
      out.push(`
        <section class="d-section">
          <h3>Drives</h3>
          <ol class="drives">
            ${drives
              .slice()
              .reverse()
              .slice(0, 12)
              .map(
                (d) => `
              <li>
                <span class="play-team">${logo(d.team, "xs")}${esc(d.team?.abbreviation || "")}</span>
                <span class="drive-result">${esc(d.displayResult || d.result || "")}</span>
                <span class="drive-desc">${esc(d.description || "")}</span>
              </li>`
              )
              .join("")}
          </ol>
        </section>`);
    }

    const leaders = leadersSection(summary, comp);
    if (leaders) out.push(leaders);

    const stats = teamStats(summary);
    if (stats) out.push(stats);

    const broadcast = (comp.broadcasts || []).flatMap((b) => b.names || []).join(", ");
    const odds = comp.odds?.[0];
    const info = [
      ["Kickoff", kickoffText(ev.date)],
      ["Venue", [comp.venue?.fullName, comp.venue?.address?.city, comp.venue?.address?.state].filter(Boolean).join(", ")],
      ["TV", broadcast],
      ["Line", odds?.details],
      ["Over/Under", odds?.overUnder],
    ].filter(([, v]) => v);
    if (info.length) {
      out.push(`
        <section class="d-section">
          <h3>Game info</h3>
          <dl class="info">${info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
        </section>`);
    }

    return out.join("");
  }

  function lineScore(away, home) {
    const periods = Math.max(4, away?.linescores?.length || 0, home?.linescores?.length || 0);
    const heads = Array.from({ length: periods }, (_, i) => (i < 4 ? i + 1 : i === 4 ? "OT" : `OT${i - 3}`));
    const row = (c) => `
      <tr>
        <th scope="row">${esc(c?.team?.abbreviation)}</th>
        ${heads.map((_, i) => `<td>${esc(c?.linescores?.[i]?.value ?? c?.linescores?.[i]?.displayValue ?? "")}</td>`).join("")}
        <td class="total">${esc(c?.score)}</td>
      </tr>`;
    return `
      <section class="d-section">
        <table class="linescore">
          <thead><tr><th></th>${heads.map((h) => `<th>${h}</th>`).join("")}<th>T</th></tr></thead>
          <tbody>${row(away)}${row(home)}</tbody>
        </table>
      </section>`;
  }

  function leadersSection(summary, comp) {
    // The summary groups leaders by team; the scoreboard has game-wide leaders as a fallback.
    const groups = summary?.leaders;
    if (Array.isArray(groups) && groups.length) {
      const cats = ["passingYards", "rushingYards", "receivingYards"];
      const titles = { passingYards: "Passing", rushingYards: "Rushing", receivingYards: "Receiving" };
      const rows = cats
        .map((cat) => {
          const cells = groups.map((g) => {
            const l = g.leaders?.find((x) => x.name === cat)?.leaders?.[0];
            return l
              ? `<div class="leader"><span class="leader-name">${esc(l.athlete?.shortName || l.athlete?.displayName)}</span><span class="leader-line">${esc(l.displayValue)}</span></div>`
              : '<div class="leader"></div>';
          });
          if (cells.every((c) => c === '<div class="leader"></div>')) return "";
          return `<div class="leader-row"><span class="leader-cat">${titles[cat]}</span>${cells.join("")}</div>`;
        })
        .join("");
      if (!rows) return "";
      return `
        <section class="d-section">
          <h3>Leaders</h3>
          <div class="leader-head"><span></span>${groups.map((g) => `<span>${esc(g.team?.abbreviation)}</span>`).join("")}</div>
          ${rows}
        </section>`;
    }
    const flat = comp.leaders;
    if (Array.isArray(flat) && flat.length) {
      return `
        <section class="d-section">
          <h3>Leaders</h3>
          ${flat
            .map((cat) => {
              const l = cat.leaders?.[0];
              if (!l) return "";
              return `<div class="leader-row flat"><span class="leader-cat">${esc(cat.shortDisplayName || cat.displayName)}</span><div class="leader"><span class="leader-name">${esc(l.athlete?.shortName || l.athlete?.displayName)}</span><span class="leader-line">${esc(l.displayValue)}</span></div></div>`;
            })
            .join("")}
        </section>`;
    }
    return "";
  }

  function teamStats(summary) {
    const teams = summary?.boxscore?.teams;
    if (!Array.isArray(teams) || teams.length !== 2) return "";
    const wanted = ["totalYards", "netPassingYards", "rushingYards", "firstDowns", "thirdDownEff", "turnovers", "totalPenaltiesYards", "possessionTime"];
    const byName = (t) => Object.fromEntries((t.statistics || []).map((s) => [s.name, s]));
    const [a, b] = teams.map(byName);
    const rows = wanted
      .filter((n) => a[n] || b[n])
      .map(
        (n) => `
        <tr>
          <td>${esc(a[n]?.displayValue ?? "–")}</td>
          <th scope="row">${esc(a[n]?.label || b[n]?.label || n)}</th>
          <td>${esc(b[n]?.displayValue ?? "–")}</td>
        </tr>`
      )
      .join("");
    if (!rows) return "";
    return `
      <section class="d-section">
        <h3>Team stats</h3>
        <table class="team-stats">
          <thead><tr><th>${esc(teams[0].team?.abbreviation)}</th><th></th><th>${esc(teams[1].team?.abbreviation)}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
  }

  // ---------- events ----------

  function goToWeek(idx) {
    const w = state.weeks[idx];
    if (!w) return;
    state.seasonType = w.seasonType;
    state.week = w.week;
    state.events = [];
    state.lastScores.clear();
    gamesEl.innerHTML = "";
    statusEl.textContent = "Loading…";
    refresh();
  }

  const currentIdx = () => state.weeks.findIndex((w) => w.seasonType === state.seasonType && w.week === state.week);

  weekSelect.addEventListener("change", () => goToWeek(weekSelect.selectedIndex));
  prevBtn.addEventListener("click", () => goToWeek(currentIdx() - 1));
  nextBtn.addEventListener("click", () => goToWeek(currentIdx() + 1));

  document.querySelectorAll(".filter").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.filter;
      saveFilter();
      render();
    })
  );

  gamesEl.addEventListener("click", (e) => {
    const favBtn = e.target.closest("[data-fav]");
    if (favBtn) {
      e.stopPropagation();
      const abbr = favBtn.dataset.fav;
      if (state.favorites.has(abbr)) state.favorites.delete(abbr);
      else state.favorites.add(abbr);
      saveFavorites();
      render();
      return;
    }
    const card = e.target.closest(".game-card");
    if (card) openGame(card.dataset.id);
  });

  gamesEl.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("game-card")) {
      e.preventDefault();
      openGame(e.target.dataset.id);
    }
  });

  document.getElementById("close-dialog").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    state.openGameId = null;
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(state.timer);
    else refresh();
  });

  refresh();
})();
