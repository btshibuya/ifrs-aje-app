// 開始仕訳・開始実現仕訳・当期仕訳の一覧（論点別／会社別）
// 1枚目に合計の仕訳、開くと会社（論点）×仕訳区分ごとの仕訳を出す

import { useState } from 'react'
import { DivergingBars, type useTooltip } from '../../components/charts'
import { CARRY_METHOD_LABELS } from '../../lib/issues'
import { KIND_LABELS, accountOrder, amt, impacts, type Account, type CLine, type Category, type Kind } from '../../lib/consolidation'

type GroupBy = 'issue' | 'company'

const NOTES: Record<Kind, { lead: string; points: string[] }> = {
  opening: {
    lead: '前年度までのIFRS調整を、当期の期首に入れる仕訳です（BTrexの開始仕訳に当たります）。',
    points: [
      '累積の論点（減価償却など）：前年度までの確定した仕訳を累計します。',
      '洗替の論点（有給休暇引当金など）：前年度末の確定した仕訳（期末の全額）を入れます。',
      '損益の科目は「利益剰余金」、その他の包括利益は「その他の資本の構成要素」に置き換えます。組換の論点は引き継ぎません。',
    ],
  },
  realization: {
    lead: '洗替の論点で、開始仕訳で入れた前年度末の全額を、期首に戻し入れる仕訳です。',
    points: [
      '前年度末の仕訳の貸借を逆にします。BSは開始仕訳と相殺され、損益は当期の損益に入ります。',
      '当期仕訳（期末の全額）と合わせると、損益は「当期末 − 前年度末」の増減になります。',
    ],
  },
  current: {
    lead: '選んだ時点（四半期末・期末）の、子会社ごとの計算の仕訳です。',
    points: ['累積の論点は当期の変動分（四半期は期首からの累計）、洗替の論点は期末の全額です。', '下書きの計算は「下書き」と表示します（上の絞り込みで除けます）。'],
  },
}

export default function JournalList({ kind, lines, accounts, categories, issueName, companyName, companyCode, issueOrder, companyOrder, label, tooltip }: {
  kind: Kind; lines: CLine[]; accounts: Map<string, Account>; categories: Map<string, Category>
  issueName: (c: string) => string; companyName: (id: string) => string; companyCode: (id: string) => string
  issueOrder: (c: string) => number; companyOrder: (id: string) => number; label: string
  tooltip: ReturnType<typeof useTooltip>
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>('issue')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const gKey = (l: CLine) => (groupBy === 'issue' ? l.issueCode : l.companyId)
  const subKey = (l: CLine) => `${groupBy === 'issue' ? l.companyId : l.issueCode}|${l.categoryCode}`
  const gName = (k: string) => (groupBy === 'issue' ? issueName(k) : companyName(k))
  const keys = [...new Set(lines.map(gKey))].sort((a, b) => (groupBy === 'issue' ? issueOrder(a) - issueOrder(b) : companyOrder(a) - companyOrder(b)))
  // 開始仕訳は純資産（期首）への影響、開始実現・当期は当期利益への影響
  const effect = (ls: CLine[]) => (kind === 'opening' ? impacts(ls, accounts).netAssets : impacts(ls, accounts).profit)
  const effectLabel = kind === 'opening' ? '期首の純資産への影響' : '当期利益への影響'

  const csv = () => {
    const head = ['種類', '会社コード', '会社', '論点', '仕訳区分コード', '仕訳区分', '方式', '科目コード', '科目', '借方金額', '貸方金額', '元の仕訳']
    const rows = lines.map((l) => {
      const c = categories.get(l.categoryCode)
      return [KIND_LABELS[l.kind], companyCode(l.companyId), companyName(l.companyId), issueName(l.issueCode), l.categoryCode, c?.name ?? '', c ? CARRY_METHOD_LABELS[c.carry_method] : '',
        l.account, accounts.get(l.account)?.name ?? '', l.amount > 0 ? Math.round(l.amount) : '', l.amount < 0 ? Math.round(-l.amount) : '', l.source ?? '']
    })
    const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const blob = new Blob(['﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv' })
    const el = document.createElement('a')
    el.href = URL.createObjectURL(blob)
    el.download = `${KIND_LABELS[kind]}_${label}.csv`
    el.click()
    URL.revokeObjectURL(el.href)
  }

  return (
    <div className="stack">
      <div className={`card kind-note kind-${kind}`}>
        <div className="card-title"><span><span className={`kind-dot kind-${kind}`} aria-hidden />{KIND_LABELS[kind]}</span></div>
        <p style={{ margin: '0 0 4px' }}>{NOTES[kind].lead}</p>
        <ul className="small muted">{NOTES[kind].points.map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="まとめ方">
          <button className={groupBy === 'issue' ? 'on' : ''} aria-pressed={groupBy === 'issue'} onClick={() => { setGroupBy('issue'); setOpen(new Set()) }}>論点別</button>
          <button className={groupBy === 'company' ? 'on' : ''} aria-pressed={groupBy === 'company'} onClick={() => { setGroupBy('company'); setOpen(new Set()) }}>会社別</button>
        </div>
        <div className="actions">
          {keys.length > 0 && <button className="btn btn-sm" onClick={() => setOpen(open.size === keys.length ? new Set() : new Set(keys))}>{open.size === keys.length ? '内訳をすべて閉じる' : '内訳をすべて開く'}</button>}
          <button className="btn btn-sm" onClick={csv} disabled={lines.length === 0}>CSVで出力</button>
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="alert alert-info">
          {kind === 'opening' ? '開始仕訳はありません。前年度の計算が確定すると、ここに出ます。'
            : kind === 'realization' ? '開始実現仕訳はありません。洗替の論点（有給休暇引当金など）で前年度の計算が確定すると、ここに出ます。'
              : '当期仕訳はありません。子会社の作業画面で計算すると、ここに出ます。'}
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-title">{groupBy === 'issue' ? '論点別' : '会社別'}：{effectLabel}<span className="small muted">押すと内訳を開く</span></div>
            <DivergingBars tooltip={tooltip}
              rows={keys.map((k) => ({ key: k, label: gName(k), value: effect(lines.filter((l) => gKey(l) === k)) }))}
              selected={open.size === 1 ? [...open][0] : null}
              onSelect={(k) => { setOpen(new Set([k])); document.getElementById(`jl-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} />
          </div>
          {keys.map((k) => {
            const ls = lines.filter((l) => gKey(l) === k)
            const subs = [...new Set(ls.map(subKey))]
            const isOpen = open.has(k)
            return (
              <div key={k} id={`jl-${k}`} className="card jl-group">
                <button className="jl-head" aria-expanded={isOpen} onClick={() => { const s = new Set(open); if (isOpen) s.delete(k); else s.add(k); setOpen(s) }}>
                  <span className="jl-caret" aria-hidden>{isOpen ? '▾' : '▸'}</span>
                  <b>{gName(k)}</b>
                  <span className="small muted">{groupBy === 'issue' ? `${new Set(ls.map((l) => l.companyId)).size}社` : `${new Set(ls.map((l) => l.issueCode)).size}論点`}・{subs.length}仕訳</span>
                  <span className="jl-effect small">{effectLabel} <b className={effect(ls) < 0 ? 'text-error' : ''}>{effect(ls) > 0 ? '+' : ''}{Math.round(effect(ls)).toLocaleString('ja-JP')}</b></span>
                </button>
                <JournalTable lines={ls} accounts={accounts} caption="合計の仕訳" />
                {isOpen && (
                  <div className="jl-subs">
                    {subs.map((sk) => {
                      const sl = ls.filter((l) => subKey(l) === sk)
                      const first = sl[0]
                      const cat = categories.get(first.categoryCode)
                      const draft = sl.some((l) => l.status === 'draft')
                      return (
                        <div key={sk} className="jl-sub">
                          <div className="jl-sub-head">
                            <b>{groupBy === 'issue' ? companyName(first.companyId) : issueName(first.issueCode)}</b>
                            <span className="badge cat">{cat?.name ?? first.categoryCode}</span>
                            {cat && <span className={`badge method-${cat.carry_method}`}>{CARRY_METHOD_LABELS[cat.carry_method]}</span>}
                            {draft && <span className="badge run-draft">下書き</span>}
                          </div>
                          <JournalTable lines={sl} accounts={accounts} />
                          {[...new Set(sl.map((l) => l.source).filter(Boolean))].length > 0 && (
                            <div className="small muted">元の仕訳：{[...new Set(sl.map((l) => l.source).filter(Boolean))].slice(0, 3).join('／')}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

// 科目ごとにまとめ、借方・貸方を左右に並べる
function JournalTable({ lines, accounts, caption }: { lines: CLine[]; accounts: Map<string, Account>; caption?: string }) {
  const net = new Map<string, number>()
  for (const l of lines) net.set(l.account, (net.get(l.account) ?? 0) + l.amount)
  const acc = (c: string) => accounts.get(c) ?? { code: c, name: c, statement: 'BS' as const, bs_class: null, pl_class: null }
  const sorted = [...net.entries()].filter(([, v]) => Math.round(v) !== 0).sort(([a], [b]) => accountOrder(acc(a)) - accountOrder(acc(b)))
  const dr = sorted.filter(([, v]) => v > 0)
  const cr = sorted.filter(([, v]) => v < 0)
  const n = Math.max(dr.length, cr.length)
  const total = dr.reduce((s, [, v]) => s + v, 0)
  if (n === 0) return <p className="small muted">金額のある行はありません（相殺されています）。</p>
  return (
    <div className="table-wrap journal-wrap">
      <table className="compact journal">
        {caption && <caption className="small muted">{caption}</caption>}
        <thead><tr><th>借方科目</th><th className="num">借方金額</th><th>貸方科目</th><th className="num">貸方金額</th></tr></thead>
        <tbody>
          {Array.from({ length: n }, (_, i) => (
            <tr key={i}>
              <td>{dr[i] && <>{acc(dr[i][0]).name} <span className="muted small">{dr[i][0]}</span></>}</td>
              <td className="num">{dr[i] && amt(dr[i][1])}</td>
              <td>{cr[i] && <>{acc(cr[i][0]).name} <span className="muted small">{cr[i][0]}</span></>}</td>
              <td className="num">{cr[i] && amt(-cr[i][1])}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="subtotal"><td>合計</td><td className="num">{amt(total, false)}</td><td /><td className="num">{amt(total, false)}</td></tr></tfoot>
      </table>
    </div>
  )
}
