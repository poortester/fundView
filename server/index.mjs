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
const isChinaTradingDay = isChinaBusinessDay()
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
    if (!provider) return response.status(404).json({ message: '模型配置不存在' })
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
    if (uniqueHoldings.length === 0) return response.status(400).json({ message: '未识别到有效持仓' })

    const resolvedHoldings = await Promise.all(uniqueHoldings.map((holding) => resolveOcrImportHolding(holding)))
    const statements = []
    for (const resolved of resolvedHoldings) {
      const fundId = randomUUID()
      statements.push(
        {
          sql: `INSERT OR IGNORE INTO funds (id, code, name, fund_type, tags) VALUES (?, ?, ?, ?, ?)`,
          args: [fundId, resolved.code, resolved.name, resolved.type || 'OCR导入', JSON.stringify(['OCR导入'])],
        },
        {
          sql: `UPDATE funds SET name = ?, fund_type = ?, tags = ?, updated_at = datetime('now') WHERE code = ?`,
          args: [resolved.name, resolved.type || 'OCR导入', JSON.stringify(['OCR导入']), resolved.code],
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
    if (!request.file) return response.status(400).json({ message: '请上传持仓截图' })
    if (!request.file.mimetype.startsWith('image/')) return response.status(400).json({ message: '只支持图片文件' })
    response.json(await recognizePositionScreenshot(request.file.buffer))
  } catch (error) {
    next(error)
  }
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(error.statusCode ?? 500).json({ message: error instanceof Error ? error.message : '服务器错误' })
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
  if (value.length <= 8) return '已填写'
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
    name: cleanString(body?.name) || '未命名基金',
    type: cleanString(body?.type) || '主动权益',
    cost: toNumber(body?.cost, 1),
    nav: toNumber(body?.nav, 1),
    shares: toNumber(body?.shares, 0),
    estimateChange: toNumber(body?.estimateChange, 0),
    positionRatio: toNumber(body?.positionRatio, 0),
    tags: cleanString(body?.tags).split(/[,\s，、]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 6),
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
      industry: String(row.f100 || '未分类'),
      region: String(row.f102 || ''),
      concepts: String(row.f103 || '').split(',').filter(Boolean).slice(0, 6),
      updatedAt: Number(row.f124 || 0),
      raw: row,
    }))
}

function summarizeSectors(stockQuotes) {
  const sectors = new Map()
  for (const stock of stockQuotes) {
    const key = stock.industry || '未分类'
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

function isChinaBusinessDay(reference = new Date()) {
  const day = new Date(reference).getDay()
  return day >= 1 && day <= 5
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
        title: '基金净值',
        value: latest ? `${latest.tradeDate} NAV ${latest.nav}` : '暂无历史净值',
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
      sectorKeywords.length ? `主要板块：${sectorKeywords.join('、')}` : '',
      stockKeywords.length ? `重仓股票：${stockKeywords.join('、')}` : '',
      marketKeywords.length ? `市场参考：${marketKeywords.join('、')}` : '',
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
  const officialAuthor = /基金资讯|基金公告|天天基金|东方财富|基金公司|上市公司公告/.test(author)
  const officialTag = /公告|资讯|研报|新闻/.test(tag)
  const officialTitle = /公告|定期报告|季度报告|年度报告|中期报告|招募说明书|基金产品资料概要|基金经理变更|托管协议|基金合同|风险提示|清算报告/.test(title)
  const forumNoise = /股友|基民|操作分享|晒收益|加仓|补仓|跑路|清了|跌麻|偷吃|接盘|韭菜|瓜分|为什么|怎么办|咋回事|限购是什么意思/.test(text)
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
    5: '基金销售',
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
    [/纳斯达克|NASDAQ|Nasdaq/i, ['纳斯达克', '美股', '科技股', '英伟达', '苹果', '微软', '特斯拉', 'AI']],
    [/标普|S&P|SP500|500/i, ['标普', '标普500', '美股', '美国股市']],
    [/QDII/i, ['QDII', '海外市场', '美股', '美元']],
    [/光伏/i, ['光伏', '新能源', '硅料', '组件', '逆变器']],
    [/稀土|小金属|工业金属/i, ['稀土', '小金属', '工业金属', '有色金属']],
    [/通信|通信设备/i, ['通信', '通信设备', '5G', '算力', '光模块']],
    [/半导体|芯片/i, ['半导体', '芯片', '集成电路', 'AI芯片']],
    [/消费电子|元件/i, ['消费电子', '电子元件', '华为']],
    [/中证全指/i, ['中证全指']],
  ]
  for (const [pattern, values] of rules) {
    if (pattern.test(name)) keywords.push(...values)
  }
  const shortName = name
    .replace(/[A-Z]$/i, '')
    .replace(/\(.*?\)|（.*?）/g, '')
    .replace(/(人民币|发起式|联接|指数|股票|混合|基金|ETF|FOF|C|A|100|500)/g, '')
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
    breadth: breadth ?? { advancing: 0, declining: 0, advanceRatio: 0, breadth: 0, message: '暂无数据' },
    sectorMomentum: {
      upCount: upSectors,
      downCount: downSectors,
      leaders: (sectorLeaders.items ?? []).slice(0, 5).map((s) => `${s.name}${formatPct(s.changePercent)}`),
      topInflow: topInflow.map((s) => `${s.name}净流入${(s.netInflow / 1e8).toFixed(2)}亿`),
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
  if (csi300 > 0.5 && (breadth?.advanceRatio ?? 0) > 60) parts.push('A股做多情绪明显')
  else if (csi300 < -0.5 && (breadth?.advanceRatio ?? 0) < 40) parts.push('A股承压，跌多涨少')
  else parts.push('A股震荡')
  if (hstech > 1) parts.push('港股科技走强')
  else if (hstech < -1) parts.push('港股科技走弱')
  if (ndx > 1) parts.push('美股偏强')
  else if (ndx < -1) parts.push('美股偏弱')
  if (upSectors > downSectors + 2) parts.push('板块普涨')
  else if (downSectors > upSectors + 2) parts.push('板块普跌')
  return parts.join('；')
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
    sentiment: sentiment ?? { overall: '未获取', indices: [], breadth: {}, sectorMomentum: {}, news: [] },
    matchedNews: matchedNews.slice(0, 5).map((n) => n.title),
    latestAnnouncement: latestAnnouncement ? `${latestAnnouncement.title}，${latestAnnouncement.date}` : null,
    sectorLeaders: (sectorLeaders.items ?? []).slice(0, 5).map((s) => `${s.name}${formatPct(s.changePercent)}净流入${(s.netInflow / 1e8).toFixed(1)}亿`),
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
    { id: 'market', title: '市场研究员', role: '评估宏观指数、市场宽度和基准相对表现，只说明对本基金的影响路径' },
    { id: 'sector', title: '行业研究员', role: '评估基金重仓行业、板块动量和资金流，不夸大未验证的主题叙事' },
    { id: 'risk', title: '组合风控研究员', role: '评估仓位、回撤、波动和集中度，明确风险等级与观察阈值' },
    { id: 'news', title: '事件研究员', role: '核对快讯和公告，只标记需要人工确认的事件风险' },
    { id: 'trade', title: '组合决策研究员', role: '综合研究结论，输出持有、观察、减仓观察或补仓观察，不输出确定性交易指令' },
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
  return `你是专业的${agentDef.title}，职责：${agentDef.role}

## 分析数据

请基于下面 JSON 数据做基金研究分析：

${JSON.stringify(structuredData)}

## 输出要求

写成投研备忘录，不要像普通聊天。结论必须有条件边界，证据必须来自上面的数据。
严格输出 JSON：{"thinking":"逐步推理：1.关键数据观察 2.异常识别 3.影响评估","level":"positive/negative/watch/neutral","conclusion":"一句研究结论，包含动作倾向和限制条件","evidence":["依据1","依据2","依据3"],"recommendation":{"action":"持有/观察/减仓观察/补仓观察","targetPositionRatio":null,"stopLossNav":null,"conditions":["条件1","条件2"],"confidence":"低/中/高"}}`
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
        confidence: ['低', '中', '高'].includes(parsed.recommendation.confidence) ? parsed.recommendation.confidence : '低',
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
    evidence.push(`${ctx.benchmark.name}${formatPct(ctx.benchmark.change)}`, `相对强弱${formatPct(f.relative)}`)
    if (s.overall) evidence.push(s.overall)
    if (s.breadth?.total) evidence.push(`涨跌比${s.breadth.advancing}:${s.breadth.declining}`)
    level = f.estimateChange >= 0 ? 'positive' : 'negative'
    conclusion = `今日估值${formatPct(f.estimateChange)}，相对${ctx.benchmark.name}${f.relative >= 0 ? '更强' : '更弱'}${formatPct(Math.abs(f.relative))}。市场情绪：${s.overall || '数据不足'}。`
    thinking = `估值${formatPct(f.estimateChange)}，基准${ctx.benchmark.name}${formatPct(ctx.benchmark.change)}，相对强弱${formatPct(f.relative)}。${s.overall || '情绪数据不足'}。`
    recommendation = { action: f.estimateChange >= 0 ? '持有' : '观察', targetPositionRatio: null, stopLossNav: null, conditions: [`若${ctx.benchmark.name}连续3日跌超1.5%，降低权益仓位`, '若市场宽度上涨占比连续2日超70%，可适当放宽仓位'], confidence: '低' }
  } else if (agentDef.id === 'sector') {
    const top = ctx.exposure.sectors[0]
    if (top) {
      evidence.push(`${top.name}权重${top.weight.toFixed(0)}%`, `板块涨跌${formatPct(top.avgChange)}`)
      level = top.avgChange >= 0 ? 'positive' : 'negative'
      conclusion = `主要暴露为${top.name}，权重${top.weight.toFixed(0)}%，今日${formatPct(top.avgChange)}。${ctx.sectorLeaders.length ? `资金流向：${ctx.sectorLeaders.slice(0, 2).join('、')}` : ''}`
      thinking = `重仓板块${top.name}权重${top.weight.toFixed(0)}%，涨跌${formatPct(top.avgChange)}。${ctx.sectorLeaders.length ? `资金方向：${ctx.sectorLeaders.slice(0, 2).join('、')}` : ''}`
      recommendation = { action: top.avgChange >= 0 ? '持有' : '观察', targetPositionRatio: null, stopLossNav: null, conditions: [`若${top.name}板块净流入连续3日为负且跌幅超3%，降低该主题暴露`, '若重仓板块换手率异常放大，关注回调风险'], confidence: '中' }
    } else {
      conclusion = '未获取到板块暴露数据。'
      thinking = '板块暴露数据缺失，无法判断行业风险。'
      recommendation = { action: '观察', targetPositionRatio: null, stopLossNav: null, conditions: [], confidence: '低' }
    }
  } else if (agentDef.id === 'risk') {
    evidence.push(`浮盈${formatPct(f.profitRate)}`, `近90日回撤${formatPct(m.last90.maxDrawdownPct)}`, `波动${formatPct(m.last90.volatilityPct)}`, `仓位${f.positionRatio}%`)
    level = (f.profitRate > 25 || m.last90.maxDrawdownPct < -18 || f.positionRatio > 25) ? 'watch' : 'neutral'
    conclusion = `浮盈${formatPct(f.profitRate)}，仓位${f.positionRatio}%，近90日回撤${formatPct(m.last90.maxDrawdownPct)}，波动${formatPct(m.last90.volatilityPct)}。`
    thinking = `浮盈${formatPct(f.profitRate)}，仓位${f.positionRatio}%，回撤${formatPct(m.last90.maxDrawdownPct)}，波动${formatPct(m.last90.volatilityPct)}。${level === 'watch' ? '触发风控观察信号。' : '风控指标正常。'}`
    recommendation = { action: level === 'watch' ? '减仓观察' : '持有', targetPositionRatio: f.positionRatio > 25 ? 20 : null, stopLossNav: f.cost > 0 ? Number((f.cost * 0.9).toFixed(4)) : null, conditions: [`若仓位超过${f.positionRatio > 25 ? 25 : 30}%，建议分批减至${Math.max(10, f.positionRatio - 10)}%`, '若近30日回撤超过15%，暂停补仓计划'], confidence: m.last90.maxDrawdownPct < -15 ? '中' : '低' }
  } else if (agentDef.id === 'news') {
    evidence.push(...ctx.matchedNews.slice(0, 3))
    if (ctx.latestAnnouncement) evidence.push(ctx.latestAnnouncement)
    level = ctx.matchedNews.length ? 'watch' : 'neutral'
    conclusion = ctx.matchedNews.length ? `命中${ctx.matchedNews.length}条相关快讯，需要人工确认是否影响持仓。` : '快讯和公告未命中明显负面因素。'
    thinking = ctx.matchedNews.length ? `命中${ctx.matchedNews.length}条相关快讯，需要关注事件风险。` : '快讯和公告无明显负面信号。'
    recommendation = { action: ctx.matchedNews.length ? '观察' : '持有', targetPositionRatio: null, stopLossNav: null, conditions: ctx.matchedNews.length ? ['关注快讯后续发展，若确认重大利空则考虑减仓'] : [], confidence: '低' }
  } else {
    evidence.push(`估值${formatPct(f.estimateChange)}`, `浮盈${formatPct(f.profitRate)}`, `相对强弱${formatPct(f.relative)}`)
    if (f.estimateChange <= -3 && f.profitRate < -8) {
      level = 'negative'
      conclusion = '下跌且浮亏扩大，暂不情绪化补仓，等估值回稳后再按计划处理。'
      thinking = `估值跌${formatPct(f.estimateChange)}且浮亏${formatPct(f.profitRate)}，触发下跌和浮亏信号。`
      recommendation = { action: '补仓观察', targetPositionRatio: Math.min(f.positionRatio + 5, 30), stopLossNav: f.cost > 0 ? Number((f.cost * 0.85).toFixed(4)) : null, conditions: ['仅在净值企稳2日后再补仓', `补仓后仓位不超过${Math.min(f.positionRatio + 5, 30)}%`, '单次补仓不超过当前市值的20%'], confidence: '中' }
    } else if (f.profitRate > 20 && f.estimateChange > 1) {
      level = 'watch'
      conclusion = '盈利较多且当日上涨，优先设置止盈线，不建议继续追高。'
      thinking = `浮盈${formatPct(f.profitRate)}且当日涨${formatPct(f.estimateChange)}，触发止盈观察信号。`
      recommendation = { action: '减仓观察', targetPositionRatio: Math.max(f.positionRatio - 5, 5), stopLossNav: null, conditions: [`止盈线设在净值${Number(f.nav * 0.95).toFixed(4)}`, '可分3批减仓，每批减持1/3', '若连续2日下跌，立即执行止盈'], confidence: '中' }
    } else if (f.relative > 1.5) {
      level = 'positive'
      conclusion = '相对参考指数明显更强，可以继续持有观察，新增买入要看仓位上限。'
      thinking = `相对强弱${formatPct(f.relative)}，跑赢基准明显。`
      recommendation = { action: '持有', targetPositionRatio: null, stopLossNav: f.cost > 0 ? Number((f.cost * 0.92).toFixed(4)) : null, conditions: ['新增买入需确认仓位未超限', '若相对强弱转负则进入观察'], confidence: '低' }
    } else {
      conclusion = '没有触发极端信号，按原计划持有，等净值确认后复盘。'
      thinking = `估值${formatPct(f.estimateChange)}，浮盈${formatPct(f.profitRate)}，相对强弱${formatPct(f.relative)}，未触发极端信号。`
      recommendation = { action: '持有', targetPositionRatio: null, stopLossNav: f.cost > 0 ? Number((f.cost * 0.9).toFixed(4)) : null, conditions: ['若单日跌幅超3%且仓位未超限，进入补仓观察', '若浮盈超25%且连续上涨2日，进入止盈观察'], confidence: '低' }
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
        const name = String(sector?.name ?? '未分类')
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
    .map((s) => `${s.name} 暴露权重约${s.weight.toFixed(0)}%，覆盖${s.fundCount}只基金`)

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
                 CASE
                   WHEN n.trade_date = ? OR ? = 0 THEN COALESCE(n.change_percent, 0)
                   ELSE 0
                 END AS estimate_change,
                 CASE WHEN n.trade_date = ? THEN 0 ELSE 1 END AS estimate_stale,
                 CASE WHEN ? = 1 AND n.trade_date != ? THEN 1 ELSE 0 END AS estimate_missing,
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
    args: [tradeDate, isChinaTradingDay ? 1 : 0, tradeDate, isChinaTradingDay ? 1 : 0, tradeDate, userId],
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
    estimateStale: Boolean(row.estimate_stale),
    estimateMissing: Boolean(row.estimate_missing),
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
      confidence: String(row.confidence ?? '低'),
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
  const riskProfile = analysis.riskItems.length ? '存在风控观察项' : '风险正常'
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
        tradeAgent.recommendation?.confidence ?? '低',
      ],
    })
  }
  if (adviceStatements.length) await db.batch(adviceStatements, 'write')

  return { analysis, reportId, llmUsed: Boolean(llmSummary) }
}

function buildLlmPrompt(analysis, markets, sentiment) {
  const marketLine = markets.map((m) => `${m.name}${formatPct(m.change)}`).join('、')
  const riskLine = analysis.riskItems.length ? analysis.riskItems.join('；') : '无明显风险'
  const sectorLine = (analysis.portfolioExposure?.sectors ?? []).slice(0, 5).map((s) => `${s.name}权重${s.weight.toFixed(0)}%`).join('、')
  const sentimentLine = sentiment?.overall || '未获取'
  const breadthLine = sentiment?.breadth?.total ? `上涨${sentiment.breadth.advancing}家，下跌${sentiment.breadth.declining}家` : ''
  const fundLine = analysis.fundAnalyses.slice(0, 8).map((f) => `${f.name}(${f.category}, 相对${formatPct(f.relative)})`).join('、')
  return `你是基金持仓分析助手，请基于以下数据用2-3句话给出组合层面的风险提示和操作纪律建议，不要给具体买卖指令。
市场：${marketLine}
市场情绪：${sentimentLine}${breadthLine ? `；${breadthLine}` : ''}
风险：${riskLine}
组合暴露：${sectorLine || '暂无'}
基金表现：${fundLine}`
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

async function getFundAnalysisHistory(fundId) {
  const result = await db.execute({
    sql: `SELECT ai.id, ai.title, ai.level, ai.reason, ai.action, ai.status, ai.thinking,
                 ai.target_position, ai.stop_loss_nav, ai.action_conditions, ai.confidence,
                 ai.baseline_nav, ai.executed_at, ai.created_at, ar.trade_date
          FROM advice_items ai
          JOIN analysis_reports ar ON ar.id = ai.report_id
          WHERE ar.user_id = ? AND ai.fund_id = ?
          ORDER BY ar.trade_date DESC, ai.created_at DESC
          LIMIT 30`,
    args: [userId, fundId],
  })
  const latestNavRow = await db.execute({
    sql: `SELECT estimated_nav, nav
          FROM fund_nav_snapshots
          WHERE fund_id = ?
          ORDER BY trade_date DESC, created_at DESC
          LIMIT 1`,
    args: [fundId],
  })
  const latestNav = Number(latestNavRow.rows[0]?.estimated_nav ?? latestNavRow.rows[0]?.nav ?? 0)
  const history = result.rows.map((row) => {
    const baselineNav = row.baseline_nav == null ? null : Number(row.baseline_nav)
    const actualReturnPct = baselineNav && latestNav > 0
      ? Number(((latestNav - baselineNav) / baselineNav * 100).toFixed(2))
      : null
    return {
      id: String(row.id),
      tradeDate: String(row.trade_date),
      level: String(row.level ?? 'neutral'),
      action: String(row.action ?? ''),
      conclusion: String(row.reason ?? row.title ?? ''),
      thinking: String(row.thinking ?? ''),
      recommendation: {
        targetPosition: row.target_position == null ? null : Number(row.target_position),
        stopLossNav: row.stop_loss_nav == null ? null : Number(row.stop_loss_nav),
        conditions: parseJsonArray(row.action_conditions),
        confidence: String(row.confidence ?? '低'),
      },
      status: String(row.status ?? 'open'),
      baselineNav,
      actualReturnPct,
      executedAt: String(row.executed_at ?? ''),
      createdAt: String(row.created_at ?? ''),
    }
  })
  const verified = history.filter((item) => item.status === 'executed' && item.actualReturnPct != null)
  const winCount = verified.filter((item) => item.actualReturnPct > 0).length
  const avgReturnPct = verified.length
    ? Number((verified.reduce((sum, item) => sum + item.actualReturnPct, 0) / verified.length).toFixed(2))
    : 0
  return {
    fundId,
    totalReports: history.length,
    accuracy: {
      totalExecuted: verified.length,
      winCount,
      winRate: verified.length ? Number((winCount / verified.length * 100).toFixed(1)) : 0,
      avgReturnPct,
    },
    history,
  }
}

async function getAdviceAttribution() {
  return getAttributionSummary()
}

function buildPortfolioAnalysis(funds, markets, portfolioExposure) {
  const marketMap = Object.fromEntries(markets.map((market) => [market.code, market.change]))
  const fundAnalyses = funds.map((fund) => analyzeFund(fund, marketMap))
  const totalValue = funds.reduce((sum, fund) => sum + fund.nav * fund.shares, 0)
  const equityPosition = funds.filter((fund) => !['债券', '货币'].includes(fund.type)).reduce((sum, fund) => sum + fund.positionRatio, 0)
  const duplicateTags = getDuplicateTags(funds)
  const concentration = portfolioExposure?.concentration ?? []
  const riskItems = [
    equityPosition > 70 ? `权益仓位 ${equityPosition}% 偏高` : '',
    duplicateTags.length ? `主题重复：${duplicateTags.join('、')}` : '',
    ...concentration,
  ].filter(Boolean)
  const sectorView = (portfolioExposure?.sectors ?? []).slice(0, 3).map((s) => `${s.name} ${s.weight.toFixed(0)}%`).join('、')
  return {
    summary: `当前持仓 ${funds.length} 只，估算市值 ${Math.round(totalValue)} 元，权益仓位 ${equityPosition}%。`,
    riskItems,
    portfolioExposure: portfolioExposure ?? { sectors: [], concentration: [] },
    fundAnalyses,
    agents: [
      { role: '行情分析员', view: `沪深300 ${formatPct(marketMap.CSI300)}，创业板 ${formatPct(marketMap.CHINEXT)}，市场环境偏${(marketMap.CSI300 ?? 0) >= 0 ? '积极' : '谨慎'}。` },
      { role: '基金分析员', view: `重点关注跑输参考市场的基金：${fundAnalyses.filter((item) => item.category === '跑输市场').map((item) => item.name).join('、') || '暂无'}。` },
      { role: '风控分析员', view: riskItems.length ? riskItems.join('；') : '当前未触发明显集中度或仓位风险。' },
      { role: '持仓穿透员', view: sectorView ? `组合主要暴露：${sectorView}。` : '暂无持仓穿透数据，建议刷新行情后查看。' },
      { role: '建议分析员', view: '建议以持有和观察为主，只在仓位未超限且跌幅达到计划区间时再补仓。' },
      { role: '复盘分析员', view: '每天保存建议、实际操作和原因，后续用于识别追涨、过早补仓等行为偏差。' },
    ],
    scenarios: [
      { name: '上涨情景', impact: '权益基金受益，但重复主题需要考虑分批止盈。' },
      { name: '震荡情景', impact: '优先维持仓位纪律，避免因单日波动频繁操作。' },
      { name: '回撤情景', impact: '只有低于计划阈值且仓位未超限的基金进入补仓观察。' },
    ],
  }
}
function analyzeFund(fund, marketMap) {
  const benchmark = chooseBenchmark(fund, marketMap)
  const relative = Number((fund.estimateChange - benchmark.change).toFixed(2))
  const category = relative > 0.8 ? '跑赢市场' : relative < -0.8 ? '跑输市场' : Math.abs(fund.estimateChange) > 2.5 ? '异常波动' : '跟随市场'
  return {
    fundId: fund.id,
    name: fund.name,
    benchmark: benchmark.name,
    benchmarkChange: benchmark.change,
    relative,
    category,
    reasons: buildReasons(fund, benchmark, relative),
    advice: null,
    confidence: Math.abs(relative) > 1.2 ? '中' : '低',
  }
}

function chooseBenchmark(fund, marketMap) {
  const name = `${fund.name}${fund.tags.join('')}`
  if (fund.type === '债券' || name.includes('债')) return { code: 'CN10Y', name: '十年国债', change: marketMap.CN10Y ?? 0 }
  if (name.includes('纳斯达克') || name.includes('纳指') || name.includes('NDX')) return { code: 'NDX', name: '纳斯达克100', change: marketMap.NDX ?? 0 }
  if (name.includes('标普') || name.includes('SPX') || name.includes('S&P')) return { code: 'SPX', name: '标普500', change: marketMap.SPX ?? 0 }
  if (name.includes('恒生') || name.includes('港股') || name.includes('恒生科技')) return { code: 'HSI', name: '恒生指数', change: marketMap.HSI ?? 0 }
  if (fund.type === 'QDII' || fund.tags.includes('港美')) return { code: 'NDX', name: '纳斯达克100', change: marketMap.NDX ?? 0 }
  if (name.includes('通信') || name.includes('电子') || name.includes('半导体') || name.includes('芯片')) return { code: 'CHINEXT', name: '创业板指', change: marketMap.CHINEXT ?? 0 }
  return { code: 'CSI300', name: '沪深300', change: marketMap.CSI300 ?? 0 }
}

function buildReasons(fund, benchmark, relative) {
  const reasons = [`今日估值${formatPct(fund.estimateChange)}，参考${benchmark.name}${formatPct(benchmark.change)}。`]
  if (relative > 0.8) reasons.push(`相对参考指数强 ${formatPct(relative)}，短线表现较强。`)
  if (relative < -0.8) reasons.push(`相对参考指数弱 ${formatPct(Math.abs(relative))}，需要观察是否为基金自身因素。`)
  const profitRate = fund.cost > 0 ? (fund.nav - fund.cost) / fund.cost * 100 : 0
  reasons.push(`当前浮盈${formatPct(profitRate)}，成本${fund.cost.toFixed(4)}，估值${fund.nav.toFixed(4)}。`)
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
    if (!isLikelyFundName(name) || lines[index + 1] !== '基金') continue
    const window = lines.slice(index + 2, index + 10)
    const amounts = window.filter((line) => /^[+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?$/.test(line))
    const positionRatio = window.find((line) => /^仓位\d+(?:\.\d+)?%$/.test(line) || /^\d+(?:\.\d+)?%$/.test(line))
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
  if (['基金', '持有份额', '持有金额', '最新净值', '收益/亏损', '参考市值'].includes(value)) return false
  return /(基金|ETF|QDII|FOF|指数|混合|股票|债券|货币|联接)/i.test(value)
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
    .replace(/[()（）·\\-_\\[\\]【】]/g, '')
}

function scoreFundName(target, candidate) {
  if (!target || !candidate) return 0
  if (target === candidate) return 120
  if (candidate.includes(target)) return 100
  if (target.includes(candidate)) return 90
  const compactTarget = target.replace(/基金|ETF|联接|指数|混合|股票|债券|货币|QDII|FOF/g, '')
  const compactCandidate = candidate.replace(/基金|ETF|联接|指数|混合|股票|债券|货币|QDII|FOF/g, '')
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
    type: directoryMatch?.type || 'OCR导入',
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
    if (!window.slice(0, 2).some((line) => line === '基金')) continue
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
  if (/[<>%]/.test(text) || /(收益|分析|全部|名称|金额|排序|占比|基金$|理财|定投|算力|心意|光模块)/.test(text)) return false
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
    ?.filter((token) => !['基金', '持有', '金额', '收益', '净值', '份额', '成本'].includes(token))
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





