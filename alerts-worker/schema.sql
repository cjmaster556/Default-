-- Phones signed up for alerts, and the teams each one follows (JSON).
CREATE TABLE IF NOT EXISTS subs (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  teams TEXT NOT NULL DEFAULT '[]',
  created INTEGER NOT NULL
);

-- Last seen score and state of each followed game, to spot changes.
CREATE TABLE IF NOT EXISTS games (
  key TEXT PRIMARY KEY,
  a INTEGER NOT NULL,
  h INTEGER NOT NULL,
  st TEXT NOT NULL,
  updated INTEGER NOT NULL
);

-- Server settings, such as its push signing keys.
CREATE TABLE IF NOT EXISTS config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- League highlight videos seen on YouTube, kept a few days.
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  league TEXT NOT NULL,
  title TEXT NOT NULL,
  published TEXT NOT NULL,
  thumbnail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS videos_by_league ON videos (league, published);

-- Each phone's alert settings and game reminders (JSON).
CREATE TABLE IF NOT EXISTS prefs (
  endpoint TEXT PRIMARY KEY,
  settings TEXT NOT NULL DEFAULT '{}',
  reminders TEXT NOT NULL DEFAULT '[]'
);

-- Extra per-game memory for alerts: last status line, period, red zone,
-- and whether a close-game alert went out (JSON).
CREATE TABLE IF NOT EXISTS gamex (
  key TEXT PRIMARY KEY,
  x TEXT NOT NULL DEFAULT '{}',
  updated INTEGER NOT NULL
);

-- Sharks Rush game: each player name's best run, shared between phones.
CREATE TABLE IF NOT EXISTS rush_scores (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  pucks INTEGER NOT NULL DEFAULT 0,
  player TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL
);

-- Sharks Rush daily challenge: each name's best run on that day's course. Old days are cleared after a month.
CREATE TABLE IF NOT EXISTS rush_daily (
  day TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  pucks INTEGER NOT NULL DEFAULT 0,
  player TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL,
  PRIMARY KEY (day, key)
);
