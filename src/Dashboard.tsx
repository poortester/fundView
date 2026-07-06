import { AlertCircle, ArrowUpDown, CheckCircle2, ChevronDown, ChevronRight, RefreshCw, Save, Search, Settings2, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

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
  estimateDate?: string
  estimateTime?: string
  estimateUpdatedAt?: string
  estimateStale?: boolean
  estimateMissing?: boolean
}
type Market = { code: string; name: string; value: number; change: number; source: string }
type NewsItem = { id: string; title: string; summary: string; time: string }
type DashboardData = { tradeDate: string; funds: Fund[]; markets: Market[]; fastNews?: NewsItem[] }
type AgentInsight = {
  id: string
  title: string
  level: 'positive' | 'negative' | 'watch' | 'neutral'
  conclusion: string
  evidence: string[]
  thinking?: string
  recommendation?: { action: string; confidence: string; conditions: string[]; targetPositionRatio: number | null; stopLossNav: number | null } | null
}
type AnalysisHistoryItem = {
  id: string
  tradeDate: string
  level: string
  action: string
  conclusion: string
  thinking: string
  recommendation: { targetPosition: number | null; stopLossNav: number | null; conditions: string[]; confidence: string }
  status: string
  baselineNav: number | null
  actualReturnPct: number | null
  executedAt: string
  createdAt: string
}
type AnalysisHistory = {
  fundId: string
  totalReports: number
  accuracy: { totalExecuted: number; winCount: number; winRate: number; avgReturnPct: number }
  history: AnalysisHistoryItem[]
}
type Evidence = {
  agents?: AgentInsight[]
  exposure?: { sectors: { name: string; weight: number; avgChange: number }[]; stocks: { code: string; name: string; changePercent: number }[] }
  fastNews?: { items: NewsItem[] }
  announcements?: { items: { id: string; title: string; category: string; date: string; url: string }[] }
  sourceStatus?: { source: string; ok: boolean; count: number; message: string }[]
}
type LlmProvider = { id: string; provider: string; name: string; baseUrl: string; models: string[]; selectedModel: string; source: string; hasApiKey: boolean; apiKeyPreview: string }
type LlmSettings = { activeProviderId: string; providers: LlmProvider[] }
type SortKey = 'name' | 'estimateChange' | 'shares' | 'cost' | 'value' | 'todayProfit' | 'profit'
type DetailTab = 'evidence' | 'news'

const refreshMs = 5000
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 })
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [selectedFundId, setSelectedFundId] = useState('')
  const [expandedFundId, setExpandedFundId] = useState('')
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisHistory | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('evidence')
  const [newCode, setNewCode] = useState('')
  const [query, setQuery] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Fund>>({})
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'value', direction: 'desc' })
  const [isEditing, setIsEditing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selectedNews, setSelectedNews] = useState<NewsItem | null>(null)
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [currentTime, setCurrentTime] = useState('')
  const [nextRefreshAt, setNextRefreshAt] = useState(0)
  const [refreshPhase, setRefreshPhase] = useState<'idle' | 'refreshing' | 'synced'>('idle')
  const [tick, setTick] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refreshingRef = useRef(false)

  useEffect(() => { void loadDashboard() }, [])
  useEffect(() => {
    const timer = window.setInterval(() => {
      setTick((value) => value + 1)
      setCurrentTime(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    }, 1000)
    setCurrentTime(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!nextRefreshAt || refreshingRef.current || refreshPhase === 'refreshing') return
    if (Date.now() >= nextRefreshAt) void refreshData(true)
  }, [nextRefreshAt, refreshPhase, tick])
  useEffect(() => {
    if (!selectedFundId) {
      setEvidence(null)
      setAnalysisHistory(null)
      return
    }
    setEvidence(null)
    setAnalysisHistory(null)
    void loadEvidence(selectedFundId)
    void loadAnalysisHistory(selectedFundId)
  }, [selectedFundId])

  const funds = data?.funds ?? []
  const selectedFund = funds.find((fund) => fund.id === selectedFundId) ?? funds[0]
  const valuationFunds = funds.map((fund) => drafts[fund.id] ?? fund)
  const totalValue = valuationFunds.reduce((sum, fund) => sum + currentValue(fund), 0)
  const dayProfit = valuationFunds.reduce((sum, fund) => sum + todayProfitValue(fund), 0)
  const totalProfit = valuationFunds.reduce((sum, fund) => sum + (fund.nav - fund.cost) * fund.shares, 0)
  const equityPosition = valuationFunds.filter((fund) => !['债券', '货币'].includes(fund.type)).reduce((sum, fund) => sum + fund.positionRatio, 0)
  const visibleFunds = useMemo(() => {
    const matched = funds.filter((fund) => `${fund.code}${fund.name}${fund.tags.join('')}`.includes(query.trim()))
    const sorted = matched.toSorted((left, right) => compareFunds(drafts[left.id] ?? left, drafts[right.id] ?? right, sort.key))
    return sort.direction === 'desc' ? sorted.reverse() : sorted
  }, [drafts, funds, query, sort])
  const secondsToRefresh = nextRefreshAt ? Math.max(1, Math.ceil((nextRefreshAt - Date.now()) / 1000)) : 5
  const refreshLabel = refreshPhase === 'refreshing' ? '刷新中' : `${secondsToRefresh}s`

  async function loadDashboard() {
    setBusy('加载估值')
    try {
      applyDashboard(await requestJson<DashboardData>('/api/dashboard'))
      markSynced()
    } catch (err) {
      setError(errorMessage(err))
      scheduleNextRefresh()
    } finally {
      setBusy('')
    }
  }
  async function refreshData(silent = false) {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshPhase('refreshing')
    if (!silent) setBusy('刷新估值')
    try {
      applyDashboard(await requestJson<DashboardData>('/api/data/refresh', { method: 'POST' }))
      markSynced()
      if (!silent) setNotice('估值已刷新')
    } catch (err) {
      setError(errorMessage(err))
      setRefreshPhase('idle')
      scheduleNextRefresh()
    } finally {
      refreshingRef.current = false
      if (!silent) setBusy('')
    }
  }
  async function loadEvidence(fundId: string) {
    try { setEvidence(await requestJson<Evidence>(`/api/funds/${fundId}/evidence`)) } catch { setEvidence(null) }
  }
  async function loadAnalysisHistory(fundId: string) {
    try { setAnalysisHistory(await requestJson<AnalysisHistory>(`/api/funds/${fundId}/analysis-history`)) } catch { setAnalysisHistory(null) }
  }
  async function markAdviceExecuted(adviceId: string) {
    if (!selectedFundId) return
    setBusy('mark advice')
    setError('')
    setNotice('正在记录执行...')
    try {
      await requestJson<{ ok: boolean }>(`/api/advice/${adviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'executed' }),
      })
      await loadAnalysisHistory(selectedFundId)
      setNotice('已记录执行，后续会按最新净值自动验证')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }
  function applyDashboard(next: DashboardData) {
    setData(next)
    setDrafts(Object.fromEntries(next.funds.map((fund) => [fund.id, { ...fund }])))
    setSelectedFundId((current) => current && next.funds.some((fund) => fund.id === current) ? current : next.funds[0]?.id || '')
  }
  function markSynced() {
    setRefreshPhase('synced')
    scheduleNextRefresh()
    window.setTimeout(() => setRefreshPhase((phase) => phase === 'synced' ? 'idle' : phase), 1200)
  }
  function scheduleNextRefresh() { setNextRefreshAt(Date.now() + refreshMs) }
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
      setNotice('基金已导入')
      await refreshData(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }
  async function saveAll() {
    setBusy('保存持仓')
    try {
      const fundsPayload = Object.values(drafts).map((fund) => ({ ...fund, tags: fund.tags.join('、') }))
      applyDashboard(await requestJson<DashboardData>('/api/funds/bulk', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funds: fundsPayload }),
      }))
      setIsEditing(false)
      setNotice('持仓已保存')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }
  async function uploadScreenshot(file?: File) {
    if (!file) return
    setBusy('上传截图')
    try {
      const body = new FormData()
      body.append('image', file)
      await requestJson('/api/ocr/position-screenshot', { method: 'POST', body })
      setNotice('截图已上传')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy('')
    }
  }
  function patchFund(fundId: string, field: 'shares' | 'cost', value: string) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return
    setDrafts((current) => ({ ...current, [fundId]: { ...current[fundId], [field]: numeric } }))
  }
  function changeSort(key: SortKey) {
    setSort((current) => current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'desc' })
  }

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950">
      <TopBar
        tradeDate={data?.tradeDate}
        currentTime={currentTime}
        refreshLabel={refreshLabel}
        isRefreshing={refreshPhase === 'refreshing'}
        showSynced={refreshPhase === 'synced'}
        newsItems={data?.fastNews ?? []}
        onNewsClick={setSelectedNews}
      />
      <main className="mx-auto max-w-[1540px] px-3 py-3">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(860px,980px)_520px]">
          <div className="space-y-3">
            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_340px]">
              <SummaryCards totalValue={totalValue} dayProfit={dayProfit} totalProfit={totalProfit} equityPosition={equityPosition} fundCount={funds.length} />
              <CommandBar busy={Boolean(busy)} newCode={newCode} onNewCodeChange={setNewCode} onAddFund={() => void addFund()} onRefresh={() => void refreshData(false)} onUpload={() => fileInputRef.current?.click()} />
            </div>
            <MarketStrip markets={data?.markets ?? []} />
            <input ref={fileInputRef} hidden type="file" accept="image/*" onChange={(event) => void uploadScreenshot(event.target.files?.[0])} />
            <HoldingsTable
              funds={visibleFunds}
              drafts={drafts}
              selectedFundId={selectedFund?.id}
              query={query}
              sort={sort}
              isEditing={isEditing}
              busy={Boolean(busy)}
              evidence={evidence}
              analysisHistory={analysisHistory}
              detailTab={detailTab}
              expandedFundId={expandedFundId}
              onQueryChange={setQuery}
              onSort={changeSort}
              onSelect={setSelectedFundId}
              onTabChange={setDetailTab}
              onToggleExpand={(fundId) => {
                setSelectedFundId(fundId)
                setExpandedFundId((current) => current === fundId ? '' : fundId)
              }}
              onToggleEdit={() => setIsEditing((value) => !value)}
              onSave={() => void saveAll()}
              onPatch={patchFund}
              onVerifyAdvice={(adviceId) => void markAdviceExecuted(adviceId)}
            />
          </div>
          <ResearchPanel fund={selectedFund} evidence={evidence} onOpenModelSettings={() => setShowModelSettings(true)} />
        </div>
      </main>
      <div className="fixed right-4 top-16 z-50 grid w-[min(420px,calc(100vw-24px))] gap-3">
        {error ? <Toast tone="error" text={error} onClose={() => setError('')} /> : null}
        {notice ? <Toast tone="success" text={notice} onClose={() => setNotice('')} /> : null}
      </div>
      {selectedNews ? <NewsDialog item={selectedNews} onClose={() => setSelectedNews(null)} /> : null}
      {showModelSettings ? <ModelSettingsDialog onClose={() => setShowModelSettings(false)} /> : null}
    </div>
  )
}

function TopBar({ tradeDate, currentTime, refreshLabel, isRefreshing, showSynced, newsItems, onNewsClick }: {
  tradeDate?: string
  currentTime: string
  refreshLabel: string
  isRefreshing: boolean
  showSynced: boolean
  newsItems: NewsItem[]
  onNewsClick: (item: NewsItem) => void
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1540px] items-center px-3 py-2.5">
        <div className="flex flex-none items-center gap-4">
          <h1 className="text-base font-semibold text-zinc-950">基金估值</h1>
          <span className="text-sm tabular-nums text-zinc-500">{tradeDate ?? '--'}</span>
          <div className="flex items-center gap-2 whitespace-nowrap">
            <span className="w-[78px] text-right text-sm font-semibold tabular-nums text-blue-600">{currentTime || '--:--:--'}</span>
            <span className={`inline-flex w-[78px] items-center justify-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-all ${isRefreshing ? 'bg-blue-100 text-blue-600 shadow-[0_0_0_4px_rgba(59,130,246,0.08)]' : 'bg-zinc-100 text-zinc-500'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isRefreshing ? 'animate-pulse bg-blue-500' : 'bg-zinc-400'}`} />
              {refreshLabel}
            </span>
            <span className={`inline-flex w-[76px] items-center justify-center gap-1 text-xs font-semibold text-emerald-600 transition-opacity ${showSynced ? 'opacity-100' : 'opacity-0'}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              已同步
            </span>
          </div>
        </div>
        <div className="ml-6 min-w-0 flex-1 overflow-hidden">
          {newsItems.length ? (
            <div className="flex animate-marquee whitespace-nowrap">
              {[...newsItems, ...newsItems].map((item, index) => (
                <button key={`${item.id}-${index}`} className="mr-7 inline-flex items-center gap-3 text-xs text-zinc-500 transition-colors hover:text-zinc-900" onClick={() => onNewsClick(item)}>
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-300" />
                  <span className="text-zinc-400">{item.time.slice(11, 16)}</span>
                  <span className="text-zinc-600">{item.title}</span>
                </button>
              ))}
            </div>
          ) : <span className="text-xs text-zinc-400">暂无滚动资讯</span>}
        </div>
      </div>
    </header>
  )
}

function SummaryCards({ totalValue, dayProfit, totalProfit, equityPosition, fundCount }: {
  totalValue: number
  dayProfit: number
  totalProfit: number
  equityPosition: number
  fundCount: number
}) {
  return (
    <section className="grid grid-cols-2 gap-2 lg:grid-cols-[1.45fr_1fr_1fr_0.9fr]">
      <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm">
        <div className="text-sm font-medium text-zinc-500">组合资产</div>
        <div className="mt-0.5 text-[1.65rem] font-bold leading-8 tabular-nums text-zinc-950">{money.format(totalValue)}</div>
        <div className="mt-1.5 flex gap-4 whitespace-nowrap text-xs">
          <span>今日 <b className={dayProfit >= 0 ? 'text-red-500' : 'text-emerald-500'}>{formatMoney(dayProfit)}</b></span>
          <span>累计 <b className={totalProfit >= 0 ? 'text-red-500' : 'text-emerald-500'}>{formatMoney(totalProfit)}</b></span>
        </div>
      </div>
      <Metric title="今日收益" value={formatMoney(dayProfit)} tone={dayProfit >= 0 ? 'up' : 'down'} />
      <Metric title="权益仓位" value={`${number.format(equityPosition)}%`} />
      <Metric title="持仓基金" value={`${fundCount} 只`} />
    </section>
  )
}

function Metric({ title, value, tone }: { title: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex min-h-[76px] flex-col justify-center rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm">
      <div className="whitespace-nowrap text-sm font-medium text-zinc-500">{title}</div>
      <div className={`mt-1 whitespace-nowrap text-xl font-bold tabular-nums ${tone === 'up' ? 'text-red-500' : tone === 'down' ? 'text-emerald-600' : 'text-zinc-950'}`}>{value}</div>
    </div>
  )
}

function MarketStrip({ markets }: { markets: Market[] }) {
  return (
    <section className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {markets.slice(0, 8).map((market) => (
        <div key={market.code} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm">
          <span className="font-medium text-zinc-600">{market.name}</span>
          <span className="ml-auto mr-3 font-semibold tabular-nums text-zinc-900">{number.format(market.value)}</span>
          <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${market.change >= 0 ? 'bg-red-50 text-red-500' : 'bg-emerald-50 text-emerald-600'}`}>{formatPct(market.change)}</span>
        </div>
      ))}
    </section>
  )
}

function CommandBar({ busy, newCode, onNewCodeChange, onAddFund, onRefresh, onUpload }: {
  busy: boolean
  newCode: string
  onNewCodeChange: (value: string) => void
  onAddFund: () => void
  onRefresh: () => void
  onUpload: () => void
}) {
  return (
    <section className="h-full rounded-lg border border-zinc-200 bg-white p-2 shadow-sm">
      <div className="grid h-full grid-cols-3 content-between gap-2">
        <label className="col-span-3 flex h-9 w-full items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3">
          <Search className="h-4 w-4 shrink-0 text-zinc-400" />
          <input className="w-full bg-transparent text-sm outline-none" value={newCode} onChange={(event) => onNewCodeChange(event.target.value)} placeholder="输入 6 位基金代码，例如 110022" />
        </label>
        <button className="h-10 whitespace-nowrap rounded-lg bg-blue-600 px-3 text-sm font-semibold text-white disabled:opacity-50" onClick={onAddFund} disabled={busy}>导入基金</button>
        <button className="inline-flex h-10 items-center justify-center gap-1 rounded-lg border border-zinc-200 px-2 text-sm font-semibold whitespace-nowrap" onClick={onRefresh} disabled={busy}><RefreshCw className="h-3.5 w-3.5 shrink-0" />刷新估值</button>
        <button className="inline-flex h-10 items-center justify-center gap-1 rounded-lg border border-zinc-200 px-2 text-sm font-semibold whitespace-nowrap" onClick={onUpload} disabled={busy}><Upload className="h-3.5 w-3.5 shrink-0" />上传截图</button>
      </div>
    </section>
  )
}

function HoldingsTable({ funds, drafts, selectedFundId, query, sort, isEditing, busy, evidence, analysisHistory, detailTab, expandedFundId, onQueryChange, onSort, onSelect, onTabChange, onToggleExpand, onToggleEdit, onSave, onPatch, onVerifyAdvice }: {
  funds: Fund[]
  drafts: Record<string, Fund>
  selectedFundId?: string
  query: string
  sort: { key: SortKey; direction: 'asc' | 'desc' }
  isEditing: boolean
  busy: boolean
  evidence: Evidence | null
  analysisHistory: AnalysisHistory | null
  detailTab: DetailTab
  expandedFundId: string
  onQueryChange: (value: string) => void
  onSort: (key: SortKey) => void
  onSelect: (id: string) => void
  onTabChange: (tab: DetailTab) => void
  onToggleExpand: (id: string) => void
  onToggleEdit: () => void
  onSave: () => void
  onPatch: (fundId: string, field: 'shares' | 'cost', value: string) => void
  onVerifyAdvice: (adviceId: string) => void
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Holdings</div>
          <h2 className="text-lg font-semibold text-zinc-950">持仓估值</h2>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex h-9 w-56 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3">
            <Search className="h-4 w-4 text-zinc-400" />
            <input className="w-full bg-transparent outline-none" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索基金" />
          </label>
          <button className="h-9 rounded-lg border border-zinc-200 bg-white px-3 font-semibold" onClick={onToggleEdit}>{isEditing ? '退出编辑' : '编辑持仓'}</button>
          <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 font-semibold text-blue-700 disabled:opacity-50" onClick={onSave} disabled={!isEditing || busy}><Save className="h-4 w-4" />保存</button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <div className="grid min-w-[900px] grid-cols-[minmax(220px,1fr)_82px_86px_86px_110px_110px_110px_40px] border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-semibold text-zinc-500">
          <SortButton label="基金" sortKey="name" current={sort} onSort={onSort} />
          <SortButton label="估值" sortKey="estimateChange" current={sort} onSort={onSort} alignRight />
          <SortButton label="份额" sortKey="shares" current={sort} onSort={onSort} alignRight />
          <SortButton label="成本" sortKey="cost" current={sort} onSort={onSort} alignRight />
          <SortButton label="市值" sortKey="value" current={sort} onSort={onSort} alignRight />
          <SortButton label="今日盈亏" sortKey="todayProfit" current={sort} onSort={onSort} alignRight />
          <SortButton label="累计盈亏" sortKey="profit" current={sort} onSort={onSort} alignRight />
          <span />
        </div>
        {funds.map((fund) => {
          const draft = drafts[fund.id] ?? fund
          const today = todayProfitValue(draft)
          const profit = (draft.nav - draft.cost) * draft.shares
          const expanded = expandedFundId === fund.id
          return (
            <div key={fund.id} className={`grid min-w-[900px] cursor-pointer grid-cols-[minmax(220px,1fr)_82px_86px_86px_110px_110px_110px_40px] items-center border-b border-zinc-100 px-3 py-2.5 last:border-b-0 ${selectedFundId === fund.id ? 'bg-blue-50/60' : 'hover:bg-zinc-50'}`} onClick={() => onSelect(fund.id)}>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-zinc-950" title={fund.name}>{fund.name}</div>
                  <div className="mt-1 truncate text-xs text-zinc-500">{fund.code}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums text-zinc-950">{draft.nav.toFixed(4)}</div>
                  <div className={draft.estimateMissing ? 'text-zinc-400' : draft.estimateChange >= 0 ? 'text-red-500' : 'text-emerald-600'}>{draft.estimateMissing ? '0%' : formatPct(draft.estimateChange)}</div>
                </div>
              <EditableNumber disabled={!isEditing} value={draft.shares} onChange={(value) => onPatch(fund.id, 'shares', value)} />
              <EditableNumber disabled={!isEditing} value={draft.cost} onChange={(value) => onPatch(fund.id, 'cost', value)} />
              <div className="text-right font-semibold tabular-nums text-zinc-900">{money.format(currentValue(draft))}</div>
              <div className={`text-right font-semibold tabular-nums ${today >= 0 ? 'text-red-500' : 'text-emerald-600'}`}>{formatMoney(today)}</div>
              <div className={`text-right font-semibold tabular-nums ${profit >= 0 ? 'text-red-500' : 'text-emerald-600'}`}>{formatMoney(profit)}</div>
              <button className="ml-auto inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900" onClick={(event) => { event.stopPropagation(); onToggleExpand(fund.id) }} aria-label={expanded ? '收起基金详情' : '展开基金详情'}>
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {expanded ? <FundInlineDetail evidence={selectedFundId === fund.id ? evidence : null} analysisHistory={selectedFundId === fund.id ? analysisHistory : null} activeTab={detailTab} onTabChange={onTabChange} onVerifyAdvice={onVerifyAdvice} /> : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function FundInlineDetail({ evidence, analysisHistory, activeTab, onTabChange, onVerifyAdvice }: {
  evidence: Evidence | null
  analysisHistory: AnalysisHistory | null
  activeTab: DetailTab
  onTabChange: (tab: DetailTab) => void
  onVerifyAdvice: (adviceId: string) => void
}) {
  return (
    <div className="col-span-full mt-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm" onClick={(event) => event.stopPropagation()}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Fund detail</div>
          <div className="text-sm font-semibold text-zinc-950">基金详情</div>
        </div>
        <div className="grid w-[min(360px,100%)] grid-cols-2 rounded-lg border border-zinc-200 bg-zinc-50 p-1">
          {([
            ['evidence', '证据'],
            ['news', '资讯'],
          ] as const).map(([tab, label]) => (
            <button key={tab} className={`h-8 rounded-md text-sm font-semibold transition-colors ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-zinc-500 hover:text-zinc-900'}`} onClick={() => onTabChange(tab)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-lg bg-zinc-50/70 p-3">
        {activeTab === 'evidence' ? <EvidenceOverview evidence={evidence} analysisHistory={analysisHistory} onVerifyAdvice={onVerifyAdvice} /> : null}
        {activeTab === 'news' ? <NewsTab evidence={evidence} /> : null}
      </div>
    </div>
  )
}

function EvidenceOverview({ evidence, analysisHistory, onVerifyAdvice }: { evidence: Evidence | null; analysisHistory: AnalysisHistory | null; onVerifyAdvice: (adviceId: string) => void }) {
  const sectors = evidence?.exposure?.sectors ?? []
  const stocks = evidence?.exposure?.stocks ?? []
  const sources = evidence?.sourceStatus ?? []
  const latestHistory = analysisHistory?.history?.slice(0, 3) ?? []
  const verifiedHistory = (analysisHistory?.history ?? []).filter((item) => item.actualReturnPct != null).slice(0, 4)
  return (
    <section className="grid gap-3 xl:grid-cols-[1.05fr_1fr]">
      <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-200">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-950">建议验证</h3>
          <span className="text-xs text-zinc-400">{analysisHistory?.accuracy.totalExecuted ?? 0} 次已执行</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <MiniStat label="命中" value={`${analysisHistory?.accuracy.winCount ?? 0}`} />
          <MiniStat label="胜率" value={`${analysisHistory?.accuracy.winRate ?? 0}%`} />
          <MiniStat label="均值" value={formatPct(analysisHistory?.accuracy.avgReturnPct ?? 0)} tone={(analysisHistory?.accuracy.avgReturnPct ?? 0) >= 0 ? 'up' : 'down'} />
        </div>
        {verifiedHistory.length ? (
          <div className="mt-2 space-y-1.5">
            {verifiedHistory.map((item) => (
              <div key={item.id} className="grid grid-cols-[78px_1fr_62px] items-center gap-2 rounded-lg bg-zinc-50 px-2 py-1.5 text-xs">
                <span className="tabular-nums text-zinc-400">{item.tradeDate}</span>
                <span className="truncate font-medium text-zinc-700">{item.action || item.recommendation?.confidence || '观察'}</span>
                <span className={`text-right font-bold tabular-nums ${(item.actualReturnPct ?? 0) >= 0 ? 'text-red-500' : 'text-emerald-600'}`}>{formatPct(item.actualReturnPct ?? 0)}</span>
              </div>
            ))}
          </div>
        ) : <div className="mt-2"><EmptyText text="暂无已执行建议，点击历史研究里的标记执行后会形成验证记录。" /></div>}
      </div>
      <div className="space-y-3">
        <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-200">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-950">历史研究</h3>
            <span className="text-xs text-zinc-400">{analysisHistory?.totalReports ?? 0} 次</span>
          </div>
          {analysisHistory?.totalReports ? (
            <div className="space-y-2">
              {latestHistory.map((item) => (
                <article key={item.id} className="rounded-lg bg-zinc-50 px-3 py-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs tabular-nums text-zinc-400">{item.tradeDate}</span>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${agentToneClass(item.level as AgentInsight['level'])}`}>{agentLevelLabel(item.level as AgentInsight['level'])}</span>
                      {item.status === 'executed' ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-600">已执行</span>
                      ) : (
                        <button className="rounded-full border border-blue-200 bg-white px-2 py-0.5 text-xs font-semibold text-blue-600 hover:bg-blue-50" onClick={() => onVerifyAdvice(item.id)}>标记执行</button>
                      )}
                    </div>
                  </div>
                  <p className="line-clamp-2 text-sm leading-5 text-zinc-700">{item.conclusion}</p>
                </article>
              ))}
            </div>
          ) : <EmptyText text="暂无历史研究记录。" />}
        </div>
        <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-200">
          <h3 className="mb-2 text-sm font-semibold text-zinc-950">数据源</h3>
          {sources.length ? (
            <div className="grid grid-cols-2 gap-2">
              {sources.map((source) => (
                <div key={source.source} className="rounded-lg bg-zinc-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-zinc-700">{sourceLabel(source.source)}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${source.ok ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>{source.ok ? '正常' : '异常'}</span>
                  </div>
                  <div className="mt-1 text-xs tabular-nums text-zinc-400">{source.count} 条</div>
                </div>
              ))}
            </div>
          ) : <EmptyText text="暂无数据源状态。" />}
        </div>
      </div>
      <div className="space-y-3">
        <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-200">
          <h3 className="mb-2 text-sm font-semibold text-zinc-950">持仓穿透</h3>
          <div className="space-y-1.5">
            {sectors.slice(0, 5).map((sector) => (
              <div key={sector.name} className="grid grid-cols-[1fr_52px_64px] items-center gap-2 rounded-lg bg-zinc-50 px-2 py-1.5 text-xs">
                <span className="truncate font-medium text-zinc-700">{sector.name}</span>
                <span className="text-right tabular-nums text-zinc-500">{sector.weight.toFixed(0)}%</span>
                <span className={`text-right font-semibold tabular-nums ${sector.avgChange >= 0 ? 'text-red-500' : 'text-emerald-600'}`}>{formatPct(sector.avgChange)}</span>
              </div>
            ))}
            {!sectors.length ? <EmptyText text="暂无板块穿透数据。" /> : null}
          </div>
        </div>
        <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-200">
          <h3 className="mb-2 text-sm font-semibold text-zinc-950">重仓股</h3>
          <div className="flex flex-wrap gap-1.5">
            {stocks.slice(0, 10).map((stock) => (
              <span key={stock.code} className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs">{stock.name} <b className={stock.changePercent >= 0 ? 'text-red-500' : 'text-emerald-600'}>{formatPct(stock.changePercent)}</b></span>
            ))}
            {!stocks.length ? <EmptyText text="暂无重仓股数据。" /> : null}
          </div>
        </div>
      </div>
    </section>
  )
}

function NewsTab({ evidence }: { evidence: Evidence | null }) {
  const news = evidence?.fastNews?.items ?? []
  const announcements = evidence?.announcements?.items ?? []
  return (
    <section className="space-y-4">
      <div>
        <PanelTitle title="基金快讯" />
        <div className="space-y-2">
          {news.slice(0, 5).map((item) => (
            <article key={item.id} className="rounded-lg bg-zinc-50 px-3 py-2">
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-xs tabular-nums text-zinc-400">{item.time?.slice(11, 16) || '--:--'}</span>
                <span className="text-sm leading-5 text-zinc-700">{item.title}</span>
              </div>
              {item.summary ? <p className="mt-1 pl-10 text-xs leading-5 text-zinc-500">{item.summary}</p> : null}
            </article>
          ))}
          {!news.length ? <EmptyText text="暂无相关基金快讯。" /> : null}
        </div>
      </div>
      <div>
        <PanelTitle title="公告" />
        <div className="space-y-2">
          {announcements.slice(0, 4).map((item) => (
            <a key={item.id} href={item.url} target="_blank" rel="noreferrer" className="block rounded-lg bg-zinc-50 px-3 py-2 hover:bg-zinc-100">
              <div className="flex items-start gap-2">
                <span className="shrink-0 text-xs tabular-nums text-blue-500">{item.date}</span>
                <span className="shrink-0 text-xs text-zinc-400">{item.category}</span>
                <span className="text-sm leading-5 text-zinc-700">{item.title}</span>
              </div>
            </a>
          ))}
          {!announcements.length ? <EmptyText text="暂无基金公告。" /> : null}
        </div>
      </div>
    </section>
  )
}

function ResearchPanel({ fund, evidence, onOpenModelSettings }: { fund?: Fund; evidence: Evidence | null; onOpenModelSettings: () => void }) {
  if (!fund) return <aside className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"><div className="text-sm text-zinc-500">选择一只基金查看研究员分析。</div></aside>
  const agents = evidence?.agents ?? []
  const consensus = buildAgentConsensus(agents)
  return (
    <aside className="sticky top-[68px] max-h-[calc(100vh-84px)] overflow-auto rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Research Panel</div>
          <h2 className="mt-1 text-lg font-semibold text-zinc-950">研究员分析</h2>
        </div>
        <button className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-semibold text-zinc-600 hover:bg-zinc-50" onClick={onOpenModelSettings}>
          <Settings2 className="h-3.5 w-3.5" />
          模型设置
        </button>
      </div>
      <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50/60 p-3">
        <div className="text-xs font-semibold text-blue-700">{fund.code}</div>
        <div className="mt-1 font-semibold text-zinc-950">{fund.name}</div>
        <div className="mt-2 flex items-end justify-between">
          <span className="text-xs text-zinc-500">{fund.estimateTime || fund.estimateUpdatedAt || '--'}</span>
          <span className={`text-2xl font-bold tabular-nums ${fund.estimateChange >= 0 ? 'text-red-500' : 'text-emerald-600'}`}>{formatPct(fund.estimateChange)}</span>
        </div>
      </div>
      {agents.length ? <AgentConsensusCard consensus={consensus} /> : null}
      <PanelTitle title="研究员结论" />
      <div className="space-y-2">
        {agents.length ? agents.map((agent) => <AgentCard key={agent.id} agent={agent} />) : <EmptyText text="暂无研究员结论，等待证据链加载。" />}
      </div>
      <PanelTitle title="板块暴露" />
      <div className="space-y-1.5">
        {(evidence?.exposure?.sectors ?? []).slice(0, 5).map((sector) => (
          <div key={sector.name} className="grid grid-cols-[1fr_52px_64px] items-center gap-2 rounded-lg bg-zinc-50 px-2 py-1.5 text-xs">
            <span className="truncate font-medium text-zinc-700">{sector.name}</span>
            <span className="text-right tabular-nums text-zinc-500">{sector.weight.toFixed(0)}%</span>
            <span className={`text-right font-semibold tabular-nums ${sector.avgChange >= 0 ? 'text-red-500' : 'text-emerald-600'}`}>{formatPct(sector.avgChange)}</span>
          </div>
        ))}
        {!(evidence?.exposure?.sectors ?? []).length ? <EmptyText text="暂无板块穿透数据。" /> : null}
      </div>
      <PanelTitle title="重仓股" />
      <div className="flex flex-wrap gap-1.5">
        {(evidence?.exposure?.stocks ?? []).slice(0, 8).map((stock) => (
          <span key={stock.code} className="rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs">{stock.name} <b className={stock.changePercent >= 0 ? 'text-red-500' : 'text-emerald-600'}>{formatPct(stock.changePercent)}</b></span>
        ))}
        {!(evidence?.exposure?.stocks ?? []).length ? <EmptyText text="暂无重仓股数据。" /> : null}
      </div>
    </aside>
  )
}

function AgentConsensusCard({ consensus }: { consensus: ReturnType<typeof buildAgentConsensus> }) {
  return (
    <div className={`mb-3 rounded-xl border p-3 ${agentEmphasisClass(consensus.level).surface} ${agentEmphasisClass(consensus.level).border}`}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Consensus</div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${agentToneClass(consensus.level)}`}>{agentLevelLabel(consensus.level)}</span>
      </div>
      <div className="mt-2 text-sm font-semibold text-zinc-950">{consensus.action}</div>
      <p className="mt-1 text-xs leading-5 text-zinc-700">{consensus.summary}</p>
      <div className="mt-2 grid grid-cols-4 gap-1 text-center text-xs">
        <MiniStat label="偏强" value={`${consensus.positive}`} />
        <MiniStat label="偏弱" value={`${consensus.negative}`} />
        <MiniStat label="关注" value={`${consensus.watch}`} />
        <MiniStat label="高确信" value={`${consensus.highConfidence}`} />
      </div>
    </div>
  )
}

function AgentCard({ agent }: { agent: AgentInsight }) {
  const recommendation = agent.recommendation
  const emphasis = agentEmphasisClass(agent.level)
  const actionTone = actionToneClass(recommendation?.action)
  return (
    <article className={`rounded-xl border p-3 ${emphasis.border} ${emphasis.surface}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${emphasis.dot}`} />
            <strong className="text-sm text-zinc-950">{agent.title}</strong>
          </div>
          <div className="mt-1 text-xs text-zinc-500">{agentRoleLabel(agent.id)}</div>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${agentToneClass(agent.level)}`}>{agentLevelLabel(agent.level)}</span>
      </div>
      <p className="mt-3 text-sm font-medium leading-5 text-zinc-900">{agent.conclusion}</p>
      {recommendation ? (
        <div className={`mt-3 rounded-lg border px-3 py-2 ${actionTone.box}`}>
          <div className="flex items-center justify-between gap-2">
            <span className={`text-sm font-bold ${actionTone.text}`}>{recommendation.action || '观察'}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${confidenceToneClass(recommendation.confidence)}`}>{recommendation.confidence || '低'}确信</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <MiniStat label="目标仓位" value={recommendation.targetPositionRatio != null ? `${recommendation.targetPositionRatio}%` : '未触发'} />
            <MiniStat label="止损净值" value={recommendation.stopLossNav != null ? recommendation.stopLossNav.toFixed(4) : '未触发'} />
          </div>
        </div>
      ) : null}
      {agent.thinking ? (
        <div className="mt-3 rounded-lg bg-white/65 px-3 py-2">
          <div className="text-xs font-semibold text-zinc-500">推理路径</div>
          <p className="mt-1 text-xs leading-5 text-zinc-700">{agent.thinking}</p>
        </div>
      ) : null}
      {agent.evidence.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {agent.evidence.slice(0, 5).map((item) => <span key={item} className="rounded-full border border-zinc-200 bg-white/75 px-2 py-0.5 text-xs font-medium text-zinc-700">{item}</span>)}
        </div>
      ) : null}
    </article>
  )
}

function ModelSettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<LlmSettings | null>(null)
  const [draft, setDraft] = useState({ provider: 'openai-compatible', name: '', baseUrl: '', models: '', selectedModel: '', apiKey: '' })
  const [message, setMessage] = useState('')
  useEffect(() => { void load() }, [])
  async function load() {
    try { setSettings(await requestJson<LlmSettings>('/api/settings/llm')) } catch (err) { setMessage(errorMessage(err)) }
  }
  async function saveProvider() {
    try {
      await requestJson('/api/settings/llm/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, models: draft.models.split(',').map((item) => item.trim()).filter(Boolean) }),
      })
      setDraft({ provider: 'openai-compatible', name: '', baseUrl: '', models: '', selectedModel: '', apiKey: '' })
      setMessage('模型配置已保存，并设为当前研究员模型。')
      await load()
    } catch (err) {
      setMessage(errorMessage(err))
    }
  }
  async function activate(id: string) {
    try {
      await requestJson('/api/settings/llm/active', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: id }) })
      await load()
    } catch (err) {
      setMessage(errorMessage(err))
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/30 p-4">
      <section className="w-[min(880px,100%)] rounded-2xl bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">LLM Settings</div>
            <h2 className="mt-1 text-xl font-bold text-zinc-950">研究员模型配置</h2>
            <p className="mt-1 text-sm text-zinc-500">可添加 OpenAI 兼容、Anthropic 或自建网关模型。密钥只保存在本地配置文件。</p>
          </div>
          <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-semibold" onClick={onClose}>关闭</button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
          <div className="rounded-xl border border-zinc-200 p-3">
            <h3 className="mb-3 font-semibold">已配置模型</h3>
            <div className="space-y-2">
              {(settings?.providers ?? []).map((provider) => (
                <button key={provider.id} className={`w-full rounded-lg border px-3 py-2 text-left ${settings?.activeProviderId === provider.id ? 'border-blue-300 bg-blue-50' : 'border-zinc-200 bg-zinc-50'}`} onClick={() => void activate(provider.id)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{provider.name}</span>
                    <span className="text-xs text-zinc-500">{settings?.activeProviderId === provider.id ? '当前' : '设为当前'}</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">{provider.selectedModel || provider.models[0] || '--'} · {provider.apiKeyPreview || '未填 key'}</div>
                </button>
              ))}
              {!(settings?.providers ?? []).length ? <EmptyText text="还没有配置模型。保存右侧配置后，研究员会使用它生成结论。" /> : null}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 p-3">
            <h3 className="mb-3 font-semibold">添加模型</h3>
            <div className="grid gap-2">
              <select className="h-9 rounded-lg border border-zinc-200 px-3 text-sm outline-none" value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })}>
                <option value="openai-compatible">OpenAI 兼容接口</option>
                <option value="anthropic">Anthropic</option>
              </select>
              <input className="h-9 rounded-lg border border-zinc-200 px-3 text-sm outline-none" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="显示名称，例如 DeepSeek / OpenAI / Claude" />
              <input className="h-9 rounded-lg border border-zinc-200 px-3 text-sm outline-none" value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="Base URL，例如 https://api.openai.com/v1" />
              <input className="h-9 rounded-lg border border-zinc-200 px-3 text-sm outline-none" value={draft.models} onChange={(event) => setDraft({ ...draft, models: event.target.value })} placeholder="模型列表，用逗号分隔" />
              <input className="h-9 rounded-lg border border-zinc-200 px-3 text-sm outline-none" value={draft.selectedModel} onChange={(event) => setDraft({ ...draft, selectedModel: event.target.value })} placeholder="默认模型" />
              <input className="h-9 rounded-lg border border-zinc-200 px-3 text-sm outline-none" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="API Key，仅保存在本地" type="password" />
              <button className="mt-1 h-10 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white" onClick={() => void saveProvider()}>保存模型</button>
              {message ? <div className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600">{message}</div> : null}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function NewsDialog({ item, onClose }: { item: NewsItem; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/20 px-4 pt-24">
      <article className="w-[min(640px,100%)] rounded-2xl bg-white p-5 shadow-2xl">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs tabular-nums text-zinc-400">{item.time || '--'}</div>
            <h2 className="mt-1 text-lg font-bold leading-6 text-zinc-950">{item.title}</h2>
          </div>
          <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-semibold" onClick={onClose}>关闭</button>
        </div>
        <p className="text-sm leading-6 text-zinc-600">{item.summary || item.title}</p>
      </article>
    </div>
  )
}

function Toast({ tone, text, onClose }: { tone: 'error' | 'success'; text: string; onClose: () => void }) {
  const isError = tone === 'error'
  return (
    <div className={`relative overflow-hidden rounded-xl border bg-white p-4 shadow-2xl ring-1 ${isError ? 'border-red-200 ring-red-100' : 'border-emerald-200 ring-emerald-100'}`}>
      <div className={`absolute inset-y-0 left-0 w-1.5 ${isError ? 'bg-red-500' : 'bg-emerald-500'}`} />
      <div className="flex items-start gap-3 pl-1">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${isError ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
          {isError ? <AlertCircle className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-bold ${isError ? 'text-red-700' : 'text-emerald-700'}`}>{isError ? '操作失败' : '操作成功'}</div>
          <div className="mt-1 text-sm leading-5 text-zinc-700">{text}</div>
        </div>
        <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700" onClick={onClose} aria-label="关闭提示">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-3 py-2">
      <div className="text-xs text-zinc-400">{label}</div>
      <div className={`mt-0.5 text-sm font-bold tabular-nums ${tone === 'up' ? 'text-red-500' : tone === 'down' ? 'text-emerald-600' : 'text-zinc-950'}`}>{value}</div>
    </div>
  )
}
function PanelTitle({ title }: { title: string }) { return <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-zinc-400 first:mt-0">{title}</h3> }
function EmptyText({ text }: { text: string }) { return <div className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-400">{text}</div> }
function SortButton({ label, sortKey, current, onSort, alignRight = false }: { label: string; sortKey: SortKey; current: { key: SortKey; direction: 'asc' | 'desc' }; onSort: (key: SortKey) => void; alignRight?: boolean }) {
  return (
    <button className={`inline-flex items-center gap-1 ${alignRight ? 'justify-end text-right' : ''} ${current.key === sortKey ? 'text-blue-600' : ''}`} onClick={() => onSort(sortKey)}>
      {label}<ArrowUpDown className={`h-3.5 w-3.5 ${current.key === sortKey && current.direction === 'desc' ? 'rotate-180' : ''}`} />
    </button>
  )
}
function EditableNumber({ disabled, value, onChange }: { disabled: boolean; value: number; onChange: (value: string) => void }) {
  return <input className="h-8 w-full rounded border border-transparent bg-transparent px-2 text-right font-semibold tabular-nums text-zinc-900 outline-none enabled:border-zinc-200 enabled:bg-white enabled:focus:border-blue-400" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />
}
function compareFunds(left: Fund, right: Fund, key: SortKey) {
  if (key === 'name') return left.name.localeCompare(right.name, 'zh-CN')
  return sortValue(left, key) - sortValue(right, key)
}
function sortValue(fund: Fund, key: Exclude<SortKey, 'name'>) {
  if (key === 'estimateChange') return fund.estimateChange
  if (key === 'shares') return fund.shares
  if (key === 'cost') return fund.cost
  if (key === 'value') return currentValue(fund)
  if (key === 'todayProfit') return todayProfitValue(fund)
  return (fund.nav - fund.cost) * fund.shares
}
function currentValue(fund: Fund) { return fund.nav * fund.shares }
function todayProfitValue(fund: Fund) { return fund.estimateMissing ? 0 : currentValue(fund) * fund.estimateChange / 100 }
function formatMoney(value: number) { return `${value >= 0 ? '+' : ''}${money.format(value)}` }
function formatPct(value: number) { return `${value >= 0 ? '+' : ''}${number.format(value)}%` }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作失败' }
function agentLevelLabel(level: AgentInsight['level']) { return level === 'positive' ? '偏强' : level === 'negative' ? '偏弱' : level === 'watch' ? '关注' : '正常' }
function agentRoleLabel(id: string) {
  const labels: Record<string, string> = {
    market: '指数、宽度、市场情绪',
    sector: '行业暴露、重仓、资金流',
    risk: '仓位、回撤、波动、止损',
    news: '快讯、公告、事件风险',
    trade: '交易纪律、执行条件、复盘',
  }
  return labels[id] ?? '证据链研究'
}
function buildAgentConsensus(agents: AgentInsight[]) {
  const positive = agents.filter((agent) => agent.level === 'positive').length
  const negative = agents.filter((agent) => agent.level === 'negative').length
  const watch = agents.filter((agent) => agent.level === 'watch').length
  const highConfidence = agents.filter((agent) => agent.recommendation?.confidence === '高').length
  const tradeAgent = agents.find((agent) => agent.id === 'trade')
  const action = tradeAgent?.recommendation?.action || mostCommon(agents.map((agent) => agent.recommendation?.action).filter((value): value is string => Boolean(value))) || '观察'
  const level: AgentInsight['level'] = negative > positive ? 'negative' : watch >= 2 ? 'watch' : positive > negative ? 'positive' : 'neutral'
  const conditions = agents.flatMap((agent) => agent.recommendation?.conditions ?? []).filter(Boolean).slice(0, 3)
  const summary = tradeAgent?.conclusion || (level === 'positive' ? '多数研究员偏积极，继续持有但保留仓位纪律。' : level === 'negative' ? '偏弱信号更多，优先控制回撤和仓位。' : level === 'watch' ? '观察信号较多，等待触发条件确认。' : '研究员意见中性，按原计划复核。')
  return { positive, negative, watch, highConfidence, action, level, conditions, summary }
}
function mostCommon(values: string[]) {
  const counts = new Map<string, number>()
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1))
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}
function agentEmphasisClass(level: AgentInsight['level']) {
  if (level === 'positive') return { border: 'border-red-100', surface: 'bg-red-50/55', label: 'text-red-600', dot: 'bg-red-500' }
  if (level === 'negative') return { border: 'border-emerald-100', surface: 'bg-emerald-50/60', label: 'text-emerald-700', dot: 'bg-emerald-500' }
  if (level === 'watch') return { border: 'border-amber-100', surface: 'bg-amber-50/65', label: 'text-amber-700', dot: 'bg-amber-500' }
  return { border: 'border-zinc-200', surface: 'bg-zinc-50', label: 'text-zinc-500', dot: 'bg-zinc-400' }
}
function actionToneClass(action?: string) {
  if (action?.includes('减仓')) return { box: 'border-amber-200 bg-amber-50', text: 'text-amber-700' }
  if (action?.includes('补仓')) return { box: 'border-blue-200 bg-blue-50', text: 'text-blue-700' }
  if (action?.includes('观察')) return { box: 'border-zinc-200 bg-zinc-50', text: 'text-zinc-800' }
  return { box: 'border-red-100 bg-red-50', text: 'text-red-600' }
}
function confidenceToneClass(confidence: string) {
  if (confidence === '高') return 'bg-red-50 text-red-600'
  if (confidence === '中') return 'bg-blue-50 text-blue-600'
  return 'bg-zinc-100 text-zinc-500'
}
function agentToneClass(level: AgentInsight['level']) {
  if (level === 'positive') return 'bg-red-50 text-red-600'
  if (level === 'negative') return 'bg-emerald-50 text-emerald-600'
  if (level === 'watch') return 'bg-amber-50 text-amber-600'
  return 'bg-zinc-100 text-zinc-500'
}
function sourceLabel(source: string) {
  const labels: Record<string, string> = {
    'eastmoney-fund': '东方财富基金',
    'eastmoney-sector': '东方财富板块',
    'eastmoney-news': '东方财富快讯',
    'eastmoney-fund-news': '东方财富基金资讯',
    'eastmoney-announcement': '基金公告',
  }
  return labels[source] ?? source
}
async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message ?? `请求失败：${response.status}`)
  return response.json() as Promise<T>
}
