// マスタの表を、アプリから追加・編集・非表示・削除できるようにする共通の部品
// 削除は確認してから行い、ほかのデータが使っている場合は（DBの外部キーで）削除できないため、非表示を案内する
// 変更はDBの変更履歴に自動で残る

import { Fragment, useState, type ReactNode } from 'react'
import { useFeedback } from '../../components/feedback'
import { ErrorBox } from '../../components/ui'
import { supabase } from '../../lib/supabase'

export type Row = Record<string, unknown>

export interface Column {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'date' | 'mapping' | 'bool'
  required?: boolean
  options?: { value: string; label: string }[]
  placeholder?: string
  help?: string
  render?: (row: Row) => ReactNode // 一覧での表示
  readOnlyOnEdit?: boolean // 主キーなど、追加のときだけ入力する
  width?: number
  emptyValue?: unknown // 空欄のときに保存する値（既定は null）
}

export interface MasterTableProps {
  table: string
  title: string
  description?: string
  rows: Row[]
  pk: string // 主キーの列
  columns: Column[]
  hidden?: { column: string; inverted?: boolean } // 非表示の列（会社は is_active を逆に使う）
  defaults?: () => Row // 追加のときの初期値
  validate?: (row: Row, isNew: boolean) => string | null
  onChanged: () => void
}

const toInput = (c: Column, v: unknown) => {
  if (v === null || v === undefined) return ''
  if (c.type === 'mapping') return Object.entries(v as Record<string, string>).map(([k, x]) => `${k} = ${x}`).join('\n')
  if (c.type === 'bool') return v ? 'true' : 'false'
  return String(v)
}

function fromInput(c: Column, s: string): unknown {
  const t = s.trim()
  if (c.type === 'mapping') {
    return Object.fromEntries(t.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2 && p[0].trim()).map(([k, ...v]) => [k.trim(), v.join('=').trim()]))
  }
  if (c.type === 'bool') return t === 'true'
  if (t === '') return c.emptyValue ?? null
  if (c.type === 'number') return Number(t.replace(/[,，]/g, ''))
  return t
}

export default function MasterTable({ table, title, description, rows, pk, columns, hidden, defaults, validate, onChanged }: MasterTableProps) {
  const fb = useFeedback()
  const [editing, setEditing] = useState<{ id: unknown; values: Record<string, string> } | null>(null) // id が null なら追加
  const [showHidden, setShowHidden] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const isHidden = (r: Row) => (hidden ? (hidden.inverted ? r[hidden.column] === false : r[hidden.column] === true) : false)
  const visible = rows.filter((r) => showHidden || !isHidden(r))
  const hiddenCount = rows.filter(isHidden).length

  const startAdd = () => {
    const d = defaults?.() ?? {}
    setEditing({ id: null, values: Object.fromEntries(columns.map((c) => [c.key, toInput(c, d[c.key])])) })
    setError(null)
  }
  const startEdit = (r: Row) => {
    setEditing({ id: r[pk], values: Object.fromEntries(columns.map((c) => [c.key, toInput(c, r[c.key])])) })
    setError(null)
  }

  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>, done: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fn()
      if (res.error) throw new Error(res.error.message)
      fb.toast(done)
      setEditing(null)
      onChanged()
    } catch (e) {
      const m = (e as Error).message
      setError(/foreign key|violates/i.test(m) && /delete/i.test(m)
        ? 'ほかのデータ（決算期・明細・仕訳・方針など）が使っているため削除できません。使わなくなった場合は「非表示」にしてください。'
        : /duplicate key/i.test(m) ? '同じコード（または同じ組み合わせ）がすでにあります。' : m)
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!editing) return
    const row: Row = {}
    for (const c of columns) {
      if (editing.id !== null && c.readOnlyOnEdit) continue
      const v = fromInput(c, editing.values[c.key] ?? '')
      if (c.required && (v === null || v === '')) return setError(`「${c.label}」を入力してください`)
      if (c.type === 'number' && v !== null && !Number.isFinite(v as number)) return setError(`「${c.label}」は数字で入力してください`)
      row[c.key] = v
    }
    const msg = validate?.(row, editing.id === null)
    if (msg) return setError(msg)
    if (editing.id === null) void run(() => supabase.from(table).insert(row), `${title}に追加しました`)
    else void run(() => supabase.from(table).update(row).eq(pk, editing.id as string), '変更を保存しました')
  }

  const toggleHidden = (r: Row) => {
    if (!hidden) return
    const nowHidden = isHidden(r)
    const value = hidden.inverted ? nowHidden : !nowHidden
    void run(() => supabase.from(table).update({ [hidden.column]: value }).eq(pk, r[pk] as string), nowHidden ? '表示に戻しました' : '非表示にしました（一覧・計算に使いません）')
  }

  const remove = async (r: Row) => {
    const name = String(r.name ?? r.label ?? r[pk])
    const ok = await fb.confirm({
      title: `「${name}」を削除しますか？`, confirmLabel: '削除する', danger: true,
      body: <ul><li>削除すると元に戻せません（変更履歴には残ります）。</li><li>ほかのデータが使っている場合は削除できません。そのときは「非表示」にしてください。</li></ul>,
    })
    if (ok !== null) await run(() => supabase.from(table).delete().eq(pk, r[pk] as string), '削除しました')
  }

  const editor = editing && (
    <div className="master-editor">
      <div className="master-editor-grid">
        {columns.map((c) => {
          const locked = editing.id !== null && c.readOnlyOnEdit
          const v = editing.values[c.key] ?? ''
          const set = (x: string) => setEditing({ ...editing, values: { ...editing.values, [c.key]: x } })
          return (
            <label key={c.key} className={`master-field${c.type === 'mapping' ? ' wide' : ''}`}>
              <span className="small"><b>{c.label}</b>{c.required && <span className="req">必須</span>}</span>
              {c.type === 'bool' ? (
                <select value={v || 'false'} disabled={locked} onChange={(e) => set(e.target.value)}>
                  <option value="true">はい</option><option value="false">いいえ</option>
                </select>
              ) : c.type === 'select' ? (
                <select value={v} disabled={locked} onChange={(e) => set(e.target.value)}>
                  <option value="">（なし）</option>
                  {c.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : c.type === 'mapping' ? (
                <textarea rows={6} value={v} disabled={locked} onChange={(e) => set(e.target.value)} placeholder={c.placeholder} />
              ) : (
                <input type={c.type === 'date' ? 'date' : 'text'} inputMode={c.type === 'number' ? 'decimal' : undefined} value={v} disabled={locked}
                  placeholder={c.placeholder} onChange={(e) => set(e.target.value)} />
              )}
              {c.help && <span className="small muted">{c.help}</span>}
            </label>
          )
        })}
      </div>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{editing.id === null ? '追加する' : '保存する'}</button>
        <button className="btn" onClick={() => { setEditing(null); setError(null) }}>やめる</button>
      </div>
    </div>
  )

  return (
    <div className="master-table">
      <div className="master-head">
        <div>
          <b>{title}</b> <span className="small muted">{rows.length - hiddenCount}件{hiddenCount ? `（非表示 ${hiddenCount}件）` : ''}</span>
          {description && <div className="small muted">{description}</div>}
        </div>
        <div className="actions">
          {hidden && hiddenCount > 0 && (
            <label className="check-inline small"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> 非表示も表示</label>
          )}
          <button className="btn btn-primary" onClick={startAdd} disabled={!!editing}>＋ 追加</button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {editing?.id === null && editor}
      <div className="table-wrap">
        <table className="compact">
          <thead>
            <tr>{columns.map((c) => <th key={c.key} style={c.width ? { minWidth: c.width } : undefined}>{c.label}</th>)}<th className="master-ops">操作</th></tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <Fragment key={String(r[pk])}>
              <tr className={isHidden(r) ? 'master-hidden' : ''}>
                {columns.map((c) => (
                  <td key={c.key} className={c.type === 'number' ? 'num' : ''}>
                    {c.render ? c.render(r) : c.type === 'bool' ? (r[c.key] ? '○' : '') : c.type === 'select' ? (c.options!.find((o) => o.value === String(r[c.key] ?? ''))?.label ?? String(r[c.key] ?? '')) : String(r[c.key] ?? '')}
                    {c === columns[0] && isHidden(r) && <span className="badge app-not_applicable" style={{ marginLeft: 6 }}>非表示</span>}
                  </td>
                ))}
                <td className="master-ops">
                  <button className="btn-link" onClick={() => startEdit(r)} disabled={!!editing}>編集</button>
                  {hidden && <button className="btn-link" onClick={() => toggleHidden(r)} disabled={busy}>{isHidden(r) ? '表示する' : '非表示'}</button>}
                  <button className="btn-link text-error" onClick={() => void remove(r)} disabled={busy}>削除</button>
                </td>
              </tr>
              {editing && editing.id === r[pk] && (
                <tr className="master-editing"><td colSpan={columns.length + 1}>{editor}</td></tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
