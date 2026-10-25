import { Link } from 'react-router-dom'
import { ApplicabilityBadge, ErrorBox, Loading, PageHeader, SlotToggle, StatusBadge } from '../components/ui'
import { useAsync, useSlot } from '../lib/hooks'
import { ISSUE_CONFIGS, STATUS_LABELS } from '../lib/issues'
import { fetchMasters } from '../lib/masters'
import { must, supabase } from '../lib/supabase'

interface ProgressRow { period_id: string; issue_code: string; status: string }
interface PolicyRow { period_id: string; issue_code: string; applicability: string | null }

export default function ProgressPage() {
  const [slot, setSlot] = useSlot()
  const { data, error, loading } = useAsync(async () => {
    const [m, progress, policies] = await Promise.all([
      fetchMasters(),
      supabase.from('v_progress').select('period_id, issue_code, status'),
      supabase.from('v_policy_matrix').select('period_id, issue_code, applicability'),
    ])
    return { m, progress: must(progress) as ProgressRow[], policies: must(policies) as PolicyRow[] }
  }, [])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { m } = data
  const status = new Map(data.progress.map((r) => [`${r.period_id}|${r.issue_code}`, r.status]))
  const app = new Map(data.policies.map((r) => [`${r.period_id}|${r.issue_code}`, r.applicability]))

  const counts: Record<string, number> = {}
  for (const c of m.companies) {
    const p = m.periodFor(c.id, slot)
    if (!p) continue
    for (const i of m.issues) {
      const a = app.get(`${p.id}|${i.code}`)
      if (a !== 'applied') continue
      const s = status.get(`${p.id}|${i.code}`) ?? 'not_started'
      counts[s] = (counts[s] ?? 0) + 1
    }
  }
  const totalApplied = Object.values(counts).reduce((s, n) => s + n, 0)

  return (
    <>
      <PageHeader title="進捗一覧">
        <SlotToggle slot={slot} onChange={setSlot} />
      </PageHeader>
      <div className="summary-row">
        <div className="stat"><div className="stat-label">対象（適用）</div><div className="stat-value">{totalApplied}</div></div>
        {Object.keys(STATUS_LABELS).map((s) => (
          <div className="stat" key={s}><div className="stat-label">{STATUS_LABELS[s]}</div><div className="stat-value">{counts[s] ?? 0}</div></div>
        ))}
      </div>
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
                    <div className="muted small">{p?.label} ／ {c.accounting_software}</div>
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
        </table>
      </div>
    </>
  )
}
