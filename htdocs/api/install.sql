-- =====================================================================
--  FORGE INFINITE — game schema (MVP v1)
--  SQLite 3.35+ · designed for shared cPanel hosting (WAL, short tx)
--  Run: php api/db_install.php   (creates + seeds from balance.json)
-- =====================================================================
PRAGMA foreign_keys = ON;

-- ---------- auth ----------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash     TEXT    NOT NULL DEFAULT '',
  email         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_seen_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_ip       TEXT,
  role          TEXT    NOT NULL DEFAULT 'player' CHECK (role IN ('player','mod','admin')),
  is_banned     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_seen ON users(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  expires_at  INTEGER NOT NULL,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 1,
  window_start INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ---------- hot row: one per player, keep it narrow ----------
CREATE TABLE IF NOT EXISTS player_state (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gold              REAL    NOT NULL DEFAULT 0,
  gems              INTEGER NOT NULL DEFAULT 0,
  tokens            INTEGER NOT NULL DEFAULT 0,
  energy            REAL    NOT NULL DEFAULT 20,
  energy_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  level             INTEGER NOT NULL DEFAULT 1,
  xp                INTEGER NOT NULL DEFAULT 0,
  sparks            INTEGER NOT NULL DEFAULT 0,
  prestige_count    INTEGER NOT NULL DEFAULT 0,
  run_gold          REAL    NOT NULL DEFAULT 0,      -- lifetime gold THIS run (prestige fuel)
  total_gold        REAL    NOT NULL DEFAULT 0,      -- lifetime gold forever (leaderboard)
  total_clicks      INTEGER NOT NULL DEFAULT 0,
  streak_days       INTEGER NOT NULL DEFAULT 0,
  streak_freeze     INTEGER NOT NULL DEFAULT 0,
  last_claim_day    TEXT,
  last_settle       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_active       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_free_crate   INTEGER NOT NULL DEFAULT 0,
  loadout_json      TEXT    NOT NULL DEFAULT '{}',
  settings_json     TEXT    NOT NULL DEFAULT '{}',
  updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  CHECK (gold >= 0 AND gems >= 0 AND tokens >= 0)
);

-- ---------- progression ----------
CREATE TABLE IF NOT EXISTS player_gens (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gen_id  TEXT    NOT NULL,
  level   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, gen_id)
);

CREATE TABLE IF NOT EXISTS player_skills (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id TEXT   NOT NULL,
  level   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, skill_id)
);

-- ---------- items & shop ----------
CREATE TABLE IF NOT EXISTS items (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slot         TEXT NOT NULL,
  rarity       TEXT NOT NULL,
  tradable     INTEGER NOT NULL DEFAULT 1,
  power_effect REAL NOT NULL DEFAULT 0,
  css_json     TEXT,
  edition_left INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_slot ON items(slot, rarity);

CREATE TABLE IF NOT EXISTS player_items (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL DEFAULT 1,
  source      TEXT    NOT NULL DEFAULT 'shop',
  acquired_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS shop_offers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  currency    TEXT    NOT NULL CHECK (currency IN ('gold','gems','tokens')),
  price       INTEGER NOT NULL,
  stock_total INTEGER,
  stock_left  INTEGER,
  ends_at     INTEGER,
  featured    INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_shop_active ON shop_offers(is_active, sort_order);

CREATE TABLE IF NOT EXISTS loot_entries (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id TEXT NOT NULL,
  item_id  TEXT,
  weight   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_loot ON loot_entries(table_id);

-- ---------- daily loop ----------
CREATE TABLE IF NOT EXISTS player_counters (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period    TEXT    NOT NULL,     -- 'D:2026-10-25' | 'W:2026-W43'
  metric    TEXT    NOT NULL,
  value     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period, metric)
);

CREATE TABLE IF NOT EXISTS player_quests (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_id  TEXT    NOT NULL,
  period    TEXT    NOT NULL,
  claimed_at INTEGER,
  PRIMARY KEY (user_id, quest_id, period)
);

CREATE TABLE IF NOT EXISTS achievements (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  desc_t    TEXT NOT NULL,
  metric    TEXT NOT NULL,
  target    INTEGER NOT NULL,
  reward_json TEXT NOT NULL,
  tier      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS player_achievements (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ach_id  TEXT    NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  unlocked_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, ach_id)
);

-- ---------- economy & ops ----------
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency   TEXT NOT NULL,
  delta      REAL NOT NULL,
  balance    REAL NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_u ON ledger(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_r ON ledger(reason, created_at);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  name       TEXT NOT NULL,
  props_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_n ON events(name, created_at);

CREATE TABLE IF NOT EXISTS cache (
  k        TEXT PRIMARY KEY,
  v        TEXT NOT NULL,
  until_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id       TEXT NOT NULL,
  amount_usd    REAL NOT NULL,
  gems          INTEGER NOT NULL,
  tx_hash       TEXT,
  provider      TEXT,
  idem_key      TEXT UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','refunded')),
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  paid_at       INTEGER
);

CREATE VIEW IF NOT EXISTS v_lb AS
SELECT u.id AS user_id, u.username, s.level, s.sparks, s.prestige_count,
       s.total_gold, s.loadout_json
FROM player_state s JOIN users u ON u.id = s.user_id
WHERE u.is_banned = 0
ORDER BY s.total_gold DESC;

-- ---------------------------------------------------------------------------
-- v2.0 additions — admin panel (all IF NOT EXISTS: safe on existing v1 DBs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER,
  actor_name  TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail_json TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit(created_at DESC);

CREATE TABLE IF NOT EXISTS economy_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at          INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  total_gold        REAL,
  total_gems        INTEGER,
  gold_created_24h  REAL,
  gold_burned_24h   REAL,
  faucet_sink_ratio REAL,
  median_gold       REAL,
  active_users_24h  INTEGER,
  new_users_24h     INTEGER,
  revenue_usd       REAL
);
CREATE INDEX IF NOT EXISTS idx_econ_time ON economy_snapshots(taken_at DESC);

-- analytics indexes (admin charts scan ledger/events by time + user)
CREATE INDEX IF NOT EXISTS idx_events_u   ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_ct  ON ledger(currency, created_at);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
