// 収集パッケージ：子会社の担当者が、論点ごとの様式に入力して提出する
//   左：様式の一覧（状況つき）／右：入力欄・入力例・前期の値（前年度末または前年同期、直前四半期）
//   スマホ幅では、様式の一覧を上の選択欄にし、提出ボタンを画面下に固定する

import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorBox, Loading } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import { fetchMasters, type PeriodRow } from '../../lib/masters'
import { MATERIALS, PACKAGE_FORMS, formatAsOf, quarterEnds, type PackageForm } from '../../lib/materials'
import {
  ENTRY_STATUS_LABELS, compareDates, fetchEntries, type CompareDates, type PackageEntry,
} from '../../lib/package'
import { must, supabase } from '../../lib/supabase'
import FormEditor from './FormEditor'

const readPref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // 保存できなくても動作に支障はない
  }
}

export default function PackagePage() {
  const { companyCode, asOf, formCode } = useParams()
  const navigate = useNavigate()
  const [enteredBy, setEnteredBy] = useState(() => readPref('enteredBy', ''))
  const [showExamples, setShowExamples] = useState(() => readPref('showExamples', '1') === '1')
  useEffect(() => writePref('enteredBy', enteredBy), [enteredBy])
  useEffect(() => writePref('showExamples', showExamples ? '1' : '0'), [showExamples])

  const masters = useAsync(fetchMasters, [])
  const m = masters.data
  const company = m?.companies.find((c) => c.code === companyCode)
  const periods = m && company ? m.periods.filter((p) => p.company_id === company.id) : []
  // 基準日：指定がなければ最新の期末
  const asOfs = periods.flatMap((p) => quarterEnds(p.start_date, p.end_date).map((d) => ({ d, p })))
  const current = asOfs.find((x) => x.d === asOf) ?? asOfs[asOfs.length - 1]
  const period: PeriodRow | undefined = current?.p
  const dates: CompareDates | null = current ? compareDates(current.d, current.p) : null

  const detail = useAsync(async () => {
    if (!company || !period || !dates || !current) return null
    const [entries, policies] = await Promise.all([
      fetchEntries(company.id, [current.d, dates.priorYearEnd, dates.priorSamePeriod, dates.prevQuarter]),
      supabase.from('v_policy_matrix').select('issue_code, applicability').eq('period_id', period.id),
    ])
    const applied = new Set((must(policies) as { issue_code: string; applicability: string | null }[]).filter((p) => p.applicability === 'applied').map((p) => p.issue_code))
    return { entries, forms: PACKAGE_FORMS.filter((f) => applied.has(f.issueCode)) }
  }, [company?.id, current?.d])

  // この画面で保存した内容（会社・基準日が変わったら使わない）
  const scope = `${company?.id}|${current?.d}`
  const [saved, setSaved] = useState<{ scope: string; map: Record<string, PackageEntry> }>({ scope: '', map: {} })
  const local = saved.scope === scope ? saved.map : {}

  const entryOf = (code: string, date: string): PackageEntry | undefined =>
    (date === current?.d ? local[code] : undefined) ?? detail.data?.entries.find((e) => e.form_code === code && e.as_of === date)

  const forms = detail.data?.forms ?? []
  const form: PackageForm | undefined = forms.find((f) => f.code === formCode) ?? forms[0]
  const issueNo = (code: string) => m?.issues.find((i) => i.code === code)?.no

  const counts = { todo: 0, draft: 0, submitted: 0, confirmed: 0 }
  for (const f of forms) counts[(current && entryOf(f.code, current.d)?.status) || 'todo']++

  if (masters.loading && !m) return <Loading />
  if (masters.error) return <ErrorBox message={masters.error} />
  if (!m) return null

  // 会社を選ぶ画面
  if (!company) {
    return (
      <div className="stack">
        <h1>収集パッケージ</h1>
        <p className="muted">入力する会社を選んでください。担当者ごとにログインする運用では、ここが自社だけの画面になります。</p>
        <div className="company-grid">
          {m.companies.map((c) => {
            const last = m.periods.filter((p) => p.company_id === c.id).at(-1)
            return (
              <Link key={c.id} className="card company-card" to={`/package/${c.code}/${last?.end_date ?? ''}`}>
                <b>{c.code} {c.name}</b>
                <span className="small muted">{last?.label} ／ {c.accounting_software}</span>
              </Link>
            )
          })}
        </div>
      </div>
    )
  }
  if (!current || !period || !dates) return <ErrorBox message="この会社の決算期が登録されていません" />

  const go = (code: string) => navigate(`/package/${company.code}/${current.d}/${code}`)
  const done = counts.submitted + counts.confirmed

  return (
    <div className="pkg">
      <div className="breadcrumb">
        <Link to="/materials">資料一覧</Link> ／ <Link to={`/materials/${company.code}`}>{company.code} {company.name}</Link> ／ 収集パッケージ
      </div>
      <div className="pkg-head">
        <div>
          <h1>収集パッケージ <span className="muted small">{company.code} {company.name}</span></h1>
          <div className="small muted">提出 {done} / {forms.length} 様式 ・ 入力中 {counts.draft} ・ 未着手 {counts.todo}</div>
        </div>
        <div className="pkg-tools">
          <label className="field-inline">
            <span>基準日</span>
            <select value={current.d} onChange={(e) => navigate(`/package/${company.code}/${e.target.value}${form ? `/${form.code}` : ''}`)}>
              {[...asOfs].reverse().map((x) => (
                <option key={x.d} value={x.d}>{formatAsOf(x.d)}{x.d === x.p.end_date ? `（${x.p.label} 期末）` : '（四半期末）'}</option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            <span>入力者</span>
            <input id="entered-by" value={enteredBy} onChange={(e) => setEnteredBy(e.target.value)} placeholder="例：山田 花子（必須）" aria-required="true" className={enteredBy.trim() ? '' : 'needs-value'} />
          </label>
          <label className="check-inline">
            <input type="checkbox" checked={showExamples} onChange={(e) => setShowExamples(e.target.checked)} /> 入力例を表示
          </label>
        </div>
      </div>

      {detail.loading && !detail.data && <Loading />}
      {detail.error && <ErrorBox message={detail.error} />}
      {detail.data && forms.length === 0 && <div className="alert alert-info">この会社・基準日に入力する様式はありません（収集パッケージの論点がすべて対象外です）。</div>}
      {detail.data && form && (
        <div className="pkg-body">
          <nav className="pkg-nav" aria-label="様式">
            <select className="pkg-nav-select" value={form.code} onChange={(e) => go(e.target.value)} aria-label="様式を選ぶ">
              {forms.map((f) => <option key={f.code} value={f.code}>{issueNo(f.issueCode)}. {f.title}（{ENTRY_STATUS_LABELS[entryOf(f.code, current.d)?.status ?? 'todo']}）</option>)}
            </select>
            <ul className="pkg-nav-list">
              {forms.map((f) => {
                const st = entryOf(f.code, current.d)?.status ?? 'todo'
                return (
                  <li key={f.code}>
                    <button className={f.code === form.code ? 'on' : ''} onClick={() => go(f.code)}>
                      <span className={`dot mst-dot-${st}`} aria-hidden />
                      <span className="pkg-nav-title"><span className="muted small">{issueNo(f.issueCode)}.</span> {f.title}</span>
                      <span className={`badge mst-badge-${st}`}>{ENTRY_STATUS_LABELS[st]}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="small muted pkg-nav-note">
              会計システムから出すファイル（{MATERIALS.filter((x) => x.kind === 'system').map((x) => x.name).filter((v, i, a) => a.indexOf(v) === i).join('・')}）は
              <Link to={`/materials/${company.code}`}>資料一覧</Link>から提出します。
            </div>
          </nav>
          <FormEditor
            key={`${form.code}|${current.d}`}
            form={form}
            issueNo={issueNo(form.issueCode)}
            companyId={company.id}
            asOf={current.d}
            dates={dates}
            entry={entryOf(form.code, current.d)}
            priorEntry={(d) => entryOf(form.code, d)}
            enteredBy={enteredBy}
            showExamples={showExamples}
            onSaved={(e) => setSaved((x) => ({ scope, map: { ...(x.scope === scope ? x.map : {}), [e.form_code]: e } }))}
            nextForm={forms[forms.indexOf(form) + 1]}
            onNext={(code) => go(code)}
          />
        </div>
      )}
    </div>
  )
}
