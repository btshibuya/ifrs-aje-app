// 収集パッケージ：子会社の担当者が、論点ごとの様式に入力して提出する
//   左：様式の一覧（状況つき）／右：入力欄・入力例・前期の値（前年度末または前年同期、直前四半期）
//   入力者と操作ボタンは、様式の一覧の上のバーにまとめる。Excel でダウンロード・アップロードもできる
//   スマホ幅では、様式の一覧を上の選択欄にする

import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ErrorBox, Loading } from '../../components/ui'
import { useFeedback } from '../../components/feedback'
import { exportPackage, importPackage } from '../../lib/packageExcel'
import { useAsync } from '../../lib/hooks'
import { fetchMasters, type PeriodRow } from '../../lib/masters'
import { MATERIALS, PACKAGE_FORMS, formatAsOf, quarterEnds, type PackageForm } from '../../lib/materials'
import {
  ENTRY_STATUS_LABELS, compareDates, fetchEntries, firstCompareDate, saveDraft, type CompareDates, type PackageEntry,
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
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null)
  const [showExamples, setShowExamples] = useState(() => readPref('showExamples', '1') === '1')
  const fb = useFeedback()
  const fileInput = useRef<HTMLInputElement>(null)
  const [excelBusy, setExcelBusy] = useState(false)
  const [importVersion, setImportVersion] = useState(0) // Excel から取り込んだら、入力欄を作り直す
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
    const [entries, policies, leaveItems, accounts] = await Promise.all([
      fetchEntries(company.id, [current.d, dates.priorYearEnd, dates.priorSamePeriod, dates.prevQuarter]),
      supabase.from('v_policy_matrix').select('issue_code, applicability, params').eq('period_id', period.id),
      // 仕訳のプレビュー用：取り込んだ有給休暇の残日数一覧
      supabase.from('detail_items').select('data').eq('period_id', period.id).eq('issue_code', 'PAID_LEAVE'),
      supabase.from('group_accounts').select('code, name'),
    ])
    const pol = must(policies) as { issue_code: string; applicability: string | null; params: Record<string, unknown> }[]
    const applied = new Set(pol.filter((p) => p.applicability === 'applied').map((p) => p.issue_code))
    const items = must(leaveItems) as { data: Record<string, unknown> }[]
    return {
      entries,
      forms: PACKAGE_FORMS.filter((f) => applied.has(f.issueCode)),
      params: Object.fromEntries(pol.map((p) => [p.issue_code, p.params ?? {}])) as Record<string, Record<string, unknown>>,
      leave: items.length ? { count: items.length, base: items.reduce((a, i) => a + Number(i.data.unused_days ?? 0) * Number(i.data.daily_wage ?? 0), 0) } : undefined,
      accounts: new Map((must(accounts) as { code: string; name: string }[]).map((a) => [a.code, a.name])),
    }
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
  const short = (d: string) => d.replaceAll('-', '/')

  // Excel でダウンロード：今の入力内容・入力例・前期の値を入れたブック
  const download = async () => {
    setExcelBusy(true)
    try {
      const blob = await exportPackage({
        companyLabel: `${company.code} ${company.name}`,
        asOf: current.d,
        forms: forms.map((f) => ({
          form: f, no: issueNo(f.issueCode), data: entryOf(f.code, current.d)?.data,
          prior: (fd) => fd.basis
            ? [
              { label: `${fd.basis === 'flow' ? '前年同期' : '前年度末'}（${short(firstCompareDate(fd, dates))}）`, value: entryOf(f.code, firstCompareDate(fd, dates))?.data.fields?.[fd.key] },
              { label: `直前四半期（${short(dates.prevQuarter)}）`, value: entryOf(f.code, dates.prevQuarter)?.data.fields?.[fd.key] },
            ]
            : [{ label: `前回（${short(dates.prevQuarter)}）`, value: entryOf(f.code, dates.prevQuarter)?.data.fields?.[fd.key] }],
        })),
      })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `収集パッケージ_${company.code}_${current.d}.xlsx`
      a.click()
      URL.revokeObjectURL(a.href)
      fb.toast('Excel をダウンロードしました')
    } catch (e) {
      fb.toast(`ダウンロードできませんでした：${(e as Error).message}`, 'error')
    } finally {
      setExcelBusy(false)
    }
  }

  // Excel から取り込む：内容を確かめてから、下書きとして保存する（提出済み・確認済みの様式は変えない）
  const upload = async (file: File | undefined) => {
    if (fileInput.current) fileInput.current.value = ''
    if (!file) return
    setExcelBusy(true)
    try {
      const { imported, unknownSheets } = await importPackage(file, forms)
      if (imported.length === 0) {
        fb.toast('取り込める様式がありませんでした（このアプリでダウンロードした Excel を使ってください）', 'error')
        return
      }
      // 変わったものだけを取り込む（入力値・明細・該当なし・備考を比べる）
      // 項目の並び順の違いは無視して比べる（DBに保存した値は項目の順が変わるため）
      const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && x !== '').sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]))
        : v)
      const same = (a: unknown, b: unknown) => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null))
      const changed = (x: (typeof imported)[number]) => {
        const before = entryOf(x.form.code, current.d)?.data ?? {}
        const bf = Object.fromEntries(Object.entries(before.fields ?? {}).filter(([, v]) => v !== null && v !== ''))
        const af = Object.fromEntries(Object.entries(x.data.fields ?? {}).filter(([, v]) => v !== null && v !== ''))
        const bf2 = Object.fromEntries(Object.entries(bf).filter(([k]) => !x.form.fields?.find((f) => f.key === k)?.compute))
        return !same(bf2, af) || !same(before.rows ?? [], x.data.rows ?? []) || !!before.none !== !!x.data.none || (x.data.note !== undefined && !same(before.note, x.data.note))
      }
      const locked = imported.filter((x) => ['submitted', 'confirmed'].includes(entryOf(x.form.code, current.d)?.status ?? '') && changed(x))
      const targets = imported.filter((x) => !locked.includes(x) && changed(x))
      const unchanged = imported.filter((x) => !changed(x))
      if (targets.length === 0) {
        fb.toast(locked.length ? '変更のある様式は提出済み・確認済みのため、取り込みませんでした' : 'Excel の内容は、今の入力と同じでした（変更なし）', 'info')
        return
      }
      const ok = await fb.confirm({
        title: 'Excel の内容を取り込みますか？',
        confirmLabel: `${targets.length}様式を取り込む`,
        body: (
          <div className="import-summary">
            <p>取り込むと、各様式の入力内容が Excel の内容に置き換わり、下書きとして保存されます（増減の理由は残します）。</p>
            <ul>
              {targets.map((x) => (
                <li key={x.form.code}>
                  <b>{issueNo(x.form.issueCode)}. {x.form.title}</b>：{x.form.fields ? `${x.filled}項目` : x.data.none ? '該当なし' : `明細 ${x.filled}行`}
                  {x.warnings.length > 0 && <div className="small text-error">{x.warnings.slice(0, 3).join('／')}{x.warnings.length > 3 ? ` ほか${x.warnings.length - 3}件` : ''}</div>}
                </li>
              ))}
            </ul>
            {unchanged.length > 0 && <p className="small muted">変更なし（取り込まない）：{unchanged.map((x) => x.form.title).join('、')}</p>}
            {locked.length > 0 && <p className="small muted">提出済み・確認済みのため取り込まない様式：{locked.map((x) => x.form.title).join('、')}</p>}
            {unknownSheets.length > 0 && <p className="small muted">様式として読めなかったシート：{unknownSheets.join('、')}</p>}
          </div>
        ),
      })
      if (ok === null) return
      fb.toast(`${targets.length}様式を取り込んでいます…`, 'info')
      // まとめて保存する（1つずつ待たない）
      const results = await Promise.all(targets.map((x) => {
        const before = entryOf(x.form.code, current.d)?.data ?? {}
        return saveDraft(company.id, current.d, x.form, { ...before, ...x.data, reasons: before.reasons }, enteredBy)
      }))
      setSaved((s) => ({ scope, map: { ...(s.scope === scope ? s.map : {}), ...Object.fromEntries(results.map((e) => [e.form_code, e])) } }))
      setImportVersion((v) => v + 1)
      fb.toast(`${targets.length}様式を取り込みました（下書き）。内容を確かめてから提出してください`)
    } catch (e) {
      fb.toast(`取り込めませんでした：${(e as Error).message}`, 'error')
    } finally {
      setExcelBusy(false)
    }
  }
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
          <label className="check-inline">
            <input type="checkbox" checked={showExamples} onChange={(e) => setShowExamples(e.target.checked)} /> 入力例を表示
          </label>
          <div className="actions excel-actions">
            <button className="btn" disabled={excelBusy || forms.length === 0} onClick={() => void download()}>Excel でダウンロード</button>
            <button className="btn" disabled={excelBusy || forms.length === 0} onClick={() => fileInput.current?.click()}>Excel から取り込む</button>
            <input ref={fileInput} type="file" accept=".xlsx" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          </div>
        </div>
      </div>

      {/* 会社・基準日を切り替えたときは、前の会社の内容を出さない（自動保存が別の会社に入らないようにする） */}
      {detail.loading && <Loading />}
      {detail.error && <ErrorBox message={detail.error} />}
      {!detail.loading && detail.data && forms.length === 0 && <div className="alert alert-info">この会社・基準日に入力する様式はありません（収集パッケージの論点がすべて対象外です）。</div>}
      {/* 入力者と操作ボタン（様式の画面が、ここに出す） */}
      <div ref={setToolbarSlot} className="pkg-toolbar-slot" />
      {!detail.loading && detail.data && form && (
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
            key={`${company.id}|${form.code}|${current.d}|${importVersion}`}
            form={form}
            issueNo={issueNo(form.issueCode)}
            companyId={company.id}
            asOf={current.d}
            dates={dates}
            entry={entryOf(form.code, current.d)}
            priorEntry={(d) => entryOf(form.code, d)}
            enteredBy={enteredBy}
            onEnteredBy={setEnteredBy}
            toolbarSlot={toolbarSlot}
            previewCtx={{
              asOf: current.d, periodStart: period.start_date,
              taxRate: typeof detail.data.params.TAX_EFFECT?.effective_tax_rate === 'number' ? (detail.data.params.TAX_EFFECT.effective_tax_rate as number) : null,
              params: detail.data.params, leave: detail.data.leave,
              other: (code) => entryOf(code, current.d)?.data,
            }}
            accountName={(code) => detail.data!.accounts.get(code)}
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
