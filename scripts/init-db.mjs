import { createClient } from '@libsql/client'
import { config } from 'dotenv'

config({ path: '.env.local' })

const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN

if (!url || !authToken) {
  throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in .env.local')
}

const db = createClient({ url, authToken })

const statements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS funds (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    fund_type TEXT NOT NULL,
    manager TEXT,
    company TEXT,
    risk_level TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS watchlist_items (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    fund_id TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, fund_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS holdings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    fund_id TEXT NOT NULL,
    shares REAL NOT NULL DEFAULT 0,
    avg_cost REAL NOT NULL DEFAULT 0,
    target_position_ratio REAL NOT NULL DEFAULT 0,
    account_name TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, fund_id, account_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS market_snapshots (
    id TEXT PRIMARY KEY,
    trade_date TEXT NOT NULL,
    source TEXT NOT NULL,
    index_code TEXT NOT NULL,
    index_name TEXT NOT NULL,
    value REAL NOT NULL,
    change_percent REAL NOT NULL,
    raw_payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(trade_date, source, index_code)
  )`,
  `CREATE TABLE IF NOT EXISTS fund_nav_snapshots (
    id TEXT PRIMARY KEY,
    fund_id TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    nav REAL,
    estimated_nav REAL,
    change_percent REAL,
    source TEXT NOT NULL,
    raw_payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fund_id, trade_date, source),
    FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS analysis_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    risk_profile TEXT NOT NULL,
    summary TEXT NOT NULL,
    market_view TEXT,
    portfolio_view TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, trade_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS advice_items (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    fund_id TEXT,
    title TEXT NOT NULL,
    level TEXT NOT NULL,
    reason TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    baseline_nav REAL,
    executed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (report_id) REFERENCES analysis_reports(id) ON DELETE CASCADE,
    FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trade_plans (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    fund_id TEXT NOT NULL,
    plan_date TEXT NOT NULL,
    action TEXT NOT NULL,
    amount REAL,
    shares REAL,
    trigger_condition TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS trade_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    fund_id TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    action TEXT NOT NULL,
    amount REAL NOT NULL,
    shares REAL NOT NULL,
    price REAL NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS review_notes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    content TEXT NOT NULL,
    checklist TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, trade_date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS fund_exposures (
    id TEXT PRIMARY KEY,
    fund_id TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    sectors TEXT NOT NULL DEFAULT '[]',
    stocks TEXT NOT NULL DEFAULT '[]',
    concepts TEXT NOT NULL DEFAULT '[]',
    asset_allocation TEXT,
    source TEXT NOT NULL DEFAULT 'eastmoney-fund',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(fund_id, trade_date, source),
    FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_fund_nav_trade_date ON fund_nav_snapshots(trade_date)`,
  `CREATE INDEX IF NOT EXISTS idx_market_snapshots_trade_date ON market_snapshots(trade_date)`,
  `CREATE INDEX IF NOT EXISTS idx_advice_report ON advice_items(report_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trade_records_user_date ON trade_records(user_id, trade_date)`,
]

for (const sql of statements) {
  await db.execute(sql)
}

const tables = await db.execute(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
  ORDER BY name
`)

console.log('Database initialized.')
console.table(tables.rows.map((row) => ({ table: row.name })))
