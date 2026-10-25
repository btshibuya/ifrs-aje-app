// 根拠をたどる：仕訳の1行 → 計算シートの行 → 明細の内訳 → 元資料（原本のハッシュ値の確認）
// PC では画面右、スマホでは下から出るパネル

import { useEffect, useState } from 'react'
import { ErrorBox, Loading, Money, formatDateTime } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import { contributingItems, verifySourceFile } from '../../lib/verify'
import { fetchBalances, fetchItems, fetchSourceFiles, fetchSteps, type EntryRow, type Period, type Run } from '../../lib/workflow'

type Line = EntryRow['journal_lines'][number]

export default function TracePanel({ period, issueCode, run, entry, line, onClose }: {
  period: Period; issueCode: string; run: Run; entry: EntryRow; line: Line; onClose: () => void
}) {
  const { data, error, loading } = useAsync(async () => {
    const [steps, balances, items, files] = await Promise.all([
      fetchSteps(run.id), fetchBalances(run.id), fetchItems(period.id, issueCode), fetchSourceFiles(period.id, issueCode),
    ])
    return { steps, balances, items, files }
  }, [run.id])

  // Escキーで閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const step = data?.steps.find((s) => s.id === line.calculation_step_id)
  const parts = step && data ? contributingItems(issueCode, step, data.steps) : null
  const partsTotal = parts?.reduce((a, p) => a + p.value, 0) ?? 0
  const name = (k: string) => String(data?.balances.find((b) => b.item_key === k)?.extra.name ?? '')
  // この計算に使った明細の元資料
  const fileIds = new Set(data?.items.map((i) => i.source_file_id).filter(Boolean))
  const files = data?.files.filter((f) => fileIds.has(f.id)) ?? []
  const snap = run.assumptions_snapshot as Record<string, unknown>
  const pct = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—')

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="根拠をたどる">
        <div className="drawer-head">
          <b>根拠をたどる</b>
          <button className="btn btn-sm" onClick={onClose} aria-label="閉じる">閉じる</button>
        </div>
        <div className="drawer-body">
          <ol className="trace">
            <li>
              <div className="trace-label">仕訳 No.{entry.entry_no}（{entry.journal_categories.name}）</div>
              <div className="trace-main">
                {line.side === 'debit' ? '借方' : '貸方'}：{line.group_accounts.name} <span className="muted small">{line.group_account_code}</span>
                <span className="trace-amount"><Money value={line.amount} /></span>
              </div>
              <div className="small muted">{entry.description}</div>
            </li>

            {loading && !data && <li><Loading /></li>}
            {error && <li><ErrorBox message={error} /></li>}

            {data && (
              <li>
                <div className="trace-label">計算シートの行</div>
                {step ? (
                  <>
                    <div className="trace-main">{step.label}<span className="trace-amount"><Money value={step.value} /></span></div>
                    <div className="small formula">{step.formula}</div>
                    <div className={`trace-check ${Math.abs(Math.abs(Number(step.value)) - Number(line.amount)) < 1 ? 'ok' : 'note'}`}>
                      {Math.abs(Math.abs(Number(step.value)) - Number(line.amount)) < 1
                        ? '✓ 仕訳の金額と一致'
                        : 'この行の値から、科目の向き（借方・貸方）と差引で仕訳の金額を出しています'}
                    </div>
                  </>
                ) : <div className="small muted">この仕訳行には計算シートの行の対応がありません。</div>}
              </li>
            )}

            {data && step && (
              <li>
                <div className="trace-label">明細の内訳</div>
                {parts ? (
                  <>
                    <div className="table-wrap trace-table">
                      <table className="compact">
                        <thead><tr><th>明細</th><th>名称</th><th className="num">値</th></tr></thead>
                        <tbody>
                          {parts.filter((p) => Math.round(p.value) !== 0).map((p) => (
                            <tr key={p.itemKey}><td>{p.itemKey}</td><td>{name(p.itemKey)}</td><td className="num"><Money value={p.value} /></td></tr>
                          ))}
                          <tr className="subtotal"><td colSpan={2}>合計（{parts.length}明細。0円の明細は省略）</td><td className="num"><Money value={partsTotal} /></td></tr>
                        </tbody>
                      </table>
                    </div>
                    <div className={`trace-check ${Math.abs(partsTotal - Number(step.value)) < 1 ? 'ok' : 'ng'}`}>
                      {Math.abs(partsTotal - Number(step.value)) < 1 ? '✓ 明細の合計と集計行が一致' : `明細の合計と集計行が一致しません（差額 ${(partsTotal - Number(step.value)).toLocaleString('ja-JP')}）`}
                    </div>
                  </>
                ) : (
                  <div className="small">
                    この行は明細ごとの内訳を持たない集計値です。計算式：{step.formula ?? '—'}。前提値：実効税率 {pct(snap.tax_rate)}
                    {'prior_tax_rate' in snap && <>・期首の実効税率 {pct(snap.prior_tax_rate)}</>}
                  </div>
                )}
              </li>
            )}

            {data && (
              <li>
                <div className="trace-label">元資料（取り込んだ原本）</div>
                {files.length === 0 && <div className="small muted">元資料が見つかりません。</div>}
                {files.map((f) => <SourceFileCheck key={f.id} file={f} />)}
              </li>
            )}
          </ol>
          <p className="small muted">計算に使った前提値は、計算した時点の内容を保存しています（計算シートの「前提値」）。</p>
        </div>
      </aside>
    </>
  )
}

function SourceFileCheck({ file }: { file: { file_name: string; sha256: string; uploaded_at: string; storage_path: string } }) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'ng' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const check = async () => {
    setState('busy')
    try {
      const r = await verifySourceFile(file.storage_path, file.sha256)
      setState(r.ok ? 'ok' : 'ng')
      setMsg(r.ok ? `原本（${r.size.toLocaleString('ja-JP')}バイト）のハッシュ値を計算し直し、取込時の値と一致しました。取り込んだあとに書き換えられていません。` : `ハッシュ値が一致しません（計算し直した値 ${r.actual.slice(0, 16)}…）。原本が差し替えられた可能性があります。`)
    } catch (e) {
      setState('error')
      setMsg((e as Error).message)
    }
  }
  return (
    <div className="trace-file">
      <div className="trace-main">{file.file_name}</div>
      <div className="small muted">取込 {formatDateTime(file.uploaded_at)}</div>
      <div className="small mono hash" title="SHA-256（ファイルの指紋）">SHA-256：{file.sha256}</div>
      <button className="btn btn-sm" disabled={state === 'busy'} onClick={() => void check()}>{state === 'busy' ? '確かめています…' : '原本が改ざんされていないか確かめる'}</button>
      {state !== 'idle' && state !== 'busy' && <div className={`trace-check ${state === 'ok' ? 'ok' : 'ng'}`}>{state === 'ok' ? '✓ ' : ''}{msg}</div>}
    </div>
  )
}
