// Sample data in ESPN's scoreboard/summary shape, used when the page is opened
// with ?demo. The live game's clock runs down on each refresh so the
// auto-update path can be seen without a real game on.
(() => {
  "use strict";

  const team = (id, abbr, name, short, color) => ({
    id: String(id),
    abbreviation: abbr,
    displayName: name,
    shortDisplayName: short,
    color,
    logo: `https://a.espncdn.com/i/teamlogos/nfl/500/${abbr.toLowerCase()}.png`,
  });

  const T = {
    KC: team(12, "KC", "Kansas City Chiefs", "Chiefs", "e31837"),
    BUF: team(2, "BUF", "Buffalo Bills", "Bills", "00338d"),
    PHI: team(21, "PHI", "Philadelphia Eagles", "Eagles", "06424d"),
    DAL: team(6, "DAL", "Dallas Cowboys", "Cowboys", "002a5c"),
    SF: team(25, "SF", "San Francisco 49ers", "49ers", "aa0000"),
    DET: team(8, "DET", "Detroit Lions", "Lions", "0076b6"),
    BAL: team(33, "BAL", "Baltimore Ravens", "Ravens", "29126f"),
    CIN: team(4, "CIN", "Cincinnati Bengals", "Bengals", "fb4f14"),
  };

  const start = Date.now();
  const hoursFromNow = (h) => new Date(start + h * 3600 * 1000).toISOString();

  const side = (homeAway, t, score, record, lines, winner) => ({
    homeAway,
    team: t,
    score: score == null ? "" : String(score),
    records: [{ summary: record }],
    linescores: (lines || []).map((value) => ({ value })),
    ...(winner != null ? { winner } : {}),
  });

  function event(id, away, home, status, extra = {}) {
    return {
      id: String(id),
      date: extra.date || hoursFromNow(-2),
      name: `${away.team.displayName} at ${home.team.displayName}`,
      shortName: `${away.team.abbreviation} @ ${home.team.abbreviation}`,
      status,
      competitions: [
        {
          competitors: [home, away],
          broadcasts: [{ names: [extra.tv || "CBS"] }],
          venue: { fullName: extra.venue || "Stadium", address: extra.address || {} },
          ...(extra.situation ? { situation: extra.situation } : {}),
          ...(extra.odds ? { odds: [extra.odds] } : {}),
        },
      ],
    };
  }

  function liveClock() {
    // 7:42 left in Q3 when the page opens, ticking 15s of game time per refresh.
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const secs = Math.max(0, 462 - elapsed);
    return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  }

  function scoreboard() {
    const clock = liveClock();
    const live = event(
      "401",
      side("away", T.KC, 20, "5-1", [7, 10, 3]),
      side("home", T.BUF, 17, "4-2", [3, 7, 7]),
      {
        displayClock: clock,
        period: 3,
        type: { state: "in", completed: false, detail: `${clock} - 3rd Quarter`, shortDetail: `${clock} - 3rd` },
      },
      {
        tv: "CBS",
        venue: "Highmark Stadium",
        address: { city: "Orchard Park", state: "NY" },
        situation: {
          down: 2,
          distance: 6,
          possession: T.BUF.id,
          possessionText: "KC 18",
          downDistanceText: "2nd & 6 at KC 18",
          shortDownDistanceText: "2nd & 6",
          isRedZone: true,
          homeTimeouts: 2,
          awayTimeouts: 3,
          lastPlay: { text: "J.Allen pass short right to K.Coleman for 4 yards (T.McDuffie)." },
        },
      }
    );

    const live2 = event(
      "402",
      side("away", T.DAL, 10, "2-4", [0, 10]),
      side("home", T.PHI, 14, "5-1", [7, 7]),
      {
        displayClock: "0:00",
        period: 2,
        type: { state: "in", completed: false, detail: "Halftime", shortDetail: "Halftime" },
      },
      {
        tv: "FOX",
        venue: "Lincoln Financial Field",
        address: { city: "Philadelphia", state: "PA" },
        situation: { lastPlay: { text: "End of 2nd quarter." }, homeTimeouts: 3, awayTimeouts: 3 },
      }
    );

    const final = event(
      "403",
      side("away", T.SF, 24, "4-2", [7, 3, 7, 7], false),
      side("home", T.DET, 31, "5-1", [14, 7, 0, 10], true),
      { period: 4, type: { state: "post", completed: true, detail: "Final", shortDetail: "Final" } },
      { tv: "FOX", venue: "Ford Field", address: { city: "Detroit", state: "MI" }, date: hoursFromNow(-5) }
    );

    const upcoming = event(
      "404",
      side("away", T.CIN, null, "3-3"),
      side("home", T.BAL, null, "4-2"),
      { period: 0, type: { state: "pre", completed: false, detail: "Scheduled", shortDetail: "Scheduled" } },
      {
        tv: "NBC",
        venue: "M&T Bank Stadium",
        address: { city: "Baltimore", state: "MD" },
        date: hoursFromNow(4),
        odds: { details: "BAL -3.5", overUnder: 48.5 },
      }
    );

    return {
      season: { year: 2026, type: 2 },
      week: { number: 7 },
      leagues: [
        {
          calendar: [
            { label: "Regular Season", value: "2", entries: Array.from({ length: 18 }, (_, i) => ({ label: `Week ${i + 1}`, value: String(i + 1) })) },
            {
              label: "Postseason",
              value: "3",
              entries: ["Wild Card", "Divisional Round", "Conference Championship", "Super Bowl"].map((label, i) => ({
                label,
                value: String(i + 1),
              })),
            },
          ],
        },
      ],
      events: [final, upcoming, live2, live],
    };
  }

  const stat = (name, label, displayValue) => ({ name, label, displayValue });
  const leader = (name, shortName, displayValue) => ({ name, leaders: [{ athlete: { shortName }, displayValue }] });

  function summary(id) {
    if (id !== "401") return { scoringPlays: [], drives: { previous: [] } };
    return {
      scoringPlays: [
        { period: { number: 1 }, clock: { displayValue: "9:12" }, team: T.KC, text: "Kareem Hunt 2 Yd Run (Harrison Butker Kick)", awayScore: 7, homeScore: 0 },
        { period: { number: 1 }, clock: { displayValue: "2:40" }, team: T.BUF, text: "Tyler Bass 44 Yd Field Goal", awayScore: 7, homeScore: 3 },
        { period: { number: 2 }, clock: { displayValue: "11:05" }, team: T.BUF, text: "James Cook 12 Yd Run (Tyler Bass Kick)", awayScore: 7, homeScore: 10 },
        { period: { number: 2 }, clock: { displayValue: "4:51" }, team: T.KC, text: "Travis Kelce 9 Yd pass from Patrick Mahomes (Harrison Butker Kick)", awayScore: 14, homeScore: 10 },
        { period: { number: 2 }, clock: { displayValue: "0:03" }, team: T.KC, text: "Harrison Butker 51 Yd Field Goal", awayScore: 17, homeScore: 10 },
        { period: { number: 3 }, clock: { displayValue: "12:20" }, team: T.BUF, text: "Khalil Shakir 31 Yd pass from Josh Allen (Tyler Bass Kick)", awayScore: 17, homeScore: 17 },
        { period: { number: 3 }, clock: { displayValue: "9:58" }, team: T.KC, text: "Harrison Butker 38 Yd Field Goal", awayScore: 20, homeScore: 17 },
      ],
      drives: {
        previous: [
          { team: T.KC, displayResult: "Touchdown", description: "10 plays, 75 yards, 5:48" },
          { team: T.BUF, displayResult: "Field Goal", description: "9 plays, 52 yards, 6:20" },
          { team: T.KC, displayResult: "Punt", description: "3 plays, 4 yards, 1:31" },
          { team: T.BUF, displayResult: "Touchdown", description: "8 plays, 80 yards, 4:15" },
          { team: T.KC, displayResult: "Touchdown", description: "11 plays, 70 yards, 6:14" },
          { team: T.BUF, displayResult: "Interception", description: "5 plays, 28 yards, 2:08" },
          { team: T.KC, displayResult: "Field Goal", description: "6 plays, 41 yards, 0:58" },
          { team: T.BUF, displayResult: "Touchdown", description: "6 plays, 75 yards, 2:40" },
          { team: T.KC, displayResult: "Field Goal", description: "7 plays, 49 yards, 2:22" },
        ],
      },
      leaders: [
        { team: T.KC, leaders: [leader("passingYards", "P. Mahomes", "17/24, 211 YDS, 1 TD"), leader("rushingYards", "K. Hunt", "11 CAR, 48 YDS, 1 TD"), leader("receivingYards", "T. Kelce", "6 REC, 72 YDS, 1 TD")] },
        { team: T.BUF, leaders: [leader("passingYards", "J. Allen", "15/22, 188 YDS, 1 TD, 1 INT"), leader("rushingYards", "J. Cook", "12 CAR, 64 YDS, 1 TD"), leader("receivingYards", "K. Shakir", "4 REC, 67 YDS, 1 TD")] },
      ],
      boxscore: {
        teams: [
          { team: T.KC, statistics: [stat("totalYards", "Total Yards", "301"), stat("netPassingYards", "Passing", "205"), stat("rushingYards", "Rushing", "96"), stat("firstDowns", "1st Downs", "18"), stat("thirdDownEff", "3rd down efficiency", "5-9"), stat("turnovers", "Turnovers", "0"), stat("totalPenaltiesYards", "Penalties", "3-25"), stat("possessionTime", "Possession", "21:40")] },
          { team: T.BUF, statistics: [stat("totalYards", "Total Yards", "287"), stat("netPassingYards", "Passing", "180"), stat("rushingYards", "Rushing", "107"), stat("firstDowns", "1st Downs", "16"), stat("thirdDownEff", "3rd down efficiency", "4-8"), stat("turnovers", "Turnovers", "1"), stat("totalPenaltiesYards", "Penalties", "5-40"), stat("possessionTime", "Possession", "15:38")] },
        ],
      },
    };
  }

  window.NFL_DEMO = { scoreboard, summary };
})();
