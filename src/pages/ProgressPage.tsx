import { Link } from 'react-router-dom'
import { Legend, StackedBar, useTooltip, type Segment } from '../components/charts'
import { ApplicabilityBadge, ErrorBox, Loading, PageHeader, SlotToggle, StatusBadge } from '../components/ui'
import { useAsync, useSlot } from '../lib/hooks'
import { ISSUE_CONFIGS, STATUS_LABELS } from '../lib/issues'
import { fetchMasters, type PeriodRow } from '../lib/masters'
import { fetchAllMaterialStates, summarize } from '../lib/package'
import { must, supabase } from '../lib/supabase'

interface ProgressRow { period_id: string; issue_code: string; status: string }
interface PolicyRow { period_id: string; issue_code: string; applicability: string | null }

const STATUS_ORDER = ['not_started', 'imported', 'checked', 'calculated', 'locked']
const statusColor = (s: string) => `var(--viz-st-${s})`

// 状況ごとの件数を、グラフの区分にする（確定が左＝進んだ順に並べる）
function toSegments(counts: Record<string, number>): Segment[] {
  return [...STATUS_ORDER].reverse().map((s) => ({ key: s, label: STATUS_LABELS[s], value: counts[s] ?? 0, color: statusColor(s) }))
}

export default function ProgressPage() {
  const [slot, setSlot] = useSlot()
  const tooltip = useTooltip()
  const { data, error, loading } = useAsync(async () => {
    const [m, progress, policies] = await Promise.all([
      fetchMasters(),
      supabase.from('v_progress').select('period_id, issue_code, status'),
      supabase.from('v_policy_matrix').select('period_id, issue_code, applicability'),
    ])
    const periods = m.companies.map((c) => m.periodFor(c.id, slot)).filter((p): p is PeriodRow => !!p)
    const materials = await fetchAllMaterialStates(m, periods)
    return { m, progress: must(progress) as ProgressRow[], policies: must(policies) as PolicyRow[], materials }
  }, [slot])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { m } = data
  const status = new Map(data.progress.map((r) => [`${r.period_id}|${r.issue_code}`, r.status]))
  const app = new Map(data.policies.map((r) => [`${r.period_id}|${r.issue_code}`, r.applicability]))

  // 適用の会社×論点だけを数える（全体・会社別・論点別）
  const counts: Record<string, number> = {}
  const byCompany = new Map<string, Record<string, number>>()
  const byIssue = new Map<string, Record<string, number>>()
  const bump = (rec: Record<string, number>, s: string) => { rec[s] = (rec[s] ?? 0) + 1 }
  for (const c of m.companies) {
    const p = m.periodFor(c.id, slot)
    if (!p) continue
    const rc: Record<string, number> = {}
    byCompany.set(c.id, rc)
    for (const i of m.issues) {
      const a = app.get(`${p.id}|${i.code}`)
      if (a !== 'applied') continue
      const s = status.get(`${p.id}|${i.code}`) ?? 'not_started'
      bump(counts, s)
      bump(rc, s)
      if (!byIssue.has(i.code)) byIssue.set(i.code, {})
      bump(byIssue.get(i.code)!, s)
    }
  }
  const sum = (rec: Record<string, number> | undefined) => Object.values(rec ?? {}).reduce((s, n) => s + n, 0)
  const totalApplied = sum(counts)
  const lockedRate = totalApplied ? Math.round(((counts.locked ?? 0) / totalApplied) * 100) : 0

  return (
    <>
      <PageHeader title="進捗一覧">
        <SlotToggle slot={slot} onChange={setSlot} />
      </PageHeader>
      <div className="progress-hero">
        <div>
          <div className="hero-label">確定（適用の会社×論点）</div>
          <div className="hero-value">{lockedRate}%<small>{counts.locked ?? 0} / {totalApplied}件</small></div>
          <div className="small muted">作業中 {totalApplied - (counts.locked ?? 0) - (counts.not_started ?? 0)}件 ／ 未着手 {counts.not_started ?? 0}件</div>
        </div>
        <div>
          <StackedBar segments={toSegments(counts)} height={18} tooltip={tooltip} />
          <Legend items={toSegments(counts).map((g) => ({ key: g.key, label: g.label, color: g.color, value: g.value }))} />
        </div>
      </div>
      {tooltip.node}
      <p className="muted small">
        会社×論点ごとの状況です。<b>太枠</b>の論点（有給休暇引当金・減価償却）はこのプロトタイプで計算まで動きます。セルを押すと作業画面に移ります。
      </p>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th className="sticky-col">会社</th>
              {m.issues.map((i) => (
                <th key={i.code} className={ISSUE_CONFIGS[i.code] ? 'implemented' : ''} title={i.standard_ref ?? ''}>
                  <div className="issue-no">{i.no}</div>
                  <div className="issue-name">{i.name}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.companies.map((c) => {
              const p = m.periodFor(c.id, slot)
              return (
                <tr key={c.id}>
                  <th className="sticky-col">
                    <div>{c.code} {c.name}</div>
                    <div className="muted small">{p?.label}<span className="hide-sp"> ／ {c.accounting_software}</span></div>
                    <div className="company-progress">
                      <StackedBar segments={toSegments(byCompany.get(c.id) ?? {})} height={6} tooltip={tooltip} />
                      <span className="small muted nowrap">確定 {byCompany.get(c.id)?.locked ?? 0}/{sum(byCompany.get(c.id))}</span>
                    </div>
                    {data.materials.get(c.id) && (() => {
                      const ms = summarize(data.materials.get(c.id)!)
                      return <Link className="small nowrap" to={`/materials/${c.code}`}>資料 {ms.done}/{ms.total} 提出 →</Link>
                    })()}
                  </th>
                  {m.issues.map((i) => {
                    if (!p) return <td key={i.code} />
                    const a = app.get(`${p.id}|${i.code}`) ?? null
                    const s = status.get(`${p.id}|${i.code}`) ?? 'not_started'
                    const implemented = !!ISSUE_CONFIGS[i.code]
                    const cell = a === 'applied' ? <StatusBadge status={s} /> : <ApplicabilityBadge value={a} />
                    return (
                      <td key={i.code} className={implemented ? 'implemented' : ''}>
                        {implemented ? <Link to={`/work/${p.id}/${i.code}`} className="cell-link">{cell}</Link> : cell}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <th className="sticky-col">論点別の確定（適用の会社）</th>
              {m.issues.map((i) => {
                const rec = byIssue.get(i.code)
                return (
                  <td key={i.code} className={ISSUE_CONFIGS[i.code] ? 'implemented' : ''}>
                    {rec ? (
                      <div className="issue-rate">
                        <StackedBar segments={toSegments(rec)} height={6} tooltip={tooltip} />
                        <span className="nowrap">{rec.locked ?? 0}/{sum(rec)}社</span>
                      </div>
                    ) : '—'}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  )
}
