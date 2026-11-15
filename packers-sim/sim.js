// Monte Carlo NFL season engine. Works in browser (window.NFLSim) and node.
(function (root) {
  const SD = 13.5, HFA = 48, ELO_PER_PT = 25;

  function setup(data) {
    const teams = [], conf = [], div = [];
    for (const [d, ts] of Object.entries(data.divisions)) for (const t of ts) { teams.push(t); conf.push(d.slice(0, 3)); div.push(d); }
    const idx = Object.fromEntries(teams.map((t, i) => [t, i]));
    return { teams, conf, div, idx, n: teams.length, data };
  }

  function baseState(S) {
    const n = S.n, st = {
      w: new Float64Array(n), g: new Float64Array(n), dw: new Float64Array(n), dg: new Float64Array(n),
      cw: new Float64Array(n), cg: new Float64Array(n), pd: new Float64Array(n), h2h: new Float64Array(n * n), rem: []
    };
    S.data.games.forEach((gm, k) => {
      const a = S.idx[gm.a], h = S.idx[gm.h];
      if (gm.as == null || gm.hs == null) { st.rem.push({ k, a, h, w: gm.w, d: gm.d }); return; }
      apply(S, st, h, a, gm.hs - gm.as);
    });
    return st;
  }

  function apply(S, st, h, a, margin) {
    const hw = margin > 0 ? 1 : margin < 0 ? 0 : .5;
    st.w[h] += hw; st.w[a] += 1 - hw; st.g[h]++; st.g[a]++;
    st.pd[h] += margin; st.pd[a] -= margin;
    st.h2h[h * S.n + a] += hw; st.h2h[a * S.n + h] += 1 - hw;
    if (S.div[h] === S.div[a]) { st.dw[h] += hw; st.dw[a] += 1 - hw; st.dg[h]++; st.dg[a]++; }
    if (S.conf[h] === S.conf[a]) { st.cw[h] += hw; st.cw[a] += 1 - hw; st.cg[h]++; st.cg[a]++; }
  }

  const pct = (w, g) => (g ? w / g : .5);

  // Order a list of team indices best -> worst using simplified NFL tiebreakers.
  function order(S, st, list, sameDiv, rnd) {
    const out = [], byW = new Map();
    for (const t of list) { const k = st.w[t] / Math.max(1, st.g[t]); if (!byW.has(k)) byW.set(k, []); byW.get(k).push(t); }
    const keys = [...byW.keys()].sort((a, b) => b - a);
    for (const k of keys) {
      const grp = byW.get(k);
      if (grp.length === 1) { out.push(grp[0]); continue; }
      const sc = grp.map(t => {
        let hw = 0, hg = 0;
        for (const o of grp) if (o !== t) { hw += st.h2h[t * S.n + o]; hg += st.h2h[t * S.n + o] + st.h2h[o * S.n + t]; }
        return { t, h: hg ? hw / hg : .5, d: sameDiv ? pct(st.dw[t], st.dg[t]) : 0, c: pct(st.cw[t], st.cg[t]), p: st.pd[t], r: rnd() };
      });
      sc.sort((x, y) => (y.h - x.h) || (y.d - x.d) || (y.c - x.c) || (y.p - x.p) || (y.r - x.r));
      for (const s of sc) out.push(s.t);
    }
    return out;
  }

  function seed(S, st, rnd) {
    // returns seeds[conf] = array of 7 team indices (1..7)
    const res = {};
    for (const c of ["AFC", "NFC"]) {
      const winners = [], rest = [];
      const divs = Object.keys(S.data.divisions).filter(d => d.startsWith(c));
      for (const d of divs) {
        const ts = S.data.divisions[d].map(t => S.idx[t]);
        const o = order(S, st, ts, true, rnd); winners.push(o[0]); rest.push(...o.slice(1));
      }
      const ws = order(S, st, winners, false, rnd);
      const wc = order(S, st, rest, false, rnd).slice(0, 3);
      res[c] = ws.concat(wc);
    }
    return res;
  }

  function normal(rnd) { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  // opts: sims, adj {TEAM: eloDelta}, force {gameKey: 'h'|'a'}, rnd
  function run(S, opts) {
    const base = baseState(S), n = S.n, N = opts.sims || 10000, rnd = opts.rnd || Math.random;
    const adj = opts.adj || {}, force = opts.force || {};
    const elo = S.teams.map(t => S.data.elo[t] + (adj[t] || 0));
    const mean = base.rem.map(g => (elo[g.h] + HFA - elo[g.a]) / ELO_PER_PT);
    const R = base.rem.length;
    const target = opts.target != null ? opts.target : S.idx.GB;
    const cnt = { playoff: new Float64Array(n), div: new Float64Array(n), seed1: new Float64Array(n), wins: new Float64Array(n), seeds: new Float64Array(n * 7) };
    const winDist = {}; // wins -> [sims, made]
    const gHome = new Float64Array(R), gHomeMade = new Float64Array(R), gAwayMade = new Float64Array(R);
    let tgtMade = 0;
    const st = { w: new Float64Array(n), g: new Float64Array(n), dw: new Float64Array(n), dg: new Float64Array(n), cw: new Float64Array(n), cg: new Float64Array(n), pd: new Float64Array(n), h2h: new Float64Array(n * n) };
    const res = new Uint8Array(R);
    for (let s = 0; s < N; s++) {
      for (const k of ["w", "g", "dw", "dg", "cw", "cg", "pd", "h2h"]) st[k].set(base[k]);
      for (let i = 0; i < R; i++) {
        const g = base.rem[i], f = force[g.k];
        let m = mean[i] + normal(rnd) * SD;
        m = Math.round(m);
        if (f === "h") m = Math.max(1, Math.abs(m)); else if (f === "a") m = -Math.max(1, Math.abs(m));
        else if (m === 0) m = rnd() < .5 ? 1 : -1;
        res[i] = m > 0 ? 1 : 0;
        apply(S, st, g.h, g.a, m);
      }
      const sd = seed(S, st, rnd);
      let made = 0;
      for (const c of ["AFC", "NFC"]) sd[c].forEach((t, j) => {
        cnt.playoff[t]++; cnt.seeds[t * 7 + j]++;
        if (j < 4) cnt.div[t]++; if (j === 0) cnt.seed1[t]++;
        if (t === target) made = 1;
      });
      for (let t = 0; t < n; t++) cnt.wins[t] += st.w[t];
      tgtMade += made;
      const wk = st.w[target]; const e = winDist[wk] || (winDist[wk] = [0, 0]); e[0]++; e[1] += made;
      for (let i = 0; i < R; i++) { if (res[i]) { gHome[i]++; gHomeMade[i] += made; } else gAwayMade[i] += made; }
    }
    const teams = S.teams.map((t, i) => ({
      team: t, conf: S.conf[i], div: S.div[i], w: base.w[i], g: base.g[i], pd: base.pd[i],
      playoff: cnt.playoff[i] / N, divWin: cnt.div[i] / N, seed1: cnt.seed1[i] / N, projW: cnt.wins[i] / N,
      seeds: Array.from(cnt.seeds.slice(i * 7, i * 7 + 7), x => x / N)
    }));
    const games = base.rem.map((g, i) => {
      const nh = gHome[i], na = N - gHome[i];
      return {
        k: g.k, w: g.w, d: g.d, a: S.teams[g.a], h: S.teams[g.h],
        pHome: nh / N,
        madeIfHome: nh ? gHomeMade[i] / nh : null, madeIfAway: na ? gAwayMade[i] / na : null
      };
    });
    return { N, teams, games, winDist, targetMade: tgtMade / N, base };
  }

  root.NFLSim = { setup, run, baseState, SD, HFA, ELO_PER_PT };
  if (typeof module !== "undefined") module.exports = root.NFLSim;
})(typeof window !== "undefined" ? window : globalThis);
