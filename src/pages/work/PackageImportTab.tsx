// 収集パッケージから明細を作る論点の取込：提出された様式の入力を、明細として取り込む
// 入力の内容はCSVにして元資料として保存する（ハッシュ値で、あとから書き換えられていないかを確かめられる）

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useFeedback } from '../../components/feedback'
import { ErrorBox, Loading, formatDateTime } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import { formByCode, formatAsOf } from '../../lib/materials'
import { ENTRY_STATUS_LABELS, type PackageEntry } from '../../lib/package'
import type { PackageCalcDef } from '../../lib/packageCalc'
import { fetchPackageSource, importFromPackage, type ItemRow, type Period } from '../../lib/workflow'
import SourceFileHistory from './SourceFileHistory'

const STATUS_CLASS: Record<string, string> = { draft: 'status-imported', submitted: 'status-calculated', confirmed: 'status-checked' }

function EntryLine({ period, formCode, entry }: { period: Period; formCode: string; entry: PackageEntry | null }) {
  const form = formByCode(formCode)
  return (
    <div className="pkg-source-line">
      <Link to={`/package/${period.companies.code}/${period.end_date}/${formCode}`}><b>{form?.title ?? formCode}</b></Link>
      {entry
        ? <span className={`badge ${STATUS_CLASS[entry.status] ?? ''}`}>{ENTRY_STATUS_LABELS[entry.status]}</span>
        : <span className="badge status-not_started">未着手</span>}
      {entry && (
        <span className="small muted">
          入力 {entry.entered_by ?? '—'}
          {entry.submitted_at && <>・提出 {formatDateTime(entry.submitted_at)}</>}
          {entry.confirmed_at && <>・確認 {formatDateTime(entry.confirmed_at)}（{entry.confirmed_by ?? '—'}）</>}
        </span>
      )}
      {entry?.status === 'draft' && entry.return_note && <div className="small text-error">差し戻し中：{entry.return_note}</div>}
    </div>
  )
}

export default function PackageImportTab({ period, def, items, locked, onDone }: {
  period: Period; def: PackageCalcDef; items: ItemRow[]; locked: boolean; onDone: () => void
}) {
  const fb = useFeedback()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const src = useAsync(() => fetchPackageSource(period, def.issueCode), [period.id, def.issueCode, version])
  const form = formByCode(def.formCode)

  const onImport = async () => {
    if (!src.data) return
    setBusy(true)
    setError(null)
    try {
      const n = await importFromPackage(period, def.issueCode, src.data)
      fb.toast(`${n}件の明細を取り込みました。「明細チェック」で内容を確認してください`)
      setVersion((v) => v + 1)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const s = src.data
  const entry = s?.entry ?? null
  const changed = !!s && s.lastHash !== null && s.lastHash !== s.hash
  const same = !!s && s.lastHash !== null && s.lastHash === s.hash && items.length > 0
  const othersReady = !!s && Object.values(s.others).every((e) => e && e.status !== 'draft')
  const canImport = !!entry && entry.status !== 'draft' && othersReady && (s?.rows.length ?? 0) > 0 && !locked
  const cols = def.fields
  // 明細の番号は、ふつうは様式の「前期と突き合わせる列」と同じ。違う行（空・重複に番号を足した行）があるときだけ列を出す
  const keyCol = form?.table?.keyColumn
  const showKey = !cols.some((c) => c.key === 'item') && (s?.rows ?? []).some((r) => !keyCol || String(r.data[keyCol] ?? '') !== r.itemKey)

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">元にする収集パッケージ（{formatAsOf(period.end_date)}時点）</div>
        <p className="small muted" style={{ marginTop: 0 }}>
          子会社が入力した様式の{form?.table ? '行（1行が1件の明細）' : '項目'}を、そのまま明細として取り込みます。取り込んだ内容はCSVにして元資料として保存し、ハッシュ値で書き換えがないかを確かめられます。
        </p>
        {src.loading && !s && <Loading />}
        {src.error && <ErrorBox message={src.error} />}
        {s && (
          <>
            <EntryLine period={period} formCode={def.formCode} entry={entry} />
            {Object.entries(s.others).map(([code, e]) => <EntryLine key={code} period={period} formCode={code} entry={e} />)}
            {!entry && <div className="alert alert-info">まだ入力されていません。子会社に収集パッケージの入力・提出を依頼してください。</div>}
            {entry?.status === 'draft' && <div className="alert alert-info">子会社が入力中です。提出されると取り込めます。</div>}
            {entry && entry.status !== 'draft' && !othersReady && <div className="alert alert-info">計算に使うほかの様式が、まだ提出されていません。提出されると取り込めます。</div>}
            {entry?.status === 'submitted' && <div className="alert alert-warn">提出済みですが、親会社の確認前です。取り込めますが、様式で内容を確かめて「確認済にする」を押すことをおすすめします。</div>}
            {changed && <div className="alert alert-warn"><b>前回の取込のあとで、収集パッケージの入力が変わっています。</b>取り込み直すと明細を入れ替えます（確定前の計算は「再計算待ち」になり、再計算のときに上書き前後を確かめられます）。</div>}
            {same && <div className="alert alert-ok">取り込んだ明細は、いまの収集パッケージの入力と同じです（ハッシュ値が一致）。</div>}
          </>
        )}
      </div>

      {error && <ErrorBox message={error} />}

      {s && s.rows.length > 0 && (
        <div className="card">
          <div className="card-title">取り込む明細（{s.rows.length}件）</div>
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="compact">
              <thead><tr>{showKey && <th>明細</th>}{cols.map((c) => <th key={c.key} className={c.type === 'number' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.itemKey}>
                    {showKey && <td className="nowrap">{r.itemKey}</td>}
                    {cols.map((c) => {
                      const v = r.data[c.key]
                      return <td key={c.key} className={c.type === 'number' ? 'num' : ''}>{r.data.none ? (c === cols[0] ? '該当なし' : '') : v === null || v === undefined ? '' : c.type === 'number' ? Number(v).toLocaleString('ja-JP', { maximumFractionDigits: 3 }) : String(v)}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={!canImport || busy} onClick={() => void onImport()}>
              {busy ? '取り込み中…' : items.length > 0 ? '取り込み直す' : 'この内容で取り込む'}
            </button>
            {locked && <span className="small muted">確定済みのため取り込めません。取り込み直すには、仕訳タブで確定を解除してください。</span>}
            {!locked && <span className="small muted">取り込むと、この期・論点の明細を入れ替えます。</span>}
          </div>
        </div>
      )}

      <SourceFileHistory periodId={period.id} issueCode={def.issueCode} version={version} packageSource />
    </div>
  )
}
