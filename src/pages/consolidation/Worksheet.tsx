// 精算表：科目（行）×仕訳の種類・論点・会社（列）。関係する科目だけを出す
// 上書き前後：前回の集計と比べ、変わったセルに前の金額と差額を出す
// セルを押すと、その金額を作っている仕訳（会社×論点×仕訳区分）を右側に出す

import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { CARRY_METHOD_LABELS } from '../../lib/issues'
import {
  KINDS, KIND_LABELS, SECTION_LABELS, amt, pivot, sectionOf, type Account, type CLine, type Category, type Kind, type Section,
} from '../../lib/consolidation'

export type Axis = 'kind' | 'issue' | 'company'
const AXIS_LABELS: Record<Axis, string> = { kind: '仕訳の種類', issue: '論点別', company: '会社別' }
const KIND_HELP: Record<Kind, string> = {
  opening: '前年度までの調整を期首に入れる仕訳（累積は累計、洗替は前年度末の全額。損益は利益剰余金に置き換え）',
  realization: '洗替の論点で、前年度末の全額を期首に戻し入れる仕訳',
  current: '選んだ時点の各社の計算の仕訳（四半期は期首からの累計）',
}
const SECTIONS: Section[] = ['asset', 'liability', 'equity', 'pl', 'oci']

const fmt = (v: number) => Math.round(Math.abs(v)).toLocaleString('ja-JP')
const diffText = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(v)}`
const same = (a: number, b: number) => Math.round(a) === Math.round(b)

export default function Worksheet({ lines, before, accounts, categories, axis, onAxis, issueName, companyName, companyCode, issueOrder, companyOrder, accountSort }: {
  lines: CLine[]
  before: CLine[] | null
  accounts: Map<string, Account>
  categories: Map<string, Category>
  axis: Axis
  onAxis: (a: Axis) => void
  issueName: (c: string) => string
  companyName: (id: string) => string
  companyCode: (id: string) => string
  issueOrder: (c: string) => number
  companyOrder: (id: string) => number
  accountSort: (a: Account, b: Account) => number
}) {
  const [kinds, setKinds] = useState<Kind[]>(KINDS)
  const [heat, setHeat] = useState(true)
  const [changedOnly, setChangedOnly] = useState(false)
  const [drill, setDrill] = useState<{ account: string; col: string | null } | null>(null)

  const inKinds = (l: CLine) => axis === 'kind' || kinds.includes(l.kind)
  const after = lines.filter(inKinds)
  const prev = before?.filter(inKinds) ?? null
  const colOf = (l: CLine) => (axis === 'kind' ? l.kind : axis === 'issue' ? l.issueCode : l.companyId)
  const A = pivot(after, colOf)
  const B = prev ? pivot(prev, colOf) : null

  const keys = new Set([...after, ...(prev ?? [])].map(colOf))
  const cols: string[] = axis === 'kind' ? KINDS
    : axis === 'issue' ? [...keys].sort((a, b) => issueOrder(a) - issueOrder(b))
      : [...keys].sort((a, b) => companyOrder(a) - companyOrder(b))
  const colLabel = (c: string) => (axis === 'kind' ? KIND_LABELS[c as Kind] : axis === 'issue' ? issueName(c) : companyName(c))
  const colShort = (c: string) => (axis === 'company' ? companyCode(c) : colLabel(c))

  const val = (P: Map<string, Map<string, number>> | null, acc: string, col: string | null) => {
    const row = P?.get(acc)
    if (!row) return 0
    return col === null ? [...row.values()].reduce((s, v) => s + v, 0) : row.get(col) ?? 0
  }
  const changed = (acc: string) => !!B && [...cols, null].some((c) => !same(val(A, acc, c), val(B, acc, c)))

  // 関係する科目だけ（どこかの列に金額がある科目）
  const accs = [...new Set([...A.keys(), ...(B?.keys() ?? [])])]
    .map((code) => accounts.get(code) ?? { code, name: code, statement: 'BS' as const, bs_class: 'equity', pl_class: null })
    .filter((a) => [...cols, null].some((c) => !same(val(A, a.code, c), 0) || (B && !same(val(B, a.code, c), 0))))
    .filter((a) => !changedOnly || changed(a.code))
    .sort(accountSort)
  const changedCount = B ? [...new Set([...A.keys(), ...B.keys()])].filter(changed).length : 0

  const maxAbs = Math.max(1, ...accs.flatMap((a) => cols.map((c) => Math.abs(val(A, a.code, c)))))
  const heatStyle = (v: number) => (heat && !same(v, 0) ? { background: `color-mix(in srgb, var(--primary) ${Math.round(5 + 28 * Math.min(1, Math.abs(v) / maxAbs))}%, transparent)` } : undefined)

  const sumOf = (P: Map<string, Map<string, number>> | null, codes: string[], col: string | null) => codes.reduce((s, c) => s + val(P, c, col), 0)
  const allCodes = [...new Set([...A.keys(), ...(B?.keys() ?? [])])]
  const plCodes = allCodes.filter((c) => { const a = accounts.get(c); return a && sectionOf(a) === 'pl' })
  const ociCodes = allCodes.filter((c) => { const a = accounts.get(c); return a && sectionOf(a) === 'oci' })

  const cell = (key: string, { a, b, onClick, strong, style }: { a: number; b: number | null; onClick?: () => void; strong?: boolean; style?: CSSProperties }) => {
    const diff = b !== null && !same(a, b)
    const content = (
      <>
        <span className={`ws-amt${a < 0 ? ' cr' : ''}`}>{strong ? <b>{amt(a, false)}</b> : amt(a)}</span>
        {diff && (
          <span className="ws-diff">
            <span className="ws-before">前 {amt(b!, false)}</span>
            <span className={`ws-delta ${a - b! > 0 ? 'up' : 'down'}`}>{diffText(a - b!)}</span>
          </span>
        )}
      </>
    )
    return (
      <td key={key} className={`num ws-cell${diff ? ' ws-changed' : ''}`} style={style}>
        {onClick && (!same(a, 0) || diff) ? <button className="ws-btn" onClick={onClick} title="内訳を見る">{content}</button> : content}
      </td>
    )
  }

  const csv = () => {
    const head = ['区分', '科目コード', '科目', ...cols.map(colLabel), '合計', ...(B ? ['前回の集計（合計）', '差額'] : [])]
    const rows = accs.map((a) => [SECTION_LABELS[sectionOf(a)], a.code, a.name, ...cols.map((c) => Math.round(val(A, a.code, c))), Math.round(val(A, a.code, null)),
      ...(B ? [Math.round(val(B, a.code, null)), Math.round(val(A, a.code, null) - val(B, a.code, null))] : [])])
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const blob = new Blob(['﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv' })
    const el = document.createElement('a')
    el.href = URL.createObjectURL(blob)
    el.download = `連結精算表_${AXIS_LABELS[axis]}.csv`
    el.click()
    URL.revokeObjectURL(el.href)
  }

  return (
    <div className="card ws-card">
      <div className="ws-toolbar">
        <div className="ws-tools-left">
          <span className="small muted">列の切り口</span>
          <div className="segmented" role="group" aria-label="列の切り口">
            {(Object.keys(AXIS_LABELS) as Axis[]).map((x) => (
              <button key={x} className={axis === x ? 'on' : ''} aria-pressed={axis === x} onClick={() => onAxis(x)}>{AXIS_LABELS[x]}</button>
            ))}
          </div>
          {axis !== 'kind' && (
            <div className="chips" role="group" aria-label="集計する仕訳">
              {KINDS.map((k) => (
                <button key={k} className={`chip kind-${k}${kinds.includes(k) ? ' on' : ''}`} aria-pressed={kinds.includes(k)}
                  onClick={() => setKinds(kinds.includes(k) ? (kinds.length > 1 ? kinds.filter((x) => x !== k) : kinds) : KINDS.filter((x) => kinds.includes(x) || x === k))}>
                  {KIND_LABELS[k]}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ws-tools-right">
          <label className="check-inline small"><input type="checkbox" checked={heat} onChange={(e) => setHeat(e.target.checked)} /> 金額の大きさを色で表示</label>
          {B && <label className="check-inline small"><input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} /> 変わった科目だけ（{changedCount}）</label>}
          <button className="btn btn-sm" onClick={csv}>CSVで出力</button>
        </div>
      </div>
      {B && (
        <div className={`alert ${changedCount ? 'alert-warn' : 'alert-ok'} ws-compare-note`}>
          {changedCount
            ? <>前回の集計から <b>{changedCount}科目</b> が変わりました。変わったセルに、前の金額（前）と差額を出しています。セルを押すと、どの会社・論点の仕訳が変わったかを確かめられます。</>
            : <>前回の集計から変わった科目はありません。</>}
        </div>
      )}
      {accs.length === 0 ? (
        <p className="muted">集計する仕訳がありません。{lines.length === 0 && '子会社の作業画面で計算すると、ここに集まります。'}</p>
      ) : (
        <div className="table-wrap ws-wrap">
          <table className={`compact ws-table${B ? ' comparing' : ''}`}>
            <thead>
              <tr>
                <th className="ws-acc">科目</th>
                {cols.map((c) => (
                  <th key={c} className={`num ws-col${axis === 'kind' ? ` kind-${c}` : ''}`} title={axis === 'kind' ? KIND_HELP[c as Kind] : colLabel(c)}>
                    {axis === 'kind' && <span className={`kind-dot kind-${c}`} aria-hidden />}{colShort(c)}
                  </th>
                ))}
                <th className="num ws-total">合計{axis === 'kind' && <div className="small muted ws-th-sub">IFRS調整後</div>}</th>
                {B && <th className="num ws-total ws-dhead">差額<div className="small muted ws-th-sub">前回比</div></th>}
              </tr>
            </thead>
            {SECTIONS.map((sec) => {
              const list = accs.filter((a) => sectionOf(a) === sec)
              if (list.length === 0) return null
              const codes = list.map((a) => a.code)
              return (
                <tbody key={sec} className={`ws-section ws-${sec}`}>
                  <tr className="ws-section-head"><th colSpan={cols.length + 2 + (B ? 1 : 0)}>{SECTION_LABELS[sec]}</th></tr>
                  {list.map((a) => (
                    <tr key={a.code} className={`${changed(a.code) ? 'ws-row-changed ' : ''}${drill?.account === a.code ? 'ws-row-on' : ''}`}>
                      <th className="ws-acc" scope="row">{a.name}<span className="ws-code">{a.code}</span></th>
                      {cols.map((c) => (
                        cell(c, { a: val(A, a.code, c), b: B ? val(B, a.code, c) : null, style: heatStyle(val(A, a.code, c)), onClick: () => setDrill({ account: a.code, col: c }) })
                      ))}
                      {cell('total', { a: val(A, a.code, null), b: B ? val(B, a.code, null) : null, strong: true, onClick: () => setDrill({ account: a.code, col: null }) })}
                      {B && <td className={`num ws-dcol${same(val(A, a.code, null), val(B, a.code, null)) ? '' : ' on'}`}>{same(val(A, a.code, null), val(B, a.code, null)) ? '' : diffText(val(A, a.code, null) - val(B, a.code, null))}</td>}
                    </tr>
                  ))}
                  <tr className="subtotal">
                    <th className="ws-acc">{SECTION_LABELS[sec]} 計</th>
                    {cols.map((c) => cell(c, { a: sumOf(A, codes, c), b: B ? sumOf(B, codes, c) : null }))}
                    {cell('total', { a: sumOf(A, codes, null), b: B ? sumOf(B, codes, null) : null, strong: true })}
                    {B && <td className="num ws-dcol">{same(sumOf(A, codes, null), sumOf(B, codes, null)) ? '' : diffText(sumOf(A, codes, null) - sumOf(B, codes, null))}</td>}
                  </tr>
                </tbody>
              )
            })}
            <tfoot>
              <tr className="ws-check">
                <th className="ws-acc">貸借の検証（0になる）</th>
                {[...cols, null].map((c) => {
                  const v = sumOf(A, allCodes, c)
                  return <td key={c ?? 'total'} className={`num ${same(v, 0) ? 'ok-text' : 'text-error'}`}>{same(v, 0) ? '✓ 0' : amt(v, false)}</td>
                })}
                {B && <td />}
              </tr>
              <tr className="ws-profit">
                <th className="ws-acc">当期利益への影響<div className="small muted ws-th-sub">プラス＝利益が増える</div></th>
                {[...cols, null].map((c) => {
                  const v = -sumOf(A, plCodes, c)
                  const b = B ? -sumOf(B, plCodes, c) : null
                  return (
                    <td key={c ?? 'total'} className={`num${v < 0 ? ' text-error' : ''}`}>
                      <b>{same(v, 0) ? '0' : diffText(v).replace('±', '')}</b>
                      {b !== null && !same(v, b) && <div className="ws-before">前 {diffText(b).replace('±', '')}</div>}
                    </td>
                  )
                })}
                {B && <td className="num ws-dcol on">{same(-sumOf(A, plCodes, null), -sumOf(B, plCodes, null)) ? '' : diffText(-sumOf(A, plCodes, null) + sumOf(B, plCodes, null))}</td>}
              </tr>
              {ociCodes.length > 0 && (
                <tr className="ws-profit">
                  <th className="ws-acc">包括利益への影響</th>
                  {[...cols, null].map((c) => {
                    const v = -sumOf(A, [...plCodes, ...ociCodes], c)
                    return <td key={c ?? 'total'} className={`num${v < 0 ? ' text-error' : ''}`}>{same(v, 0) ? '0' : diffText(v).replace('±', '')}</td>
                  })}
                  {B && <td />}
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}
      <div className="small muted ws-legend">
        借方はそのまま、貸方は「△」で表示します（円）。{axis !== 'kind' && `集計する仕訳：${kinds.map((k) => KIND_LABELS[k]).join('・')}。`}
        セルを押すと、その金額の内訳（会社・論点・仕訳区分）を表示します。
      </div>

      {drill && (
        <DrillDrawer
          account={accounts.get(drill.account)?.name ?? drill.account} code={drill.account}
          colLabel={drill.col === null ? '合計' : colLabel(drill.col)}
          after={after.filter((l) => l.account === drill.account && (drill.col === null || colOf(l) === drill.col))}
          before={prev ? prev.filter((l) => l.account === drill.account && (drill.col === null || colOf(l) === drill.col)) : null}
          categories={categories} issueName={issueName} companyName={companyName}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  )
}

function DrillDrawer({ account, code, colLabel, after, before, categories, issueName, companyName, onClose }: {
  account: string; code: string; colLabel: string; after: CLine[]; before: CLine[] | null
  categories: Map<string, Category>; issueName: (c: string) => string; companyName: (id: string) => string; onClose: () => void
}) {
  // 会社×論点×仕訳区分×種類でまとめる（上書き前後の比較もこの単位）
  type G = { key: string; l: CLine; a: number; b: number; sources: Set<string>; periodId?: string }
  const groups = new Map<string, G>()
  const keyOf = (l: CLine) => `${l.companyId}|${l.issueCode}|${l.categoryCode}|${l.kind}`
  for (const l of after) {
    const g = groups.get(keyOf(l)) ?? { key: keyOf(l), l, a: 0, b: 0, sources: new Set<string>(), periodId: l.periodId }
    g.a += l.amount
    if (l.source) g.sources.add(l.sourceAccount && l.sourceAccount !== l.account ? `${l.source}（元の科目：${l.sourceAccount}）` : l.source)
    groups.set(g.key, g)
  }
  for (const l of before ?? []) {
    const g = groups.get(keyOf(l)) ?? { key: keyOf(l), l, a: 0, b: 0, sources: new Set<string>() }
    g.b += l.amount
    groups.set(g.key, g)
  }
  const list = [...groups.values()].filter((g) => !same(g.a, 0) || !same(g.b, 0))
    .sort((x, y) => Number(same(x.a, x.b)) - Number(same(y.a, y.b)) || Math.abs(y.a) - Math.abs(x.a))
  const total = list.reduce((s, g) => s + g.a, 0)
  const totalB = list.reduce((s, g) => s + g.b, 0)
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="精算表の内訳">
        <div className="drawer-head">
          <div><b>{account}</b> <span className="small muted">{code}</span><div className="small muted">{colLabel}</div></div>
          <button className="btn btn-sm" onClick={onClose} autoFocus>閉じる</button>
        </div>
        <div className="drawer-body stack">
          <div className="ws-drill-total">
            <span className="muted small">金額</span>
            <b className="ws-drill-amt">{amt(total, false)}</b>
            {before && !same(total, totalB) && <span className="small">前回の集計 {amt(totalB, false)}（{diffText(total - totalB)}）</span>}
          </div>
          <ul className="ws-drill-list">
            {list.map((g) => {
              const cat = categories.get(g.l.categoryCode)
              const diff = before !== null && !same(g.a, g.b)
              return (
                <li key={g.key} className={diff ? 'changed' : ''}>
                  <div className="ws-drill-head">
                    <span className={`kind-pill kind-${g.l.kind}`}>{KIND_LABELS[g.l.kind]}</span>
                    <b>{companyName(g.l.companyId)}</b>
                    <span className="num ws-drill-amt-sm">{amt(g.a, false)}</span>
                  </div>
                  <div className="small">{issueName(g.l.issueCode)} ／ {cat?.name ?? g.l.categoryCode}{cat && <span className={`badge method-${cat.carry_method}`} style={{ marginLeft: 6 }}>{CARRY_METHOD_LABELS[cat.carry_method]}</span>}{g.l.kind === 'current' && g.l.status === 'draft' && <span className="badge run-draft" style={{ marginLeft: 6 }}>下書き</span>}</div>
                  {diff && <div className="small ws-drill-diff">前回の集計 {amt(g.b, false)} → いま {amt(g.a, false)}（{diffText(g.a - g.b)}）{same(g.a, 0) && '：仕訳がなくなりました'}{same(g.b, 0) && '：新しく入った仕訳です'}</div>}
                  {g.sources.size > 0 && <ul className="small muted ws-drill-src">{[...g.sources].slice(0, 4).map((s) => <li key={s}>{s}</li>)}</ul>}
                  {g.periodId && <Link className="small" to={`/work/${g.periodId}/${g.l.issueCode}`}>{g.l.kind === 'current' ? '作業画面を開く' : '元の計算（前年度）を開く'} ›</Link>}
                </li>
              )
            })}
          </ul>
          {list.length === 0 && <p className="muted">内訳がありません。</p>}
        </div>
      </aside>
    </>
  )
}

