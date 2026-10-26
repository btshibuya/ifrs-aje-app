import { useState } from 'react'
import { useFeedback } from '../../components/feedback'
import { ErrorBox, formatDateTime } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import type { IssueConfig } from '../../lib/issues'
import {
  commitImport, downloadSourceFile, fetchColumnMapping, fetchSourceFiles, previewImport, remapPreview, saveCompanyMapping,
  type ImportPreview, type ItemRow, type Period,
} from '../../lib/workflow'
import ManualEntry, { type ManualMode } from './ManualEntry'

type Method = 'file' | ManualMode

const FILE_TYPE_LABELS: Record<string, string> = { excel: 'Excel', csv: 'CSV', pdf: 'PDF', manual: '手入力' }

export default function ImportTab({ period, cfg, items, locked, onDone }: { period: Period; cfg: IssueConfig; items: ItemRow[]; locked: boolean; onDone: () => void }) {
  const fb = useFeedback()
  // いまの明細の入れ方に合わせて、最初の入力方法を選ぶ
  const initial: Method = items.some((i) => i.data.input_mode === 'aggregate') ? 'aggregate' : items.some((i) => i.data.input_mode === 'detail') ? 'detail' : 'file'
  const [method, setMethod] = useState<Method>(initial)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [remapped, setRemapped] = useState(false)
  const [saveMapping, setSaveMapping] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const mapping = useAsync(() => fetchColumnMapping(period, cfg.sourceKind), [period.id, cfg.code])
  const files = useAsync(() => fetchSourceFiles(period.id, cfg.code), [period.id, cfg.code])

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    setMessage(null)
    setPreview(null)
    setRemapped(false)
    try {
      setPreview(await previewImport(period, cfg, file))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // 列の対応・見出しの行を画面で選び直す
  const remap = async (headerRow: number, map: Record<string, string>) => {
    if (!preview) return
    setRemapped(true)
    setPreview(await remapPreview(cfg, preview, headerRow, map))
  }

  const onCommit = async () => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      if (remapped && saveMapping) await saveCompanyMapping(period, cfg, preview.headerRow, preview.mapping)
      const n = await commitImport(period, cfg, preview)
      setMessage(`${n}件の明細を取り込みました。「明細チェック」で内容を確認してください。`)
      if (remapped && saveMapping) fb.toast('列の対応を、この会社の列マッピングとして保存しました')
      setPreview(null)
      files.reload()
      mapping.reload()
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const errorRows = preview?.rows.filter((r) => r.errors.length > 0) ?? []
  const canCommit = preview && preview.missingColumns.length === 0 && preview.duplicateKeys.length === 0 && preview.rows.length > errorRows.length

  const METHODS: { key: Method; title: string; tag?: string; desc: string }[] = [
    { key: 'file', title: 'ファイルを取り込む', tag: 'おすすめ', desc: `会計ソフト等から出した${cfg.sourceLabel}（Excel・CSV）を、加工せずにそのまま取り込みます。列名が違っても、画面で対応を選べます。` },
    { key: 'detail', title: `${cfg.manual.unitLabel}ごとに入力する`, desc: 'ファイルが出せないときに、1件ずつ入力します。Excel の表をコピーして貼り付けることもできます。' },
    { key: 'aggregate', title: '合計で入力する', desc: `${cfg.manual.aggregate.title.replace('で入力する', '')}で入れます。精度を保つまとめ方を案内します。` },
  ]

  return (
    <div className="stack">
      <div className="method-picker" role="radiogroup" aria-label="明細の入れ方">
        {METHODS.map((m) => (
          <button key={m.key} role="radio" aria-checked={method === m.key} className={`method-card${method === m.key ? ' on' : ''}`} onClick={() => setMethod(m.key)}>
            <span className="method-title">{m.title}{m.tag && <span className="method-tag">{m.tag}</span>}</span>
            <span className="small muted">{m.desc}</span>
          </button>
        ))}
      </div>

      {error && <ErrorBox message={error} />}
      {message && <div className="alert alert-ok">{message}</div>}

      {method !== 'file' && (
        <ManualEntry key={`${period.id}|${method}`} period={period} cfg={cfg} mode={method} items={items} locked={locked}
          onDone={(n) => { setMessage(`${n}${method === 'aggregate' ? '区分' : '件'}を保存しました。「明細チェック」で内容を確認してください。`); files.reload(); onDone() }} />
      )}

      {method === 'file' && (
        <div className="grid-2">
          <div className="card">
            <div className="card-title">取込ファイル：{cfg.sourceLabel}</div>
            {mapping.error && <ErrorBox message={mapping.error} />}
            {mapping.data && (
              <>
                <p className="small muted">列マッピング：{mapping.data.scope}（{mapping.data.header_row}行目が見出し）</p>
                <table className="compact">
                  <thead><tr><th>アプリの項目</th><th>ファイルの列名</th></tr></thead>
                  <tbody>
                    {cfg.fields.map((f) => (
                      <tr key={f.key}>
                        <td>{f.label}{f.required && <span className="req">必須</span>}</td>
                        <td>{mapping.data!.mapping[f.key] ?? <span className="muted">（なし）</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
          <div className="card">
            <div className="card-title">ファイルを選ぶ</div>
            {locked ? (
              <div className="alert alert-info">確定済みのため取り込めません。取り込み直すには、仕訳タブで確定を解除してください。</div>
            ) : (
              <label className="dropzone">
                <input type="file" accept=".xlsx,.csv" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
                <span>Excel（.xlsx）またはCSVを選ぶ</span>
              </label>
            )}
            <div className="small muted" style={{ marginTop: 12 }}>
              デモ用のサンプル：
              <ul className="links">
                {cfg.sampleFiles.map((s) => (
                  <li key={s.path}><a href={`${import.meta.env.BASE_URL}${s.path}`} download>{s.label}</a></li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {method === 'file' && preview && (
        <div className="card">
          <div className="card-title">読み取り結果：{preview.file.name}</div>
          {(preview.missingColumns.length > 0 || remapped) && (
            <div className={`remap ${preview.missingColumns.length > 0 ? 'remap-need' : ''}`}>
              <p style={{ margin: '0 0 6px' }}>
                {preview.missingColumns.length > 0
                  ? <><b>列名が合いません。</b>ファイルを直さずに、下でアプリの項目に当たる列を選んでください（{preview.missingColumns.length}項目）。</>
                  : <b>列の対応を選び直しました。</b>}
              </p>
              <div className="remap-grid">
                <label className="remap-field">
                  <span className="small">見出しの行</span>
                  <input type="number" min={1} max={30} value={preview.headerRow} onChange={(e) => void remap(Math.max(1, Number(e.target.value) || 1), preview.mapping)} style={{ width: 70 }} />
                </label>
                {cfg.fields.map((f) => {
                  const cur = preview.mapping[f.key] ?? ''
                  const missing = !preview.headers.includes(cur)
                  return (
                    <label key={f.key} className={`remap-field${missing && f.required ? ' need' : ''}`}>
                      <span className="small">{f.label}{f.required && <span className="req">必須</span>}</span>
                      <select value={preview.headers.includes(cur) ? cur : ''} onChange={(e) => void remap(preview.headerRow, { ...preview.mapping, [f.key]: e.target.value })}>
                        <option value="">（選んでください）</option>
                        {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>
                  )
                })}
              </div>
              <label className="check-inline small" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={saveMapping} onChange={(e) => setSaveMapping(e.target.checked)} /> 取り込むときに、この対応を {period.companies.code} の列マッピングとして保存する（次回から自動で読めます）
              </label>
            </div>
          )}
          {preview.missingColumns.length === 0 && !remapped && (
            <p className="small" style={{ margin: '0 0 6px' }}>
              <button className="btn-link" onClick={() => setRemapped(true)}>列の対応を変える</button>
            </p>
          )}
          {preview.duplicateKeys.length > 0 && (
            <div className="alert alert-error">番号が重複しています：{preview.duplicateKeys.join('、')}</div>
          )}
          {preview.missingColumns.length === 0 && (
            <>
              <p>
                {preview.rows.length}行を読み取りました。
                {errorRows.length > 0 && <span className="text-error"> うち{errorRows.length}行は読み取れない値があるため取り込みません。</span>}
              </p>
              <div className="table-wrap" style={{ maxHeight: 360 }}>
                <table className="compact">
                  <thead>
                    <tr><th>行</th>{cfg.fields.map((f) => <th key={f.key}>{f.label}</th>)}<th>読み取りエラー</th></tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((r) => (
                      <tr key={r.rowNo} className={r.errors.length ? 'row-error' : ''}>
                        <td className="num">{r.rowNo}</td>
                        {cfg.fields.map((f) => (
                          <td key={f.key} className={f.type === 'number' ? 'num' : ''}>
                            {r.data[f.key] === null || r.data[f.key] === undefined ? '' : f.type === 'number' ? Number(r.data[f.key]).toLocaleString('ja-JP') : String(r.data[f.key])}
                          </td>
                        ))}
                        <td className="text-error small">{r.errors.join('、')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="actions">
            <button className="btn btn-primary" disabled={!canCommit || busy} onClick={onCommit}>
              {busy ? '取り込み中…' : 'この内容で取り込む'}
            </button>
            <button className="btn" onClick={() => { setPreview(null); setRemapped(false) }}>やめる</button>
            <span className="small muted">取り込むと、この期・論点の明細と、確定前の計算を入れ替えます。原本はハッシュ値とともに保存します。</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">取込・入力の履歴（元資料の原本）</div>
        {files.data && files.data.length === 0 && <p className="muted">まだ取り込んでいません。</p>}
        {files.data && files.data.length > 0 && (
          <div className="table-wrap">
            <table className="compact">
              <thead><tr><th>日時</th><th>入れ方</th><th>ファイル名</th><th className="hide-sp">SHA-256</th><th /></tr></thead>
              <tbody>
                {files.data.map((f, i) => (
                  <tr key={f.id}>
                    <td className="nowrap">{formatDateTime(f.uploaded_at)}{i === 0 && <span className="badge status-checked" style={{ marginLeft: 6 }}>最新</span>}</td>
                    <td className="nowrap">{FILE_TYPE_LABELS[f.file_type] ?? f.file_type}</td>
                    <td>{f.file_name}</td>
                    <td className="mono small hide-sp">{f.sha256.slice(0, 16)}…</td>
                    <td>
                      <button className="btn-link" onClick={async () => {
                        const url = await downloadSourceFile(f.storage_path)
                        if (url) window.open(url, '_blank')
                      }}>原本をダウンロード</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
