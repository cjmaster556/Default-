// Sample data in ESPN's scoreboard/summary/teams shapes, used when the page is
// opened with ?demo. Running game clocks count down in real time so the live
// clock and auto-refresh can be seen without a real game on.
(() => {
  "use strict";

  const start = Date.now();
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const hoursFromNow = (h) => new Date(start + h * 3600 * 1000).toISOString();
  const daysFromNow = (n) => {
    const d = new Date(start);
    d.setDate(d.getDate() + n);
    return d;
  };

  const LOGO_PATH = { nfl: "nfl", nba: "nba", wnba: "wnba", mlb: "mlb", nhl: "nhl" };

  function team(league, id, abbr, name, short, color) {
    const logo =
      league === "cfb"
        ? `https://a.espncdn.com/i/teamlogos/ncaa/500/${id}.png`
        : `https://a.espncdn.com/i/teamlogos/${LOGO_PATH[league]}/500/${abbr.toLowerCase()}.png`;
    return { id: String(id), abbreviation: abbr, displayName: name, shortDisplayName: short, color, logo };
  }

  const T = {
    nfl: [
      team("nfl", 12, "KC", "Kansas City Chiefs", "Chiefs", "e31837"),
      team("nfl", 2, "BUF", "Buffalo Bills", "Bills", "00338d"),
      team("nfl", 21, "PHI", "Philadelphia Eagles", "Eagles", "06424d"),
      team("nfl", 6, "DAL", "Dallas Cowboys", "Cowboys", "002a5c"),
      team("nfl", 25, "SF", "San Francisco 49ers", "49ers", "aa0000"),
      team("nfl", 8, "DET", "Detroit Lions", "Lions", "0076b6"),
      team("nfl", 33, "BAL", "Baltimore Ravens", "Ravens", "29126f"),
      team("nfl", 4, "CIN", "Cincinnati Bengals", "Bengals", "fb4f14"),
    ],
    cfb: [
      team("cfb", 2483, "ORE", "Oregon Ducks", "Oregon", "154733"),
      team("cfb", 194, "OSU", "Ohio State Buckeyes", "Ohio State", "ba0c2f"),
      team("cfb", 333, "ALA", "Alabama Crimson Tide", "Alabama", "9e1b32"),
      team("cfb", 61, "UGA", "Georgia Bulldogs", "Georgia", "ba0c2f"),
    ],
    nba: [
      team("nba", 13, "LAL", "Los Angeles Lakers", "Lakers", "552583"),
      team("nba", 2, "BOS", "Boston Celtics", "Celtics", "008348"),
      team("nba", 9, "GS", "Golden State Warriors", "Warriors", "1d428a"),
      team("nba", 7, "DEN", "Denver Nuggets", "Nuggets", "0e2240"),
      team("nba", 18, "NY", "New York Knicks", "Knicks", "1d428a"),
    ],
    wnba: [
      team("wnba", 17, "LV", "Las Vegas Aces", "Aces", "a7a8aa"),
      team("wnba", 9, "NY", "New York Liberty", "Liberty", "86cebc"),
      team("wnba", 5, "IND", "Indiana Fever", "Fever", "002d62"),
    ],
    mlb: [
      team("mlb", 19, "LAD", "Los Angeles Dodgers", "Dodgers", "005a9c"),
      team("mlb", 10, "NYY", "New York Yankees", "Yankees", "132448"),
      team("mlb", 21, "NYM", "New York Mets", "Mets", "002d72"),
    ],
    nhl: [
      team("nhl", 21, "TOR", "Toronto Maple Leafs", "Maple Leafs", "00205b"),
      team("nhl", 1, "BOS", "Boston Bruins", "Bruins", "fdb71a"),
      team("nhl", 13, "NYR", "New York Rangers", "Rangers", "0038a8"),
      team("nhl", 11, "NJ", "New Jersey Devils", "Devils", "ce1126"),
      team("nhl", 6, "EDM", "Edmonton Oilers", "Oilers", "041e42"),
      team("nhl", 5, "DET", "Detroit Red Wings", "Red Wings", "ce1126"),
    ],
  };
  const t = (league, abbr) => T[league].find((x) => x.abbreviation === abbr);

  const side = (homeAway, tm, score, record, lines, extra = {}) => ({
    homeAway,
    team: tm,
    score: score == null ? "" : String(score),
    records: [{ summary: record }],
    linescores: (lines || []).map((value) => ({ value })),
    ...extra,
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
          broadcasts: [{ names: [extra.tv || "ESPN"] }],
          venue: { fullName: extra.venue || "Stadium", address: extra.address || {} },
          ...(extra.situation ? { situation: extra.situation } : {}),
          ...(extra.odds ? { odds: [extra.odds] } : {}),
          ...(extra.note ? { notes: [{ headline: extra.note }] } : {}),
        },
      ],
    };
  }

  // A clock that started at `secs` when the page loaded and runs in real time.
  function running(secs) {
    const left = Math.max(0, secs - Math.floor((Date.now() - start) / 1000));
    return `${Math.floor(left / 60)}:${pad(left % 60)}`;
  }

  // The Bills score a touchdown 25 seconds after the page opens, to show score alerts.
  const billsTD = () => Date.now() - start > 25000;

  const ord = (n) => ["", "1st", "2nd", "3rd", "4th"][n] || `${n}th`;
  const live = (clock, period, word = "Quarter") => ({
    displayClock: clock,
    period,
    type: { state: "in", completed: false, detail: `${clock} - ${ord(period)} ${word}`, shortDetail: `${clock} - ${ord(period)}` },
  });
  const final = (period = 4) => ({ displayClock: "0:00", period, type: { state: "post", completed: true, detail: "Final", shortDetail: "Final" } });
  const scheduled = () => ({ displayClock: "0:00", period: 0, type: { state: "pre", completed: false, detail: "Scheduled", shortDetail: "Scheduled" } });

  const weekCalendar = (weeks) => [
    { label: "Regular Season", value: "2", entries: Array.from({ length: weeks }, (_, i) => ({ label: `Week ${i + 1}`, value: String(i + 1) })) },
    {
      label: "Postseason",
      value: "3",
      entries: ["Wild Card", "Divisional Round", "Conference Championship", "Super Bowl"].map((label, i) => ({ label, value: String(i + 1) })),
    },
  ];

  const dayCalendar = (offsets) => offsets.map((n) => `${ymd(daysFromNow(n)).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}T07:00Z`);

  const boards = {
    nfl: () => ({
      season: { year: 2026, type: 2 },
      week: { number: 7 },
      leagues: [{ calendar: weekCalendar(18) }],
      events: [
        event("401", side("away", t("nfl", "KC"), 20, "5-1", [7, 10, 3]), side("home", t("nfl", "BUF"), billsTD() ? 24 : 17, "4-2", [3, 7, billsTD() ? 14 : 7]), live(running(462), 3), {
          tv: "CBS",
          venue: "Highmark Stadium",
          address: { city: "Orchard Park", state: "NY" },
          situation: {
            down: 2,
            distance: 6,
            possession: "2",
            possessionText: "KC 18",
            downDistanceText: "2nd & 6 at KC 18",
            isRedZone: true,
            homeTimeouts: 2,
            awayTimeouts: 3,
            lastPlay: {
              text: billsTD()
                ? "J.Allen pass short right to D.Kincaid for 18 yards, TOUCHDOWN. T.Bass extra point is GOOD."
                : "J.Allen pass short right to K.Coleman for 4 yards (T.McDuffie).",
            },
          },
        }),
        event("402", side("away", t("nfl", "DAL"), 10, "2-4", [0, 10]), side("home", t("nfl", "PHI"), 14, "5-1", [7, 7]), {
          displayClock: "0:00",
          period: 2,
          type: { state: "in", completed: false, detail: "Halftime", shortDetail: "Halftime" },
        }, { tv: "FOX" }),
        event("403", side("away", t("nfl", "SF"), 24, "4-2", [7, 3, 7, 7], { winner: false }), side("home", t("nfl", "DET"), 31, "5-1", [14, 7, 0, 10], { winner: true }), final(), {
          tv: "FOX",
          date: hoursFromNow(-5),
        }),
        event("404", side("away", t("nfl", "CIN"), null, "3-3"), side("home", t("nfl", "BAL"), null, "4-2"), scheduled(), {
          tv: "NBC",
          date: hoursFromNow(4),
          odds: { details: "BAL -3.5", overUnder: 48.5 },
        }),
      ],
    }),
    cfb: () => ({
      season: { year: 2026, type: 2 },
      week: { number: 8 },
      leagues: [{ calendar: weekCalendar(15) }],
      events: [
        event(
          "501",
          side("away", t("cfb", "ORE"), 21, "7-0", [7, 7, 7], { curatedRank: { current: 3 } }),
          side("home", t("cfb", "OSU"), 24, "6-1", [10, 7, 7], { curatedRank: { current: 5 } }),
          live(running(305), 3),
          {
            tv: "FOX",
            situation: {
              down: 1,
              distance: 10,
              possession: "2483",
              possessionText: "ORE 35",
              downDistanceText: "1st & 10 at ORE 35",
              lastPlay: { text: "Kickoff returned 27 yards to the ORE 35." },
            },
          }
        ),
        event(
          "502",
          side("away", t("cfb", "ALA"), 27, "5-2", [7, 10, 3, 7], { curatedRank: { current: 11 }, winner: false }),
          side("home", t("cfb", "UGA"), 30, "6-1", [3, 10, 7, 10], { curatedRank: { current: 2 }, winner: true }),
          final(),
          { tv: "ABC", date: hoursFromNow(-6) }
        ),
      ],
    }),
    nba: (date) =>
      date !== ymd(daysFromNow(0))
        ? []
        : [
            event("601", side("away", t("nba", "LAL"), 78, "2-1", [24, 28, 26]), side("home", t("nba", "BOS"), 84, "3-0", [30, 25, 29]), live(running(272), 3), {
              tv: "ESPN",
              situation: { lastPlay: { text: "Jaylen Brown makes 24-foot three point jumper (Jrue Holiday assists)" } },
            }),
            event("602", side("away", t("nba", "GS"), null, "2-1"), side("home", t("nba", "DEN"), null, "1-2"), scheduled(), {
              tv: "TNT",
              date: hoursFromNow(3),
              odds: { details: "DEN -4.5", overUnder: 228.5 },
            }),
          ],
    wnba: () => [],
    mlb: (date) =>
      date !== ymd(daysFromNow(0))
        ? []
        : [
            event(
              "701",
              side("away", t("mlb", "LAD"), 3, "1-1", [0, 2, 0, 0, 1, 0], { hits: 6, errors: 0 }),
              side("home", t("mlb", "NYY"), 4, "1-1", [1, 0, 0, 3, 0], { hits: 7, errors: 1 }),
              { displayClock: "0:00", period: 6, type: { state: "in", completed: false, detail: "Bottom 6th", shortDetail: "Bot 6th" } },
              {
                tv: "FOX",
                note: "World Series - Game 3",
                venue: "Yankee Stadium",
                address: { city: "Bronx", state: "NY" },
                situation: {
                  balls: 2,
                  strikes: 1,
                  outs: 1,
                  onFirst: true,
                  onSecond: false,
                  onThird: true,
                  pitcher: { athlete: { shortName: "Y. Yamamoto" } },
                  batter: { athlete: { shortName: "A. Judge" } },
                  lastPlay: { text: "Juan Soto singled to right, Volpe to third." },
                },
              }
            ),
          ],
    nhl: (date) =>
      date !== ymd(daysFromNow(0))
        ? []
        : [
            event("801", side("away", t("nhl", "TOR"), 2, "4-2-1", [1, 1]), side("home", t("nhl", "BOS"), 2, "3-3-1", [0, 2]), live("8:15", 2, "Period"), {
              tv: "ESPN+",
              situation: { lastPlay: { text: "Timeout called by Toronto." } },
            }),
            event("802", side("away", t("nhl", "NYR"), 3, "5-1-0", [1, 1, 1], { winner: true }), side("home", t("nhl", "NJ"), 1, "3-3-0", [0, 1, 0], { winner: false }), final(3), {
              date: hoursFromNow(-3),
              tv: "MSG",
            }),
            event("803", side("away", t("nhl", "EDM"), null, "3-3-1"), side("home", t("nhl", "DET"), null, "2-4-1"), scheduled(), {
              date: hoursFromNow(2.5),
              tv: "TNT",
              odds: { details: "EDM -150", overUnder: 6.5 },
            }),
          ],
  };

  function scoreboard(key, cursor) {
    const b = boards[key];
    if (key === "nfl" || key === "cfb") {
      const data = b();
      // Only the current week has games in the demo.
      if (cursor && cursor.week !== data.week.number) return { ...data, week: { number: cursor.week }, season: { ...data.season, type: cursor.seasonType }, events: [] };
      return data;
    }
    const date = cursor?.date || ymd(daysFromNow(0));
    const calendars = { nba: [-2, -1, 0, 1, 3], wnba: [-40, -38], mlb: [-1, 0, 1, 2], nhl: [-1, 0, 1, 2] };
    return { leagues: [{ calendar: dayCalendar(calendars[key]) }], events: b(date) };
  }

  const stat = (name, label, displayValue) => ({ name, label, displayValue });
  const leader = (name, displayName, shortName, displayValue) => ({ name, displayName, leaders: [{ athlete: { shortName }, displayValue }] });

  function summary(key, id) {
    if (key === "nfl" && id === "401") {
      const [KC, BUF] = [t("nfl", "KC"), t("nfl", "BUF")];
      return {
        scoringPlays: [
          { period: { number: 1 }, clock: { displayValue: "9:12" }, team: KC, text: "Kareem Hunt 2 Yd Run (Harrison Butker Kick)", awayScore: 7, homeScore: 0 },
          { period: { number: 1 }, clock: { displayValue: "2:40" }, team: BUF, text: "Tyler Bass 44 Yd Field Goal", awayScore: 7, homeScore: 3 },
          { period: { number: 2 }, clock: { displayValue: "11:05" }, team: BUF, text: "James Cook 12 Yd Run (Tyler Bass Kick)", awayScore: 7, homeScore: 10 },
          { period: { number: 2 }, clock: { displayValue: "4:51" }, team: KC, text: "Travis Kelce 9 Yd pass from Patrick Mahomes (Harrison Butker Kick)", awayScore: 14, homeScore: 10 },
          { period: { number: 2 }, clock: { displayValue: "0:03" }, team: KC, text: "Harrison Butker 51 Yd Field Goal", awayScore: 17, homeScore: 10 },
          { period: { number: 3 }, clock: { displayValue: "12:20" }, team: BUF, text: "Khalil Shakir 31 Yd pass from Josh Allen (Tyler Bass Kick)", awayScore: 17, homeScore: 17 },
          { period: { number: 3 }, clock: { displayValue: "9:58" }, team: KC, text: "Harrison Butker 38 Yd Field Goal", awayScore: 20, homeScore: 17 },
        ],
        drives: {
          previous: [
            { team: KC, displayResult: "Touchdown", description: "10 plays, 75 yards, 5:48" },
            { team: BUF, displayResult: "Field Goal", description: "9 plays, 52 yards, 6:20" },
            { team: BUF, displayResult: "Touchdown", description: "8 plays, 80 yards, 4:15" },
            { team: KC, displayResult: "Touchdown", description: "11 plays, 70 yards, 6:14" },
            { team: KC, displayResult: "Field Goal", description: "6 plays, 41 yards, 0:58" },
            { team: BUF, displayResult: "Touchdown", description: "6 plays, 75 yards, 2:40" },
            { team: KC, displayResult: "Field Goal", description: "7 plays, 49 yards, 2:22" },
          ],
          current: { id: "d10", team: BUF, description: "6 plays, 57 yards, 2:31" },
        },
        pickcenter: [
          {
            provider: { name: "DraftKings" },
            details: "BUF -2.5",
            overUnder: 47.5,
            overOdds: -110,
            underOdds: -110,
            awayTeamOdds: { moneyLine: 120, spreadOdds: -108 },
            homeTeamOdds: { moneyLine: -142, spreadOdds: -112 },
          },
        ],
        standings: {
          groups: [
            {
              header: "AFC East",
              standings: {
                entries: [
                  ["2", "Buffalo Bills", 4, 2],
                  ["20", "New York Jets", 3, 3],
                  ["15", "Miami Dolphins", 2, 4],
                  ["17", "New England Patriots", 2, 4],
                ].map(([id, team, w, l]) => ({ id, team, stats: [{ name: "wins", displayValue: String(w) }, { name: "losses", displayValue: String(l) }, { name: "ties", displayValue: "0" }, { name: "winPercent", displayValue: (w / (w + l)).toFixed(3).replace(/^0/, "") }] })),
              },
            },
            {
              header: "AFC West",
              standings: {
                entries: [
                  ["12", "Kansas City Chiefs", 5, 1],
                  ["24", "Los Angeles Chargers", 4, 2],
                  ["7", "Denver Broncos", 3, 3],
                  ["13", "Las Vegas Raiders", 1, 5],
                ].map(([id, team, w, l]) => ({ id, team, stats: [{ name: "wins", displayValue: String(w) }, { name: "losses", displayValue: String(l) }, { name: "ties", displayValue: "0" }, { name: "winPercent", displayValue: (w / (w + l)).toFixed(3).replace(/^0/, "") }] })),
              },
            },
          ],
        },
        leaders: [
          { team: KC, leaders: [leader("passingYards", "Passing", "P. Mahomes", "17/24, 211 YDS, 1 TD"), leader("rushingYards", "Rushing", "K. Hunt", "11 CAR, 48 YDS, 1 TD"), leader("receivingYards", "Receiving", "T. Kelce", "6 REC, 72 YDS, 1 TD")] },
          { team: BUF, leaders: [leader("passingYards", "Passing", "J. Allen", "15/22, 188 YDS, 1 TD"), leader("rushingYards", "Rushing", "J. Cook", "12 CAR, 64 YDS, 1 TD"), leader("receivingYards", "Receiving", "K. Shakir", "4 REC, 67 YDS, 1 TD")] },
        ],
        boxscore: {
          teams: [
            { team: KC, statistics: [stat("totalOffensivePlays", "Total Plays", "35"), stat("yardsPerPlay", "Yards per Play", "8.6"), stat("thirdDownEff", "3rd down efficiency", "5-9"), stat("totalYards", "Total Yards", "301"), stat("netPassingYards", "Passing", "205"), stat("rushingYards", "Rushing", "96"), stat("firstDowns", "1st Downs", "18"), stat("turnovers", "Turnovers", "0"), stat("possessionTime", "Possession", "21:40")] },
            { team: BUF, statistics: [stat("totalOffensivePlays", "Total Plays", "29"), stat("yardsPerPlay", "Yards per Play", "9.9"), stat("thirdDownEff", "3rd down efficiency", "4-8"), stat("totalYards", "Total Yards", "287"), stat("netPassingYards", "Passing", "180"), stat("rushingYards", "Rushing", "107"), stat("firstDowns", "1st Downs", "16"), stat("turnovers", "Turnovers", "1"), stat("possessionTime", "Possession", "15:38")] },
          ],
        },
      };
    }
    if (key === "nba" && id === "601") {
      const [LAL, BOS] = [t("nba", "LAL"), t("nba", "BOS")];
      const plays = [
        ["3rd", "6:02", BOS, "Jayson Tatum makes driving layup", 72, 78],
        ["3rd", "5:41", LAL, "LeBron James makes 18-foot jumper", 74, 78],
        ["3rd", "5:20", BOS, "Derrick White misses 26-foot three point jumper", 74, 78],
        ["3rd", "5:18", LAL, "Anthony Davis defensive rebound", 74, 78],
        ["3rd", "5:02", LAL, "Austin Reaves makes 25-foot three point jumper", 77, 78],
        ["3rd", "4:49", BOS, "Kristaps Porzingis makes dunk", 77, 80],
        ["3rd", "4:40", LAL, "Anthony Davis makes free throw 1 of 2", 78, 80],
        ["3rd", "4:40", LAL, "Anthony Davis misses free throw 2 of 2", 78, 80],
        ["3rd", "4:39", BOS, "Jrue Holiday defensive rebound", 78, 80],
        ["3rd", "4:32", BOS, "Jaylen Brown makes 24-foot three point jumper", 78, 83],
      ].map(([p, clock, tm, text, a, h], i) => ({
        period: { number: 3, displayValue: `${p} Quarter` },
        clock: { displayValue: clock },
        team: { id: tm.id },
        text,
        awayScore: a,
        homeScore: h,
        scoringPlay: i % 2 === 0,
      }));
      return {
        plays,
        leaders: [
          { team: LAL, leaders: [leader("points", "Points", "L. James", "24 PTS"), leader("rebounds", "Rebounds", "A. Davis", "11 REB"), leader("assists", "Assists", "L. James", "7 AST")] },
          { team: BOS, leaders: [leader("points", "Points", "J. Tatum", "26 PTS"), leader("rebounds", "Rebounds", "J. Tatum", "8 REB"), leader("assists", "Assists", "J. Holiday", "6 AST")] },
        ],
        boxscore: {
          teams: [
            { team: LAL, statistics: [stat("fieldGoalsMade-fieldGoalsAttempted", "FG", "29-61"), stat("fieldGoalPct", "Field Goal %", "47.5"), stat("threePointFieldGoalsMade-threePointFieldGoalsAttempted", "3PT", "8-24"), stat("totalRebounds", "Rebounds", "31"), stat("assists", "Assists", "17"), stat("turnovers", "Turnovers", "9")] },
            { team: BOS, statistics: [stat("fieldGoalsMade-fieldGoalsAttempted", "FG", "31-63"), stat("fieldGoalPct", "Field Goal %", "49.2"), stat("threePointFieldGoalsMade-threePointFieldGoalsAttempted", "3PT", "12-30"), stat("totalRebounds", "Rebounds", "34"), stat("assists", "Assists", "21"), stat("turnovers", "Turnovers", "7")] },
          ],
        },
      };
    }
    if (key === "mlb" && id === "701") {
      const [LAD, NYY] = [t("mlb", "LAD"), t("mlb", "NYY")];
      return {
        plays: [
          { period: { displayValue: "Top 6th" }, team: { id: LAD.id }, text: "Freeman grounded out to second.", awayScore: 3, homeScore: 4 },
          { period: { displayValue: "Top 6th" }, team: { id: LAD.id }, text: "Smith struck out swinging.", awayScore: 3, homeScore: 4 },
          { period: { displayValue: "Top 6th" }, team: { id: LAD.id }, text: "Muncy flied out to center.", awayScore: 3, homeScore: 4 },
          { period: { displayValue: "Bottom 6th" }, team: { id: NYY.id }, text: "Volpe doubled to left.", awayScore: 3, homeScore: 4 },
          { period: { displayValue: "Bottom 6th" }, team: { id: NYY.id }, text: "Wells struck out looking.", awayScore: 3, homeScore: 4 },
          { period: { displayValue: "Bottom 6th" }, team: { id: NYY.id }, text: "Soto singled to right, Volpe to third.", awayScore: 3, homeScore: 4 },
        ],
        leaders: [
          { team: LAD, leaders: [leader("hits", "Hits", "S. Ohtani", "2-3, HR, 2 RBI"), leader("pitching", "Pitching", "Y. Yamamoto", "5.1 IP, 4 ER, 6 K")] },
          { team: NYY, leaders: [leader("hits", "Hits", "A. Judge", "1-2, HR, 3 RBI"), leader("pitching", "Pitching", "G. Cole", "5.0 IP, 3 ER, 7 K")] },
        ],
        boxscore: { teams: [{ team: LAD, statistics: [] }, { team: NYY, statistics: [] }] },
      };
    }
    return {};
  }

  function teams(key) {
    return { sports: [{ leagues: [{ teams: T[key].map((tm) => ({ team: { ...tm, logos: [{ href: tm.logo }] } })) }] }] };
  }

  // Next game for a team that isn't on today's board: tomorrow evening at home.
  function teamNext(key, id) {
    const me = T[key].find((x) => x.id === String(id));
    const opp = T[key].find((x) => x.id !== String(id));
    if (!me || !opp) return { team: {} };
    const d = daysFromNow(1);
    d.setHours(19, 30, 0, 0);
    return {
      team: {
        nextEvent: [
          {
            id: `next-${key}-${id}`,
            date: d.toISOString(),
            name: `${opp.displayName} at ${me.displayName}`,
            competitions: [
              {
                status: scheduled(),
                competitors: [
                  { homeAway: "home", team: { ...me, logos: [{ href: me.logo }] }, score: { value: 0, displayValue: "0" } },
                  { homeAway: "away", team: { ...opp, logos: [{ href: opp.logo }] }, score: { value: 0, displayValue: "0" } },
                ],
                broadcasts: [{ names: ["Local"] }],
              },
            ],
          },
        ],
      },
    };
  }

  window.SCORES_DEMO = { scoreboard, summary, teams, team: teamNext };
})();
