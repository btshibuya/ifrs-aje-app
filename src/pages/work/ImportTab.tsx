import { useState } from 'react'
import { ErrorBox, formatDateTime } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import type { IssueConfig } from '../../lib/issues'
import {
  commitImport, downloadSourceFile, fetchColumnMapping, fetchSourceFiles, previewImport,
  type ImportPreview, type Period,
} from '../../lib/workflow'

export default function ImportTab({ period, cfg, locked, onDone }: { period: Period; cfg: IssueConfig; locked: boolean; onDone: () => void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null)
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
    try {
      setPreview(await previewImport(period, cfg, file))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const onCommit = async () => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const n = await commitImport(period, cfg, preview)
      setMessage(`${n}件の明細を取り込みました。「明細チェック」で内容を確認してください。`)
      setPreview(null)
      files.reload()
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const errorRows = preview?.rows.filter((r) => r.errors.length > 0) ?? []
  const canCommit = preview && preview.missingColumns.length === 0 && preview.duplicateKeys.length === 0 && preview.rows.length > errorRows.length

  return (
    <div className="stack">
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
              <input type="file" accept=".xlsx,.csv" onChange={(e) => onFile(e.target.files?.[0])} />
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

      {error && <ErrorBox message={error} />}
      {message && <div className="alert alert-ok">{message}</div>}

      {preview && (
        <div className="card">
          <div className="card-title">読み取り結果：{preview.file.name}</div>
          {preview.missingColumns.length > 0 && (
            <div className="alert alert-error">必須の列が見つかりません：{preview.missingColumns.join('、')}</div>
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
            <button className="btn" onClick={() => setPreview(null)}>やめる</button>
            <span className="small muted">取り込むと、この期・論点の明細と、確定前の計算を入れ替えます。原本はハッシュ値とともに保存します。</span>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">取込の履歴（元資料の原本）</div>
        {files.data && files.data.length === 0 && <p className="muted">まだ取り込んでいません。</p>}
        {files.data && files.data.length > 0 && (
          <table className="compact">
            <thead><tr><th>取込日時</th><th>ファイル名</th><th>SHA-256</th><th /></tr></thead>
            <tbody>
              {files.data.map((f, i) => (
                <tr key={f.id}>
                  <td>{formatDateTime(f.uploaded_at)}{i === 0 && <span className="badge status-checked" style={{ marginLeft: 6 }}>最新</span>}</td>
                  <td>{f.file_name}</td>
                  <td className="mono small">{f.sha256.slice(0, 16)}…</td>
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
        )}
      </div>
    </div>
  )
}
