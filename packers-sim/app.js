(function () {
  const D = window.NFL_DATA, S = NFLSim.setup(D), $ = id => document.getElementById(id);
  const ME = "GB", force = {};
  const pc = (x, d = 0) => (x * 100).toFixed(d) + "%";
  function recStr(t) { const T = Math.round((t.w % 1) * 2); const W = Math.floor(t.w); const L = t.g - W - T; return T ? `${W}-${L}-${T}` : `${W}-${L}`; }
  const gbGames = () => D.games.filter(g => g.a === ME || g.h === ME);
  const fmtDate = d => new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  let last = null, timer = null;

  function lastPlayed() { return Math.max(...D.games.filter(g => g.as != null).map(g => g.w)); }
  $("sub").textContent = `${D.season} season · results through Week ${lastPlayed()} · data updated ${D.updated}`;

  function schedule(res) {
    const rem = res.games.filter(g => g.a === ME || g.h === ME);
    $("sched").innerHTML = rem.map(g => {
      const home = g.h === ME, opp = home ? g.a : g.h, p = home ? g.pHome : 1 - g.pHome;
      const wIf = home ? g.madeIfHome : g.madeIfAway, lIf = home ? g.madeIfAway : g.madeIfHome;
      const f = force[g.k], cur = !f ? "S" : (f === "h") === home ? "W" : "L";
      const lev = wIf != null && lIf != null && !f ? `Win: ${pc(wIf)} playoffs · Loss: ${pc(lIf)} · swing ${pc(wIf - lIf)}` : "";
      return `<div class="game"><div><div class="t">Wk ${g.w} ${home ? "vs" : "@"} ${opp}</div><div class="m">${fmtDate(g.d)} · ${f ? 'Locked: ' + (cur === 'W' ? 'GB win' : 'GB loss') : 'GB win prob ' + pc(p)}</div></div>
      <div class="seg" data-k="${g.k}" data-home="${home}">${["W", "S", "L"].map(x => `<button class="${x}${cur === x ? " on" : ""}" data-v="${x}">${x === "S" ? "Sim" : x}</button>`).join("")}</div>
      ${lev ? `<div class="lev">${lev}</div>` : ""}</div>`;
    }).join("") || "<p class='hint'>No games remaining.</p>";
    document.querySelectorAll(".seg").forEach(el => el.onclick = e => {
      const b = e.target.closest("button"); if (!b) return;
      const k = +el.dataset.k, home = el.dataset.home === "true", v = b.dataset.v;
      if (v === "S") delete force[k]; else force[k] = (v === "W") === home ? "h" : "a";
      go();
    });
  }

  function dist(res) {
    const keys = Object.keys(res.winDist).map(Number).sort((a, b) => b - a), max = Math.max(...keys.map(k => res.winDist[k][0]));
    $("dist").innerHTML = keys.map(k => {
      const [n, m] = res.winDist[k], share = n / res.N, label = k % 1 ? `${Math.floor(k)}-${17 - Math.floor(k)}-1`.replace(/^(\d+)-(\d+)-1$/, (_, a) => `${a} W (tie)`) : `${k} wins`;
      if (share < 0.002) return "";
      return `<div class="row"><span>${label}</span><div class="bar"><i class="f" style="width:${n / max * 100}%"></i><i style="width:${n / max * 100 * m / n}%"></i></div><span><b>${pc(m / n)}</b> <small style="color:var(--mut)">(${pc(share, 1)})</small></span></div>`;
    }).join("");
  }

  function rooting(res) {
    const t = res.teams, items = res.games.filter(g => g.madeIfHome != null && g.madeIfAway != null && g.a !== ME && g.h !== ME && !force[g.k])
      .map(g => ({ g, sw: g.madeIfHome - g.madeIfAway })).sort((a, b) => Math.abs(b.sw) - Math.abs(a.sw)).slice(0, 12);
    $("root").innerHTML = items.map(({ g, sw }) => {
      const root = sw > 0 ? g.h : g.a, other = sw > 0 ? g.a : g.h;
      return `<div class="root"><div>Wk ${g.w}: root for <b>${root}</b> over ${other} <span class="hint">(${fmtDate(g.d)})</span></div><div class="r pos">+${pc(Math.abs(sw), 1)}</div></div>`;
    }).join("") || "<p class='hint'>Nothing left to root for.</p>";
  }

  function table(res) {
    const heat = x => `<span class="pc" style="background:rgba(47,158,91,${(x * .7).toFixed(2)})">${x < .005 ? "–" : pc(x)}</span>`;
    const rows = res.teams.filter(t => t.conf === "NFC").sort((a, b) => b.playoff - a.playoff || b.projW - a.projW);
    $("tbl").innerHTML = `<tr><th>Team</th><th>Rec</th><th>Proj W</th><th>Playoffs</th><th>Div</th>${[1, 2, 3, 4, 5, 6, 7].map(i => `<th>#${i}</th>`).join("")}</tr>` +
      rows.map(t => `<tr class="${t.team === ME ? "gb" : ""}"><td>${t.team}</td><td>${recStr(t)}</td><td>${t.projW.toFixed(1)}</td><td>${heat(t.playoff)}</td><td>${heat(t.divWin)}</td>${t.seeds.map(x => `<td>${x < .005 ? "–" : pc(x)}</td>`).join("")}</tr>`).join("");
  }

  function go() {
    const adj = +$("adj").value; $("adjV").textContent = (adj > 0 ? "+" : "") + adj;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const res = NFLSim.run(S, { sims: +$("sims").value, adj: { [ME]: adj }, force });
      last = res; const me = res.teams[S.idx[ME]];
      $("pPlayoff").textContent = pc(me.playoff, 1); $("pDiv").textContent = pc(me.divWin, 1);
      $("pBye").textContent = pc(me.seed1, 1); $("pWins").textContent = me.projW.toFixed(1);
      schedule(res); dist(res); rooting(res); table(res);
    }, 30);
  }
  $("adj").oninput = go; $("sims").onchange = go;
  $("reset").onclick = () => { for (const k in force) delete force[k]; $("adj").value = 0; go(); };
  go();
})();
