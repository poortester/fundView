import { createClient } from '@libsql/client'
import { config } from 'dotenv'
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

config({ path: '.env.local' })

const app = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })
const port = Number(process.env.API_PORT ?? 4001)
const userId = 'demo-user'
const tradeDate = resolveTradeDate()
const llmSettingsUrl = new URL('../llm-settings.local.json', import.meta.url)

const db = createClient({
  url: requiredEnv('TURSO_DATABASE_URL'),
  authToken: requiredEnv('TURSO_AUTH_TOKEN'),
})

app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_request, response) => response.json({ ok: true }))

app.get('/api/settings/llm', async (_request, response, next) => {
  try {
    response.json(sanitizeLlmSettings(await readLlmSettings()))
  } catch (error) {
    next(error)
  }
})

app.post('/api/settings/llm/providers', async (request, response, next) => {
  try {
    const settings = await readLlmSettings()
    const provider = normalizeLlmProvider(request.body)
    const existing = settings.providers.find((item) => item.id === provider.id)
    if (existing && !provider.apiKey) provider.apiKey = existing.apiKey
    settings.providers = existing
      ? settings.providers.map((item) => item.id === provider.id ? { ...item, ...provider } : item)
      : [...settings.providers, provider]
    if (request.body?.active !== false) settings.activeProviderId = provider.id
    await writeLlmSettings(settings)
    response.json(sanitizeLlmSettings(settings))
  } catch (error) {
    next(error)
  }
})

app.patch('/api/settings/llm/active', async (request, response, next) => {
  try {
    const settings = await readLlmSettings()
    const providerId = cleanString(request.body?.providerId)
    const model = cleanString(request.body?.model)
    const provider = settings.providers.find((item) => item.id === providerId)
    if (!provider) return response.status(404).json({ message: '妯″瀷閰嶇疆涓嶅瓨鍦? })
    if (model) provider.selectedModel = model
    settings.activeProviderId = providerId
    await writeLlmSettings(settings)
    response.json(sanitizeLlmSettings(settings))
  } catch (error) {
    next(error)
  }
})

app.get('/api/dashboard', async (_request, response, next) => {
  try {
    await ensureSeedData()
    await ensureMarketSnapshots()
    response.json(await getDashboardData())
  } catch (error) {
    next(error)
  }
})

app.post('/api/funds', async (request, response, next) => {
  try {
    await ensureSeedData()
    const code = cleanString(request.body?.code)
    const name = cleanString(request.body?.name)
    if (!code && !name) return response.status(400).json({ message: '鐠囩柉绶崗銉ョ唨闁叉垳鍞惍浣瑰灗閸氬秶袨' })

    const fund = normalizeFundPayload({ ...request.body, code, name })
    let fundId = randomUUID()
    let latestNav = fund.nav
    let latestChange = fund.estimateChange
    const statements = []

    if (/^\d{6}$/.test(fund.code)) {
      const fundData = await fetchEastmoneyFundNav(fund.code)
      const realtimeEstimate = await fetchFundRealtimeEstimate(fund.code).catch(() => null)
      fund.name = fundData.name || fund.name || `閸╂椽鍣?{fund.code}`
      latestNav = realtimeEstimate?.estimatedNav ?? fundData.latest.nav
      latestChange = realtimeEstimate?.changePercent ?? fundData.latest.changePercent
    }

    const existingFund = fund.code ? await db.execute({
      sql: `SELECT id FROM funds WHERE code = ? LIMIT 1`,
      args: [fund.code],
    }) : { rows: [] }

    if (existingFund.rows[0]?.id) {
      fundId = String(existingFund.rows[0].id)
      statements.push({
        sql: `UPDATE funds SET name = ?, fund_type = ?, tags = ?, updated_at = datetime('now') WHERE id = ?`,
        args: [fund.name, fund.type, JSON.stringify(fund.tags), fundId],
      })
    } else {
      statements.push({
        sql: `INSERT INTO funds (id, code, name, fund_type, tags) VALUES (?, ?, ?, ?, ?)`,
        args: [fundId, fund.code || createFundCode(), fund.name, fund.type, JSON.stringify(fund.tags)],
      })
    }

    statements.push(
      {
        sql: `INSERT INTO holdings (id, user_id, fund_id, shares, avg_cost, target_position_ratio)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id, fund_id, account_name)
              DO UPDATE SET shares = excluded.shares,
                            avg_cost = excluded.avg_cost,
                            target_position_ratio = excluded.target_position_ratio,
                            updated_at = datetime('now')`,
        args: [randomUUID(), userId, fundId, fund.shares, fund.cost, fund.positionRatio],
      },
      fundNavStatement({
        fundId,
        date: tradeDate,
        nav: latestNav,
        estimatedNav: latestNav,
        changePercent: latestChange,
        source: /^\d{6}$/.test(fund.code) ? 'eastmoney-fund' : 'manual',
      }),
    )

    await db.batch(statements, 'write')
    await refreshRealDataSources()

    response.status(201).json(await getDashboardData())
  } catch (error) {
    next(error)
  }
})

app.put('/api/funds/:id', async (request, response, next) => {
  try {
    await ensureSeedData()
    const fundId = request.params.id
    const fund = normalizeFundPayload(request.body)

    await db.batch([
      {
        sql: `UPDATE funds
              SET code = ?, name = ?, fund_type = ?, tags = ?, updated_at = datetime('now')
              WHERE id = ?`,
        args: [fund.code || createFundCode(), fund.name, fund.type, JSON.stringify(fund.tags), fundId],
      },
      {
        sql: `UPDATE holdings
              SET shares = ?, avg_cost = ?, target_position_ratio = ?, updated_at = datetime('now')
              WHERE user_id = ? AND fund_id = ?`,
        args: [fund.shares, fund.cost, fund.positionRatio, userId, fundId],
      },
      latestNavStatement(fundId, fund.nav, fund.estimateChange),
    ], 'write')

    response.json(await getDashboardData())
  } catch (error) {
    next(error)
  }
})

async function updateFundsBulk(request, response, next) {
  try {
    await ensureSeedData()
    const updates = request.body?.funds ?? []
    const statements = []
    for (const update of updates) {
      const fund = normalizeFundPayload(update)
      statements.push({
        sql: `UPDATE funds
              SET code = ?, name = ?, fund_type = ?, tags = ?, updated_at = datetime('now')
              WHERE id = ?`,
        args: [fund.code || createFundCode(), fund.name, fund.type, JSON.stringify(fund.tags), fund.id],
      })
      statements.push({
        sql: `UPDATE holdings
              SET shares = ?, avg_cost = ?, target_position_ratio = ?, updated_at = datetime('now')
              WHERE user_id = ? AND fund_id = ?`,
        args: [fund.shares, fund.cost, fund.positionRatio, userId, fund.id],
      })
      statements.push(latestNavStatement(fund.id, fund.nav, fund.estimateChange))
    }
    if (statements.length) await db.batch(statements, 'write')
    response.json(await getDashboardData({ skipAnalysis: true }))
  } catch (error) {
    next(error)
  }
}

app.post('/api/funds/batch', updateFundsBulk)
app.put('/api/funds/bulk', updateFundsBulk)

app.delete('/api/funds/:id', async (request, response, next) => {
  try {
    const fundId = request.params.id
    await db.batch([
      { sql: `DELETE FROM holdings WHERE user_id = ? AND fund_id = ?`, args: [userId, fundId] },
      { sql: `DELETE FROM fund_nav_snapshots WHERE fund_id = ?`, args: [fundId] },
      { sql: `DELETE FROM funds WHERE id = ?`, args: [fundId] },
    ], 'write')
    response.json(await getDashboardData())
  } catch (error) {
    next(error)
  }
})

app.post('/api/holdings/import-from-ocr', async (request, response, next) => {
  try {
    await ensureSeedData()
    const holdings = Array.isArray(request.body?.holdings) ? request.body.holdings : []
    const uniqueHoldings = [...new Map(holdings
      .map((item) => normalizeOcrImportHolding(item))
      .filter(Boolean)
      .map((item) => [item.code, item])).values()]
    if (uniqueHoldings.length === 0) return response.status(400).json({ message: '濞屸剝婀侀崣顖氼嚤閸忋儳娈戦崺娲櫨娴狅絿鐖? })

    const resolvedHoldings = await Promise.all(uniqueHoldings.map((holding) => resolveOcrImportHolding(holding)))
    const statements = []
    for (const resolved of resolvedHoldings) {
      const fundId = randomUUID()
      statements.push(
        {
          sql: `INSERT OR IGNORE INTO funds (id, code, name, fund_type, tags) VALUES (?, ?, ?, ?, ?)`,
          args: [fundId, resolved.code, resolved.name, resolved.type || 'OCR鐎电厧鍙?, JSON.stringify(['OCR鐎电厧鍙?])],
        },
        {
          sql: `UPDATE funds SET name = ?, fund_type = ?, tags = ?, updated_at = datetime('now') WHERE code = ?`,
          args: [resolved.name, resolved.type || 'OCR鐎电厧鍙?, JSON.stringify(['OCR鐎电厧鍙?]), resolved.code],
        },
        {
          sql: `INSERT INTO holdings (id, user_id, fund_id, shares, avg_cost, target_position_ratio, account_name)
                SELECT ?, ?, id, ?, ?, ?, ? FROM funds WHERE code = ?
                ON CONFLICT(user_id, fund_id, account_name)
                DO UPDATE SET shares = excluded.shares,
                              avg_cost = excluded.avg_cost,
                              target_position_ratio = excluded.target_position_ratio,
                              updated_at = datetime('now')`,
          args: [randomUUID(), userId, resolved.shares, resolved.cost, resolved.positionRatio, 'default', resolved.code],
        },
      )
    }
    await db.batch(statements, 'write')
    response.json(await getDashboardData())
  } catch (error) {
    next(error)
  }
})

app.put('/api/review', async (request, response, next) => {
  try {
    await ensureSeedData()
    const content = cleanString(request.body?.content)
    const checklist = Array.isArray(request.body?.checklist) ? request.body.checklist.map(String) : []
    await db.execute({
      sql: `INSERT INTO review_notes (id, user_id, trade_date, content, checklist)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, trade_date)
            DO UPDATE SET content = excluded.content, checklist = excluded.checklist, updated_at = datetime('now')`,
      args: [randomUUID(), userId, tradeDate, content, JSON.stringify(checklist)],
    })
    response.json(await getDashboardData())
  } catch (error) {
    next(error)
  }
})

app.get('/api/review', async (_request, response, next) => {
  try {
    await ensureSeedData()
    response.json(await readReview())
  } catch (error) {
    next(error)
  }
})

app.get('/api/review/stats', async (_request, response, next) => {
  try {
    await ensureSeedData()
    response.json(await getAdviceStats())
  } catch (error) {
    next(error)
  }
})

app.get('/api/review/attribution', async (_request, response, next) => {
  try {
    await ensureSeedData()
    response.json(await getAdviceAttribution())
  } catch (error) {
    next(error)
  }
})

app.post('/api/analysis/refresh', async (_request, response, next) => {
  try {
    await ensureSeedData()
    await persistAnalysisReport()
    response.json(await getDashboardData())
  } catch (error) {
    next(error)
  }
})

app.patch('/api/advice/:id', async (request, response, next) => {
  try {
    const adviceId = request.params.id
    const requested = cleanString(request.body?.status)
    const status = ['open', 'executed', 'skipped'].includes(requested) ? requested : 'executed'

    let baselineNav = null
    let fundId = null
    if (status === 'executed') {
      const adviceRow = await db.execute({ sql: `SELECT fund_id FROM advice_items WHERE id = ?`, args: [adviceId] })
      fundId = String(adviceRow.rows[0]?.fund_id ?? '')
      if (fundId) {
        const navRow = await db.execute({
          sql: `SELECT estimated_nav, nav FROM fund_nav_snapshots WHERE fund_id = ? ORDER BY created_at DESC LIMIT 1`,
          args: [fundId],
        })
        baselineNav = Number(navRow.rows[0]?.estimated_nav ?? navRow.rows[0]?.nav ?? 0) || null
      }
    }

    await db.execute({
      sql: `UPDATE advice_items SET status = ?, baseline_nav = ?, executed_at = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [status, baselineNav, status === 'executed' ? new Date().toISOString() : null, adviceId],
    })
    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/data/refresh', async (_request, response, next) => {
  try {
    await ensureSeedData()
    const refreshReport = await refreshRealDataSources()
    await persistAnalysisReport()
    response.json({ ...await getDashboardData(), refreshReport, dataSourceStatus: await getDataSourceStatus() })
  } catch (error) {
    next(error)
  }
})

app.get('/api/data-sources/status', async (_request, response, next) => {
  try {
    await ensureSeedData()
    response.json(await getDataSourceStatus())
  } catch (error) {
    next(error)
  }
})

app.get('/api/funds/:id/evidence', async (request, response, next) => {
  try {
    await ensureSeedData()
    response.json(await getFundEvidence(request.params.id))
  } catch (error) {
    next(error)
  }
})

app.get('/api/funds/:id/analysis-history', async (request, response, next) => {
  try {
    await ensureSeedData()
    response.json(await getFundAnalysisHistory(request.params.id))
  } catch (error) {
    next(error)
  }
})

app.patch('/api/advice/:id/verify', async (request, response, next) => {
  try {
    const adviceId = request.params.id
    const verified = cleanString(request.body?.verified)
    if (!['correct', 'incorrect', 'pending'].includes(verified)) return response.status(400).json({ message: 'verified must be correct/incorrect/pending' })
    await db.execute({
      sql: `UPDATE advice_items SET verified = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [verified, adviceId],
    })
    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ocr/position-screenshot', upload.single('image'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ message: '璇蜂笂浼犳寔浠撴埅鍥? })
    if (!request.file.mimetype.startsWith('image/')) return response.status(400).json({ message: '鍙敮鎸佸浘鐗囨枃浠? })
    response.json(await recognizePositionScreenshot(request.file.buffer))
  } catch (error) {
    next(error)
  }
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(error.statusCode ?? 500).json({ message: error instanceof Error ? error.message : '鏈嶅姟鍣ㄩ敊璇? })
})

app.listen(port, '127.0.0.1', () => {
  console.log(`API server listening on http://127.0.0.1:${port}`)
  setInterval(() => {}, 60000)
})

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name} in .env.local`)
  return value
}

function cleanString(value) {
  return String(value ?? '').trim()
}

async function readLlmSettings() {
  let settings = { activeProviderId: '', providers: [] }
  try {
    settings = JSON.parse(await readFile(llmSettingsUrl, 'utf8'))
  } catch {
    settings = { activeProviderId: '', providers: [] }
  }
  if (!Array.isArray(settings.providers)) settings.providers = []

  if (process.env.LLM_API_KEY && !settings.providers.some((item) => item.id === 'env-default')) {
    settings.providers.unshift({
      id: 'env-default',
      provider: 'openai-compatible',
      name: '鐜鍙橀噺榛樿妯″瀷',
      baseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
      apiKey: process.env.LLM_API_KEY,
      models: [process.env.LLM_MODEL || 'gpt-4o-mini'],
      selectedModel: process.env.LLM_MODEL || 'gpt-4o-mini',
      source: 'env',
    })
    if (!settings.activeProviderId) settings.activeProviderId = 'env-default'
  }

  return settings
}

async function writeLlmSettings(settings) {
  const persisted = {
    activeProviderId: settings.activeProviderId || settings.providers[0]?.id || '',
    providers: settings.providers.filter((item) => item.source !== 'env'),
  }
  await writeFile(llmSettingsUrl, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
}

async function getActiveLlmConfig() {
  const settings = await readLlmSettings()
  const active = settings.providers.find((item) => item.id === settings.activeProviderId) ?? settings.providers[0]
  if (!active?.apiKey) return null
  return active
}

function sanitizeLlmSettings(settings) {
  return {
    activeProviderId: settings.activeProviderId || '',
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      provider: provider.provider,
      name: provider.name,
      baseUrl: provider.baseUrl,
      models: provider.models,
      selectedModel: provider.selectedModel,
      source: provider.source || 'local',
      hasApiKey: Boolean(provider.apiKey),
      apiKeyPreview: provider.apiKey ? maskSecret(provider.apiKey) : '',
    })),
  }
}

function normalizeLlmProvider(input) {
  const provider = cleanString(input?.provider) || 'openai-compatible'
  const name = cleanString(input?.name) || provider
  const id = cleanString(input?.id) || `${provider}-${randomUUID()}`
  const baseUrl = cleanString(input?.baseUrl) || defaultLlmBaseUrl(provider)
  const apiKey = cleanString(input?.apiKey)
  const models = Array.isArray(input?.models)
    ? input.models.map(cleanString).filter(Boolean)
    : cleanString(input?.models).split(',').map((item) => item.trim()).filter(Boolean)
  const selectedModel = cleanString(input?.selectedModel) || models[0] || defaultLlmModel(provider)
  return {
    id,
    provider,
    name,
    baseUrl,
    apiKey,
    models: models.length ? models : [selectedModel],
    selectedModel,
    source: 'local',
  }
}

function defaultLlmBaseUrl(provider) {
  const map = {
    openai: 'https://api.openai.com/v1',
    'openai-compatible': 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    anthropic: 'https://api.anthropic.com/v1',
  }
  return map[provider] || 'https://api.openai.com/v1'
}

function defaultLlmModel(provider) {
  const map = {
    openai: 'gpt-4o-mini',
    'openai-compatible': 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
    qwen: 'qwen-plus',
    zhipu: 'glm-4-flash',
    anthropic: 'claude-3-5-haiku-latest',
  }
  return map[provider] || 'gpt-4o-mini'
}

function maskSecret(value) {
  if (!value) return ''
  if (value.length <= 8) return '宸插～鍐?
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function createFundCode() {
  return String(Math.floor(100000 + Math.random() * 899999))
}

function normalizeFundPayload(body) {
  return {
    id: body?.id,
    code: cleanString(body?.code),
    name: cleanString(body?.name) || '鏈懡鍚嶅熀閲?,
    type: cleanString(body?.type) || '涓诲姩鏉冪泭',
    cost: toNumber(body?.cost, 1),
    nav: toNumber(body?.nav, 1),
    shares: toNumber(body?.shares, 0),
    estimateChange: toNumber(body?.estimateChange, 0),
    positionRatio: toNumber(body?.positionRatio, 0),
    tags: cleanString(body?.tags).split(/[,\s锛屻€乚+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 6),
  }
}

function toNumber(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function latestNavStatement(fundId, nav, changePercent) {
  return {
    sql: `INSERT INTO fund_nav_snapshots (id, fund_id, trade_date, nav, estimated_nav, change_percent, source)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(fund_id, trade_date, source)
          DO UPDATE SET nav = excluded.nav, estimated_nav = excluded.estimated_nav, change_percent = excluded.change_percent`,
    args: [randomUUID(), fundId, tradeDate, nav, nav, changePercent, 'manual'],
  }
}

function fundNavStatement({ fundId, date = tradeDate, nav, estimatedNav = nav, changePercent, source = 'manual', rawPayload = null }) {
  return {
    sql: `INSERT INTO fund_nav_snapshots (id, fund_id, trade_date, nav, estimated_nav, change_percent, source, raw_payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(fund_id, trade_date, source)
          DO UPDATE SET nav = excluded.nav,
                        estimated_nav = excluded.estimated_nav,
                        change_percent = excluded.change_percent,
                        raw_payload = excluded.raw_payload,
                        created_at = datetime('now')`,
    args: [randomUUID(), fundId, date, nav, estimatedNav, changePercent, source, rawPayload ? JSON.stringify(rawPayload) : null],
  }
}

async function ensureSeedData() {
  await db.execute({
    sql: `INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)`,
    args: [userId, 'demo@local.fund', '鏈湴鐢ㄦ埛'],
  })
}

async function ensureMarketSnapshots() {
  const count = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM market_snapshots WHERE trade_date = ? AND source = 'eastmoney'`,
    args: [tradeDate],
  })
  if (Number(count.rows[0]?.count ?? 0) === 0) await refreshRealDataSources()
}

async function refreshRealDataSources() {
  const report = {
    market: { source: 'eastmoney', ok: false, count: 0, fallback: false, message: '' },
    fundNav: { source: 'eastmoney-fund', ok: false, count: 0, fallback: false, message: '' },
    exposure: { source: 'eastmoney-fund', ok: false, count: 0, message: '' },
  }

  await Promise.all([
    (async () => {
      try {
    const marketSnapshots = await fetchEastmoneyMarketSnapshots()
    await upsertMarketSnapshotRows(marketSnapshots)
    report.market.ok = true
    report.market.count = marketSnapshots.length
    report.market.message = 'real market snapshots refreshed'
      } catch (error) {
    report.market.ok = false
    report.market.message = errorMessage(error)
      }
    })(),

    (async () => {
      try {
    const fundResult = await refreshEastmoneyFundNavSnapshots()
    report.fundNav.ok = fundResult.count > 0
    report.fundNav.count = fundResult.count
    report.fundNav.message = fundResult.message
      } catch (error) {
    report.fundNav.ok = false
    report.fundNav.message = errorMessage(error)
      }
    })(),

    (async () => {
      try {
    const exposureResult = await persistFundExposures()
    report.exposure.ok = exposureResult.ok
    report.exposure.count = exposureResult.count
    report.exposure.message = exposureResult.message
      } catch (error) {
    report.exposure.ok = false
    report.exposure.message = errorMessage(error)
      }
    })(),
  ])

  return report
}

async function fetchEastmoneyMarketSnapshots() {
  const secids = [
    ['CSI300', '1.000300'],
    ['CHINEXT', '0.399006'],
    ['SSE', '1.000001'],
    ['SZSE', '0.399001'],
    ['HSI', '100.HSI'],
    ['HSTECH', '124.HSTECH'],
    ['NDX', '100.NDX'],
    ['SPX', '100.SPX'],
    ['USDCNH', '133.USDCNH'],
    ['CN10Y', '171.CN10Y'],
  ]
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3&secids=${secids.map(([, secid]) => secid).join(',')}`
  const payload = await fetchJson(url)
  const codeMap = Object.fromEntries(secids.map(([code, secid]) => [secid.split('.')[1], code]))
  const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : []
  if (!rows.length) throw new Error('eastmoney market response is empty')
  return rows
    .filter((row) => Number.isFinite(Number(row.f2)) && Number.isFinite(Number(row.f3)))
    .map((row) => ({
      code: codeMap[String(row.f12)] ?? String(row.f12),
      name: String(row.f14),
      value: Number(row.f2),
      change: Number(row.f3),
      source: 'eastmoney',
      raw: row,
    }))
}

async function upsertMarketSnapshotRows(rows) {
  if (!rows.length) return
  await db.batch(rows.map((row) => ({
    sql: `INSERT INTO market_snapshots (id, trade_date, source, index_code, index_name, value, change_percent, raw_payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(trade_date, source, index_code)
          DO UPDATE SET index_name = excluded.index_name,
                        value = excluded.value,
                        change_percent = excluded.change_percent,
                        raw_payload = excluded.raw_payload,
                        created_at = datetime('now')`,
    args: [randomUUID(), tradeDate, row.source, row.code, row.name, row.value, row.change, JSON.stringify(row.raw)],
  })), 'write')
}

async function refreshEastmoneyFundNavSnapshots() {
  const funds = await readFunds()
  const statements = []
  const errors = []

  await Promise.all(funds.map(async (fund) => {
    if (!/^\d{6}$/.test(fund.code)) return
    try {
      const realtimeEstimate = await fetchFundRealtimeEstimate(fund.code)
      statements.push(fundNavStatement({
        fundId: fund.id,
        date: realtimeEstimate.date,
        nav: realtimeEstimate.unitNav,
        estimatedNav: realtimeEstimate.estimatedNav,
        changePercent: realtimeEstimate.changePercent,
        source: 'eastmoney-fund',
        rawPayload: realtimeEstimate.raw,
      }))
    } catch (error) {
      errors.push(`${fund.code}:${errorMessage(error)}`)
    }
  }))

  if (statements.length) await db.batch(statements, 'write')
  return {
    count: funds.length - errors.length,
    rows: statements.length,
    message: statements.length ? `realtime estimates refreshed, failed ${errors.length}` : `no realtime estimates refreshed: ${errors.join('; ')}`,
    errors,
  }
}

async function fetchEastmoneyFundNav(code) {
  const text = await fetchText(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`)
  const name = readJsString(text, 'fS_name')
  const trendText = readJsArray(text, 'Data_netWorthTrend')
  const trend = JSON.parse(trendText)
  const stockCodes = readJsArrayLoose(text, 'stockCodesNew')
  const assetAllocation = readJsObjectLoose(text, 'Data_assetAllocation')
  const latest = trend.at(-1)
  if (!latest || !Number.isFinite(Number(latest.y))) throw new Error(`eastmoney fund nav missing for ${code}`)
  return {
    code,
    name,
    stockCodes,
    assetAllocation,
    latest: normalizeEastmoneyNavPoint(code, name, latest),
    history: trend
      .filter((item) => Number.isFinite(Number(item?.x)) && Number.isFinite(Number(item?.y)))
      .map((item) => normalizeEastmoneyNavPoint(code, name, item)),
  }
}

async function fetchFundRealtimeEstimate(code) {
  const text = await fetchText(`https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`)
  const match = text.match(/jsonpgz\((.*)\);?/)
  if (!match) throw new Error(`fund estimate missing for ${code}`)
  const payload = JSON.parse(match[1])
  const estimatedNav = Number(payload.gsz)
  const unitNav = Number(payload.dwjz)
  const changePercent = Number(payload.gszzl)
  if (!Number.isFinite(estimatedNav) || !Number.isFinite(changePercent)) {
    throw new Error(`fund estimate invalid for ${code}`)
  }
  return {
    code,
    name: String(payload.name ?? ''),
    date: String(payload.gztime ?? '').slice(0, 10) || tradeDate,
    estimateTime: String(payload.gztime ?? ''),
    navDate: String(payload.jzrq ?? ''),
    unitNav: Number.isFinite(unitNav) ? unitNav : estimatedNav,
    estimatedNav,
    changePercent,
    raw: payload,
  }
}

function normalizeEastmoneyNavPoint(code, name, item) {
  return {
    code,
    name,
    date: formatDate(item.x),
    nav: Number(item.y),
    changePercent: Number(item.equityReturn ?? 0),
    raw: {
      code,
      name,
      x: item.x,
      y: item.y,
      equityReturn: item.equityReturn,
      unitMoney: item.unitMoney,
    },
  }
}

function readJsString(text, variableName) {
  const match = text.match(new RegExp(`var\\s+${variableName}\\s*=\\s*"([^"]*)"`))
  return match?.[1] ?? ''
}

function readJsArray(text, variableName) {
  const match = text.match(new RegExp(`${variableName}\\s*=\\s*(\\[.*?\\]);`, 's'))
  if (!match) throw new Error(`${variableName} not found`)
  return match[1]
}

function readJsArrayLoose(text, variableName) {
  const match = text.match(new RegExp(`${variableName}\\s*=\\s*(\\[.*?\\]);`, 's'))
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function readJsObjectLoose(text, variableName) {
  const match = text.match(new RegExp(`${variableName}\\s*=\\s*(\\{.*?\\});`, 's'))
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

async function fetchEastmoneyStockQuotes(secids) {
  const uniqueSecids = [...new Set(secids)].filter((item) => /^[01]\.\d{6}$/.test(item)).slice(0, 30)
  if (!uniqueSecids.length) return []
  const fields = 'f12,f14,f2,f3,f100,f102,f103,f124'
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=${fields}&secids=${uniqueSecids.join(',')}`
  const payload = await fetchJson(url)
  const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : []
  return rows
    .filter((row) => Number.isFinite(Number(row.f2)) && Number.isFinite(Number(row.f3)))
    .map((row) => ({
      code: String(row.f12),
      name: String(row.f14),
      price: Number(row.f2),
      changePercent: Number(row.f3),
      industry: String(row.f100 || '鏈垎绫?),
      region: String(row.f102 || ''),
      concepts: String(row.f103 || '').split(',').filter(Boolean).slice(0, 6),
      updatedAt: Number(row.f124 || 0),
      raw: row,
    }))
}

function summarizeSectors(stockQuotes) {
  const sectors = new Map()
  for (const stock of stockQuotes) {
    const key = stock.industry || '鏈垎绫?
    const current = sectors.get(key) ?? { name: key, count: 0, avgChange: 0, stocks: [] }
    current.count += 1
    current.avgChange += stock.changePercent
    current.stocks.push({ code: stock.code, name: stock.name, changePercent: stock.changePercent })
    sectors.set(key, current)
  }
  return [...sectors.values()]
    .map((item) => ({
      ...item,
      avgChange: Number((item.avgChange / item.count).toFixed(2)),
      weight: Number((item.count / Math.max(1, stockQuotes.length) * 100).toFixed(2)),
    }))
    .sort((a, b) => b.weight - a.weight || Math.abs(b.avgChange) - Math.abs(a.avgChange))
}

async function fetchJson(url) {
  const text = await fetchText(url)
  return JSON.parse(text)
}

async function fetchText(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: '*/*',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

function formatDate(timestamp) {
  const date = new Date(Number(timestamp))
  if (Number.isNaN(date.getTime())) return tradeDate
  return date.toISOString().slice(0, 10)
}

function resolveTradeDate(reference = new Date()) {
  const date = new Date(reference)
  const day = date.getDay()
  if (day === 0) date.setDate(date.getDate() - 2)
  else if (day === 6) date.setDate(date.getDate() - 1)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${dayOfMonth}`
}

async function getDataSourceStatus() {
  const market = await db.execute({
    sql: `SELECT source, COUNT(*) AS count, MAX(created_at) AS last_updated
          FROM market_snapshots
          WHERE source = 'eastmoney'
          GROUP BY source
          ORDER BY last_updated DESC`,
  })
  const fundNav = await db.execute({
    sql: `SELECT source, COUNT(*) AS count, MAX(created_at) AS last_updated
          FROM fund_nav_snapshots
          WHERE source = 'eastmoney-fund'
          GROUP BY source
          ORDER BY last_updated DESC`,
  })
  return {
    market: market.rows.map((row) => ({
      source: String(row.source),
      count: Number(row.count),
      lastUpdated: String(row.last_updated),
      healthy: Number(row.count) > 0,
    })),
    fundNav: fundNav.rows.map((row) => ({
      source: String(row.source),
      count: Number(row.count),
      lastUpdated: String(row.last_updated),
      healthy: Number(row.count) > 0,
    })),
  }
}

async function getFundEvidence(fundId) {
  const funds = await readFunds()
  const fund = funds.find((item) => item.id === fundId)
  if (!fund) {
    const error = new Error('Fund not found')
    error.statusCode = 404
    throw error
  }

  const markets = await readMarkets()
  const marketMap = Object.fromEntries(markets.map((market) => [market.code, market.change]))
  const analysis = analyzeFund(fund, marketMap)
  const history = await readFundNavHistory(fundId, 180)
  const latest = history.at(-1)
  const benchmark = chooseBenchmark(fund, marketMap)
  const exposure = await getFundExposure(fund.code).catch((error) => ({
    source: 'eastmoney-fund',
    ok: false,
    message: errorMessage(error),
    assetAllocation: null,
    sectors: [],
    stocks: [],
    concepts: [],
  }))
  const [sectorLeaders, fundNews, announcements, breadth] = await Promise.all([
    fetchEastmoneySectorLeaders().catch((error) => ({ source: 'eastmoney-sector', ok: false, message: errorMessage(error), items: [] })),
    fetchEastmoneyFundNews(fund.code).catch((error) => ({ source: 'eastmoney-fund-news', ok: false, message: errorMessage(error), items: [] })),
    fetchEastmoneyFundAnnouncements(fund.code).catch((error) => ({ source: 'eastmoney-announcement', ok: false, message: errorMessage(error), items: [] })),
    fetchMarketBreadth().catch((error) => ({ source: 'eastmoney-breadth', ok: false, message: 'breadth failed', advancing: 0, declining: 0, advanceRatio: 0, breadth: 0 })),
  ])
  const newsContext = buildNewsContext(fund, exposure, markets, fundNews.items)
  const sentiment = await gatherMarketSentiment(markets, sectorLeaders, fundNews, breadth)
  const adviceAccuracy = await readFundAdviceAccuracy(fund.id)
  const agents = await buildFundAgents({ fund, markets, benchmark, analysis: { category: '', advice: null }, metricsHistory: history, exposure, sectorLeaders, fastNews: fundNews, announcements, sentiment, adviceAccuracy })

  return {
    fund: {
      id: fund.id,
      code: fund.code,
      name: fund.name,
      type: fund.type,
      tags: fund.tags,
      positionRatio: fund.positionRatio,
      latestNav: fund.nav,
      estimateChange: fund.estimateChange,
    },
    benchmark,
    analysis,
    metrics: {
      latestDate: latest?.tradeDate ?? null,
      latestSource: latest?.source ?? 'unknown',
      points: history.length,
      last30: computeNavMetrics(history.slice(-30)),
      last90: computeNavMetrics(history.slice(-90)),
      last180: computeNavMetrics(history.slice(-180)),
    },
    exposure,
    sectorLeaders,
    fastNews: fundNews,
    announcements,
    newsContext,
    agents,
    sourceStatus: [
      { source: 'eastmoney-fund', ok: exposure.ok, count: (exposure.stocks ?? []).length, message: exposure.message },
      { source: sectorLeaders.source, ok: sectorLeaders.ok, count: sectorLeaders.items.length, message: sectorLeaders.message },
      { source: fundNews.source, ok: fundNews.ok, count: fundNews.items.length, message: fundNews.message },
      { source: announcements.source, ok: announcements.ok, count: announcements.items.length, message: announcements.message },
    ],
    evidence: [
      {
        type: 'fund_nav',
        source: latest?.source ?? 'unknown',
        title: '鍩洪噾鍑€鍊?,
        value: latest ? `${latest.tradeDate} NAV ${latest.nav}` : '鏆傛棤鍘嗗彶鍑€鍊?,
      },
      {
        type: 'market',
        source: markets.find((market) => market.code === benchmark.code)?.source ?? 'unknown',
        title: benchmark.name,
        value: formatPct(benchmark.change),
      },
      {
        type: 'position',
        source: 'portfolio-db',
        title: '褰撳墠浠撲綅',
        value: `${fund.positionRatio}%`,
      },
    ],
    history: history.slice(-60),
  }
}

function buildNewsContext(fund, exposure, markets) {
  const sectorKeywords = (exposure?.sectors ?? []).slice(0, 4).map((item) => item.name)
  const stockKeywords = (exposure?.stocks ?? []).slice(0, 5).map((item) => item.name)
  const marketKeywords = markets.slice(0, 4).map((item) => item.name)
  return {
    source: 'eastmoney-news',
    keywords: [...new Set([fund.name, fund.code, ...sectorKeywords, ...stockKeywords, ...marketKeywords])],
    inputs: [
      `鍩洪噾锛?{fund.name}(${fund.code})`,
      `瀹炴椂浼板€硷細${formatPct(fund.estimateChange)}`,
      sectorKeywords.length ? `涓昏鏉垮潡锛?{sectorKeywords.join('銆?)}` : '',
      stockKeywords.length ? `閲嶄粨鑲＄エ锛?{stockKeywords.join('銆?)}` : '',
      marketKeywords.length ? `甯傚満鍙傝€冿細${marketKeywords.join('銆?)}` : '',
    ].filter(Boolean),
  }
}

async function fetchEastmoneySectorLeaders() {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=12&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f2,f3,f62,f128'
  const payload = await fetchJson(url)
  const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : []
  return {
    source: 'eastmoney-sector',
    ok: rows.length > 0,
    message: rows.length ? 'sector leaders refreshed' : 'sector leaders empty',
    items: rows.map((row) => ({
      code: String(row.f12),
      name: String(row.f14),
      value: Number(row.f2),
      changePercent: Number(row.f3),
      mainStock: String(row.f128 || ''),
      netInflow: Number(row.f62 || 0),
    })).filter((item) => Number.isFinite(item.changePercent)),
  }
}

async function fetchMarketBreadth() {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5000&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f3'
  const payload = await fetchJson(url)
  const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : []
  let advancing = 0
  let declining = 0
  let flat = 0
  let totalNetInflow = 0
  for (const row of rows) {
    const change = Number(row.f3)
    if (!Number.isFinite(change)) continue
    if (change > 0) advancing += 1
    else if (change < 0) declining += 1
    else flat += 1
  }
  const total = advancing + declining + flat
  return {
    source: 'eastmoney-breadth',
    ok: total > 0,
    advancing,
    declining,
    flat,
    total,
    advanceRatio: total > 0 ? Number((advancing / total * 100).toFixed(1)) : 0,
    breadth: total > 0 ? Number(((advancing - declining) / total * 100).toFixed(1)) : 0,
    message: `娑撳﹥瀹?{advancing}鐎硅绱濇稉瀣┘${declining}鐎硅绱濇稉濠冨畾閸楃姵鐦?{total > 0 ? (advancing / total * 100).toFixed(1) : 0}%`,
  }
}

async function fetchEastmoneyFastNews() {
  const url = `https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=&sortEnd=&pageSize=20&req_trace=${Date.now()}`
  const payload = await fetchJsonWithReferer(url, 'https://kuaixun.eastmoney.com/')
  const rows = Array.isArray(payload?.data?.fastNewsList) ? payload.data.fastNewsList : []
  return {
    source: 'eastmoney-news',
    ok: rows.length > 0,
    message: rows.length ? 'fast news refreshed' : 'fast news empty',
    items: rows.map((row) => ({
      id: String(row.code || row.realSort || ''),
      title: cleanHtmlText(row.title),
      summary: cleanHtmlText(row.summary),
      time: String(row.showTime || ''),
      stocks: Array.isArray(row.stockList) ? row.stockList.map(String) : [],
    })).filter((item) => item.title),
  }
}

async function fetchEastmoneyFundNews(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('invalid fund code')
  const url = `https://guba.eastmoney.com/list,of${code}.html`
  const html = await fetchTextWithHeaders(url, {
    Referer: `https://fund.eastmoney.com/${code}.html`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  })
  const items = []
  const linkPattern = new RegExp(`<a href="([^"]*news,of${code},\\d+\\.html)"[^>]*title="([^"]+)"`, 'g')
  for (const linkMatch of html.matchAll(linkPattern)) {
    const blockStart = Math.max(0, linkMatch.index - 500)
    const blockEnd = Math.min(html.length, linkMatch.index + 900)
    const block = html.slice(blockStart, blockEnd)
    if (!linkMatch) continue
    const href = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://guba.eastmoney.com${linkMatch[1].startsWith('/') ? '' : '/'}${linkMatch[1]}`
    const title = cleanHtmlText(decodeHtmlEntity(linkMatch[2]))
    if (!title || title.includes('澶╁ぉ鍩洪噾绀惧尯绠＄悊瑙勫垯') || title.includes('鑱婅亰鎴戠殑')) continue
    const tag = cleanHtmlText(block.match(/<em class="hinfo">([\s\S]*?)<\/em>/)?.[1] ?? '')
    const author = cleanHtmlText(block.match(/<span class="l4">[\s\S]*?<font>([\s\S]*?)<\/font>/)?.[1] ?? '')
    const time = cleanHtmlText(block.match(/<span class="l5">([\s\S]*?)<\/span>/)?.[1] ?? '')
    if (!isOfficialFundNews({ title, tag, author })) continue
    items.push({
      id: href.match(/news,[^,]+,(\d+)\.html/)?.[1] ?? href,
      title,
      summary: [tag, author].filter(Boolean).join(' 路 '),
      time,
      url: href,
    })
  }
  const deduped = [...new Map(items.map((item) => [item.id, item])).values()].slice(0, 20)
  return {
    source: 'eastmoney-fund-news',
    ok: deduped.length > 0,
    message: deduped.length ? 'fund news refreshed' : 'fund news empty',
    items: deduped,
  }
}

function isOfficialFundNews({ title, tag, author }) {
  const text = `${title} ${tag} ${author}`
  const officialAuthor = /鍩洪噾璧勮|鍩洪噾鍏憡|澶╁ぉ鍩洪噾|涓滄柟璐㈠瘜|鍩洪噾鍏徃|涓婂競鍏徃鍏憡/.test(author)
  const officialTag = /鍏憡|璧勮|鐮旀姤|鏂伴椈/.test(tag)
  const officialTitle = /鍏憡|瀹氭湡鎶ュ憡|瀛ｅ害鎶ュ憡|骞村害鎶ュ憡|涓湡鎶ュ憡|鎷涘嫙璇存槑涔鍩洪噾浜у搧璧勬枡姒傝|鍩洪噾缁忕悊鍙樻洿|鎵樼鍗忚|鍩洪噾鍚堝悓|椋庨櫓鎻愮ず|娓呯畻鎶ュ憡/.test(title)
  const forumNoise = /鑲″弸|鍩烘皯|鎿嶄綔鍒嗕韩|鏅掓敹鐩妡鍔犱粨|琛ヤ粨|璺戣矾|娓呬簡|璺岄夯|鍋峰悆|缁忕悊涓嶈|鍩洪噾缁忕悊涓嶇煡閬搢澶辨湜|鏄庡ぉ|浠婂ぉ鑳絴鑳戒拱鍚梶鎬庝箞鍔瀨鍨冨溇|鐑倈姝绘椿|鎺ョ洏|闊彍|鐡滃垎|涓轰粈涔坾鎬庝箞|鍜嬪洖浜媩鑰佹槸|涓嶈涔皘闄愯喘鏄粈涔堟剰鎬?.test(text)
  return (officialAuthor || officialTag || officialTitle) && !forumNoise
}

async function fetchEastmoneyFundAnnouncements(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('invalid fund code')
  const url = `https://api.fund.eastmoney.com/f10/JJGG?fundcode=${code}&pageIndex=1&pageSize=6&type=0`
  const payload = await fetchJsonWithReferer(url, 'https://fundf10.eastmoney.com/')
  const rows = Array.isArray(payload?.Data) ? payload.Data : []
  return {
    source: 'eastmoney-announcement',
    ok: rows.length > 0,
    message: rows.length ? 'announcements refreshed' : 'announcements empty',
    items: rows.map((row) => ({
      id: String(row.ID || ''),
      title: cleanHtmlText(row.TITLE),
      category: announcementCategory(row.NEWCATEGORY),
      date: String(row.PUBLISHDATEDesc || '').slice(0, 10),
      url: row.ID ? `https://fund.eastmoney.com/gonggao/${code},${row.ID}.html` : '',
    })).filter((item) => item.title),
  }
}

async function fetchJsonWithReferer(url, referer) {
  return JSON.parse(await fetchTextWithHeaders(url, { Referer: referer }))
}

async function fetchTextWithHeaders(url, extraHeaders = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: '*/*',
        ...extraHeaders,
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

function announcementCategory(value) {
  const map = {
    1: '鍙戣杩愪綔',
    2: '鍒嗙孩鍏憡',
    3: '瀹氭湡鎶ュ憡',
    4: '浜轰簨璋冩暣',
    5: '鍩洪噾閿€鍞?,
    6: '鍏朵粬鍏憡',
  }
  return map[Number(value)] ?? '鍩洪噾鍏憡'
}

function cleanHtmlText(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeHtmlEntity(value) {
  return String(value ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function matchNewsForFund(fund, exposure, fastNews = []) {
  const keywords = [
    ...deriveFundNewsKeywords(fund),
    ...fund.tags,
    ...(exposure?.sectors ?? []).map((item) => item.name),
    ...(exposure?.stocks ?? []).map((item) => item.name),
    ...(exposure?.concepts ?? []).map((item) => item.name),
  ].map(cleanString).filter((item) => item.length >= 2 && item !== 'OCR瀵煎叆')
  return fastNews
    .map((item) => ({
      ...item,
      score: keywords.reduce((sum, keyword) => {
        const text = `${item.title} ${item.summary}`
        return sum + (text.includes(keyword) ? 1 : 0)
      }, 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
}

function deriveFundNewsKeywords(fund) {
  const name = cleanString(fund?.name)
  const keywords = []
  const rules = [
    [/绾虫柉杈惧厠|NASDAQ|Nasdaq/i, ['绾虫柉杈惧厠', '缇庤偂', '绉戞妧鑲?, '鑻变紵杈?, '鑻规灉', '寰蒋', '鐗规柉鎷?, 'AI']],
    [/鏍囨櫘|S&P|SP500|500/i, ['鏍囨櫘', '鏍囨櫘500', '缇庤偂', '缇庡浗鑲″競']],
    [/QDII/i, ['QDII', '娴峰甯傚満', '缇庤偂', '缇庡厓']],
    [/鍏変紡/i, ['鍏変紡', '鏂拌兘婧?, '纭呮枡', '缁勪欢', '閫嗗彉鍣?]],
    [/绋€鍦焲灏忛噾灞瀨宸ヤ笟閲戝睘/i, ['绋€鍦?, '灏忛噾灞?, '宸ヤ笟閲戝睘', '鏈夎壊閲戝睘']],
    [/閫氫俊|閫氫俊璁惧/i, ['閫氫俊', '閫氫俊璁惧', '5G', '绠楀姏', '鍏夋ā鍧?]],
    [/鍗婂浣搢鑺墖/i, ['鍗婂浣?, '鑺墖', '闆嗘垚鐢佃矾', 'AI鑺墖']],
    [/娑堣垂鐢靛瓙|鍏冧欢/i, ['娑堣垂鐢靛瓙', '鐢靛瓙鍏冧欢', '鍗庝负']],
    [/涓瘉鍏ㄦ寚/i, ['涓瘉鍏ㄦ寚']],
  ]
  for (const [pattern, values] of rules) {
    if (pattern.test(name)) keywords.push(...values)
  }
  const shortName = name
    .replace(/[A-Z]$/i, '')
    .replace(/\(.*?\)|锛?*?锛?g, '')
    .replace(/(浜烘皯甯亅鍙戣捣寮弢鑱旀帴|鎸囨暟|鑲＄エ|娣峰悎|鍩洪噾|ETF|FOF|C|A|100|500)/g, '')
  if (shortName.length >= 2 && shortName.length <= 8) keywords.push(shortName)
  return [...new Set(keywords)]
}

function buildFundAgents({ fund, markets, benchmark, analysis, metricsHistory, exposure, sectorLeaders, fastNews, announcements, sentiment, adviceAccuracy }) {
  return runFundAgents({ fund, markets, benchmark, metricsHistory, exposure, sectorLeaders, fastNews, announcements, sentiment, adviceAccuracy })
}

async function gatherMarketSentiment(markets, sectorLeaders, fastNews, breadth) {
  const marketMap = Object.fromEntries(markets.map((market) => [market.code, market]))
  const upSectors = (sectorLeaders.items ?? []).filter((s) => s.changePercent > 0).length
  const downSectors = (sectorLeaders.items ?? []).filter((s) => s.changePercent < 0).length
  const topInflow = [...(sectorLeaders.items ?? [])].sort((a, b) => b.netInflow - a.netInflow).slice(0, 3)
  const newsTitles = (fastNews.items ?? []).slice(0, 8).map((item) => item.title)

  return {
    indices: markets.map((m) => ({ name: m.name, change: m.change, value: m.value })),
    breadth: breadth ?? { advancing: 0, declining: 0, advanceRatio: 0, breadth: 0, message: '鏈幏鍙? },
    sectorMomentum: {
      upCount: upSectors,
      downCount: downSectors,
      leaders: (sectorLeaders.items ?? []).slice(0, 5).map((s) => `${s.name}${formatPct(s.changePercent)}`),
      topInflow: topInflow.map((s) => `${s.name}鍑€娴佸叆${(s.netInflow / 1e8).toFixed(2)}浜縛),
    },
    news: newsTitles,
    overall: describeSentiment(marketMap, breadth, upSectors, downSectors),
  }
}

function describeSentiment(marketMap, breadth, upSectors, downSectors) {
  const parts = []
  const csi300 = marketMap.CSI300?.change ?? 0
  const ndx = marketMap.NDX?.change ?? 0
  const hstech = marketMap.HSTECH?.change ?? 0
  if (csi300 > 0.5 && (breadth?.advanceRatio ?? 0) > 60) parts.push('A鑲″仛澶氭儏缁槑鏄?)
  else if (csi300 < -0.5 && (breadth?.advanceRatio ?? 0) < 40) parts.push('A鑲℃壙鍘嬶紝璺屽娑ㄥ皯')
  else parts.push('A鑲￠渿鑽?)
  if (hstech > 1) parts.push('娓偂绉戞妧璧板己')
  else if (hstech < -1) parts.push('娓偂绉戞妧璧板急')
  if (ndx > 1) parts.push('缇庤偂鍋忓己')
  else if (ndx < -1) parts.push('缇庤偂鍋忓急')
  if (upSectors > downSectors + 2) parts.push('鏉垮潡鏅定')
  else if (downSectors > upSectors + 2) parts.push('鏉垮潡鏅穼')
  return parts.join('锛?)
}

function buildFundAgentContext({ fund, markets, benchmark, metricsHistory, exposure, sectorLeaders, fastNews, announcements, sentiment, adviceAccuracy }) {
  const marketMap = Object.fromEntries(markets.map((market) => [market.code, market]))
  const relative = Number((fund.estimateChange - (benchmark.change ?? 0)).toFixed(2))
  const profitRate = fund.cost > 0 ? (fund.nav - fund.cost) / fund.cost * 100 : 0
  const last30 = computeNavMetrics(metricsHistory.slice(-30))
  const last90 = computeNavMetrics(metricsHistory.slice(-90))
  const matchedNews = matchNewsForFund(fund, exposure, fastNews.items)
  const topSectors = (exposure.sectors ?? []).slice(0, 4)
  const topStocks = (exposure.stocks ?? []).slice(0, 6)
  const latestAnnouncement = announcements.items[0]
  const positionValue = Math.round(fund.nav * fund.shares)
  const valuationPercentile = computeValuationPercentile(metricsHistory, fund.nav)

  return {
    fund: {
      code: fund.code, name: fund.name, type: fund.type, tags: fund.tags,
      nav: fund.nav, cost: fund.cost, shares: fund.shares,
      estimateChange: fund.estimateChange, positionRatio: fund.positionRatio,
      profitRate, positionValue, relative,
      manager: fund.manager || '', company: fund.company || '', riskLevel: fund.riskLevel || '',
    },
    benchmark: { name: benchmark.name, change: benchmark.change },
    metrics: { last30, last90 },
    exposure: { sectors: topSectors, stocks: topStocks },
    sentiment: sentiment ?? { overall: '鏈幏鍙?, indices: [], breadth: {}, sectorMomentum: {}, news: [] },
    matchedNews: matchedNews.slice(0, 5).map((n) => n.title),
    latestAnnouncement: latestAnnouncement ? `${latestAnnouncement.title}锛?{latestAnnouncement.date}` : null,
    sectorLeaders: (sectorLeaders.items ?? []).slice(0, 5).map((s) => `${s.name}${formatPct(s.changePercent)}鍑€娴佸叆${(s.netInflow / 1e8).toFixed(1)}浜縛),
    valuationPercentile,
    adviceAccuracy: adviceAccuracy ?? { totalAdvice: 0, winCount: 0, winRate: 0, avgReturnPct: 0, recentItems: [] },
  }
}

function computeValuationPercentile(history, currentNav) {
  if (!history.length || !currentNav) return { p30: 50, p90: 50, p365: 50 }
  const pct = (arr) => {
    if (!arr.length) return 50
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = sorted.findIndex((v) => v >= currentNav)
    return idx < 0 ? 100 : Math.round(idx / sorted.length * 100)
  }
  const navs30 = history.slice(-30).map((h) => h.nav).filter(Boolean)
  const navs90 = history.slice(-90).map((h) => h.nav).filter(Boolean)
  const navs365 = history.map((h) => h.nav).filter(Boolean)
  return { p30: pct(navs30), p90: pct(navs90), p365: pct(navs365) }
}

async function readFundAdviceAccuracy(fundId) {
  try {
    const rows = await db.execute({
      sql: `SELECT ai.baseline_nav, ai.status, ai.created_at,
                   n.nav AS latest_nav
            FROM advice_items ai
            LEFT JOIN fund_nav_snapshots n ON n.fund_id = ai.fund_id
              AND n.id = (SELECT id FROM fund_nav_snapshots WHERE fund_id = ai.fund_id ORDER BY trade_date DESC LIMIT 1)
            WHERE ai.fund_id = ? AND ai.status = 'executed' AND ai.baseline_nav > 0`,
      args: [fundId],
    })
    const items = rows.rows.map((r) => ({
      baselineNav: Number(r.baseline_nav),
      latestNav: Number(r.latest_nav),
    })).filter((r) => r.baselineNav > 0 && r.latestNav > 0)
    const results = items.map((r) => Number(((r.latestNav - r.baselineNav) / r.baselineNav * 100).toFixed(2)))
    const wins = results.filter((r) => r > 0)
    return {
      totalAdvice: items.length,
      winCount: wins.length,
      winRate: results.length > 0 ? Number((wins.length / results.length * 100).toFixed(1)) : 0,
      avgReturnPct: results.length > 0 ? Number((results.reduce((s, r) => s + r, 0) / results.length).toFixed(2)) : 0,
      recentItems: results.slice(0, 5),
    }
  } catch {
    return { totalAdvice: 0, winCount: 0, winRate: 0, avgReturnPct: 0, recentItems: [] }
  }
}

async function runFundAgents(params) {
  const ctx = buildFundAgentContext(params)
  const llmConfig = await getActiveLlmConfig()

  const agentDefs = [
    { id: 'market', title: '甯傚満鐮旂┒鍛?, role: '璇勪及瀹忚鎸囨暟銆佸競鍦哄搴﹀拰鍩哄噯鐩稿琛ㄧ幇锛屽彧璇存槑瀵规湰鍩洪噾鐨勫奖鍝嶈矾寰? },
    { id: 'sector', title: '琛屼笟鐮旂┒鍛?, role: '璇勪及鍩洪噾閲嶄粨琛屼笟銆佹澘鍧楀姩閲忓拰璧勯噾娴侊紝涓嶅じ澶ф湭楠岃瘉鐨勪富棰樺彊浜? },
    { id: 'risk', title: '缁勫悎椋庢帶鐮旂┒鍛?, role: '璇勪及浠撲綅銆佸洖鎾ゃ€佹尝鍔ㄥ拰闆嗕腑搴︼紝鏄庣‘椋庨櫓绛夌骇涓庤瀵熼槇鍊? },
    { id: 'news', title: '浜嬩欢鐮旂┒鍛?, role: '鏍稿蹇鍜屽叕鍛婏紝鍙爣璁伴渶瑕佷汉宸ョ‘璁ょ殑浜嬩欢椋庨櫓' },
    { id: 'trade', title: '缁勫悎鍐崇瓥鐮旂┒鍛?, role: '缁煎悎鐮旂┒缁撹锛岃緭鍑烘寔鏈夈€佽瀵熴€佸噺浠撹瀵熸垨琛ヤ粨瑙傚療锛屼笉杈撳嚭纭畾鎬т氦鏄撴寚浠? },
  ]

  if (llmConfig?.apiKey) {
    const agents = await Promise.all(agentDefs.map((def) => runSingleAgent(def, ctx, llmConfig)))
    return agents
  }

  return agentDefs.map((def) => fallbackAgent(def, ctx))
}

async function runSingleAgent(agentDef, ctx, llmConfig) {
  const prompt = buildAgentPrompt(agentDef, ctx)
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    const text = await requestAgentCompletion(llmConfig, prompt, controller.signal)
    clearTimeout(timer)
    const parsed = parseAgentJson(text)
    if (parsed) return { id: agentDef.id, title: agentDef.title, level: parsed.level || 'neutral', conclusion: parsed.conclusion || text.slice(0, 200), evidence: parsed.evidence || [], thinking: parsed.thinking || '', recommendation: parsed.recommendation || null }
    return { id: agentDef.id, title: agentDef.title, level: 'neutral', conclusion: text.slice(0, 300) || '鍒嗘瀽瓒呮椂', evidence: [], thinking: '', recommendation: null }
  } catch {
    return fallbackAgent(agentDef, ctx)
  }
}

async function requestAgentCompletion(llmConfig, prompt, signal) {
  const systemPrompt = '浣犳槸鐮旂┒鍛樼骇鍒殑鍩洪噾鎶曠爺鍔╂墜銆傚彧鑳藉熀浜庤緭鍏ユ暟鎹仛鍙拷婧垎鏋愶紱绂佹缂栭€犳暟鎹€佺姝繚璇佹敹鐩娿€佺姝㈢粰纭畾鎬т拱鍗栨寚浠ゃ€俓n\n鍒嗘瀽娴佺▼瑕佹眰锛歕n1. 鍏堝湪thinking涓€愭鎺ㄧ悊锛氬垪鍑哄叧閿暟鎹偣銆佽瘑鍒紓甯搞€佽瘎浼板悇缁村害褰卞搷\n2. 鍩轰簬鎺ㄧ悊寰楀嚭缁撹鍜岃鍔ㄥ缓璁甛n\n杈撳嚭蹇呴』鏄弗鏍糐SON锛歕n{"thinking":"閫愭鎺ㄧ悊杩囩▼","level":"positive/negative/watch/neutral","conclusion":"涓€鍙ョ爺绌剁粨璁猴紝鍖呭惈鍔ㄤ綔鍊惧悜鍜岄檺鍒舵潯浠?,"evidence":["渚濇嵁1","渚濇嵁2","渚濇嵁3"],"recommendation":{"action":"鎸佹湁/瑙傚療/鍑忎粨瑙傚療/琛ヤ粨瑙傚療","targetPositionRatio":null,"stopLossNav":null,"conditions":["鏉′欢1","鏉′欢2"],"confidence":"浣?涓?楂?}}'
  const baseUrl = llmConfig.baseUrl || defaultLlmBaseUrl(llmConfig.provider)
  const model = llmConfig.selectedModel || defaultLlmModel(llmConfig.provider)

  if (llmConfig.provider === 'anthropic') {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': llmConfig.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.4,
      }),
      signal,
    })
    if (!response.ok) throw new Error(`LLM request failed: ${response.status}`)
    const data = await response.json()
    return String(data?.content?.map((part) => part.text ?? '').join('') ?? '').trim()
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmConfig.apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.4,
    }),
    signal,
  })
  if (!response.ok) throw new Error(`LLM request failed: ${response.status}`)
  const data = await response.json()
  return String(data?.choices?.[0]?.message?.content ?? '').trim()
}

function buildAgentPrompt(agentDef, ctx) {
  const f = ctx.fund
  const m = ctx.metrics
  const s = ctx.sentiment
  const structuredData = {
    fund: {
      code: f.code, name: f.name, type: f.type, tags: f.tags,
      nav: f.nav, cost: f.cost, estimateChange: f.estimateChange,
      positionRatio: f.positionRatio, profitRate: f.profitRate,
      relative: f.relative, positionValue: f.positionValue,
      manager: f.manager, company: f.company, riskLevel: f.riskLevel,
    },
    benchmark: ctx.benchmark,
    metrics: {
      last30: { returnPct: m.last30.returnPct, maxDrawdownPct: m.last30.maxDrawdownPct, volatilityPct: m.last30.volatilityPct },
      last90: { returnPct: m.last90.returnPct, maxDrawdownPct: m.last90.maxDrawdownPct, volatilityPct: m.last90.volatilityPct },
    },
    exposure: ctx.exposure,
    sentiment: { overall: s.overall, breadth: s.breadth, indices: s.indices?.map((i) => `${i.name}${formatPct(i.change)}`) },
    valuationPercentile: ctx.valuationPercentile,
    adviceAccuracy: ctx.adviceAccuracy,
    sectorLeaders: ctx.sectorLeaders,
    matchedNews: ctx.matchedNews,
    latestAnnouncement: ctx.latestAnnouncement,
  }
  return `浣犳槸涓€鍚嶄笓涓氱殑${agentDef.title}锛岃亴璐ｏ細${agentDef.role}

## 鍒嗘瀽鏁版嵁

璇峰熀浜庝互涓婮SON鏁版嵁杩涜鍒嗘瀽锛?

${JSON.stringify(structuredData)}

## 杈撳嚭瑕佹眰

鍍忔姇鐮斿蹇樺綍锛屼笉鍍忚亰澶╋紱缁撹蹇呴』鏈夋潯浠惰竟鐣岋紱璇佹嵁蹇呴』鏉ヨ嚜涓婇潰鐨勬暟鎹€?
涓ユ牸杈撳嚭JSON锛歿"thinking":"閫愭鎺ㄧ悊锛?.鍏抽敭鏁版嵁瑙傚療 2.寮傚父璇嗗埆 3.褰卞搷璇勪及","level":"positive/negative/watch/neutral","conclusion":"涓€鍙ョ爺绌剁粨璁猴紝鍖呭惈鍔ㄤ綔鍊惧悜鍜岄檺鍒舵潯浠?,"evidence":["渚濇嵁1","渚濇嵁2","渚濇嵁3"],"recommendation":{"action":"鎸佹湁/瑙傚療/鍑忎粨瑙傚療/琛ヤ粨瑙傚療","targetPositionRatio":null,"stopLossNav":null,"conditions":["鏉′欢1","鏉′欢2"],"confidence":"浣?涓?楂?}}`
}

function parseAgentJson(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    return {
      level: ['positive', 'negative', 'watch', 'neutral'].includes(parsed.level) ? parsed.level : 'neutral',
      conclusion: String(parsed.conclusion ?? ''),
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.slice(0, 5).map(String) : [],
      thinking: String(parsed.thinking ?? ''),
      recommendation: parsed.recommendation ? {
        action: String(parsed.recommendation.action ?? ''),
        targetPositionRatio: Number.isFinite(parsed.recommendation.targetPositionRatio) ? parsed.recommendation.targetPositionRatio : null,
        stopLossNav: Number.isFinite(parsed.recommendation.stopLossNav) ? parsed.recommendation.stopLossNav : null,
        conditions: Array.isArray(parsed.recommendation.conditions) ? parsed.recommendation.conditions.slice(0, 5).map(String) : [],
        confidence: ['浣?, '涓?, '楂?].includes(parsed.recommendation.confidence) ? parsed.recommendation.confidence : '浣?,
      } : null,
    }
  } catch {
    return null
  }
}

function fallbackAgent(agentDef, ctx) {
  const f = ctx.fund
  const m = ctx.metrics
  const s = ctx.sentiment
  const evidence = []
  let level = 'neutral'
  let conclusion = ''
  let thinking = ''
  let recommendation = null

  if (agentDef.id === 'market') {
    evidence.push(`${ctx.benchmark.name}${formatPct(ctx.benchmark.change)}`, `鐩稿寮哄急${formatPct(f.relative)}`)
    if (s.overall) evidence.push(s.overall)
    if (s.breadth?.total) evidence.push(`娑ㄨ穼姣?{s.breadth.advancing}:${s.breadth.declining}`)
    level = f.estimateChange >= 0 ? 'positive' : 'negative'
    conclusion = `浠婃棩浼板€?{formatPct(f.estimateChange)}锛岀浉瀵?{ctx.benchmark.name}${f.relative >= 0 ? '鏇村己' : '鏇村急'}${formatPct(Math.abs(f.relative))}銆傚競鍦烘儏缁細${s.overall || '鏁版嵁涓嶈冻'}銆俙
    thinking = `浼板€?{formatPct(f.estimateChange)}锛屽熀鍑?{ctx.benchmark.name}${formatPct(ctx.benchmark.change)}锛岀浉瀵瑰己寮?{formatPct(f.relative)}銆?{s.overall || '鎯呯华鏁版嵁涓嶈冻'}銆俙
    recommendation = {
      action: f.estimateChange >= 0 ? '鎸佹湁' : '瑙傚療',
      targetPositionRatio: null,
      stopLossNav: null,
      conditions: [`鑻?{ctx.benchmark.name}杩炵画3鏃ヨ穼瓒?.5%锛岄檷浣庢潈鐩婁粨浣峘, '鑻ュ競鍦哄搴︿笂娑ㄥ崰姣旇繛缁?鏃ヨ秴70%锛屽彲閫傚綋鏀惧浠撲綅'],
      confidence: '浣?,
    }
  } else if (agentDef.id === 'sector') {
    const top = ctx.exposure.sectors[0]
    if (top) {
      evidence.push(`${top.name}鏉冮噸${top.weight.toFixed(0)}%`, `鏉垮潡娑ㄨ穼${formatPct(top.avgChange)}`)
      level = top.avgChange >= 0 ? 'positive' : 'negative'
      conclusion = `涓昏鏆撮湶${top.name}锛屾潈閲?{top.weight.toFixed(0)}%锛屼粖鏃?{formatPct(top.avgChange)}銆?{ctx.sectorLeaders.length ? `璧勯噾娴佸悜锛?{ctx.sectorLeaders.slice(0, 2).join('銆?)}` : ''}`
      thinking = `閲嶄粨鏉垮潡${top.name}鏉冮噸${top.weight.toFixed(0)}%锛屾定璺?{formatPct(top.avgChange)}銆?{ctx.sectorLeaders.length ? `璧勯噾鏂瑰悜锛?{ctx.sectorLeaders.slice(0, 2).join('銆?)}` : ''}`
      recommendation = {
        action: top.avgChange >= 0 ? '鎸佹湁' : '瑙傚療',
        targetPositionRatio: null,
        stopLossNav: null,
        conditions: [`鑻?{top.name}鏉垮潡鍑€娴佸叆杩炵画3鏃ヤ负璐熶笖璺屽箙瓒?%锛岄檷浣庤涓婚鏆撮湶`, '鑻ラ噸浠撴澘鍧楁崲鎵嬬巼寮傚父鏀惧ぇ锛屽叧娉ㄥ洖璋冮闄?],
        confidence: '涓?,
      }
    } else {
      conclusion = '鏈幏鍙栧埌鏉垮潡鏆撮湶鏁版嵁銆?
      thinking = '鏉垮潡鏆撮湶鏁版嵁缂哄け锛屾棤娉曞垽鏂涓氶闄┿€?
      recommendation = { action: '瑙傚療', targetPositionRatio: null, stopLossNav: null, conditions: [], confidence: '浣? }
    }
  } else if (agentDef.id === 'risk') {
    evidence.push(`娴泩${formatPct(f.profitRate)}`, `杩?0鏃ュ洖鎾?{formatPct(m.last90.maxDrawdownPct)}`, `娉㈠姩${formatPct(m.last90.volatilityPct)}`, `浠撲綅${f.positionRatio}%`)
    level = (f.profitRate > 25 || m.last90.maxDrawdownPct < -18 || f.positionRatio > 25) ? 'watch' : 'neutral'
    conclusion = `娴泩${formatPct(f.profitRate)}锛屼粨浣?{f.positionRatio}%锛岃繎90鏃ュ洖鎾?{formatPct(m.last90.maxDrawdownPct)}锛屾尝鍔?{formatPct(m.last90.volatilityPct)}銆俙
    thinking = `娴泩${formatPct(f.profitRate)}锛屼粨浣?{f.positionRatio}%锛屽洖鎾?{formatPct(m.last90.maxDrawdownPct)}锛屾尝鍔?{formatPct(m.last90.volatilityPct)}銆?{level === 'watch' ? '瑙﹀彂椋庢帶瑙傚療淇″彿銆? : '椋庢帶鎸囨爣姝ｅ父銆?}`
    recommendation = {
      action: level === 'watch' ? '鍑忎粨瑙傚療' : '鎸佹湁',
      targetPositionRatio: f.positionRatio > 25 ? 20 : null,
      stopLossNav: f.cost > 0 ? Number((f.cost * 0.9).toFixed(4)) : null,
      conditions: [`鑻ヤ粨浣嶈秴杩?{f.positionRatio > 25 ? 25 : 30}%锛屽缓璁垎鎵瑰噺鑷?{Math.max(10, f.positionRatio - 10)}%`, '鑻ヨ繎30鏃ュ洖鎾よ秴杩?5%锛屾殏鍋滆ˉ浠撹鍒?],
      confidence: m.last90.maxDrawdownPct < -15 ? '涓? : '浣?,
    }
  } else if (agentDef.id === 'news') {
    evidence.push(...ctx.matchedNews.slice(0, 3))
    if (ctx.latestAnnouncement) evidence.push(ctx.latestAnnouncement)
    level = ctx.matchedNews.length ? 'watch' : 'neutral'
    conclusion = ctx.matchedNews.length ? `鍛戒腑${ctx.matchedNews.length}鏉＄浉鍏冲揩璁紝闇€瑕佷汉宸ョ‘璁ゆ槸鍚﹀奖鍝嶆寔浠撱€俙 : '蹇鍜屽叕鍛婃湭鍛戒腑鏄庢樉璐熼潰鍥犵礌銆?
    thinking = ctx.matchedNews.length ? `鍛戒腑${ctx.matchedNews.length}鏉＄浉鍏冲揩璁紝闇€鍏虫敞浜嬩欢椋庨櫓銆俙 : '蹇鍜屽叕鍛婃棤鏄庢樉璐熼潰淇″彿銆?
    recommendation = {
      action: ctx.matchedNews.length ? '瑙傚療' : '鎸佹湁',
      targetPositionRatio: null,
      stopLossNav: null,
      conditions: ctx.matchedNews.length ? ['鍏虫敞蹇鍚庣画鍙戝睍锛岃嫢纭閲嶅ぇ鍒╃┖鍒欒€冭檻鍑忎粨'] : [],
      confidence: '浣?,
    }
  } else {
    evidence.push(`浼板€?{formatPct(f.estimateChange)}`, `娴泩${formatPct(f.profitRate)}`, `鐩稿寮哄急${formatPct(f.relative)}`)
    if (f.estimateChange <= -3 && f.profitRate < -8) {
      level = 'negative'
      conclusion = '涓嬭穼涓旀诞浜忔墿澶э紝鏆備笉鎯呯华鍖栬ˉ浠擄紝绛変及鍊煎洖绋冲悗鍐嶆寜璁″垝澶勭悊銆?
      thinking = `浼板€艰穼${formatPct(f.estimateChange)}涓旀诞浜?{formatPct(f.profitRate)}锛岃Е鍙戜笅璺?娴簭淇″彿銆俙
      recommendation = {
        action: '琛ヤ粨瑙傚療',
        targetPositionRatio: Math.min(f.positionRatio + 5, 30),
        stopLossNav: f.cost > 0 ? Number((f.cost * 0.85).toFixed(4)) : null,
        conditions: ['浠呭湪鍑€鍊间紒绋?鏃ュ悗鍐嶈ˉ浠?, `琛ヤ粨鍚庝粨浣嶄笉瓒呰繃${Math.min(f.positionRatio + 5, 30)}%`, '鍗曟琛ヤ粨涓嶈秴杩囧綋鍓嶅競鍊肩殑20%'],
        confidence: '涓?,
      }
    } else if (f.profitRate > 20 && f.estimateChange > 1) {
      level = 'watch'
      conclusion = '鐩堝埄杈冨涓斿綋鏃ヤ笂娑紝浼樺厛璁剧疆姝㈢泩绾匡紝涓嶅缓璁户缁拷楂樸€?
      thinking = `娴泩${formatPct(f.profitRate)}涓斿綋鏃ユ定${formatPct(f.estimateChange)}锛岃Е鍙戞鐩堣瀵熶俊鍙枫€俙
      recommendation = {
        action: '鍑忎粨瑙傚療',
        targetPositionRatio: Math.max(f.positionRatio - 5, 5),
        stopLossNav: null,
        conditions: [`姝㈢泩绾胯鍦ㄥ噣鍊?{Number(f.nav * 0.95).toFixed(4)}`, '鍙垎3鎵瑰噺浠擄紝姣忔壒鍑忔寔1/3', '鑻ヨ繛缁笅璺?鏃ワ紝绔嬪嵆鎵ц姝㈢泩'],
        confidence: '涓?,
      }
    } else if (f.relative > 1.5) {
      level = 'positive'
      conclusion = '鐩稿鍙傝€冩寚鏁版槑鏄炬洿寮猴紝鍙互缁х画鎸佹湁瑙傚療锛屾柊澧炰拱鍏ヨ鐪嬩粨浣嶄笂闄愩€?
      thinking = `鐩稿寮哄急${formatPct(f.relative)}锛岃窇璧㈠熀鍑嗘槑鏄俱€俙
      recommendation = {
        action: '鎸佹湁',
        targetPositionRatio: null,
        stopLossNav: f.cost > 0 ? Number((f.cost * 0.92).toFixed(4)) : null,
        conditions: ['鏂板涔板叆闇€纭浠撲綅鏈秴闄?, '鑻ョ浉瀵瑰己寮辫浆璐熷垯杩涘叆瑙傚療'],
        confidence: '浣?,
      }
    } else {
      conclusion = '娌℃湁瑙﹀彂鏋佺淇″彿锛屾寜鍘熻鍒掓寔鏈夛紝绛夊噣鍊肩‘璁ゅ悗澶嶇洏銆?
      thinking = `浼板€?{formatPct(f.estimateChange)}锛屾诞鐩?{formatPct(f.profitRate)}锛岀浉瀵瑰己寮?{formatPct(f.relative)}锛屾湭瑙﹀彂鏋佺淇″彿銆俙
      recommendation = {
        action: '鎸佹湁',
        targetPositionRatio: null,
        stopLossNav: f.cost > 0 ? Number((f.cost * 0.9).toFixed(4)) : null,
        conditions: ['鑻ュ崟鏃ヨ穼骞呰秴3%涓斾粨浣嶆湭瓒呴檺锛岃繘鍏ヨˉ浠撹瀵?, '鑻ユ诞鐩堣秴25%涓旇繛缁笂娑?鏃ワ紝杩涘叆姝㈢泩瑙傚療'],
        confidence: '浣?,
      }
    }
  }

  return { id: agentDef.id, title: agentDef.title, level, conclusion, evidence: evidence.filter(Boolean).slice(0, 5), thinking, recommendation }
}
async function getFundExposure(code) {
  if (!/^\d{6}$/.test(code)) throw new Error('invalid fund code')
  const fundData = await fetchEastmoneyFundNav(code)
  const stockQuotes = await fetchEastmoneyStockQuotes(fundData.stockCodes)
  const conceptCounts = new Map()
  for (const stock of stockQuotes) {
    for (const concept of stock.concepts) {
      conceptCounts.set(concept, (conceptCounts.get(concept) ?? 0) + 1)
    }
  }
  return {
    source: 'eastmoney-fund',
    ok: true,
    message: stockQuotes.length ? 'fund exposure refreshed' : 'no stock exposure found',
    assetAllocation: normalizeAssetAllocation(fundData.assetAllocation),
    sectors: summarizeSectors(stockQuotes),
    stocks: stockQuotes.slice(0, 10),
    concepts: [...conceptCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
  }
}

function normalizeAssetAllocation(assetAllocation) {
  const series = Array.isArray(assetAllocation?.series) ? assetAllocation.series : []
  const latest = {}
  for (const item of series) {
    const data = Array.isArray(item?.data) ? item.data : []
    const value = Number(data.at(-1))
    if (Number.isFinite(value)) latest[String(item.name)] = value
  }
  return Object.keys(latest).length ? latest : null
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value ?? 'null'))
  } catch {
    return fallback ?? null
  }
}

async function ensureExposureTable() {
  await db.execute(`CREATE TABLE IF NOT EXISTS fund_exposures (
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
  )`)
}

async function persistFundExposures() {
  await ensureExposureTable()
  const funds = await readFunds()
  let ok = 0
  let failed = 0
  await Promise.all(funds.map(async (fund) => {
    if (!/^\d{6}$/.test(fund.code)) return
    try {
      const exposure = await getFundExposure(fund.code)
      await db.execute({
        sql: `INSERT INTO fund_exposures (id, fund_id, trade_date, sectors, stocks, concepts, asset_allocation, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(fund_id, trade_date, source)
              DO UPDATE SET sectors = excluded.sectors,
                            stocks = excluded.stocks,
                            concepts = excluded.concepts,
                            asset_allocation = excluded.asset_allocation`,
        args: [
          randomUUID(),
          fund.id,
          tradeDate,
          JSON.stringify(exposure.sectors ?? []),
          JSON.stringify(exposure.stocks ?? []),
          JSON.stringify(exposure.concepts ?? []),
          exposure.assetAllocation ? JSON.stringify(exposure.assetAllocation) : null,
          'eastmoney-fund',
        ],
      })
      ok += 1
    } catch {
      failed += 1
    }
  }))
  return { source: 'eastmoney-fund', ok: ok > 0, count: ok, failed, message: `exposure persisted ${ok}, failed ${failed}` }
}

async function readPortfolioExposure() {
  await ensureExposureTable()
  const funds = await readFunds()
  const totalValue = funds.reduce((sum, fund) => sum + fund.nav * fund.shares, 0)
  if (totalValue <= 0) return { sectors: [], concentration: [] }

  const rows = await db.execute({
    sql: `SELECT fe.fund_id, fe.sectors, fe.stocks, fe.concepts
          FROM fund_exposures fe
          WHERE fe.id IN (
            SELECT id FROM fund_exposures sub
            WHERE sub.fund_id = fe.fund_id
            ORDER BY created_at DESC LIMIT 1
          )`,
  })

  const sectorMap = new Map()
  const stockMap = new Map()
  for (const row of rows.rows) {
    const fund = funds.find((f) => f.id === String(row.fund_id))
    if (!fund) continue
    const fundWeight = (fund.nav * fund.shares) / totalValue * 100
    const sectors = parseJson(row.sectors, [])
    if (Array.isArray(sectors)) {
      for (const sector of sectors) {
        const name = String(sector?.name ?? '鏈垎绫?)
        const current = sectorMap.get(name) ?? { name, fundCount: 0, totalWeight: 0, weightedChange: 0 }
        current.fundCount += 1
        current.totalWeight += fundWeight
        current.weightedChange += Number(sector?.avgChange ?? 0) * fundWeight
        sectorMap.set(name, current)
      }
    }
    const stocks = parseJson(row.stocks, [])
    if (Array.isArray(stocks)) {
      for (const stock of stocks) {
        const code = String(stock?.code ?? '')
        if (!code) continue
        const current = stockMap.get(code) ?? { code, name: String(stock?.name ?? code), fundCount: 0, weightedChange: 0, totalWeight: 0 }
        current.fundCount += 1
        current.totalWeight += fundWeight
        current.weightedChange += Number(stock?.changePercent ?? 0) * fundWeight
        stockMap.set(code, current)
      }
    }
  }

  const sectors = [...sectorMap.values()]
    .map((s) => ({
      name: s.name,
      fundCount: s.fundCount,
      weight: Number(s.totalWeight.toFixed(2)),
      avgChange: s.totalWeight > 0 ? Number((s.weightedChange / s.totalWeight).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.weight - a.weight)

  const concentration = sectors
    .filter((s) => s.weight > 25)
    .map((s) => `${s.name} 缂佸嫬鎮庨梿鍡曡厬鎼?${s.weight.toFixed(0)}%閿?{s.fundCount} 閸欘亜鐔€闁叉埊绱歚)

  return { sectors: sectors.slice(0, 8), concentration }
}

async function generateLlmSummary(prompt) {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) return null
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1'
  const model = process.env.LLM_MODEL || 'gpt-4o-mini'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.3,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!response.ok) return null
    const data = await response.json()
    return String(data?.choices?.[0]?.message?.content ?? '').trim() || null
  } catch {
    return null
  }
}

async function readFundNavHistory(fundId, limit = 180) {
  const result = await db.execute({
    sql: `SELECT trade_date, nav, estimated_nav, change_percent, source, created_at
          FROM fund_nav_snapshots
          WHERE fund_id = ?
          ORDER BY trade_date DESC,
                   CASE WHEN source = 'eastmoney-fund' THEN 0 WHEN source = 'manual' THEN 1 ELSE 2 END,
                   created_at DESC
          LIMIT ?`,
    args: [fundId, limit * 3],
  })

  const hasRealHistory = result.rows.some((row) => String(row.source) === 'eastmoney-fund')
  const byDate = new Map()
  for (const row of result.rows) {
    if (hasRealHistory && String(row.source) !== 'eastmoney-fund') continue
    const tradeDateKey = String(row.trade_date)
    if (byDate.has(tradeDateKey)) continue
    byDate.set(tradeDateKey, {
      tradeDate: tradeDateKey,
      nav: Number(row.estimated_nav ?? row.nav),
      changePercent: Number(row.change_percent ?? 0),
      source: String(row.source),
      createdAt: String(row.created_at),
    })
  }

  return [...byDate.values()]
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
    .slice(-limit)
}

function computeNavMetrics(history) {
  if (history.length < 2) {
    return {
      returnPct: 0,
      maxDrawdownPct: 0,
      volatilityPct: 0,
      startDate: history[0]?.tradeDate ?? null,
      endDate: history.at(-1)?.tradeDate ?? null,
      points: history.length,
    }
  }

  const first = history[0].nav
  const last = history.at(-1).nav
  let peak = first
  let maxDrawdown = 0
  for (const item of history) {
    peak = Math.max(peak, item.nav)
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, (item.nav - peak) / peak * 100)
  }

  const changes = history.slice(1).map((item, index) => {
    const prev = history[index].nav
    return prev > 0 ? (item.nav - prev) / prev * 100 : 0
  })
  const avg = changes.reduce((sum, value) => sum + value, 0) / changes.length
  const variance = changes.reduce((sum, value) => sum + (value - avg) ** 2, 0) / changes.length

  return {
    returnPct: Number(((last / first - 1) * 100).toFixed(2)),
    maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
    volatilityPct: Number(Math.sqrt(variance).toFixed(2)),
    startDate: history[0].tradeDate,
    endDate: history.at(-1).tradeDate,
    points: history.length,
  }
}

async function getDashboardData(options = {}) {
  const funds = await readFunds()
  const markets = await readMarkets()
  const review = await readReview()
  const portfolioExposure = options.skipAnalysis ? null : await readPortfolioExposure().catch(() => null)
  const analysis = options.skipAnalysis ? null : buildPortfolioAnalysis(funds, markets, portfolioExposure)
  const dataSourceStatus = await getDataSourceStatus()
  const persisted = options.skipAnalysis ? null : await readLatestReportWithAdvice()
  const fastNews = !options.skipAnalysis ? await fetchEastmoneyFastNews().catch(() => ({ items: [] })) : { items: [] }
  return {
    tradeDate,
    funds,
    markets,
    review,
    analysis,
    portfolioExposure,
    dataSourceStatus,
    report: persisted?.report ?? null,
    adviceItems: persisted?.adviceItems ?? [],
    fastNews: fastNews.items.slice(0, 20),
  }
}

async function readFunds() {
  const result = await db.execute({
    sql: `SELECT f.id AS fund_id, f.code, f.name, f.fund_type, f.tags, f.manager, f.company, f.risk_level, h.avg_cost, h.shares, h.target_position_ratio,
                 COALESCE(n.estimated_nav, n.nav, h.avg_cost) AS nav,
                 COALESCE(n.change_percent, 0) AS estimate_change,
                 n.source AS nav_source,
                 n.trade_date AS estimate_date,
                 n.created_at AS estimate_updated_at,
                 n.raw_payload AS estimate_payload
          FROM holdings h
          JOIN funds f ON f.id = h.fund_id
          LEFT JOIN fund_nav_snapshots n ON n.id = (
            SELECT id
            FROM fund_nav_snapshots
            WHERE fund_id = f.id AND source = 'eastmoney-fund'
            ORDER BY trade_date DESC,
                     created_at DESC
            LIMIT 1
          )
          WHERE h.user_id = ?
          ORDER BY h.created_at ASC`,
    args: [userId],
  })
  return result.rows.map((row) => ({
    id: String(row.fund_id),
    code: String(row.code),
    name: String(row.name),
    type: String(row.fund_type),
    cost: Number(row.avg_cost),
    nav: Number(row.nav),
    shares: Number(row.shares),
    estimateChange: Number(row.estimate_change),
    positionRatio: Number(row.target_position_ratio),
    tags: parseJsonArray(row.tags),
    manager: String(row.manager ?? ''),
    company: String(row.company ?? ''),
    riskLevel: String(row.risk_level ?? ''),
    estimateSource: String(row.nav_source ?? ''),
    estimateDate: String(row.estimate_date ?? ''),
    estimateUpdatedAt: String(row.estimate_updated_at ?? ''),
    estimateTime: readEstimateTime(row.estimate_payload),
  }))
}

function readEstimateTime(rawPayload) {
  try {
    const parsed = JSON.parse(String(rawPayload ?? '{}'))
    return String(parsed.gztime ?? parsed.estimateTime ?? '')
  } catch {
    return ''
  }
}

async function readMarkets() {
  const result = await db.execute({
    sql: `SELECT m.index_code, m.index_name, m.value, m.change_percent, m.source
          FROM market_snapshots m
          WHERE m.source = 'eastmoney'
          AND m.id = (
            SELECT id
            FROM market_snapshots
            WHERE index_code = m.index_code AND source = 'eastmoney'
            ORDER BY trade_date DESC,
                     created_at DESC
            LIMIT 1
          )
          ORDER BY CASE m.index_code
            WHEN 'CSI300' THEN 1
            WHEN 'CHINEXT' THEN 2
            WHEN 'SSE' THEN 3
            WHEN 'SZSE' THEN 4
            WHEN 'HSI' THEN 5
            WHEN 'HSTECH' THEN 6
            WHEN 'NDX' THEN 7
            WHEN 'SPX' THEN 8
            WHEN 'USDCNH' THEN 9
            WHEN 'CNYUSD' THEN 10
            WHEN 'CN10Y' THEN 11
            ELSE 99
          END`,
  })
  return result.rows.map((row) => ({
    code: String(row.index_code),
    name: String(row.index_name),
    value: Number(row.value),
    change: Number(row.change_percent),
    source: String(row.source),
  }))
}

async function readReview() {
  const result = await db.execute({
    sql: `SELECT content, checklist FROM review_notes WHERE user_id = ? AND trade_date = ? LIMIT 1`,
    args: [userId, tradeDate],
  })
  return {
    content: String(result.rows[0]?.content ?? ''),
    checklist: parseJsonArray(result.rows[0]?.checklist),
  }
}

async function readLatestReportWithAdvice() {
  const reportResult = await db.execute({
    sql: `SELECT id, trade_date, risk_profile, summary, market_view, portfolio_view, created_at
          FROM analysis_reports
          WHERE user_id = ?
          ORDER BY trade_date DESC, created_at DESC
          LIMIT 1`,
    args: [userId],
  })
  const reportRow = reportResult.rows[0]
  if (!reportRow) return null
  const adviceResult = await db.execute({
    sql: `SELECT a.id, a.fund_id, a.title, a.level, a.reason, a.action, a.status, a.created_at,
                 a.thinking, a.target_position, a.stop_loss_nav, a.action_conditions, a.confidence,
                 f.code AS fund_code, f.name AS fund_name
          FROM advice_items a
          LEFT JOIN funds f ON f.id = a.fund_id
          WHERE a.report_id = ?
          ORDER BY a.created_at ASC`,
    args: [String(reportRow.id)],
  })
  return {
    report: {
      id: String(reportRow.id),
      tradeDate: String(reportRow.trade_date),
      riskProfile: String(reportRow.risk_profile ?? ''),
      summary: String(reportRow.summary ?? ''),
      marketView: String(reportRow.market_view ?? ''),
      portfolioView: String(reportRow.portfolio_view ?? ''),
      createdAt: String(reportRow.created_at ?? ''),
    },
    adviceItems: adviceResult.rows.map((row) => ({
      id: String(row.id),
      fundId: String(row.fund_id ?? ''),
      fundCode: String(row.fund_code ?? ''),
      fundName: String(row.fund_name ?? ''),
      title: String(row.title),
      level: String(row.level),
      reason: String(row.reason),
      action: String(row.action),
      status: String(row.status ?? 'open'),
      thinking: String(row.thinking ?? ''),
      targetPosition: Number(row.target_position) || null,
      stopLossNav: Number(row.stop_loss_nav) || null,
      actionConditions: parseJson(row.action_conditions, []),
      confidence: String(row.confidence ?? '浣?),
    })),
  }
}

async function persistAnalysisReport() {
  const funds = await readFunds()
  const markets = await readMarkets()
  const portfolioExposure = await readPortfolioExposure().catch(() => null)
  const [sectorLeaders, fastNews, breadth] = await Promise.all([
    fetchEastmoneySectorLeaders().catch(() => ({ items: [] })),
    fetchEastmoneyFastNews().catch(() => ({ items: [] })),
    fetchMarketBreadth().catch(() => ({ ok: false, advancing: 0, declining: 0, advanceRatio: 0, breadth: 0 })),
  ])
  const sentiment = await gatherMarketSentiment(markets, sectorLeaders, fastNews, breadth)
  const analysis = buildPortfolioAnalysis(funds, markets, portfolioExposure)
  const riskProfile = analysis.riskItems.length ? '閸嬪繘鐝搴ㄦ珦' : '濮濓絽鐖?
  const marketView = sentiment.overall || ''

  const llmSummary = await generateLlmSummary(buildLlmPrompt(analysis, markets, sentiment))
  const summary = llmSummary ? `${analysis.summary}\n\nAI 鐟欙綀顕伴敍?{llmSummary}` : analysis.summary

  await db.execute({
    sql: `INSERT INTO analysis_reports (id, user_id, trade_date, risk_profile, summary, market_view, portfolio_view)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, trade_date)
          DO UPDATE SET risk_profile = excluded.risk_profile,
                        summary = excluded.summary,
                        market_view = excluded.market_view,
                        portfolio_view = excluded.portfolio_view,
                        updated_at = datetime('now')`,
    args: [randomUUID(), userId, tradeDate, riskProfile, summary, marketView, analysis.agents.map((a) => `${a.role}閿?{a.view}`).join('\n')],
  })

  const reportRow = await db.execute({
    sql: `SELECT id FROM analysis_reports WHERE user_id = ? AND trade_date = ? LIMIT 1`,
    args: [userId, tradeDate],
  })
  const reportId = String(reportRow.rows[0].id)

  await db.execute({
    sql: `DELETE FROM advice_items WHERE report_id = ?`,
    args: [reportId],
  })

  const historyCache = new Map()
  const adviceStatements = []
  for (const fund of funds) {
    const benchmark = chooseBenchmark(fund, Object.fromEntries(markets.map((m) => [m.code, m.change])))
    let history = historyCache.get(fund.id)
    if (!history) {
      history = await readFundNavHistory(fund.id, 180)
      historyCache.set(fund.id, history)
    }
    const agents = await runFundAgents({
      fund, markets, benchmark, metricsHistory: history,
      exposure: { sectors: [], stocks: [] }, sectorLeaders, fastNews,
      announcements: { items: [] }, sentiment,
    })
    const tradeAgent = agents.find((a) => a.id === 'trade') ?? agents[agents.length - 1]
    adviceStatements.push({
      sql: `INSERT INTO advice_items (id, report_id, fund_id, title, level, reason, action, status, thinking, target_position, stop_loss_nav, action_conditions, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(), reportId, fund.id || null,
        tradeAgent.title, tradeAgent.level,
        agents.filter((a) => a.id !== 'trade').map((a) => `${a.title}锛?{a.conclusion}`).join(' '),
        tradeAgent.conclusion, 'open',
        tradeAgent.thinking || agents.map((a) => a.thinking).filter(Boolean).join('\n'),
        tradeAgent.recommendation?.targetPositionRatio ?? null,
        tradeAgent.recommendation?.stopLossNav ?? null,
        JSON.stringify(tradeAgent.recommendation?.conditions ?? []),
        tradeAgent.recommendation?.confidence ?? '浣?,
      ],
    })
  }
  if (adviceStatements.length) await db.batch(adviceStatements, 'write')

  return { analysis, reportId, llmUsed: Boolean(llmSummary) }
}

function buildLlmPrompt(analysis, markets, sentiment) {
  const marketLine = markets.map((m) => `${m.name}${formatPct(m.change)}`).join('銆?)
  const riskLine = analysis.riskItems.length ? analysis.riskItems.join('锛?) : '鏃犳槑鏄鹃闄?
  const sectorLine = (analysis.portfolioExposure?.sectors ?? []).slice(0, 5).map((s) => `${s.name}鏉冮噸${s.weight.toFixed(0)}%`).join('銆?)
  const sentimentLine = sentiment?.overall || '鏈幏鍙?
  const breadthLine = sentiment?.breadth?.total ? `涓婃定${sentiment.breadth.advancing}瀹讹紝涓嬭穼${sentiment.breadth.declining}瀹禶 : ''
  const fundLine = analysis.fundAnalyses.slice(0, 8).map((f) => `${f.name}(${f.category}, 鐩稿${formatPct(f.relative)})`).join('銆?)
  return `浣犳槸鍩洪噾鎸佷粨鍒嗘瀽鍔╂墜锛岃鍩轰簬浠ヤ笅鏁版嵁鐢?-3鍙ヨ瘽缁欏嚭缁勫悎灞傞潰鐨勯闄╂彁绀哄拰鎿嶄綔绾緥寤鸿锛屼笉瑕佺粰鍏蜂綋涔板崠鎸囦护銆俓n甯傚満锛?{marketLine}\n甯傚満鎯呯华锛?{sentimentLine}${breadthLine ? `锛?{breadthLine}` : ''}\n椋庨櫓锛?{riskLine}\n缁勫悎鏆撮湶锛?{sectorLine || '鏆傛棤'}\n鍩洪噾琛ㄧ幇锛?{fundLine}`
}

async function getFundAnalysisHistory(fundId) {
  try {
    const rows = await db.execute({
      sql: `SELECT ai.id, ai.title, ai.level, ai.reason, ai.action, ai.status,
                   ai.thinking, ai.target_position, ai.stop_loss_nav,
                   ai.action_conditions, ai.confidence,
                   ai.baseline_nav, ai.executed_at, ai.created_at,
                   ar.trade_date, ar.market_view
            FROM advice_items ai
            JOIN analysis_reports ar ON ar.id = ai.report_id
            WHERE ai.fund_id = ?
            ORDER BY ar.trade_date DESC, ai.created_at DESC
            LIMIT 30`,
      args: [fundId],
    })
    let latestNav = 0
    try {
      const navRow = await db.execute({
        sql: `SELECT COALESCE(estimated_nav, nav, 0) AS nav FROM fund_nav_snapshots WHERE fund_id = ? ORDER BY trade_date DESC LIMIT 1`,
        args: [fundId],
      })
      latestNav = Number(navRow.rows[0]?.nav ?? 0)
    } catch { /* ignore */ }

    const items = rows.rows.map((row) => {
      const baseline = Number(row.baseline_nav) || 0
      let actualReturnPct = null
      if (baseline > 0 && latestNav > 0 && row.status === 'executed') {
        actualReturnPct = Number(((latestNav - baseline) / baseline * 100).toFixed(2))
      }
      return {
        id: String(row.id),
        tradeDate: String(row.trade_date ?? ''),
        level: String(row.level),
        action: String(row.action),
        conclusion: String(row.action),
        thinking: String(row.thinking ?? ''),
        recommendation: {
          targetPosition: Number(row.target_position) || null,
          stopLossNav: Number(row.stop_loss_nav) || null,
          conditions: parseJson(row.action_conditions, []),
          confidence: String(row.confidence ?? '浣?),
        },
        status: String(row.status ?? 'open'),
        baselineNav: baseline || null,
        actualReturnPct,
        executedAt: String(row.executed_at ?? '').slice(0, 10),
        createdAt: String(row.created_at ?? ''),
      }
    })

    const executed = items.filter((i) => i.status === 'executed' && i.actualReturnPct != null)
    const wins = executed.filter((i) => i.actualReturnPct > 0)
    return {
      fundId,
      totalReports: items.length,
      accuracy: {
        totalExecuted: executed.length,
        winCount: wins.length,
        winRate: executed.length > 0 ? Number((wins.length / executed.length * 100).toFixed(1)) : 0,
        avgReturnPct: executed.length > 0 ? Number((executed.reduce((s, i) => s + i.actualReturnPct, 0) / executed.length).toFixed(2)) : 0,
      },
      history: items,
    }
  } catch {
    return { fundId, totalReports: 0, accuracy: { totalExecuted: 0, winCount: 0, winRate: 0, avgReturnPct: 0 }, history: [] }
  }
}

async function getAdviceStats() {
  const total = await db.execute({
    sql: `SELECT COUNT(*) AS count FROM advice_items ai
          JOIN analysis_reports ar ON ar.id = ai.report_id
          WHERE ar.user_id = ?`,
    args: [userId],
  })
  const byStatus = await db.execute({
    sql: `SELECT ai.status, COUNT(*) AS count
          FROM advice_items ai
          JOIN analysis_reports ar ON ar.id = ai.report_id
          WHERE ar.user_id = ?
          GROUP BY ai.status`,
    args: [userId],
  })
  const byLevel = await db.execute({
    sql: `SELECT ai.level, COUNT(*) AS count
          FROM advice_items ai
          JOIN analysis_reports ar ON ar.id = ai.report_id
          WHERE ar.user_id = ?
          GROUP BY ai.level`,
    args: [userId],
  })
  const recentDays = await db.execute({
    sql: `SELECT ar.trade_date, COUNT(*) AS total,
                 SUM(CASE WHEN ai.status = 'executed' THEN 1 ELSE 0 END) AS executed,
                 SUM(CASE WHEN ai.status = 'skipped' THEN 1 ELSE 0 END) AS skipped
          FROM advice_items ai
          JOIN analysis_reports ar ON ar.id = ai.report_id
          WHERE ar.user_id = ?
          GROUP BY ar.trade_date
          ORDER BY ar.trade_date DESC
          LIMIT 14`,
    args: [userId],
  })
  const totalCount = Number(total.rows[0]?.count ?? 0)
  const statusMap = Object.fromEntries(byStatus.rows.map((row) => [String(row.status), Number(row.count)]))
  const executed = statusMap.executed ?? 0
  const skipped = statusMap.skipped ?? 0
  const open = statusMap.open ?? 0
  return {
    total: totalCount,
    executed,
    skipped,
    open,
    executionRate: totalCount > 0 ? Number((executed / totalCount * 100).toFixed(1)) : 0,
    byLevel: Object.fromEntries(byLevel.rows.map((row) => [String(row.level), Number(row.count)])),
    byDate: recentDays.rows.map((row) => ({
      tradeDate: String(row.trade_date),
      total: Number(row.total),
      executed: Number(row.executed),
      skipped: Number(row.skipped),
    })),
    attributionSummary: await getAttributionSummary(),
  }
}

async function getAttributionSummary() {
  const rows = await db.execute({
    sql: `SELECT ai.id, ai.fund_id, ai.title, ai.level, ai.baseline_nav, ai.executed_at,
                 f.code AS fund_code, f.name AS fund_name, ar.trade_date
          FROM advice_items ai
          JOIN analysis_reports ar ON ar.id = ai.report_id
          LEFT JOIN funds f ON f.id = ai.fund_id
          WHERE ar.user_id = ? AND ai.status = 'executed' AND ai.baseline_nav IS NOT NULL AND ai.baseline_nav > 0
          ORDER BY ai.executed_at DESC`,
    args: [userId],
  })
  if (!rows.rows.length) return { count: 0, winCount: 0, avgReturnPct: 0, items: [] }

  const items = []
  let winCount = 0
  let totalReturnPct = 0

  for (const row of rows.rows) {
    const baseline = Number(row.baseline_nav)
    const fundId = String(row.fund_id ?? '')
    const latestNavRow = await db.execute({
      sql: `SELECT estimated_nav, nav FROM fund_nav_snapshots WHERE fund_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [fundId],
    })
    const latestNav = Number(latestNavRow.rows[0]?.estimated_nav ?? latestNavRow.rows[0]?.nav ?? 0)
    const returnPct = latestNav > 0 ? Number(((latestNav - baseline) / baseline * 100).toFixed(2)) : 0
    if (returnPct > 0) winCount += 1
    totalReturnPct += returnPct
    const executedAt = String(row.executed_at ?? '')
    const daysHeld = executedAt ? Math.max(0, Math.floor((Date.now() - new Date(executedAt).getTime()) / 86400000)) : 0
    items.push({
      id: String(row.id),
      fundCode: String(row.fund_code ?? ''),
      fundName: String(row.fund_name ?? ''),
      title: String(row.title),
      level: String(row.level),
      baselineNav: baseline,
      latestNav,
      returnPct,
      executedAt: executedAt.slice(0, 10),
      daysHeld,
    })
  }

  return {
    count: items.length,
    winCount,
    winRate: items.length > 0 ? Number((winCount / items.length * 100).toFixed(1)) : 0,
    avgReturnPct: items.length > 0 ? Number((totalReturnPct / items.length).toFixed(2)) : 0,
    items: items.slice(0, 10),
  }
}

async function getAdviceAttribution() {
  return getAttributionSummary()
}

function buildPortfolioAnalysis(funds, markets, portfolioExposure) {
  const marketMap = Object.fromEntries(markets.map((market) => [market.code, market.change]))
  const fundAnalyses = funds.map((fund) => analyzeFund(fund, marketMap))
  const totalValue = funds.reduce((sum, fund) => sum + fund.nav * fund.shares, 0)
  const equityPosition = funds.filter((fund) => !['鍊哄埜', '璐у竵'].includes(fund.type)).reduce((sum, fund) => sum + fund.positionRatio, 0)
  const duplicateTags = getDuplicateTags(funds)
  const concentration = portfolioExposure?.concentration ?? []
  const riskItems = [
    equityPosition > 70 ? `鏉冪泭浠撲綅 ${equityPosition}% 鍋忛珮` : '',
    duplicateTags.length ? `涓婚閲嶅锛?{duplicateTags.join('銆?)}` : '',
    ...concentration,
  ].filter(Boolean)
  const sectorView = (portfolioExposure?.sectors ?? []).slice(0, 3).map((s) => `${s.name} ${s.weight.toFixed(0)}%`).join('銆?)
  return {
    summary: `褰撳墠鎸佷粨 ${funds.length} 鍙紝浼扮畻甯傚€?${Math.round(totalValue)} 鍏冿紝鏉冪泭浠撲綅 ${equityPosition}%銆俙,
    riskItems,
    portfolioExposure: portfolioExposure ?? { sectors: [], concentration: [] },
    fundAnalyses,
    agents: [
      { role: '琛屾儏鍒嗘瀽鍛?, view: `娌繁300 ${formatPct(marketMap.CSI300)}锛屽垱涓氭澘 ${formatPct(marketMap.CHINEXT)}锛屽競鍦虹幆澧冨亸${(marketMap.CSI300 ?? 0) >= 0 ? '绉瀬' : '璋ㄦ厧'}銆俙 },
      { role: '鍩洪噾鍒嗘瀽鍛?, view: `閲嶇偣鍏虫敞璺戣緭鍙傝€冨競鍦虹殑鍩洪噾锛?{fundAnalyses.filter((item) => item.category === '璺戣緭甯傚満').map((item) => item.name).join('銆?) || '鏆傛棤'}銆俙 },
      { role: '椋庢帶鍒嗘瀽鍛?, view: riskItems.length ? riskItems.join('锛?) : '褰撳墠鏈Е鍙戞槑鏄鹃泦涓害鎴栦粨浣嶉闄┿€? },
      { role: '鎸佷粨绌块€忓憳', view: sectorView ? `缁勫悎涓昏鏆撮湶锛?{sectorView}銆俙 : '鏆傛棤鎸佷粨绌块€忔暟鎹紝寤鸿鍒锋柊琛屾儏鍚庢煡鐪嬨€? },
      { role: '寤鸿鍒嗘瀽鍛?, view: '寤鸿浠ユ寔鏈夊拰瑙傚療涓轰富锛屽彧鍦ㄤ粨浣嶆湭瓒呴檺涓旇穼骞呰揪鍒拌鍒掑尯闂存椂鍐嶈ˉ浠撱€? },
      { role: '澶嶇洏鍒嗘瀽鍛?, view: '姣忓ぉ淇濆瓨寤鸿銆佸疄闄呮搷浣滃拰鍘熷洜锛屽悗缁敤浜庤瘑鍒拷娑ㄣ€佽繃鏃╄ˉ浠撶瓑琛屼负鍋忓樊銆? },
    ],
    scenarios: [
      { name: '涓婃定鎯呮櫙', impact: '鏉冪泭鍩洪噾鍙楃泭锛屼絾閲嶅涓婚闇€瑕佽€冭檻鍒嗘壒姝㈢泩銆? },
      { name: '闇囪崱鎯呮櫙', impact: '浼樺厛缁存寔浠撲綅绾緥锛岄伩鍏嶅洜鍗曟棩娉㈠姩棰戠箒鎿嶄綔銆? },
      { name: '鍥炴挙鎯呮櫙', impact: '鍙湁浣庝簬璁″垝闃堝€间笖浠撲綅鏈秴闄愮殑鍩洪噾杩涘叆琛ヤ粨瑙傚療銆? },
    ],
  }
}

function analyzeFund(fund, marketMap) {
  const benchmark = chooseBenchmark(fund, marketMap)
  const relative = Number((fund.estimateChange - benchmark.change).toFixed(2))
  const category = relative > 0.8 ? '璺戣耽甯傚満' : relative < -0.8 ? '璺戣緭甯傚満' : Math.abs(fund.estimateChange) > 2.5 ? '寮傚父娉㈠姩' : '璺熼殢甯傚満'
  return {
    fundId: fund.id,
    name: fund.name,
    benchmark: benchmark.name,
    benchmarkChange: benchmark.change,
    relative,
    category,
    reasons: buildReasons(fund, benchmark, relative),
    advice: null,
    confidence: Math.abs(relative) > 1.2 ? '涓? : '浣?,
  }
}

function chooseBenchmark(fund, marketMap) {
  const name = `${fund.name}${fund.tags.join('')}`
  if (fund.type === '鍊哄埜' || name.includes('鍊?)) return { code: 'CN10Y', name: '鍗佸勾鍥藉€?, change: marketMap.CN10Y ?? 0 }
  if (name.includes('绾虫柉杈惧厠') || name.includes('绾虫寚') || name.includes('NDX')) return { code: 'NDX', name: '绾虫柉杈惧厠100', change: marketMap.NDX ?? 0 }
  if (name.includes('鏍囨櫘') || name.includes('SPX') || name.includes('S&P')) return { code: 'SPX', name: '鏍囨櫘500', change: marketMap.SPX ?? 0 }
  if (name.includes('鎭掔敓') || name.includes('娓偂') || name.includes('鎭掔敓绉戞妧')) return { code: 'HSI', name: '鎭掔敓鎸囨暟', change: marketMap.HSI ?? 0 }
  if (fund.type === 'QDII' || fund.tags.includes('娓編')) return { code: 'NDX', name: '绾虫柉杈惧厠100', change: marketMap.NDX ?? 0 }
  if (name.includes('閫氫俊') || name.includes('鐢靛瓙') || name.includes('鍗婂浣?) || name.includes('鑺墖')) return { code: 'CHINEXT', name: '鍒涗笟鏉挎寚', change: marketMap.CHINEXT ?? 0 }
  return { code: 'CSI300', name: '娌繁300', change: marketMap.CSI300 ?? 0 }
}
function buildReasons(fund, benchmark, relative) {
  const reasons = [`浠婃棩浼板€?{formatPct(fund.estimateChange)}锛屽弬鑰?{benchmark.name}${formatPct(benchmark.change)}銆俙]
  if (relative > 0.8) reasons.push(`鐩稿鍙傝€冩寚鏁板己 ${formatPct(relative)}锛岀煭绾胯〃鐜拌緝寮恒€俙)
  if (relative < -0.8) reasons.push(`鐩稿鍙傝€冩寚鏁板急 ${formatPct(Math.abs(relative))}锛岄渶瑕佽瀵熸槸鍚︿负鍩洪噾鑷韩鍥犵礌銆俙)
  const profitRate = fund.cost > 0 ? (fund.nav - fund.cost) / fund.cost * 100 : 0
  reasons.push(`褰撳墠娴泩${formatPct(profitRate)}锛屾垚鏈?{fund.cost.toFixed(4)}锛屼及鍊?{fund.nav.toFixed(4)}銆俙)
  return reasons
}
function getDuplicateTags(funds) {
  const counts = new Map()
  funds.flatMap((fund) => fund.tags).forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1))
  return [...counts.entries()].filter(([, count]) => count > 1).map(([tag]) => tag)
}

function formatPct(value) {
  return `${value >= 0 ? '+' : ''}${Number(value ?? 0).toFixed(2)}%`
}

let baiduAccessToken = null
let baiduAccessTokenExpiresAt = 0

async function recognizePositionScreenshot(imageBuffer) {
  const accessToken = await getBaiduAccessToken()
  const api = process.env.BAIDU_OCR_DEFAULT_API || 'accurate_basic'
  const endpoint = getBaiduOcrEndpoint(api)
  const body = new URLSearchParams()
  body.set('image', imageBuffer.toString('base64'))
  body.set('detect_direction', 'true')
  body.set('paragraph', 'false')

  const response = await fetch(`${endpoint}?access_token=${accessToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await response.json()
  if (!response.ok || data.error_code) throw new Error(`閻ф儳瀹?OCR 婢惰精瑙﹂敍?{data.error_msg ?? response.statusText}`)

  const lines = Array.isArray(data.words_result) ? data.words_result.map((item) => String(item.words ?? '').trim()).filter(Boolean) : []
  return {
    api,
    lineCount: lines.length,
    lines,
    text: lines.join('\n'),
    candidates: await extractHoldingCandidates(lines),
    raw: { direction: data.direction, words_result_num: data.words_result_num },
  }
}

async function getBaiduAccessToken() {
  const now = Date.now()
  if (baiduAccessToken && now < baiduAccessTokenExpiresAt) return baiduAccessToken

  const body = new URLSearchParams()
  body.set('grant_type', 'client_credentials')
  body.set('client_id', requiredEnv('BAIDU_OCR_API_KEY'))
  body.set('client_secret', requiredEnv('BAIDU_OCR_SECRET_KEY'))

  const response = await fetch('https://aip.baidubce.com/oauth/2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await response.json()
  if (!response.ok || !data.access_token) throw new Error(`閻ф儳瀹?OCR token 閼惧嘲褰囨径杈Е閿?{data.error_description ?? response.statusText}`)

  baiduAccessToken = data.access_token
  baiduAccessTokenExpiresAt = now + Math.max(1, Number(data.expires_in ?? 3600) - 300) * 1000
  return baiduAccessToken
}

function getBaiduOcrEndpoint(api) {
  const endpoints = {
    general_basic: 'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic',
    general: 'https://aip.baidubce.com/rest/2.0/ocr/v1/general',
    accurate_basic: 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic',
    accurate: 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate',
  }
  return endpoints[api] ?? endpoints.accurate_basic
}

async function extractHoldingCandidates(lines) {
  const text = lines.join(' ')
  const holdings = await extractHoldingRowsV2(lines)
  return {
    fundCodes: uniqueMatches(text, /\b\d{6}\b/g),
    holdings,
    percentages: uniqueMatches(text, /-?\d+(?:\.\d+)?%/g),
    amounts: uniqueMatches(text, /[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[+-]?\d+\.\d{2,4}/g).slice(0, 30),
  }
}

async function extractHoldingRows(lines) {
  const rows = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const name = cleanString(lines[index])
    if (!isLikelyFundName(name) || lines[index + 1] !== '閸╂椽鍣?) continue
    const window = lines.slice(index + 2, index + 10)
    const amounts = window.filter((line) => /^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(line))
    const positionRatio = window.find((line) => /^閸楃姵鐦甛d+(?:\.\d+)?%$/.test(line))
    rows.push({
      recognizedName: name,
      amount: amounts[0] ? Number(amounts[0].replace(/,/g, '')) : 0,
      dayProfit: amounts[1] ? Number(amounts[1].replace(/,/g, '')) : null,
      holdingProfit: amounts[2] ? Number(amounts[2].replace(/,/g, '')) : null,
      totalProfit: amounts[3] ? Number(amounts[3].replace(/,/g, '')) : null,
      positionRatio: positionRatio ? Number(positionRatio.replace(/[^\d.]/g, '')) : null,
      matchedFunds: await searchFundsByName(name),
    })
  }
  return rows
}

function isLikelyFundName(value) {
  if (value.length < 5 || value.length > 42) return false
  if (['閸忋劑鍎撮幐浣规箒', '閺€鍓佹抄閸掑棙鐎?, '闁板秶鐤嗛崚鍡樼€?, '娴溿倖妲楅崚鍡樼€?, '閸氬秶袨/闁叉垿顤?, '閹镐焦婀侀弨鍓佹抄閹烘帒绨?].includes(value)) return false
  return /(濞ｅ嘲鎮巪閹稿洦鏆焲ETF|閼辨梹甯磡QDII|FOF|閼诧紕銈▅閸婂搫鍩渱鐠愌冪|娴犲嘲鈧磶娑擃叀鐦墊缁捐櫕鏌夋潏鎯у帬|閺嶅洦娅?/i.test(value)
}

let fundDirectoryCache = null

async function searchFundsByName(name) {
  const directory = await getFundDirectory()
  const target = normalizeSearchTextV3(name)
  return directory
    .map((fund) => ({ ...fund, score: scoreFundNameV3(target, normalizeSearchTextV3(fund.name)) }))
    .filter((fund) => fund.score > 0)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, 3)
}

async function getFundDirectory() {
  if (fundDirectoryCache) return fundDirectoryCache
  const text = await fetchText(`https://fund.eastmoney.com/js/fundcode_search.js?v=${Date.now()}`)
  const match = text.match(/var\s+r\s*=\s*(\[.*\]);?/s)
  if (!match) throw new Error('fund directory missing')
  const rows = JSON.parse(match[1])
  fundDirectoryCache = rows.map((row) => ({
    code: String(row[0]),
    name: String(row[2]),
    type: String(row[3] ?? ''),
  }))
  return fundDirectoryCache
}

function normalizeSearchText(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[()锛堬級路\\-_\\[\\]銆愩€慮/g, '')
}

function scoreFundName(target, candidate) {
  if (!target || !candidate) return 0
  if (target === candidate) return 120
  if (candidate.includes(target)) return 100
  if (target.includes(candidate)) return 90
  const compactTarget = target.replace(/閸╂椽鍣緗鐠囦礁鍩滈幎鏇＄カ閸╂椽鍣?g, '')
  const compactCandidate = candidate.replace(/閸╂椽鍣緗鐠囦礁鍩滈幎鏇＄カ閸╂椽鍣?g, '')
  if (compactTarget === compactCandidate) return 88
  if (compactCandidate.includes(compactTarget)) return 80
  if (compactTarget.includes(compactCandidate)) return 70
  let common = 0
  for (const char of new Set(compactTarget.split(''))) {
    if (compactCandidate.includes(char)) common += 1
  }
  const ratio = common / Math.max(compactTarget.length, compactCandidate.length)
  return ratio > 0.62 ? Math.round(ratio * 60) : 0
}

function normalizeOcrImportHolding(item) {
  const code = String(item?.code ?? '').trim()
  if (!/^\d{6}$/.test(code)) return null
  return {
    code,
    amount: toNumber(item?.amount, 0),
    holdingProfit: item?.holdingProfit == null ? null : toNumber(item.holdingProfit, null),
    positionRatio: item?.positionRatio == null ? 0 : toNumber(item.positionRatio, 0),
  }
}

async function resolveOcrImportHolding(holding) {
  const fundData = await fetchEastmoneyFundNav(holding.code).catch(() => null)
  const estimate = await fetchFundRealtimeEstimate(holding.code).catch(() => null)
  const directoryMatch = (await searchFundsByName(fundData?.name || holding.code).catch(() => []))[0]
  const nav = Number(estimate?.estimatedNav ?? fundData?.latest?.nav ?? 0)
  const amount = Number(holding.amount)
  const shares = nav > 0 && amount > 0 ? Number((amount / nav).toFixed(2)) : 0
  const costBasis = amount > 0 && holding.holdingProfit != null ? amount - Number(holding.holdingProfit) : 0
  const cost = shares > 0 && costBasis > 0 ? Number((costBasis / shares).toFixed(4)) : Number((fundData?.latest?.nav ?? estimate?.unitNav ?? 1).toFixed(4))
  return {
    code: holding.code,
    name: fundData?.name || estimate?.name || directoryMatch?.name || `OCR鐎电厧鍙嗛崺娲櫨${holding.code}`,
    type: directoryMatch?.type || 'OCR鐎电厧鍙?,
    shares,
    cost,
    positionRatio: Number(holding.positionRatio || 0),
  }
}

async function extractHoldingRowsV2(lines) {
  const rows = []
  const cleanLines = lines.map((line) => cleanString(line)).filter(Boolean)
  for (let index = 0; index < cleanLines.length; index += 1) {
    const name = cleanLines[index]
    if (!isLikelyFundNameV2(name)) continue
    const window = cleanLines.slice(index + 1, index + 14)
    if (!window.slice(0, 2).some((line) => line === '閸╂椽鍣?)) continue
    const amounts = window
      .map(parseOcrAmount)
      .filter((value) => value != null)
    const positionLine = window.find((line) => /閸楃姵鐦甛s*\d+(?:\.\d+)?%/.test(line))
    const matchedFunds = await searchFundsByName(name).catch(() => [])
    rows.push({
      recognizedName: name,
      amount: amounts[0] ?? 0,
      dayProfit: amounts[1] ?? null,
      holdingProfit: amounts[2] ?? null,
      totalProfit: amounts[3] ?? null,
      positionRatio: positionLine ? Number(positionLine.replace(/[^\d.]/g, '')) : null,
      matchedFunds,
    })
  }
  return rows
}

function isLikelyFundNameV2(value) {
  const text = cleanString(value)
  if (text.length < 5 || text.length > 42) return false
  if (/^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^[+-]?\d+(?:\.\d+)?%$/.test(text)) return false
  if (/[<>%]/.test(text) || /(鏀剁泭|鍒嗘瀽|鍏ㄩ儴|鍚嶇О|閲戦|鎺掑簭|鍗犳瘮|鍩洪噾$|鐞嗚储|瀹氭姇|绠楀姏|蹇冭剰|鍏夋ā鍧?/.test(text)) return false
  return /[A-Za-z\u4e00-\u9fa5]/.test(text)
}

function normalizeSearchTextV2(value) {
  return cleanString(value)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[()锛堬級路\\-_\\[\\]銆愩€慮/g, '')
    .replace(/閸╂椽鍣?/g, '')
}

function scoreFundNameV2(target, candidate) {
  if (!target || !candidate) return 0
  if (target === candidate) return 120
  if (candidate.includes(target)) return 105
  if (target.includes(candidate)) return 95
  const compactTarget = target.replace(/鐠囦礁鍩滈幎鏇＄カ閸╂椽鍣緗閹稿洦鏆熼崹瀣絺鐠у嘲绱閸欐垼鎹ｅ寮㈤崺娲櫨/g, '')
  const compactCandidate = candidate.replace(/鐠囦礁鍩滈幎鏇＄カ閸╂椽鍣緗閹稿洦鏆熼崹瀣絺鐠у嘲绱閸欐垼鎹ｅ寮㈤崺娲櫨/g, '')
  if (compactTarget === compactCandidate) return 92
  if (compactCandidate.includes(compactTarget)) return 84
  if (compactTarget.includes(compactCandidate)) return 76
  let common = 0
  for (const char of new Set(compactTarget.split(''))) {
    if (compactCandidate.includes(char)) common += 1
  }
  const ratio = common / Math.max(compactTarget.length, compactCandidate.length)
  return ratio > 0.64 ? Math.round(ratio * 70) : 0
}

function parseOcrAmount(value) {
  const match = cleanString(value).match(/[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?|[+-]?\d+\.\d+/)
  if (!match) return null
  const numberValue = Number(match[0].replace(/,/g, ''))
  return Number.isFinite(numberValue) ? numberValue : null
}

function normalizeSearchTextV3(value) {
  return cleanString(value)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[()锛堬級路\\-_\\[\\]銆愩€慮/g, '')
    .replace(/鐠囦礁鍩滈幎鏇＄カ閸╂椽鍣緗閹稿洦鏆熼崹瀣絺鐠у嘲绱閸欐垼鎹ｅ寮㈤崺娲櫨|娴滅儤鐨敮浜呯紘搴″帗閻滅増鐪箌缂囧骸鍘撻悳浼存寬|閼辨梹甯撮崺娲櫨/g, '')
}

function scoreFundNameV3(target, candidate) {
  if (!target || !candidate) return 0
  if (target === candidate) return 130
  if (candidate.includes(target)) return 118
  if (target.includes(candidate)) return 108
  const suffixPenalty = fundClassSuffix(target) && fundClassSuffix(candidate) && fundClassSuffix(target) !== fundClassSuffix(candidate) ? 18 : 0
  const targetTokens = fundNameTokens(target)
  const candidateTokens = fundNameTokens(candidate)
  const tokenHits = targetTokens.filter((token) => candidateTokens.includes(token) || candidate.includes(token)).length
  const tokenScore = targetTokens.length ? tokenHits / targetTokens.length * 58 : 0
  const lcsScore = longestCommonSubstringLength(target, candidate) / Math.max(target.length, candidate.length) * 46
  const charScore = commonCharRatio(target, candidate) * 24
  const score = Math.round(tokenScore + lcsScore + charScore - suffixPenalty)
  return score >= 45 ? score : 0
}

function fundNameTokens(value) {
  return String(value)
    .match(/[A-Z]+|\d+|[\u4e00-\u9fa5]{2,}/g)
    ?.filter((token) => !['閸╂椽鍣?, '閹稿洦鏆?, '濞ｅ嘲鎮?, '閼诧紕銈?, '閸婂搫鍩?, '閸欐垼鎹?, '閼辨梹甯?].includes(token))
    .slice(0, 12) ?? []
}

function fundClassSuffix(value) {
  const match = String(value).match(/(?:^|[^A-Z])(A|B|C|D|E|I|Y)(?:$|[^A-Z])/)
  return match?.[1] ?? ''
}

function commonCharRatio(left, right) {
  let common = 0
  for (const char of new Set(String(left).split(''))) {
    if (String(right).includes(char)) common += 1
  }
  return common / Math.max(1, new Set([...String(left), ...String(right)]).size)
}

function longestCommonSubstringLength(left, right) {
  const a = String(left)
  const b = String(right)
  let best = 0
  const row = Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0
    for (let j = 1; j <= b.length; j += 1) {
      const temp = row[j]
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0
      if (row[j] > best) best = row[j]
      prev = temp
    }
  }
  return best
}

function uniqueMatches(text, regex) {
  return [...new Set(text.match(regex) ?? [])]
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}





