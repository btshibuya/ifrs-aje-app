import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Legend, StackedBar, useTooltip, type Segment } from '../components/charts'
import { useFeedback } from '../components/feedback'
import { ApplicabilityBadge, ErrorBox, Loading, PageHeader, SlotToggle, formatDateTime } from '../components/ui'
import { useAsync, useSlot } from '../lib/hooks'
import { fetchMasters, type Issue, type PeriodRow } from '../lib/masters'
import { KIND_LABELS } from '../lib/materials'
import {
  MATERIAL_STATUS_LABELS, fetchStatusContext, materialStates, summarize, summarizeCompanies, uploadSourceFile,
  type MaterialState, type MaterialStatus,
} from '../lib/package'

const STATUS_ORDER: MaterialStatus[] = ['confirmed', 'submitted', 'draft', 'todo']
export const materialColor = (s: string) => `var(--mst-${s})`

export function materialSegments(counts: Record<string, number>): Segment[] {
  return STATUS_ORDER.map((s) => ({ key: s, label: MATERIAL_STATUS_LABELS[s], value: counts[s] ?? 0, color: materialColor(s) }))
}

export function MaterialBadge({ status }: { status: MaterialStatus }) {
  return <span className={`badge mst-badge-${status}`}>{MATERIAL_STATUS_LABELS[status]}</span>
}

export default function MaterialsPage() {
  const { companyCode } = useParams()
  const navigate = useNavigate()
  const [slot, setSlot] = useSlot()
  const tooltip = useTooltip()
  const { data, error, loading, reload } = useAsync(async () => {
    const m = await fetchMasters()
    const periods = m.companies.map((c) => m.periodFor(c.id, slot)).filter((p): p is PeriodRow => !!p)
    const ctx = await fetchStatusContext(periods.map((p) => p.id), m.companies.map((c) => c.id), periods.map((p) => p.end_date), m.issues.map((i) => i.code))
    return { m, states: new Map(periods.map((p) => [p.company_id, { period: p, states: materialStates(ctx, p) }])) }
  }, [slot])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { m } = data
  const company = m.companies.find((c) => c.code === companyCode)

  return (
    <>
      <PageHeader title="資料一覧">
        <select aria-label="会社" value={companyCode ?? ''} onChange={(e) => navigate(e.target.value ? `/materials/${e.target.value}` : '/materials')}>
          <option value="">全社（提出状況の一覧）</option>
          {m.companies.map((c) => <option key={c.id} value={c.code}>{c.code} {c.name}</option>)}
        </select>
        <SlotToggle slot={slot} onChange={setSlot} years={m.yearLabels} />
      </PageHeader>
      {tooltip.node}
      {company && data.states.get(company.id)
        ? <CompanyMaterials issues={m.issues} companyCode={company.code} companyName={company.name} {...data.states.get(company.id)!} onChanged={reload} />
        : <AllCompanies m={m} states={data.states} tooltip={tooltip} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// 全社：会社×論点で、用意する資料の提出状況を見る（詳細な進捗一覧）
// ---------------------------------------------------------------------------

function AllCompanies({ m, states, tooltip }: {
  m: Awaited<ReturnType<typeof fetchMasters>>
  states: Map<string, { period: PeriodRow; states: MaterialState[] }>
  tooltip: ReturnType<typeof useTooltip>
}) {
  const total = summarizeCompanies([...states.values()].map((s) => s.states))
  const rate = total.total ? Math.round((total.done / total.total) * 100) : 0
  return (
    <>
      <div className="progress-hero">
        <div>
          <div className="hero-label">資料の提出（必要な資料のうち）</div>
          <div className="hero-value">{rate}%<small>{total.done} / {total.total}件</small></div>
          <div className="small muted">入力中 {total.counts.draft ?? 0}件 ／ 未提出 {total.counts.todo ?? 0}件</div>
        </div>
        <div>
          <StackedBar segments={materialSegments(total.counts)} height={18} tooltip={tooltip} />
          <Legend items={materialSegments(total.counts).map((s) => ({ key: s.key, label: s.label, color: s.color, value: s.value }))} />
        </div>
      </div>
      <p className="muted small">
        論点ごとに、子会社の担当者が用意する資料の提出状況です。数字は「提出済・確認済 ／ 必要な資料の数」。会社名を押すと、その会社の資料の一覧（担当者が用意するもの）に移ります。
      </p>
      <div className="table-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th className="sticky-col">会社</th>
              {m.issues.map((i) => <th key={i.code}><div className="issue-no">{i.no}</div><div className="issue-name">{i.name}</div></th>)}
            </tr>
          </thead>
          <tbody>
            {m.companies.map((c) => {
              const s = states.get(c.id)
              if (!s) return null
              const sum = summarize(s.states)
              return (
                <tr key={c.id}>
                  <th className="sticky-col">
                    <Link to={`/materials/${c.code}`}>{c.code} {c.name}</Link>
                    <div className="muted small">{s.period.label}</div>
                    <div className="company-progress">
                      <StackedBar segments={materialSegments(sum.counts)} height={6} tooltip={tooltip} />
                      <span className="small muted nowrap">{sum.done}/{sum.total}</span>
                    </div>
                  </th>
                  {m.issues.map((i) => {
                    const list = s.states.filter((x) => x.material.issueCode === i.code)
                    const need = list.filter((x) => x.status !== 'not_needed')
                    if (need.length === 0) return <td key={i.code}><ApplicabilityBadge value={list[0]?.applicability ?? null} /></td>
                    const done = need.filter((x) => x.status === 'submitted' || x.status === 'confirmed').length
                    return (
                      <td key={i.code} className="clickable" title={need.map((x) => `${x.material.name}：${MATERIAL_STATUS_LABELS[x.status]}`).join('\n')}>
                        <Link to={`/materials/${c.code}`} className="cell-link">
                          <div className="mat-dots" aria-label={need.map((x) => `${x.material.name} ${MATERIAL_STATUS_LABELS[x.status]}`).join('、')}>
                            {need.map((x) => <span key={x.material.code} className="mat-dot" style={{ background: materialColor(x.status) }} />)}
                          </div>
                          <span className="small">{done}/{need.length}</span>
                        </Link>
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

// ---------------------------------------------------------------------------
// 会社別：担当者が用意するものの一覧
// ---------------------------------------------------------------------------

function CompanyMaterials({ issues, companyCode, companyName, period, states, onChanged }: {
  issues: Issue[]; companyCode: string; companyName: string; period: PeriodRow; states: MaterialState[]; onChanged: () => void
}) {
  const sum = summarize(states)
  const needed = issues.filter((i) => states.some((s) => s.material.issueCode === i.code && s.status !== 'not_needed'))
  const notNeeded = issues.filter((i) => !needed.includes(i))
  const next = states.find((s) => s.status === 'todo' || s.status === 'draft')
  return (
    <div className="stack">
      <div className="progress-hero">
        <div>
          <div className="hero-label">{companyCode} {companyName}（{period.label}）</div>
          <div className="hero-value">{sum.done} / {sum.total}<small>件 提出済</small></div>
          <div className="small muted">入力中 {sum.counts.draft ?? 0}件 ／ 未提出 {sum.counts.todo ?? 0}件</div>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <StackedBar segments={materialSegments(sum.counts)} height={18} />
          <div className="actions">
            <Link className="btn btn-primary" to={`/package/${companyCode}/${period.end_date}`}>収集パッケージに入力する</Link>
            {next && <span className="small muted">次にやること：{next.material.name}（{issues.find((i) => i.code === next.material.issueCode)?.name}）</span>}
          </div>
        </div>
      </div>

      <div className="card help-card">
        <b>担当者の方へ</b>
        <ul>
          <li>「会計システム等から出力」の資料は、システムから出したファイルをそのまま提出します（加工は不要です）。</li>
          <li>「収集パッケージに入力」の資料は、パッケージの画面で入力します。入力例と前期の値が並んで表示されます。</li>
          <li>わからない項目があれば、空欄のまま「入力中」で保存し、親会社の担当者に相談してください。</li>
        </ul>
      </div>

      {needed.map((i) => (
        <div className="card" key={i.code}>
          <div className="card-title">
            <span><span className="issue-no-sm">{i.no}</span>{i.name} <span className="small muted">{i.standard_ref}</span></span>
          </div>
          <div className="mat-list">
            {states.filter((s) => s.material.issueCode === i.code).map((s) => (
              <MaterialRow key={s.material.code} state={s} period={period} companyCode={companyCode} onChanged={onChanged} />
            ))}
          </div>
        </div>
      ))}

      {notNeeded.length > 0 && (
        <details className="card">
          <summary>資料が不要な論点（{notNeeded.length}件：対象外・重要性なし）</summary>
          <ul className="small">
            {notNeeded.map((i) => (
              <li key={i.code}>{i.no}. {i.name} <ApplicabilityBadge value={states.find((s) => s.material.issueCode === i.code)?.applicability ?? null} /></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function MaterialRow({ state, period, companyCode, onChanged }: { state: MaterialState; period: PeriodRow; companyCode: string; onChanged: () => void }) {
  const { material: mt, status } = state
  const input = useRef<HTMLInputElement>(null)
  const fb = useFeedback()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const upload = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await uploadSourceFile(period, mt, file)
      fb.toast(`「${mt.name}」を提出しました（${file.name}）`)
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  let action = null
  if (mt.kind === 'package') {
    action = <Link className={`btn${status === 'todo' || status === 'draft' ? ' btn-primary' : ''}`} to={`/package/${companyCode}/${period.end_date}/${mt.formCode}`}>{status === 'todo' ? '入力する' : status === 'draft' ? '続きを入力' : '内容を見る'}</Link>
  } else if (mt.importable) {
    action = <Link className={`btn${status === 'todo' ? ' btn-primary' : ''}`} to={`/work/${period.id}/${mt.issueCode}`}>{status === 'todo' ? '取り込む' : '作業画面へ'}</Link>
  } else {
    action = (
      <>
        <input ref={input} type="file" accept=".xlsx,.xls,.csv,.pdf" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <button className={`btn${status === 'todo' ? ' btn-primary' : ''}`} disabled={busy} onClick={() => input.current?.click()}>
          {busy ? '保存中…' : status === 'todo' ? 'ファイルを提出' : '提出し直す'}
        </button>
      </>
    )
  }

  return (
    <div className={`mat-row mat-${status}`}>
      <div className="mat-status"><MaterialBadge status={status} /></div>
      <div className="mat-main">
        <div className="mat-name">
          {mt.name}
          <span className={`badge kind-${mt.kind}`}>{KIND_LABELS[mt.kind]}</span>
        </div>
        <div className="small muted">出どころ：{mt.source} ／ 形式：{mt.format}</div>
        <div className="small">{mt.prepare}</div>
        {state.updatedAt && <div className="small muted">最終更新：{formatDateTime(state.updatedAt)}{state.detail ? `（作業：${state.detail}）` : ''}</div>}
        {error && <div className="small text-error">{error}</div>}
      </div>
      <div className="mat-action">{action}</div>
    </div>
  )
}
