import { CheckCircle2, RefreshCw, Search, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type Fund = {
  id: string
  code: string
  name: string
  type: string
  cost: number
  nav: number
  shares: number
  estimateChange: number
  positionRatio: number
  tags: string[]
  estimateSource?: string
  estimateTime?: string
  estimateUpdatedAt?: string
}

type Market = { code: string; name: string; value: number; change: number; source: string }
type DashboardData = { tradeDate: string; funds: Fund[]; markets: Market[] }
type AgentInsight = { id: string; title: string; level: 'positive' | 'negative' | 'watch' | 'neutral'; conclusion: string; evidence: string[] }
type Evidence = {
  agents?: AgentInsight[]
  exposure?: { sectors: { name: string; weight: number; avgChange: number }[]; stocks: { code: string; name: string; changePercent: number }[] }
  fastNews?: { items: { id: string; title: string; summary: string; time: string }[] }
  announcements?: { items: { id: string; title: string; category: string; date: string; url: string }[] }
  sourceStatus?: { source: string; ok: boolean; count: number; message: string }[]
}

type OcrHolding = {
  recognizedName: string
  amount: number
  holdingProfit: number | null
  positionRatio: number | null
  matchedFunds: { code: string; name: string; type: string; score: number }[]
}

type OcrResult = { candidates: { holdings: OcrHolding[] } }

const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 })
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
const refreshMs = 5000

function App() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [selectedFundId, setSelectedFundId] = useState('')
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [newCode, setNewCode] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastRefreshAt, setLastRefreshAt] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Fund>>({})
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refreshingRef = useRef(false)

  useEffect(() => {
    void loadDashboard()
    const timer = window.setInterval(() => void refreshData(true), refreshMs)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (selectedFundId) void loadEvidence(selectedFundId)
  }, [selectedFundId])

  const funds = data?.funds ?? []
  const selectedFund = funds.find((fund) => fund.id === selectedFundId) ?? funds[0]
  const visibleFunds = funds.filter((fund) => `${fund.code}${fund.name}${fund.tags.join('')}`.includes(query.trim()))
  const valuationFunds = funds.map((fund) => drafts[fund.id] ?? fund)
  const totalValue = valuationFunds.reduce((sum, fund) => sum + currentValue(fund), 0)
  const dayProfit = valuationFunds.reduce((sum, fund) => sum + todayProfitValue(fund), 0)
  const totalProfit = valuationFunds.reduce((sum, fund) => sum + (fund.nav - fund.cost) * fund.shares, 0)

  async function loadDashboard() {
    setBusy('加载中')
    try {
      applyDashboard(await requestJson<DashboardData>('/api/dashboard'))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }

  async function refreshData(silent = false) {
    if (refreshingRef.current) return
    refreshingRef.current = true
    if (!silent) setBusy('刷新估值')
    try {
      applyDashboard(await requestJson<DashboardData>('/api/data/refresh', { method: 'POST' }))
      if (!silent) setNotice('估值已刷新')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      refreshingRef.current = false
      if (!silent) setBusy('')
    }
  }

  async function loadEvidence(fundId: string) {
    try {
      setEvidence(await requestJson<Evidence>(`/api/funds/${fundId}/evidence`))
    } catch {
      setEvidence(null)
    }
  }

  function applyDashboard(next: DashboardData) {
    setData(next)
    setDrafts(Object.fromEntries(next.funds.map((fund) => [fund.id, { ...fund }])))
    setSelectedFundId((current) => current && next.funds.some((fund) => fund.id === current) ? current : next.funds[0]?.id || '')
    setLastRefreshAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
  }

  async function addFund() {
    const code = newCode.trim()
    if (!/^\d{6}$/.test(code)) {
      setError('请输入 6 位基金代码')
      return
    }
    setBusy('导入基金')
    try {
      applyDashboard(await requestJson<DashboardData>('/api/funds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, shares: 0, cost: 1, positionRatio: 0 }),
      }))
      setNewCode('')
      await refreshData(true)
      setNotice('基金已导入')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }

  async function saveFund(fundId: string) {
    const draft = drafts[fundId]
    if (!draft) return
    try {
      applyDashboard(await requestJson<DashboardData>(`/api/funds/${fundId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, tags: draft.tags.join('、') }),
      }))
      setNotice('持仓已保存')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function uploadScreenshot(file?: File) {
    if (!file) return
    setBusy('识别截图')
    try {
      const body = new FormData()
      body.set('image', file)
      setOcrResult(await requestJson<OcrResult>('/api/ocr/position-screenshot', { method: 'POST', body }))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }

  async function importOcr() {
    const holdings = (ocrResult?.candidates.holdings ?? [])
      .map((holding) => {
        const matched = holding.matchedFunds[0]
        return matched ? { code: matched.code, amount: holding.amount, holdingProfit: holding.holdingProfit, positionRatio: holding.positionRatio } : null
      })
      .filter(Boolean)
    if (!holdings.length) return
    setOcrResult(null)
    setBusy('导入识别结果')
    try {
      applyDashboard(await requestJson<DashboardData>('/api/holdings/import-from-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings }),
      }))
      await refreshData(true)
      setNotice('截图持仓已导入')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }

  function patchFund(fundId: string, field: 'shares' | 'cost', value: string) {
    const numeric = Number(value)
    setDrafts((current) => ({
      ...current,
      [fundId]: { ...(current[fundId] ?? funds.find((fund) => fund.id === fundId)!), [field]: Number.isFinite(numeric) ? numeric : 0 },
    }))
  }

  return (
    <main className="simple-shell">
      <section className="dashboard-head">
        <header className="simple-topbar">
          <h1>基金实时估值</h1>
          <div className="top-status"><CheckCircle2 size={17} />上次刷新 {lastRefreshAt || '--:--:--'}</div>
        </header>

        <section className="summary-grid">
          <Metric title="总市值" value={money.format(totalValue)} />
          <Metric title="今日预估收益" value={formatMoney(dayProfit)} tone={dayProfit >= 0 ? 'up' : 'down'} />
          <Metric title="累计盈亏" value={formatMoney(totalProfit)} tone={totalProfit >= 0 ? 'up' : 'down'} />
          <Metric title="持仓基金" value={`${funds.length} 只`} />
        </section>

        <section className="import-bar">
          <label className="code-input"><Search size={18} /><input value={newCode} onChange={(event) => setNewCode(event.target.value)} placeholder="输入 6 位基金代码，例如 110022" /></label>
          <button className="primary-button" onClick={() => void addFund()} disabled={Boolean(busy)}>导入基金</button>
          <button className="secondary-button" onClick={() => void refreshData(false)} disabled={Boolean(busy)}><RefreshCw size={17} />刷新估值</button>
          <button className="secondary-button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(busy)}><Upload size={17} />上传截图</button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={(event) => void uploadScreenshot(event.target.files?.[0])} />
        </section>

        <section className="market-strip">
          {(data?.markets ?? []).slice(0, 8).map((market) => <div className="market-chip" key={market.code}><span>{market.name}</span><strong>{number.format(market.value)}</strong><em className={market.change >= 0 ? 'up' : 'down'}>{formatPct(market.change)}</em></div>)}
        </section>
      </section>

      <div className="toast-layer">
        {error ? <div className="message error">{error}<button onClick={() => setError('')}>关闭</button></div> : null}
        {notice ? <div className="message success">{notice}<button onClick={() => setNotice('')}>关闭</button></div> : null}
      </div>

      {ocrResult ? <OcrModal result={ocrResult} onCancel={() => setOcrResult(null)} onConfirm={() => void importOcr()} /> : null}

      <section className="main-grid">
        <article className="fund-list-panel">
          <div className="panel-title"><h2>持仓估值</h2><label className="small-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索基金" /></label></div>
          <div className="fund-header"><span>基金</span><span>估值</span><span>份额</span><span>成本</span><span>市值</span><span>今日盈亏</span><span>累计盈亏</span></div>
          <div className="fund-list">
            {visibleFunds.map((fund) => {
              const draft = drafts[fund.id] ?? fund
              const today = todayProfitValue(draft)
              const profit = (draft.nav - draft.cost) * draft.shares
              return <div className={`fund-row ${selectedFund?.id === fund.id ? 'active' : ''}`} key={fund.id} onClick={() => setSelectedFundId(fund.id)}>
                <div className="fund-main"><strong title={fund.name}>{fund.name}</strong><span title={`${fund.code} · ${fund.tags.join(' / ')}`}>{fund.code} · {fund.tags.slice(0, 3).join(' / ') || '实时估值'}</span><small>{fund.estimateTime || fund.estimateUpdatedAt || '--'}</small></div>
                <div className="fund-price"><strong>{draft.nav.toFixed(4)}</strong><span className={draft.estimateChange >= 0 ? 'up' : 'down'}>{formatPct(draft.estimateChange)}</span></div>
                <div className="fund-edit" onClick={(event) => event.stopPropagation()}>
                  <input aria-label="份额" value={draft.shares} onChange={(event) => patchFund(fund.id, 'shares', event.target.value)} onBlur={() => void saveFund(fund.id)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
                  <input aria-label="成本" value={draft.cost} onChange={(event) => patchFund(fund.id, 'cost', event.target.value)} onBlur={() => void saveFund(fund.id)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
                  <span>{money.format(currentValue(draft))}</span><span className={today >= 0 ? 'up' : 'down'}>{formatMoney(today)}</span><span className={profit >= 0 ? 'up' : 'down'}>{formatMoney(profit)}</span>
                </div>
              </div>
            })}
          </div>
        </article>

        <aside className="advice-panel">
          <h2>基金详情</h2>
          {selectedFund ? <>
            <div className="selected-card"><span>{selectedFund.code}</span><strong>{selectedFund.name}</strong><small>{selectedFund.estimateTime || selectedFund.estimateUpdatedAt || '--'}</small><div className={`big-change ${selectedFund.estimateChange >= 0 ? 'up' : 'down'}`}>{formatPct(selectedFund.estimateChange)}</div></div>
            <SideSection title="智能体判断"><div className="agent-stack">{(evidence?.agents ?? []).map((agent) => <AgentCard agent={agent} key={agent.id} />)}</div></SideSection>
            <SideSection title="板块"><>{(evidence?.exposure?.sectors ?? []).slice(0, 5).map((sector) => <div className="sector-line" key={sector.name}><span>{sector.name}</span><em>{sector.weight.toFixed(0)}%</em><strong className={sector.avgChange >= 0 ? 'up' : 'down'}>{formatPct(sector.avgChange)}</strong></div>)}</></SideSection>
            <SideSection title="重仓股"><div className="stock-tags">{(evidence?.exposure?.stocks ?? []).slice(0, 8).map((stock) => <span key={stock.code}>{stock.name} <b className={stock.changePercent >= 0 ? 'up' : 'down'}>{formatPct(stock.changePercent)}</b></span>)}</div></SideSection>
            <SideSection title="快讯与公告"><div className="news-list">{(evidence?.fastNews?.items ?? []).slice(0, 3).map((item) => <span key={item.id} title={item.summary}>{item.time.slice(11, 16)} {item.title}</span>)}{(evidence?.announcements?.items ?? []).slice(0, 2).map((item) => <a href={item.url} key={item.id} target="_blank" rel="noreferrer">{item.date} {item.category} · {item.title}</a>)}</div></SideSection>
            <SideSection title="数据源"><div className="source-list compact">{(evidence?.sourceStatus ?? []).map((item) => <span key={item.source} title={item.message}>{sourceLabel(item.source)}<b className={item.ok ? 'up' : 'down'}>{item.ok ? '正常' : '异常'}</b><em>{item.count}</em></span>)}</div></SideSection>
          </> : <p className="muted">选择一只基金查看详情。</p>}
        </aside>
      </section>
    </main>
  )
}

function Metric({ title, value, tone }: { title: string; value: string; tone?: 'up' | 'down' }) {
  return <div className="metric-card"><span>{title}</span><strong className={tone ?? ''}>{value}</strong></div>
}

function SideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="side-section compact-section"><h3>{title}</h3>{children}</section>
}

function AgentCard({ agent }: { agent: AgentInsight }) {
  return <article className={`agent-card ${agent.level}`}><header><strong>{agent.title}</strong><span>{agentLevelLabel(agent.level)}</span></header><p>{agent.conclusion}</p><div className="agent-evidence">{agent.evidence.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</div></article>
}

function OcrModal({ result, onCancel, onConfirm }: { result: OcrResult; onCancel: () => void; onConfirm: () => void }) {
  const holdings = result.candidates.holdings ?? []
  return <div className="modal-backdrop"><section className="ocr-modal"><header><div><h2>确认识别结果</h2><p>识别到 {holdings.length} 条持仓，系统将按最高匹配基金导入。</p></div><button onClick={onCancel}>关闭</button></header><div className="ocr-table"><div className="ocr-head"><span>名称</span><span>匹配基金</span><span>金额</span><span>持有收益</span></div>{holdings.map((holding) => <div className="ocr-row" key={holding.recognizedName}><strong>{holding.recognizedName}</strong><span>{holding.matchedFunds[0] ? `${holding.matchedFunds[0].code} · ${holding.matchedFunds[0].name}` : '未匹配'}</span><span>{holding.amount ? money.format(holding.amount) : '-'}</span><span className={Number(holding.holdingProfit ?? 0) >= 0 ? 'up' : 'down'}>{holding.holdingProfit == null ? '-' : formatMoney(holding.holdingProfit)}</span></div>)}</div><footer><button className="secondary-button" onClick={onCancel}>取消</button><button className="primary-button" onClick={onConfirm}>确认导入</button></footer></section></div>
}

function currentValue(fund: Fund) { return fund.nav * fund.shares }
function todayProfitValue(fund: Fund) { return currentValue(fund) * fund.estimateChange / 100 }
function formatMoney(value: number) { return `${value >= 0 ? '+' : ''}${money.format(value)}` }
function formatPct(value: number) { return `${value >= 0 ? '+' : ''}${number.format(value)}%` }
function agentLevelLabel(level: AgentInsight['level']) { return level === 'positive' ? '偏强' : level === 'negative' ? '偏弱' : level === 'watch' ? '关注' : '正常' }
function sourceLabel(source: string) {
  if (source === 'eastmoney-fund') return '天天基金估值'
  if (source === 'eastmoney-sector') return '东方财富行业'
  if (source === 'eastmoney-news') return '东方财富快讯'
  if (source === 'eastmoney-announcement') return '天天基金公告'
  return source || '未知来源'
}
async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? `请求失败：${response.status}`)
  return response.json() as Promise<T>
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作失败' }

export default App
