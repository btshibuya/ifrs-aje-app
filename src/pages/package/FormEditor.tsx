// 収集パッケージの1様式の入力欄
// アシスト：入力例・見る場所・用語の説明、全角や△の数字の読み替え、自動計算、整合チェック、
//           前期から大きく変わった項目の理由入力、前回の値のコピー、自動保存

import { useEffect, useRef, useState } from 'react'
import { ErrorBox, formatDateTime } from '../../components/ui'
import type { PackageForm, PkgField } from '../../lib/materials'
import {
  ENTRY_STATUS_LABELS, UNIT, VARIANCE_THRESHOLD, describeChange, firstCompareDate, formatNumber, isNumeric, numericFields, parseNumber, saveDraft,
  setEntryStatus, validate, variance, withComputed, type CompareDates, type EntryData, type PackageEntry, type Problem,
} from '../../lib/package'

const short = (d: string) => {
  const [y, m, day] = d.split('-').map(Number)
  return `${y}/${m}/${day}`
}

interface Props {
  form: PackageForm
  issueNo?: number
  companyId: string
  asOf: string
  dates: CompareDates
  entry?: PackageEntry
  priorEntry: (date: string) => PackageEntry | undefined
  enteredBy: string
  showExamples: boolean
  onSaved: (e: PackageEntry) => void
  nextForm?: PackageForm
  onNext: (code: string) => void
}

export default function FormEditor({ form, issueNo, companyId, asOf, dates, entry, priorEntry, enteredBy, showExamples, onSaved, nextForm, onNext }: Props) {
  const [data, setData] = useState<EntryData>(() => entry?.data ?? {})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(entry?.updated_at ?? null)
  const [error, setError] = useState<string | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const status = entry?.status ?? 'todo'
  const readOnly = status === 'submitted' || status === 'confirmed'

  // 自動保存（入力が止まって1秒後）。入力が変わったときだけ動かすため、依存は data と dirty に絞る
  const latest = useRef(data)
  latest.current = data
  useEffect(() => {
    if (!dirty || readOnly) return
    const t = setTimeout(() => void save(), 1000)
    return () => clearTimeout(t)
  }, [data, dirty])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const e = await saveDraft(companyId, asOf, form, latest.current, enteredBy)
      onSaved(e)
      setSavedAt(e.updated_at)
      setDirty(false)
      return e
    } catch (e) {
      setError((e as Error).message)
      return null
    } finally {
      setSaving(false)
    }
  }

  const update = (fn: (d: EntryData) => EntryData) => {
    setData((d) => fn(d))
    setDirty(true)
  }

  const fields = withComputed(form, data.fields ?? {})
  const priorFieldValue = (f: PkgField, date: string) => priorEntry(date)?.data.fields?.[f.key]
  // 期首残高のように前年度末の期末残高と一致するはずの項目
  const carried = (f: PkgField) => (f.carryFrom ? priorEntry(dates.priorYearEnd)?.data.fields?.[f.carryFrom] : undefined)
  const problems = validate(form, data, (f) => (f.carryFrom ? carried(f) : priorFieldValue(f, firstCompareDate(f, dates))))
  const problemFor = (key: string) => problems.find((p) => p.key === key)

  // 前回の値をコピー：直前四半期、なければ前年度末の提出内容から（自動計算の項目は除く）
  const source = priorEntry(dates.prevQuarter) ?? priorEntry(dates.priorYearEnd)
  const copyPrior = () => {
    if (!source) return
    const filled = form.fields ? Object.values(data.fields ?? {}).some((v) => v !== null && v !== '') : (data.rows ?? []).length > 0
    if (filled && !confirm('入力済みの内容を、前回の値で置き換えますか？')) return
    update((d) => form.fields
      ? { ...d, fields: Object.fromEntries(form.fields.filter((f) => !f.compute).map((f) => [f.key, source.data.fields?.[f.key] ?? null])) }
      : { ...d, rows: (source.data.rows ?? []).map((r) => ({ ...r })), none: false })
  }

  const act = async (fn: () => Promise<PackageEntry>) => {
    setError(null)
    try {
      onSaved(await fn())
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const submit = async () => {
    if (problems.length > 0) {
      setShowProblems(true)
      document.getElementById(`pf-${problems[0].key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    const saved = dirty || !entry ? await save() : entry
    if (!saved) return
    await act(() => setEntryStatus(saved.id, 'submitted', { entered_by: enteredBy || saved.entered_by }))
  }

  const filledCount = form.fields
    ? form.fields.filter((f) => !f.compute && fields[f.key] !== null && fields[f.key] !== undefined && fields[f.key] !== '').length
    : (data.rows ?? []).length
  const totalCount = form.fields ? form.fields.filter((f) => !f.compute).length : null

  return (
    <section className="pkg-form" aria-label={form.title}>
      <div className="pkg-form-head">
        <div>
          <h2><span className="issue-no-sm">{issueNo}</span>{form.title}</h2>
          <p className="small">{form.intro}</p>
        </div>
        <span className={`badge mst-badge-${status}`}>{ENTRY_STATUS_LABELS[status]}</span>
      </div>

      {entry?.return_note && status === 'draft' && (
        <div className="alert alert-warn"><b>親会社から差し戻されました：</b>{entry.return_note}</div>
      )}
      {status === 'submitted' && <div className="alert alert-info">提出済みです。親会社の確認を待っています。直すときは「提出を取り消す」を押してください。</div>}
      {status === 'confirmed' && <div className="alert alert-ok">親会社が確認しました（{entry?.confirmed_by ?? ''} {formatDateTime(entry?.confirmed_at ?? null)}）。</div>}

      <div className="pkg-legend small">
        <span><b>比べる値：</b>残高・率（BS）は<b>前年度末</b>、期間の金額（PL）は<b>前年同期</b>。どちらも<b>直前四半期</b>を並べます。</span>
        {!readOnly && source && <button className="btn btn-sm" onClick={copyPrior}>前回（{short(source.as_of)}）の値をコピー</button>}
      </div>

      {form.fields && (
        <div className="pf-grid" role="table" aria-label="入力欄">
          <div className="pf-row pf-header" role="row">
            <div role="columnheader">項目</div>
            <div role="columnheader">今回の値（{short(asOf)}）</div>
            <div role="columnheader">前期の値・増減</div>
          </div>
          {form.fields.map((f) => {
            const cmpDate = firstCompareDate(f, dates)
            const p1 = priorFieldValue(f, cmpDate)
            const p2 = priorFieldValue(f, dates.prevQuarter)
            const cf = carried(f)
            const vr = f.carryFrom ? null : variance(fields[f.key], p1)
            const big = !f.compute && vr !== null && Math.abs(vr) >= VARIANCE_THRESHOLD
            const pr = problemFor(f.key)
            return (
              <div className={`pf-row${pr && showProblems ? ' has-problem' : ''}`} role="row" key={f.key} id={`pf-${f.key}`}>
                <div className="pf-label" role="cell">
                  <div><b>{f.label}</b>{f.required && !f.compute && <span className="req">必須</span>}{f.basis && <span className="basis">{f.basis === 'stock' ? 'BS' : 'PL'}</span>}</div>
                  <div className="small pf-help">{f.help}</div>
                  {f.where && <div className="small muted">見る場所：{f.where}</div>}
                </div>
                <div className="pf-input" role="cell">
                  <FieldInput field={f} value={fields[f.key]} disabled={readOnly || !!f.compute}
                    onChange={(v) => update((d) => ({ ...d, fields: { ...(d.fields ?? {}), [f.key]: v } }))} />
                  {f.carryFrom && typeof cf === 'number' && fields[f.key] !== cf && !readOnly && (
                    <button className="btn btn-sm pf-carry" onClick={() => update((d) => ({ ...d, fields: { ...(d.fields ?? {}), [f.key]: cf } }))}>
                      前年度末の期末残高 {formatNumber(cf, f.type)}{UNIT[f.type]} を入れる
                    </button>
                  )}
                  {showExamples && <div className="pf-example">入力例：{isNumeric(f) ? `${formatNumber(f.example, f.type)}${UNIT[f.type]}` : String(f.example)}</div>}
                  {pr && showProblems && <div className="small text-error">{pr.message}</div>}
                </div>
                <div className="pf-compare" role="cell">
                  {f.carryFrom ? (
                    <>
                      <CompareValue label={`前年度末の期末残高（${short(dates.priorYearEnd)}）`} field={f} value={cf} />
                      {typeof cf === 'number' && typeof fields[f.key] === 'number' && (
                        <div className={`pf-delta${Math.abs(cf - (fields[f.key] as number)) >= 1 ? ' big' : ''}`}>{Math.abs(cf - (fields[f.key] as number)) >= 1 ? '一致しません' : '✓ 一致'}</div>
                      )}
                    </>
                  ) : f.basis ? (
                    <>
                      <CompareValue label={`${f.basis === 'flow' ? '前年同期' : '前年度末'}（${short(cmpDate)}）`} field={f} value={p1} />
                      <CompareValue label={`直前四半期（${short(dates.prevQuarter)}）`} field={f} value={p2} />
                      {vr !== null && <div className={`pf-delta${big ? ' big' : ''}`}>{vr > 0 ? '▲' : vr < 0 ? '▼' : '±'} {describeChange(fields[f.key] as number, p1 as number, UNIT[f.type])}</div>}
                    </>
                  ) : (
                    <CompareValue label={`前回（${short(dates.prevQuarter)}）`} field={f} value={p2 ?? priorFieldValue(f, dates.priorYearEnd)} />
                  )}
                </div>
                {big && (
                  <div className="pf-reason" role="cell">
                    <label className="small">
                      <b>前期から{describeChange(fields[f.key] as number, p1 as number, UNIT[f.type])}。</b>理由を簡単に書いてください（例：昇給により日額が増えた）
                      <textarea rows={2} disabled={readOnly} value={data.reasons?.[f.key] ?? ''}
                        onChange={(e) => update((d) => ({ ...d, reasons: { ...(d.reasons ?? {}), [f.key]: e.target.value } }))} />
                    </label>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {form.checks && form.checks.length > 0 && (
        <div className="pf-checks">
          {form.checks.map((c) => {
            const nums = numericFields(form, fields)
            const exp = c.expected(nums)
            const act = nums[c.actualKey]
            const ok = exp !== null && act !== null && Math.abs(exp - act) < 1
            return (
              <div key={c.label} className={`pf-check ${exp === null || act === null ? 'pending' : ok ? 'ok' : 'ng'}`}>
                <span aria-hidden>{exp === null || act === null ? '…' : ok ? '✓' : '!'}</span>
                <div>
                  <b>{c.label}</b> <span className="small muted">{c.formula}</span>
                  {exp !== null && act !== null && !ok && <div className="small">計算上は {exp.toLocaleString('ja-JP')} ／ 入力は {act.toLocaleString('ja-JP')}（差額 {(act - exp).toLocaleString('ja-JP')}）</div>}
                  {(exp === null || act === null) && <div className="small muted">関係する項目を入力すると確認します</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {form.table && (
        <TableEditor form={form} data={data} readOnly={readOnly} showExamples={showExamples} dates={dates} priorEntry={priorEntry}
          showProblems={showProblems} problems={problems} update={update} />
      )}

      <label className="pf-note">
        <span className="small"><b>備考</b>（任意：補足や、わからなかった点）</span>
        <textarea rows={2} disabled={readOnly} value={data.note ?? ''} onChange={(e) => update((d) => ({ ...d, note: e.target.value }))} />
      </label>

      {error && <ErrorBox message={error} />}
      {showProblems && problems.length > 0 && (
        <div className="alert alert-warn">
          <b>提出の前に確認してください（{problems.length}件）</b>
          <ul>{problems.map((p, i) => <li key={i}><button className="btn-link" onClick={() => document.getElementById(`pf-${p.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>{p.message}</button></li>)}</ul>
        </div>
      )}

      <div className="pkg-actionbar">
        <div className="small muted">
          {totalCount !== null ? `入力 ${filledCount}/${totalCount}項目` : `明細 ${filledCount}行`}
          {' ・ '}
          {saving ? '保存中…' : dirty ? '未保存の変更あり' : savedAt ? `保存済み ${formatDateTime(savedAt)}` : 'まだ保存していません'}
        </div>
        <div className="actions">
          {!readOnly && <button className="btn" disabled={saving || !dirty} onClick={() => void save()}>下書き保存</button>}
          {!readOnly && <button className="btn btn-primary" disabled={saving} onClick={() => void submit()}>提出する</button>}
          {status === 'submitted' && <button className="btn" onClick={() => act(() => setEntryStatus(entry!.id, 'draft'))}>提出を取り消す</button>}
          {readOnly && nextForm && <button className="btn btn-primary" onClick={() => onNext(nextForm.code)}>次の様式へ：{nextForm.title}</button>}
        </div>
      </div>

      {(status === 'submitted' || status === 'confirmed') && (
        <div className="card parent-review">
          <div className="card-title">親会社の確認 <span className="small muted">（親会社の担当者が操作します）</span></div>
          <div className="actions">
            {status === 'submitted' && <button className="btn btn-primary" onClick={() => act(() => setEntryStatus(entry!.id, 'confirmed', { confirmed_by: enteredBy || '親会社' }))}>確認済にする</button>}
            <button className="btn btn-danger-outline" onClick={() => {
              const note = prompt('差し戻す理由を入力してください（担当者の画面に表示されます）')
              if (note) void act(() => setEntryStatus(entry!.id, 'draft', { return_note: note }))
            }}>差し戻す</button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

function FieldInput({ field, value, disabled, onChange, compact }: {
  field: PkgField; value: unknown; disabled: boolean; onChange: (v: unknown) => void; compact?: boolean
}) {
  const [text, setText] = useState(() => (isNumeric(field) ? formatNumber(value, field.type) : String(value ?? '')))
  const [focused, setFocused] = useState(false)
  // 外から値が変わったとき（コピーなど）に表示を合わせる。入力中（focused）の表示は上書きしない
  useEffect(() => {
    if (!focused) setText(isNumeric(field) ? formatNumber(value, field.type) : String(value ?? ''))
  }, [value])

  const label = compact ? field.label : undefined
  if (field.type === 'select') {
    return (
      <select aria-label={label ?? field.label} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">選んでください</option>
        {field.options!.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    )
  }
  if (field.type === 'date') {
    return <input type="date" aria-label={field.label} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)} />
  }
  if (!isNumeric(field)) {
    return <input aria-label={field.label} disabled={disabled} value={text} onChange={(e) => { setText(e.target.value); onChange(e.target.value) }} />
  }
  const parsed = parseNumber(text)
  return (
    <div className={`num-input${parsed === 'error' ? ' invalid' : ''}`}>
      <input
        aria-label={field.label}
        inputMode="decimal"
        disabled={disabled}
        value={text}
        placeholder={field.compute ? '自動計算' : ''}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          setText(e.target.value)
          const v = parseNumber(e.target.value)
          onChange(v === 'error' ? e.target.value : v)
        }}
        onBlur={() => {
          setFocused(false)
          const v = parseNumber(text)
          if (v !== 'error') setText(formatNumber(v, field.type))
        }}
      />
      {UNIT[field.type] && <span className="unit">{UNIT[field.type]}</span>}
    </div>
  )
}

function CompareValue({ label, field, value }: { label: string; field: PkgField; value: unknown }) {
  const has = value !== null && value !== undefined && value !== ''
  return (
    <div className="cmp">
      <span className="cmp-label">{label}</span>
      <span className={`cmp-value${has ? '' : ' muted'}`}>{has ? (isNumeric(field) ? `${formatNumber(value, field.type)}${UNIT[field.type]}` : String(value)) : '—'}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 明細の様式（行を追加して入力）。スマホ幅では1行を1枚のカードにする
// ---------------------------------------------------------------------------

function TableEditor({ form, data, readOnly, showExamples, dates, priorEntry, showProblems, problems, update }: {
  form: PackageForm; data: EntryData; readOnly: boolean; showExamples: boolean; dates: CompareDates
  priorEntry: (date: string) => PackageEntry | undefined; showProblems: boolean; problems: Problem[]
  update: (fn: (d: EntryData) => EntryData) => void
}) {
  const t = form.table!
  const rows = data.rows ?? []
  const keyOf = (r: Record<string, unknown>) => String(r[t.keyColumn] ?? '').trim()
  const priorRow = (date: string, key: string) => priorEntry(date)?.data.rows?.find((r) => keyOf(r) === key)
  const setCell = (i: number, k: string, v: unknown) => update((d) => ({ ...d, rows: (d.rows ?? []).map((r, j) => (j === i ? { ...r, [k]: v } : r)) }))
  const prior = priorEntry(dates.priorYearEnd)
  // 前期にあって今回ない行（売却・解約などの確認）
  const gone = rows.length === 0 ? [] : (prior?.data.rows ?? []).filter((r) => !rows.some((x) => keyOf(x) === keyOf(r)))

  return (
    <div className="pt" id="pf-rows">
      <label className="check-inline">
        <input type="checkbox" disabled={readOnly} checked={!!data.none} onChange={(e) => update((d) => ({ ...d, none: e.target.checked }))} /> {t.emptyLabel}
      </label>
      {!data.none && (
        <>
          <div className="table-wrap">
            <table className="pt-table">
              <thead>
                <tr>
                  <th className="pt-no">#</th>
                  {t.columns.map((c) => (
                    <th key={c.key} title={c.help}>
                      {c.label}{c.required && <span className="req">必須</span>}{c.basis && <span className="basis">{c.basis === 'stock' ? 'BS' : 'PL'}</span>}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {showExamples && t.example.map((ex, i) => (
                  <tr key={`ex${i}`} className="pt-example">
                    <td className="pt-no">例</td>
                    {t.columns.map((c) => (
                      <td key={c.key} data-label={c.label} className={isNumeric(c) ? 'num' : ''}>
                        {isNumeric(c) ? `${formatNumber(ex[c.key], c.type)}${UNIT[c.type]}` : String(ex[c.key] ?? '')}
                      </td>
                    ))}
                    <td className="small muted">入力例</td>
                  </tr>
                ))}
                {rows.map((r, i) => {
                  const k = keyOf(r)
                  return (
                    <tr key={i} id={`pf-rows.${i}`}>
                      <td className="pt-no">{i + 1}</td>
                      {t.columns.map((c) => {
                        const pr = showProblems ? problems.find((p) => p.key === `rows.${i}.${c.key}`) : undefined
                        const p1 = c.basis && k ? priorRow(firstCompareDate(c, dates), k)?.[c.key] : undefined
                        const p2 = c.basis && k ? priorRow(dates.prevQuarter, k)?.[c.key] : undefined
                        return (
                          <td key={c.key} data-label={c.label} className={pr ? 'has-problem' : ''}>
                            <FieldInput field={c} value={r[c.key]} disabled={readOnly} compact onChange={(v) => setCell(i, c.key, v)} />
                            {c.basis && (p1 !== undefined || p2 !== undefined) && (
                              <div className="pt-prior small muted">
                                {c.basis === 'flow' ? '前年同期' : '前年度末'} {p1 !== undefined ? `${formatNumber(p1, c.type)}` : '—'}
                                {' ／ 直前Q '}{p2 !== undefined ? formatNumber(p2, c.type) : '—'}
                              </div>
                            )}
                            {pr && <div className="small text-error">{pr.message.replace(/^\d+行目の/, '')}</div>}
                          </td>
                        )
                      })}
                      <td>
                        {!readOnly && <button className="btn-link text-error" aria-label={`${i + 1}行目を削除`} onClick={() => update((d) => ({ ...d, rows: (d.rows ?? []).filter((_, j) => j !== i) }))}>削除</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!readOnly && (
            <div className="actions">
              <button className="btn" onClick={() => update((d) => ({ ...d, rows: [...(d.rows ?? []), {}] }))}>＋ 行を追加</button>
            </div>
          )}
          {gone.length > 0 && (
            <div className="alert alert-warn small">
              前年度末にあって今回の明細にないもの：{gone.map(keyOf).join('、')}。売却・解約などで無くなった場合は、備考に書いてください。
            </div>
          )}
        </>
      )}
      {showProblems && problems.filter((p) => p.key === 'rows').map((p) => <div key={p.message} className="small text-error">{p.message}</div>)}
    </div>
  )
}
