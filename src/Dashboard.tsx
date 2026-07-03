import { Activity, AlertTriangle, ArrowUpDown, CheckCircle2, Pencil, RefreshCw, Save, Search, Upload } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

type Fund = {
  id: string; code: string; name: string; type: string; cost: number; nav: number
  shares: number; estimateChange: number; positionRatio: number; tags: string[]
  estimateSource?: string; estimateTime?: string; estimateUpdatedAt?: string
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
type OcrHolding = { recognizedName: string; amount: number; holdingProfit: number | null; positionRatio: number | null; matchedFunds: { code: string; name: string; type: string; score: number }[] }
type OcrResult = { candidates: { holdings: OcrHolding[] } }
type SortKey = 'name' | 'estimateChange' | 'shares' | 'cost' | 'value' | 'todayProfit' | 'profit'

const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 })
const num = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
const refreshMs = 5000

function Dashboard() {
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
  const [isEditing, setIsEditing] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'value', direction: 'desc' })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refreshingRef = useRef(false)

  useEffect(() => { void loadDashboard(); const t = setInterval(() => void refreshData(true), refreshMs); return () => clearInterval(t) }, [])
  useEffect(() => { if (selectedFundId) void loadEvidence(selectedFundId) }, [selectedFundId])

  const funds = data?.funds ?? []
  const selectedFund = funds.find(f => f.id === selectedFundId) ?? funds[0]
  const vf = funds.map(f => drafts[f.id] ?? f)
  const totalValue = vf.reduce((s, f) => s + curVal(f), 0)
  const dayProfit = vf.reduce((s, f) => s + todayVal(f), 0)
  const totalProfit = vf.reduce((s, f) => s + (f.nav - f.cost) * f.shares, 0)
  const eqPos = vf.filter(f => !['债券','货币'].includes(f.type)).reduce((s, f) => s + f.positionRatio, 0)
  const riskLabel = eqPos >= 70 ? '仓位偏高' : eqPos >= 55 ? '谨慎观察' : '仓位适中'
  const riskCls = eqPos >= 70 ? 'bg-red-500' : eqPos >= 55 ? 'bg-amber-500' : 'bg-emerald-500'
  const upCount = (data?.markets ?? []).filter(m => m.change >= 0).length
  const visible = funds.filter(f => `${f.code}${f.name}${f.tags.join('')}`.includes(query.trim())).toSorted((a, b) => cmpFunds(drafts[a.id] ?? a, drafts[b.id] ?? b, sort.key))
  if (sort.direction === 'desc') visible.reverse()

  async function loadDashboard() {
    setBusy('加载中')
    try { apply(await req<DashboardData>('/api/dashboard')) }
    catch (e) { setError(errMsg(e)) }
    finally { setBusy('') }
  }

  async function refreshData(silent = false) {
    if (refreshingRef.current) return
    refreshingRef.current = true
    if (!silent) setBusy('刷新估值')
    try {
      apply(await req<DashboardData>('/api/data/refresh', { method: 'POST' }))
      if (!silent) setNotice('估值已刷新')
    } catch (e) { setError(errMsg(e)) }
    finally { refreshingRef.current = false; if (!silent) setBusy('') }
  }

  async function loadEvidence(id: string) {
    try { setEvidence(await req<Evidence>(`/api/funds/${id}/evidence`)) }
    catch { setEvidence(null) }
  }

  function apply(next: DashboardData) {
    setData(next)
    setDrafts(Object.fromEntries(next.funds.map(f => [f.id, { ...f }])))
    setSelectedFundId(c => c && next.funds.some(f => f.id === c) ? c : next.funds[0]?.id || '')
    setLastRefreshAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
  }

  async function addFund() {
    const code = newCode.trim()
    if (!/^\d{6}$/.test(code)) { setError('请输入6位基金代码'); return }
    setBusy('导入基金')
    try {
      apply(await req<DashboardData>('/api/funds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, shares: 0, cost: 1, positionRatio: 0 }),
      }))
      setNewCode('')
      await refreshData(true)
      setNotice('基金已导入')
    } catch (e) { setError(errMsg(e)) }
    finally { setBusy('') }
  }

  async function saveFund(id: string) {
    const d = drafts[id]; if (!d) return
    try {
      apply(await req<DashboardData>(`/api/funds/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...d, tags: d.tags.join('、') }),
      }))
      setNotice('持仓已保存')
    } catch (e) { setError(errMsg(e)) }
  }

  async function saveAll() {
    setBusy('保存持仓')
    try { for (const id of Object.keys(drafts)) await saveFund(id); setIsEditing(false); setNotice('持仓已保存') }
    finally { setBusy('') }
  }

  function chgSort(k: SortKey) {
    setSort(c => ({ key: k, direction: c.key === k && c.direction === 'desc' ? 'asc' : 'desc' }))
  }

  async function uploadScreenshot(file?: File) {
    if (!file) return
    setBusy('识别截图')
    try {
      const b = new FormData(); b.set('image', file)
      setOcrResult(await req<OcrResult>('/api/ocr/position-screenshot', { method: 'POST', body: b }))
    } catch (e) { setError(errMsg(e)) }
    finally { setBusy('') }
  }

  async function importOcr() {
    const hs = (ocrResult?.candidates.holdings ?? []).map(h => {
      const m = h.matchedFunds[0]
      return m ? { code: m.code, amount: h.amount, holdingProfit: h.holdingProfit, positionRatio: h.positionRatio } : null
    }).filter(Boolean)
    if (!hs.length) return
    setOcrResult(null); setBusy('导入识别结果')
    try {
      apply(await req<DashboardData>('/api/holdings/import-from-ocr', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: hs }),
      }))
      await refreshData(true)
      setNotice('截图持仓已导入')
    } catch (e) { setError(errMsg(e)) }
    finally { setBusy('') }
  }

  function patchFund(id: string, field: 'shares' | 'cost', value: string) {
    const n = Number(value)
    setDrafts(c => ({ ...c, [id]: { ...(c[id] ?? funds.find(f => f.id === id)!), [field]: Number.isFinite(n) ? n : 0 } }))
  }

  const COLS = 'grid-cols-[minmax(160px,1.2fr)_70px_80px_80px_100px_100px_100px]'

  return (
    <div className="min-h-screen bg-zinc-50">
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-sm border-b border-zinc-200">
        <div className="max-w-[1800px] mx-auto px-3 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-blue-600 flex items-center justify-center">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-base font-semibold text-zinc-900">基金估值</h1>
            <span className="text-sm text-zinc-500">{data?.tradeDate}</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span>{lastRefreshAt || '--:--:--'}</span>
          </div>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto px-3 py-4 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4">
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="text-sm font-medium text-zinc-500 mb-1">组合资产</div>
                  <div className="text-3xl font-bold text-zinc-900 tabular-nums">{money.format(totalValue)}</div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className={`inline-flex items-center gap-1.5 text-sm font-semibold text-white px-3 py-1 rounded-full ${riskCls}`}>
                    <AlertTriangle className="w-3.5 h-3.5" />{riskLabel}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-sm text-zinc-500 bg-zinc-100 px-3 py-1 rounded-full">
                    <Activity className="w-3.5 h-3.5" />{upCount}/{data?.markets.length ?? 0}涨
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <span>今日 <span className={dayProfit >= 0 ? 'text-red-500' : 'text-emerald-500'} font-semibold>{fmtMoney(dayProfit)}</span></span>
                <span className="text-zinc-300">|</span>
                <span>累计 <span className={totalProfit >= 0 ? 'text-red-500' : 'text-emerald-500'} font-semibold>{fmtMoney(totalProfit)}</span></span>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3">
              {[
                { label: '今日收益', value: fmtMoney(dayProfit), color: dayProfit >= 0 ? 'text-red-500' : 'text-emerald-500' },
                { label: '累计盈亏', value: fmtMoney(totalProfit), color: totalProfit >= 0 ? 'text-red-500' : 'text-emerald-500' },
                { label: '权益仓位', value: `${num.format(eqPos)}%`, color: eqPos < 55 ? 'text-emerald-500' : eqPos >= 70 ? 'text-red-500' : 'text-amber-500' },
                { label: '持仓数', value: `${funds.length}只`, color: 'text-zinc-700' },
              ].map((item) => (
                <div key={item.label} className="bg-white rounded-lg border border-zinc-200 p-3">
                  <div className="text-xs text-zinc-500 mb-1">{item.label}</div>
                  <div className={`text-lg font-semibold tabular-nums ${item.color}`}>{item.value}</div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <label className="flex-1 flex items-center gap-2 bg-white border border-zinc-200 rounded-lg px-4 py-3 text-base focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 transition-all">
                <Search className="w-5 h-5 text-zinc-400" />
                <input
                  value={newCode}
                  onChange={e => setNewCode(e.target.value)}
                  placeholder="基金代码"
                  className="flex-1 bg-transparent border-none outline-none text-zinc-900 placeholder:text-zinc-400"
                />
              </label>
              <button
                onClick={() => void addFund()}
                disabled={!!busy}
                className="px-5 py-3 bg-blue-600 text-white text-base font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                导入
              </button>
              <button
                onClick={() => void refreshData(false)}
                disabled={!!busy}
                className="flex items-center gap-2 px-5 py-3 bg-zinc-100 text-zinc-700 text-base font-medium rounded-lg hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className="w-4 h-4" />刷新
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!!busy}
                className="flex items-center gap-2 px-5 py-3 bg-zinc-100 text-zinc-700 text-base font-medium rounded-lg hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Upload className="w-4 h-4" />截图
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={e => void uploadScreenshot(e.target.files?.[0])}
              />
            </div>

            <div className="grid grid-cols-4 gap-2">
              {(data?.markets ?? []).slice(0, 8).map(m => (
                <div key={m.code} className="flex items-center justify-between bg-white border border-zinc-200 rounded-lg px-3 py-2 text-sm">
                  <span className="text-zinc-600 truncate max-w-[80px]">{m.name}</span>
                  <span className="text-zinc-900 tabular-nums font-medium">{num.format(m.value)}</span>
                  <span className={`tabular-nums font-semibold ${m.change >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>{fmtPct(m.change)}</span>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-xl border border-zinc-200 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 bg-zinc-50/50">
                <span className="text-base font-semibold text-zinc-900">持仓</span>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 bg-white border border-zinc-200 rounded-md px-3 py-1.5 text-sm focus-within:border-blue-500 transition-colors">
                    <Search className="w-4 h-4 text-zinc-400" />
                    <input
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      placeholder="搜索"
                      className="w-24 bg-transparent border-none outline-none text-zinc-900 placeholder:text-zinc-400"
                    />
                  </label>
                  <button
                    onClick={() => setIsEditing(v => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-zinc-600 border border-zinc-200 rounded-md hover:bg-zinc-100 transition-colors"
                  >
                    <Pencil className="w-4 h-4" />{isEditing ? '退出' : '编辑'}
                  </button>
                  <button
                    onClick={() => void saveAll()}
                    disabled={!isEditing || !!busy}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-600 border border-blue-600/30 bg-blue-50 rounded-md hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <Save className="w-4 h-4" />保存
                  </button>
                </div>
              </div>

              <div className={`grid ${COLS} gap-1 px-4 py-2 bg-zinc-100 text-xs font-semibold text-zinc-500`}>
                <SH sort={sort} k="name" label="基金" onChange={chgSort} left />
                <SH sort={sort} k="estimateChange" label="估值" onChange={chgSort} />
                <SH sort={sort} k="shares" label="份额" onChange={chgSort} />
                <SH sort={sort} k="cost" label="成本" onChange={chgSort} />
                <SH sort={sort} k="value" label="市值" onChange={chgSort} />
                <SH sort={sort} k="todayProfit" label="今盈亏" onChange={chgSort} />
                <SH sort={sort} k="profit" label="累盈亏" onChange={chgSort} />
              </div>

              <div className="max-h-[calc(100vh-420px)] overflow-y-auto">
                {visible.map(f => {
                  const d = drafts[f.id] ?? f
                  const tv = todayVal(d)
                  const tp = (d.nav - d.cost) * d.shares
                  const sel = selectedFund?.id === f.id
                  return (
                    <div
                      key={f.id}
                      onClick={() => setSelectedFundId(f.id)}
                      className={`grid ${COLS} gap-1 items-center px-4 py-2 cursor-pointer border-b border-zinc-100 transition-colors ${sel ? 'bg-blue-50/60 ring-1 ring-blue-200 -mx-0.5 -my-0.5 mx-0.5 rounded-lg' : 'hover:bg-zinc-50'}`}
                    >
                      <div className="min-w-0">
                        <div className="text-base font-medium text-zinc-900 truncate">{f.name}</div>
                        <div className="text-xs text-zinc-500 truncate">{f.code}·{f.tags.slice(0,2).join('/') || '估值'}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-base font-semibold text-zinc-900 tabular-nums">{d.nav.toFixed(4)}</div>
                        <div className={`text-xs font-semibold tabular-nums ${d.estimateChange >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>{fmtPct(d.estimateChange)}</div>
                      </div>
                      <div onClick={e => e.stopPropagation()}>
                        <input
                          disabled={!isEditing}
                          value={d.shares}
                          onChange={e => patchFund(f.id, 'shares', e.target.value)}
                          onBlur={() => isEditing && void saveFund(f.id)}
                          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                          className={`w-full h-8 rounded-md px-2 text-right text-sm tabular-nums outline-none ${isEditing ? 'bg-zinc-100 border border-zinc-300 focus:border-blue-500' : 'bg-transparent border-none text-zinc-900'}`}
                        />
                      </div>
                      <div onClick={e => e.stopPropagation()}>
                        <input
                          disabled={!isEditing}
                          value={d.cost}
                          onChange={e => patchFund(f.id, 'cost', e.target.value)}
                          onBlur={() => isEditing && void saveFund(f.id)}
                          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                          className={`w-full h-8 rounded-md px-2 text-right text-sm tabular-nums outline-none ${isEditing ? 'bg-zinc-100 border border-zinc-300 focus:border-blue-500' : 'bg-transparent border-none text-zinc-900'}`}
                        />
                      </div>
                      <span className="text-right text-base tabular-nums text-zinc-900">{money.format(curVal(d))}</span>
                      <span className={`text-right text-base tabular-nums font-semibold ${tv >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>{fmtMoney(tv)}</span>
                      <span className={`text-right text-base tabular-nums font-semibold ${tp >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>{fmtMoney(tp)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-zinc-200 shadow-sm p-4 lg:sticky lg:top-[72px]">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-1.5 h-5 bg-blue-600 rounded-full" />
              <span className="text-base font-semibold text-zinc-900">研究员分析</span>
            </div>
            {selectedFund ? (
              <>
                <div className="bg-zinc-50 rounded-lg p-3 mb-4">
                  <div className="flex items-baseline justify-between mb-1.5">
                    <div>
                      <span className="text-sm text-zinc-500">{selectedFund.code}</span>
                      <span className="text-base font-semibold text-zinc-900 ml-2">{selectedFund.name}</span>
                    </div>
                    <span className={`text-xl font-bold tabular-nums ${selectedFund.estimateChange >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                      {fmtPct(selectedFund.estimateChange)}
                    </span>
                  </div>
                  <div className="text-sm text-zinc-500">{selectedFund.estimateTime || selectedFund.estimateUpdatedAt || '--'}</div>
                </div>

                <Sec title="研究员结论">
                  {(evidence?.agents ?? []).map(a => <Agent key={a.id} a={a} />)}
                </Sec>

                <Sec title="板块暴露">
                  {(evidence?.exposure?.sectors ?? []).slice(0, 5).map(s => (
                    <div key={s.name} className="flex items-center justify-between text-sm py-2 border-b border-zinc-100 last:border-0">
                      <span className="text-zinc-700">{s.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-500 tabular-nums">{s.weight.toFixed(0)}%</span>
                        <span className={`tabular-nums font-medium ${s.avgChange >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>{fmtPct(s.avgChange)}</span>
                      </div>
                    </div>
                  ))}
                </Sec>

                <Sec title="重仓股">
                  <div className="flex flex-wrap gap-2">
                    {(evidence?.exposure?.stocks ?? []).slice(0, 8).map(s => (
                      <span key={s.code} className="text-sm border border-zinc-200 rounded-md px-2 py-1 bg-zinc-50 text-zinc-600">
                        {s.name} <b className={s.changePercent >= 0 ? 'text-red-500' : 'text-emerald-500'}>{fmtPct(s.changePercent)}</b>
                      </span>
                    ))}
                  </div>
                </Sec>

                <Sec title="快讯与公告">
                  <div className="space-y-2">
                    {(evidence?.fastNews?.items ?? []).slice(0, 3).map(i => (
                      <span key={i.id} className="text-sm text-zinc-600 truncate block">
                        <span className="text-zinc-400 mr-2">{i.time.slice(11, 16)}</span>{i.title}
                      </span>
                    ))}
                    {(evidence?.announcements?.items ?? []).slice(0, 2).map(i => (
                      <a key={i.id} href={i.url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 truncate block hover:underline">
                        {i.date} {i.category}·{i.title}
                      </a>
                    ))}
                  </div>
                </Sec>

                <Sec title="数据源">
                  {(evidence?.sourceStatus ?? []).map(s => (
                    <div key={s.source} className="flex items-center justify-between text-sm py-1">
                      <span className="text-zinc-600">{srcLabel(s.source)}</span>
                      <span className={s.ok ? 'text-emerald-500' : 'text-red-500'}>{s.ok ? '正常' : '异常'}</span>
                      <span className="text-zinc-400 tabular-nums">{s.count}</span>
                    </div>
                  ))}
                </Sec>
              </>
            ) : (
              <div className="text-base text-zinc-500 text-center py-10">选择一只基金查看详情</div>
            )}
          </div>
        </div>
      </main>

      <div className="fixed top-12 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-[min(360px,calc(100vw-24px))] pointer-events-none">
        {error && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 font-medium shadow-md">
            {error}
            <button onClick={() => setError('')} className="ml-auto text-red-500 hover:text-red-700 underline">关闭</button>
          </div>
        )}
        {notice && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 font-medium shadow-md">
            {notice}
            <button onClick={() => setNotice('')} className="ml-auto text-emerald-500 hover:text-emerald-700 underline">关闭</button>
          </div>
        )}
      </div>

      {ocrResult && <OcrModal result={ocrResult} onCancel={() => setOcrResult(null)} onConfirm={() => void importOcr()} />}
    </div>
  )
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="text-sm font-semibold text-zinc-900 mb-2">{title}</div>
      {children}
    </div>
  )
}

function Agent({ a }: { a: AgentInsight }) {
  const levelConfig: Record<string, { border: string; bg: string; badge: string; label: string }> = {
    positive: { border: 'border-l-red-500', bg: 'bg-red-50', badge: 'bg-red-500', label: '偏强' },
    negative: { border: 'border-l-emerald-500', bg: 'bg-emerald-50', badge: 'bg-emerald-500', label: '偏弱' },
    watch: { border: 'border-l-amber-500', bg: 'bg-amber-50', badge: 'bg-amber-500', label: '关注' },
    neutral: { border: 'border-l-zinc-400', bg: 'bg-zinc-50', badge: 'bg-zinc-400', label: '正常' },
  }
  const config = levelConfig[a.level]
  return (
    <div className={`rounded-lg border border-zinc-200 ${config.border} ${config.bg} p-3 mb-2 last:mb-0`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-zinc-900">{a.title}</span>
        <span className={`text-xs font-bold text-white px-2 py-0.5 rounded-full ${config.badge}`}>{config.label}</span>
      </div>
      <p className="text-sm text-zinc-600 leading-relaxed">{a.conclusion}</p>
      <div className="flex flex-wrap gap-1 mt-2">
        {a.evidence.slice(0, 3).map(e => (
          <span key={e} className="text-xs border border-zinc-200 rounded px-1.5 py-0.5 bg-white text-zinc-500">{e}</span>
        ))}
      </div>
    </div>
  )
}

function SH({ sort, k, label, onChange, left }: { sort: { key: SortKey; direction: 'asc' | 'desc' }; k: SortKey; label: string; onChange: (k: SortKey) => void; left?: boolean }) {
  const active = sort.key === k
  return (
    <button
      onClick={() => onChange(k)}
      className={`flex items-center gap-1 h-6 w-full bg-transparent border-none cursor-pointer transition-colors ${left ? 'justify-start' : 'justify-end'} ${active ? 'text-blue-600' : 'text-zinc-500 hover:text-zinc-700'}`}
    >
      {label}
      <ArrowUpDown className={`w-3.5 h-3.5 transition-transform ${active && sort.direction === 'desc' ? 'rotate-180' : ''}`} />
    </button>
  )
}

function OcrModal({ result, onCancel, onConfirm }: { result: OcrResult; onCancel: () => void; onConfirm: () => void }) {
  const hs = result.candidates.holdings ?? []
  return (
    <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center">
      <div className="w-[min(640px,calc(100vw-24px))] max-h-[70vh] bg-white rounded-xl border border-zinc-200 shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-200 bg-zinc-50">
          <div>
            <div className="text-base font-semibold text-zinc-900">确认识别结果</div>
            <div className="text-sm text-zinc-500">识别到 {hs.length} 条持仓</div>
          </div>
          <button onClick={onCancel} className="text-base text-zinc-500 hover:text-zinc-700 transition-colors">关闭</button>
        </div>
        <div className="overflow-y-auto px-5 py-4 flex-1">
          <div className="grid grid-cols-[1.2fr_2fr_1fr_1fr] gap-3 py-3 border-b border-zinc-200 text-sm font-semibold text-zinc-500">
            <span>名称</span>
            <span>匹配</span>
            <span>金额</span>
            <span>收益</span>
          </div>
          {hs.map(h => (
            <div key={h.recognizedName} className="grid grid-cols-[1.2fr_2fr_1fr_1fr] gap-3 py-3 border-b border-zinc-100 text-sm items-center">
              <strong className="text-zinc-900 font-medium truncate">{h.recognizedName}</strong>
              <span className="text-zinc-600 truncate">{h.matchedFunds[0] ? `${h.matchedFunds[0].code}·${h.matchedFunds[0].name}` : '未匹配'}</span>
              <span className="text-right tabular-nums text-zinc-900">{h.amount ? money.format(h.amount) : '-'}</span>
              <span className={`text-right tabular-nums font-semibold ${Number(h.holdingProfit ?? 0) >= 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                {h.holdingProfit == null ? '-' : fmtMoney(h.holdingProfit)}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-zinc-200 bg-zinc-50">
          <button onClick={onCancel} className="px-5 py-2.5 text-base text-zinc-600 border border-zinc-200 rounded-lg hover:bg-zinc-100 transition-colors">取消</button>
          <button onClick={onConfirm} className="px-5 py-2.5 text-base text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">确认导入</button>
        </div>
      </div>
    </div>
  )
}

function cmpFunds(a: Fund, b: Fund, k: SortKey) {
  return k === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sortV(a, k) - sortV(b, k)
}

function sortV(f: Fund, k: Exclude<SortKey, 'name'>) {
  return k === 'estimateChange' ? f.estimateChange :
    k === 'shares' ? f.shares :
    k === 'cost' ? f.cost :
    k === 'value' ? curVal(f) :
    k === 'todayProfit' ? todayVal(f) :
    (f.nav - f.cost) * f.shares
}

function curVal(f: Fund) { return f.nav * f.shares }

function todayVal(f: Fund) { return curVal(f) * f.estimateChange / 100 }

function fmtMoney(v: number) { return `${v >= 0 ? '+' : ''}${money.format(v)}` }

function fmtPct(v: number) { return `${v >= 0 ? '+' : ''}${num.format(v)}%` }

function srcLabel(s: string) {
  return s === 'eastmoney-fund' ? '天天基金' :
    s === 'eastmoney-sector' ? '行业' :
    s === 'eastmoney-news' ? '快讯' :
    s === 'eastmoney-announcement' ? '公告' :
    s || '未知'
}

async function req<T>(url: string, opt?: RequestInit): Promise<T> {
  const r = await fetch(url, opt)
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.message ?? `请求失败：${r.status}`)
  return r.json() as Promise<T>
}

function errMsg(e: unknown) { return e instanceof Error ? e.message : '操作失败' }

export default Dashboard