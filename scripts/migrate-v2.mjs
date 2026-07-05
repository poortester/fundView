import { createClient } from '@libsql/client'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '..', '.env.local') })

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
})

const migrations = [
  { name: 'advice_items.thinking', sql: `ALTER TABLE advice_items ADD COLUMN thinking TEXT` },
  { name: 'advice_items.target_position', sql: `ALTER TABLE advice_items ADD COLUMN target_position REAL` },
  { name: 'advice_items.stop_loss_nav', sql: `ALTER TABLE advice_items ADD COLUMN stop_loss_nav REAL` },
  { name: 'advice_items.action_conditions', sql: `ALTER TABLE advice_items ADD COLUMN action_conditions TEXT NOT NULL DEFAULT '[]'` },
  { name: 'advice_items.confidence', sql: `ALTER TABLE advice_items ADD COLUMN confidence TEXT` },
  { name: 'advice_items.verified', sql: `ALTER TABLE advice_items ADD COLUMN verified TEXT NOT NULL DEFAULT 'pending'` },
  { name: 'analysis_reports.agent_context', sql: `ALTER TABLE analysis_reports ADD COLUMN agent_context TEXT` },
  { name: 'idx_advice_fund_status', sql: `CREATE INDEX IF NOT EXISTS idx_advice_fund_status ON advice_items(fund_id, status)` },
  { name: 'idx_analysis_user_date', sql: `CREATE INDEX IF NOT EXISTS idx_analysis_user_date ON analysis_reports(user_id, trade_date)` },
]

async function migrate() {
  console.log('Running v2 migrations...')
  for (const m of migrations) {
    try {
      await db.execute(m.sql)
      console.log(`  ✓ ${m.name}`)
    } catch (err) {
      if (String(err).includes('already exists') || String(err).includes('duplicate column')) {
        console.log(`  ⊙ ${m.name} (already exists)`)
      } else {
        console.error(`  ✗ ${m.name}:`, err.message)
      }
    }
  }
  console.log('Done.')
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
