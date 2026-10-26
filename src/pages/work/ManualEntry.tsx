// 明細の手入力（1件ずつ／合計で）。ファイルが出せないときの代わりの入り口
// 入力した内容はCSVにして元資料として保存する（ハッシュ値で、あとから書き換えられていないかを確かめられる）
// 入力途中の内容はこのブラウザに残し、画面を閉じても消えないようにする

import { useEffect, useMemo, useState, type ClipboardEvent } from 'react'
import { useFeedback } from '../../components/feedback'
import { ErrorBox } from '../../components/ui'
import type { FieldDef, IssueConfig } from '../../lib/issues'
import { parseDateInput, parseNumber } from '../../lib/package'
import { commitRows, type ItemRow, type Period } from '../../lib/workflow'

export type ManualMode = 'detail' | 'aggregate'

type Cells = Record<string, string>
interface Col extends FieldDef { help?: string; placeholder?: string; extra?: boolean }

const fmtNum = (n: number) => n.toLocaleString('ja-JP', { maximumFractionDigits: 2 })

const csvEsc = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const draftKey = (periodId: string, issue: string, mode: ManualMode) => `manual:${periodId}:${issue}:${mode}`
const readDraft = (k: string): Cells[] | null => {
  try {
    const v = localStorage.getItem(k)
    return v ? (JSON.parse(v) as Cells[]) : null
  } catch {
    return null
  }
}
const writeDraft = (k: string, rows: Cells[] | null) => {
  try {
    if (rows) localStorage.setItem(k, JSON.stringify(rows))
    else localStorage.removeItem(k)
  } catch {
    // 保存できなくても入力は続けられる
  }
}

export default function ManualEntry({ period, cfg, mode, items, locked, onDone }: {
  period: Period; cfg: IssueConfig; mode: ManualMode; items: ItemRow[]; locked: boolean; onDone: (n: number) => void
}) {
  const fb = useFeedback()
  const agg = cfg.manual.aggregate
  const isAgg = mode === 'aggregate'

  // 入力する列：合計のときは項目名を言い換え、人数・件数（と、加重平均の補助）を足す
  const cols: Col[] = useMemo(() => {
    const base: Col[] = cfg.fields
      .filter((f) => !(isAgg && agg.autoKey && f.key === cfg.keyField))
      .map((f) => ({ ...f, label: (isAgg ? agg.labels[f.key] : undefined) ?? f.label, placeholder: isAgg ? agg.placeholders[f.key] : undefined }))
    if (!isAgg) return base
    const count: Col = { key: 'count', label: agg.countLabel, type: 'number', required: false, extra: true, placeholder: '例：12' }
    const withCount = [...base.slice(0, 2), count, ...base.slice(2)]
    if (agg.helper === 'weighted_wage') {
      withCount.push({ key: 'wage_base', label: '残日数×日額給与の合計（任意）', type: 'number', required: false, extra: true, help: '入れると、日額給与を自動で計算します', placeholder: '例：11,700,800' })
    }
    return withCount
  }, [cfg, isAgg, agg])

  const fromItems = (): Cells[] => {
    const own = items.filter((i) => (isAgg ? i.data.input_mode === 'aggregate' : i.data.input_mode !== 'aggregate'))
    return own.map((i) => Object.fromEntries(cols.map((c) => {
      const v = i.data[c.key]
      if (v === null || v === undefined) return [c.key, '']
      if (c.type === 'date') return [c.key, String(v).replaceAll('-', '/').slice(0, isAgg && c.key === 'acquired_on' ? 7 : 10)]
      if (c.type === 'number') return [c.key, fmtNum(Number(v))]
      return [c.key, String(v)]
    })))
  }
  const key = draftKey(period.id, cfg.code, mode)
  const empty = (): Cells => Object.fromEntries(cols.map((c) => [c.key, '']))
  const [rows, setRows] = useState<Cells[]>(() => {
    const d = readDraft(key)
    if (d && d.length) return d
    const x = fromItems()
    return x.length ? x : [empty(), empty(), empty()]
  })
  const [fromDraft] = useState(() => !!readDraft(key)?.length)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  useEffect(() => { if (touched) writeDraft(key, rows) }, [rows, touched, key])

  // 1行を読む（エラーは列ごと）
  const readRow = (r: Cells) => {
    const data: Record<string, unknown> = {}
    const errors: Record<string, string> = {}
    for (const c of cols) {
      const raw = (r[c.key] ?? '').trim()
      if (c.type === 'number') {
        const n = parseNumber(raw)
        if (n === 'error') errors[c.key] = '数字で入力してください'
        else data[c.key] = n
      } else if (c.type === 'date') {
        const d = parseDateInput(raw, isAgg && c.key === 'acquired_on')
        if (d === 'error') errors[c.key] = '日付を読めません（例：2024/04/01）'
        else data[c.key] = d
      } else data[c.key] = raw === '' ? null : raw
    }
    // 加重平均の補助：残日数×日額給与の合計 ÷ 残日数の合計
    if (agg.helper === 'weighted_wage' && isAgg && typeof data.wage_base === 'number' && typeof data.unused_days === 'number' && data.unused_days > 0 && (data.daily_wage === null || data.daily_wage === undefined)) {
      data.daily_wage = Math.round((data.wage_base / data.unused_days) * 100) / 100
    }
    if (isAgg && agg.autoKey === 'asset_group' && data.asset_type && data.acquired_on) {
      data[cfg.keyField] = `${String(data.asset_type)}-${String(data.acquired_on).slice(0, 7)}${data.disposed_on ? `-除却${String(data.disposed_on).slice(0, 7)}` : ''}`
    }
    const blank = cols.every((c) => (r[c.key] ?? '').trim() === '')
    if (!blank) {
      for (const f of cfg.fields) {
        if (f.required && (data[f.key] === null || data[f.key] === undefined || data[f.key] === '') && !errors[f.key]) {
          errors[f.key] = isAgg && f.key === cfg.keyField && agg.autoKey ? '' : '必須です'
          if (isAgg && f.key === 'daily_wage' && agg.helper) errors[f.key] = '日額給与か、残日数×日額給与の合計を入れてください'
        }
      }
      for (const k of Object.keys(errors)) if (errors[k] === '') delete errors[k]
    }
    return { data, errors, blank }
  }
  const parsed = rows.map(readRow)
  const keyCount = new Map<string, number>()
  for (const p of parsed) if (!p.blank) keyCount.set(String(p.data[cfg.keyField] ?? ''), (keyCount.get(String(p.data[cfg.keyField] ?? '')) ?? 0) + 1)
  const dupOf = (p: (typeof parsed)[number]) => !p.blank && (keyCount.get(String(p.data[cfg.keyField] ?? '')) ?? 0) > 1
  const filled = parsed.filter((p) => !p.blank)
  const errorCount = filled.filter((p) => Object.keys(p.errors).length > 0 || dupOf(p)).length
  const num = (v: unknown) => (typeof v === 'number' ? v : 0)
  // 合計の行：金額・日数は合計、日額給与は残日数で加重平均（単価を足しても意味がないため）、耐用年数は出さない
  const totals = cols.filter((c) => c.type === 'number' && c.key !== 'jgaap_life').map((c) => {
    if (c.key === 'daily_wage') {
      const days = filled.reduce((s, p) => s + num(p.data.unused_days), 0)
      return { c, sum: days ? filled.reduce((s, p) => s + num(p.data.unused_days) * num(p.data.daily_wage), 0) / days : 0, avg: true }
    }
    return { c, sum: filled.reduce((s, p) => s + num(p.data[c.key]), 0), avg: false }
  })

  const set = (i: number, k: string, v: string) => {
    setTouched(true)
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  }
  const addRows = (n = 1) => { setTouched(true); setRows((rs) => [...rs, ...Array.from({ length: n }, empty)]) }
  const removeRow = (i: number) => { setTouched(true); setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [empty()])) }

  // Excel からの貼り付け：タブ・改行で区切って、押した欄から右・下へ入れる（見出しの行は飛ばす）
  const onPaste = (e: ClipboardEvent<HTMLInputElement>, i: number, colIdx: number) => {
    const text = e.clipboardData.getData('text/plain')
    if (!/[\t\n]/.test(text.trim())) return
    e.preventDefault()
    let lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '').map((l) => l.split('\t'))
    const isHeader = (cells: string[]) => cells.some((x) => cols.some((c) => c.label.startsWith(x.trim()) && x.trim() !== '') || cfg.fields.some((f) => f.label === x.trim()))
    if (lines.length && isHeader(lines[0])) lines = lines.slice(1)
    setTouched(true)
    setRows((rs) => {
      const next = [...rs]
      lines.forEach((cells, k) => {
        const at = i + k
        while (next.length <= at) next.push(empty())
        const r = { ...next[at] }
        cells.forEach((v, m) => {
          const c = cols[colIdx + m]
          if (!c) return
          const n = c.type === 'number' ? parseNumber(v) : null
          r[c.key] = typeof n === 'number' ? fmtNum(n) : v.trim()
        })
        next[at] = r
      })
      return next
    })
    fb.toast(`${lines.length}行を貼り付けました`)
  }

  const save = async () => {
    if (filled.length === 0) return setError('入力がありません')
    if (errorCount > 0) return setError(`入力を確認してください（${errorCount}行）。赤い欄にカーソルを合わせると理由が出ます。`)
    const ok = await fb.confirm({
      title: `${filled.length}${isAgg ? '区分' : '件'}を保存しますか？`, confirmLabel: '保存する',
      body: (
        <ul>
          <li>この期・論点の明細を、入力した内容で入れ替えます{items.length ? `（いまの明細 ${items.length}件は置き換わります）` : ''}。</li>
          <li>確定前の計算は削除されます。保存したあと「明細チェック」→「計算シート」へ進みます。</li>
          <li>入力内容はCSVにして元資料として保存し、ハッシュ値で書き換えがないことを確かめられます。</li>
        </ul>
      ),
    })
    if (ok === null) return
    setBusy(true)
    setError(null)
    try {
      const fields = [...cfg.fields.map((f) => f.key), ...cols.filter((c) => c.extra).map((c) => c.key)]
      const labels = fields.map((k) => cols.find((c) => c.key === k)?.label ?? cfg.fields.find((f) => f.key === k)?.label ?? k)
      const csv = '﻿' + [labels, ...filled.map((p) => fields.map((k) => p.data[k]))].map((r) => r.map(csvEsc).join(',')).join('\r\n')
      const buf = new TextEncoder().encode(csv).buffer as ArrayBuffer
      const n = await commitRows(period, cfg, {
        fileName: `${isAgg ? '合計入力' : '手入力'}_${cfg.sourceLabel}_${period.companies.code}_${period.label}.csv`,
        buf, fileType: 'manual', contentType: 'text/csv',
        rows: filled.map((p, k) => ({
          rowNo: k + 2, itemKey: String(p.data[cfg.keyField]),
          data: { ...p.data, input_mode: mode },
        })),
      })
      writeDraft(key, null)
      setTouched(false)
      onDone(n)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card manual-entry">
      <div className="card-title">
        <span>{isAgg ? agg.title : `${cfg.manual.unitLabel}ごとに入力する（${cfg.sourceLabel}）`}</span>
        <span className="small muted">{fromDraft ? '入力途中の内容を復元しました' : items.length ? 'いまの明細を読み込みました（編集して保存できます）' : ''}</span>
      </div>
      {isAgg ? (
        <div className="manual-guide">
          <p>{agg.lead}</p>
          <details open>
            <summary>計算の精度を保つコツ</summary>
            <ul>{agg.tips.map((t) => <li key={t}>{t}</li>)}</ul>
          </details>
        </div>
      ) : (
        <ul className="small muted manual-tips">{cfg.manual.detailTips.map((t) => <li key={t}>{t}</li>)}</ul>
      )}
      {locked && <div className="alert alert-info">確定済みのため入力できません。入力し直すには、仕訳タブで確定を解除してください。</div>}
      <div className="table-wrap manual-wrap">
        <table className="compact manual-table">
          <thead>
            <tr>
              <th className="num">#</th>
              {cols.map((c) => (
                <th key={c.key} className={c.type === 'number' ? 'num' : ''} title={c.help}>
                  {c.label}{cfg.fields.find((f) => f.key === c.key)?.required && !(isAgg && agg.helper && c.key === 'daily_wage') && <span className="req">必須</span>}
                  {c.help && <div className="small muted manual-th-help">{c.help}</div>}
                </th>
              ))}
              {isAgg && agg.autoKey && <th>番号（自動）</th>}
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const p = parsed[i]
              return (
                <tr key={i} className={dupOf(p) ? 'row-error' : ''}>
                  <td className="num muted">{i + 1}</td>
                  {cols.map((c, ci) => {
                    const err = p.errors[c.key] ?? (dupOf(p) && c.key === cfg.keyField ? '番号が重複しています' : undefined)
                    const auto = isAgg && agg.helper === 'weighted_wage' && c.key === 'daily_wage' && (r.daily_wage ?? '').trim() === '' && typeof p.data.daily_wage === 'number'
                    return (
                      <td key={c.key} className={err ? 'cell-error' : ''}>
                        <input
                          className={`manual-input${c.type === 'number' ? ' num' : ''}`} value={r[c.key] ?? ''} disabled={locked}
                          inputMode={c.type === 'number' ? 'decimal' : undefined}
                          placeholder={auto ? `自動：${fmtNum(p.data.daily_wage as number)}` : i === 0 ? c.placeholder ?? (c.type === 'date' ? '2024/04/01' : '') : ''}
                          aria-label={`${i + 1}行目 ${c.label}`} aria-invalid={!!err} title={err}
                          onChange={(e) => set(i, c.key, e.target.value)}
                          onPaste={(e) => onPaste(e, i, ci)}
                          onBlur={(e) => {
                            // 数字は桁区切りに整える
                            if (c.type === 'number') { const n = parseNumber(e.target.value); if (typeof n === 'number') set(i, c.key, fmtNum(n)) }
                          }}
                        />
                        {err && <div className="cell-error-text">{err}</div>}
                      </td>
                    )
                  })}
                  {isAgg && agg.autoKey && <td className="small mono muted nowrap">{p.blank ? '' : String(p.data[cfg.keyField] ?? '—')}</td>}
                  <td className="nowrap"><button className="btn-link text-error small" disabled={locked} onClick={() => removeRow(i)} aria-label={`${i + 1}行目を削除`}>削除</button></td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="subtotal">
              <td />
              {cols.map((c) => {
                const t = totals.find((x) => x.c.key === c.key)
                return <td key={c.key} className="num">{c === cols[0] ? `${filled.length}${isAgg ? '区分' : '件'}` : t && t.sum !== 0 ? <>{t.avg && <span className="small muted">加重平均 </span>}{fmtNum(Math.round(t.sum * 100) / 100)}</> : ''}</td>
              })}
              {isAgg && agg.autoKey && <td />}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {error && <ErrorBox message={error} />}
      <div className="actions">
        <button className="btn" disabled={locked} onClick={() => addRows(1)}>＋ 1行追加</button>
        <button className="btn" disabled={locked} onClick={() => addRows(10)}>＋ 10行追加</button>
        <span style={{ flex: 1 }} />
        {errorCount > 0 && <span className="small text-error">確認が必要な行 {errorCount}</span>}
        <button className="btn btn-primary" disabled={locked || busy || filled.length === 0} onClick={() => void save()}>
          {busy ? '保存しています…' : `この内容で保存する（${filled.length}${isAgg ? '区分' : '件'}）`}
        </button>
      </div>
    </div>
  )
}
