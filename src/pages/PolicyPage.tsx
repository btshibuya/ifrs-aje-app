import { useState } from 'react'
import { ApplicabilityBadge, ErrorBox, Loading, PageHeader, SlotToggle } from '../components/ui'
import { useAsync, useSlot } from '../lib/hooks'
import { fetchMasters } from '../lib/masters'
import { must, supabase } from '../lib/supabase'

interface PolicyRow {
  company_code: string
  company_name: string
  period_id: string
  period_label: string
  issue_code: string
  issue_name: string
  applicability: string | null
  params: Record<string, unknown>
  reason: string | null
  is_company_override: boolean
}

// 一覧のセルに出す代表的な前提値
const PARAM_LABELS: Record<string, string> = {
  effective_tax_rate: '実効税率',
  expected_usage_rate: '消化見込率',
  social_insurance_rate: '法定福利費率',
  discount_rate: '割引率',
  incremental_borrowing_rate: '追加借入利子率',
  default_classification: '株式の分類',
  jgaap_property_tax_method: '日本基準の処理',
}

const formatParam = (k: string, v: unknown) =>
  typeof v === 'number' && k.endsWith('_rate') ? `${(v * 100).toFixed(2)}%` : String(v)

export default function PolicyPage() {
  const [slot, setSlot] = useSlot()
  const [selected, setSelected] = useState<PolicyRow | null>(null)
  const { data, error, loading } = useAsync(async () => {
    const [m, rows] = await Promise.all([fetchMasters(), supabase.from('v_policy_matrix').select('*')])
    return { m, rows: must(rows) as PolicyRow[] }
  }, [])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { m } = data
  const byKey = new Map(data.rows.map((r) => [`${r.period_id}|${r.issue_code}`, r]))

  return (
    <>
      <PageHeader title="会社別方針一覧">
        <SlotToggle slot={slot} onChange={setSlot} />
      </PageHeader>
      <p className="muted small">
        グループ共通の方針に、会社ごとの上書きを重ねた結果です。<span className="override-mark">●</span> は会社ごとの上書きがある論点です。セルを押すと前提値と理由を表示します。
      </p>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th className="sticky-col">会社</th>
              {m.issues.map((i) => (
                <th key={i.code}><div className="issue-no">{i.no}</div><div className="issue-name">{i.name}</div></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.companies.map((c) => {
              const p = m.periodFor(c.id, slot)
              return (
                <tr key={c.id}>
                  <th className="sticky-col"><div>{c.code} {c.name}</div><div className="muted small">{p?.label}</div></th>
                  {m.issues.map((i) => {
                    const r = p ? byKey.get(`${p.id}|${i.code}`) : undefined
                    if (!r) return <td key={i.code} />
                    const firstParam = Object.entries(r.params).find(([k]) => PARAM_LABELS[k])
                    return (
                      <td key={i.code} className={`clickable${selected === r ? ' selected' : ''}`} onClick={() => setSelected(r)}>
                        <ApplicabilityBadge value={r.applicability} />
                        {r.is_company_override && <span className="override-mark" title="会社ごとの上書き">●</span>}
                        {firstParam && r.applicability === 'applied' && (
                          <div className="small muted">{PARAM_LABELS[firstParam[0]]} {formatParam(firstParam[0], firstParam[1])}</div>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {selected && (
        <div className="card detail-card">
          <div className="card-title">
            {selected.company_code} {selected.company_name} ／ {selected.period_label} ／ {selected.issue_name}
            <button className="btn-link" onClick={() => setSelected(null)}>閉じる</button>
          </div>
          <dl className="kv">
            <dt>適用</dt><dd><ApplicabilityBadge value={selected.applicability} /> {selected.is_company_override ? '（会社ごとの上書き）' : '（グループ共通）'}</dd>
            <dt>理由</dt><dd>{selected.reason ?? '—'}</dd>
            {Object.entries(selected.params).map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}><dt>{PARAM_LABELS[k] ?? k}</dt><dd>{formatParam(k, v)}</dd></span>
            ))}
          </dl>
        </div>
      )}
    </>
  )
}
