import { useCallback, useState } from 'react'
import { ErrorBox, Loading, Money } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import { CARRY_METHOD_LABELS } from '../../lib/issues'
import { fetchEntries, fetchSteps, lockIssue, unlockIssue, type EntryRow, type Period, type Run } from '../../lib/workflow'
import TracePanel from './TracePanel'
import { useFeedback } from '../../components/feedback'

const CARRY_METHOD_NOTES: Record<string, string> = {
  cumulative: '当期の変動分を出力（期首残高は開始仕訳で入る。連結精算表の「開始仕訳」で確認できる）',
  reversing: '当期末の全額を出力（前期分は開始実現仕訳で戻し入れる。連結精算表の「開始実現仕訳」で確認できる）',
  reclass: '当期の全額を出力（翌期への引継ぎなし）',
}

// 科目別の合計は BS → PL → OCI の順。BS は資産・負債・純資産、PL は営業・金融・税金の順
const STATEMENT_ORDER = ['BS', 'PL', 'OCI']
const CLASS_ORDER = ['current_asset', 'noncurrent_asset', 'current_liability', 'noncurrent_liability', 'equity', 'operating', 'finance', 'income_tax']
// 税効果の科目（繰延税金資産・負債）は、同じ区分の中で本体の科目の後に置く
const isTaxAccount = (code: string) => /_DT[AL]$/.test(code)
const byAccountOrder = ([ca, a]: [string, { cls: string | null }], [cb, b]: [string, { cls: string | null }]) =>
  (CLASS_ORDER.indexOf(a.cls ?? '') - CLASS_ORDER.indexOf(b.cls ?? '')) || (Number(isTaxAccount(ca)) - Number(isTaxAccount(cb))) || ca.localeCompare(cb)

function toCsv(period: Period, issueName: string, entries: EntryRow[]) {
  const head = ['会社コード', '決算期', '論点', '仕訳区分コード', '仕訳区分', '方式', '仕訳番号', '摘要', '行', '借方科目コード', '借方科目', '借方金額', '貸方科目コード', '貸方科目', '貸方金額', 'メモ']
  const rows = entries.flatMap((e) =>
    e.journal_lines.map((l) => {
      const d = l.side === 'debit'
      return [
        period.companies.code, period.label, issueName, e.category_code, e.journal_categories.name,
        CARRY_METHOD_LABELS[e.journal_categories.carry_method], e.entry_no, e.description, l.line_no,
        d ? l.group_account_code : '', d ? l.group_accounts.name : '', d ? l.amount : '',
        d ? '' : l.group_account_code, d ? '' : l.group_accounts.name, d ? '' : l.amount, l.memo ?? '',
      ]
    }),
  )
  const esc = (v: unknown) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')
}

export default function JournalTab({ period, issueCode, issueName, run, locked, stale, onDone }: {
  period: Period; issueCode: string; issueName: string; run: Run | null; locked: boolean; stale: boolean; onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fb = useFeedback()
  const [trace, setTrace] = useState<{ entry: EntryRow; line: EntryRow['journal_lines'][number] } | null>(null)
  const closeTrace = useCallback(() => setTrace(null), [])
  const data = useAsync(async () => {
    if (!run) return null
    const [entries, steps] = await Promise.all([fetchEntries(run.id), fetchSteps(run.id)])
    return { entries, steps: new Map(steps.map((s) => [s.id, s])) }
  }, [run?.id, run?.status])

  if (!run) return <div className="alert alert-info">まだ計算していません。「計算」タブで計算してください。</div>
  if (data.loading && !data.data) return <Loading />
  if (data.error) return <ErrorBox message={data.error} />
  if (!data.data) return null
  const { entries, steps } = data.data

  const totals = new Map<string, { name: string; statement: string; cls: string | null; net: number }>()
  for (const e of entries) for (const l of e.journal_lines) {
    const a = l.group_accounts
    const t = totals.get(l.group_account_code) ?? { name: a.name, statement: a.statement, cls: a.bs_class ?? a.pl_class, net: 0 }
    t.net += (l.side === 'debit' ? 1 : -1) * Number(l.amount)
    totals.set(l.group_account_code, t)
  }

  const act = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      if (done) fb.toast(done)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    const blob = new Blob([toCsv(period, issueName, entries)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `AJE_${period.companies.code}_${period.label}_${issueName}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const unbalanced = entries.filter((e) => e.journal_lines.reduce((s, l) => s + (l.side === 'debit' ? 1 : -1) * Number(l.amount), 0) !== 0)

  return (
    <div className="stack">
      <div className="toolbar">
        <div>
          仕訳 {entries.length}件
          {unbalanced.length === 0 ? <span className="badge status-checked" style={{ marginLeft: 8 }}>貸借一致</span> : <span className="badge status-error" style={{ marginLeft: 8 }}>貸借不一致 {unbalanced.length}件</span>}
        </div>
        <div className="actions">
          <button className="btn" onClick={download}>CSVで出力</button>
          {locked ? (
            <button className="btn btn-danger-outline" disabled={busy} onClick={async () => {
              const ok = await fb.confirm({
                title: '確定を解除しますか？', confirmLabel: '確定を解除する', danger: true,
                body: <ul><li>明細・計算・仕訳を、また変更できるようになります。</li><li>翌期が、この期の期末残高を引き継いでいる場合は、翌期も見直しが必要です。</li><li>解除の操作は変更履歴に残ります。</li></ul>,
              })
              if (ok !== null) await act(() => unlockIssue(period.id, issueCode, run.id), '確定を解除しました')
            }}>
              確定を解除
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy || stale || unbalanced.length > 0} onClick={async () => {
              const ok = await fb.confirm({
                title: 'この計算で確定しますか？', confirmLabel: '確定する',
                body: <ul><li>仕訳 {entries.length}件（貸借一致）を確定します。</li><li>確定すると、明細・計算・仕訳はDB側でロックされ、変更できなくなります。</li><li>翌期は、この計算の期末残高から引き継ぎます。</li></ul>,
              })
              if (ok !== null) await act(() => lockIssue(period.id, issueCode, run.id), '確定しました')
            }}>
              この計算で確定する
            </button>
          )}
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {trace && <TracePanel period={period} issueCode={issueCode} run={run} entry={trace.entry} line={trace.line} onClose={closeTrace} />}
      {locked && <div className="alert alert-info">確定済みです。明細・計算・仕訳はDB側で変更できないようにロックされています。翌期はこの計算の期末残高から引き継ぎます。</div>}

      {entries.map((e) => (
        <div className="card entry" key={e.id}>
          <div className="entry-head">
            <span className="entry-no">No.{e.entry_no}</span>
            <span className="badge cat">{e.journal_categories.name}</span>
            <span className={`badge method-${e.journal_categories.carry_method}`} title={CARRY_METHOD_NOTES[e.journal_categories.carry_method]}>
              {CARRY_METHOD_LABELS[e.journal_categories.carry_method]}
            </span>
            <span>{e.description}</span>
          </div>
          <div className="table-wrap journal-wrap">
          <table className="compact journal">
            <thead>
              <tr><th>借方科目</th><th className="num">借方金額</th><th>貸方科目</th><th className="num">貸方金額</th><th>計算根拠</th></tr>
            </thead>
            <tbody>
              {e.journal_lines.map((l) => {
                const s = l.calculation_step_id ? steps.get(l.calculation_step_id) : undefined
                return (
                  <tr key={l.line_no}>
                    <td>{l.side === 'debit' && <>{l.group_accounts.name} <span className="muted small">{l.group_account_code}</span></>}</td>
                    <td className="num">{l.side === 'debit' && <Money value={l.amount} />}</td>
                    <td>{l.side === 'credit' && <>{l.group_accounts.name} <span className="muted small">{l.group_account_code}</span></>}</td>
                    <td className="num">{l.side === 'credit' && <Money value={l.amount} />}</td>
                    <td className="small">
                      {s ? <span title={s.formula ?? ''}>計算シート「{s.label}」<span className="muted">：{s.formula}</span></span> : ''}
                      <button className="btn-link trace-open" onClick={() => setTrace({ entry: e, line: l })}>根拠をたどる ›</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
          <div className="small muted">{CARRY_METHOD_NOTES[e.journal_categories.carry_method]}</div>
        </div>
      ))}

      <div className="card">
        <div className="card-title">科目別の合計（借方プラス）</div>
        <table className="compact">
          <thead><tr><th>科目</th><th>区分</th><th className="num">金額</th></tr></thead>
          {STATEMENT_ORDER.map((st) => {
            const list = [...totals.entries()].filter(([, t]) => t.statement === st).sort(byAccountOrder)
            if (list.length === 0) return null
            const sum = list.reduce((x, [, t]) => x + t.net, 0)
            return (
              <tbody key={st} className="statement-group">
                {list.map(([code, t]) => (
                  <tr key={code}><td>{t.name} <span className="muted small">{code}</span></td><td>{t.statement}</td><td className="num"><Money value={t.net} /></td></tr>
                ))}
                <tr className="subtotal">
                  <td colSpan={2}>{st} 計{st === 'PL' && <span className="small muted">（当期純利益への影響 <Money value={-sum} signed />）</span>}</td>
                  <td className="num"><Money value={sum} /></td>
                </tr>
              </tbody>
            )
          })}
        </table>
      </div>
    </div>
  )
}
