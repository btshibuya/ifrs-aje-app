import { ErrorBox, formatDateTime } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import { downloadSourceFile, fetchSourceFiles } from '../../lib/workflow'

const FILE_TYPE_LABELS: Record<string, string> = { excel: 'Excel', csv: 'CSV', pdf: 'PDF', manual: '手入力' }

// 取込・入力の履歴（元資料の原本）。version を変えると読み直す
export default function SourceFileHistory({ periodId, issueCode, version, packageSource = false }: { periodId: string; issueCode: string; version: number; packageSource?: boolean }) {
  const files = useAsync(() => fetchSourceFiles(periodId, issueCode), [periodId, issueCode, version])
  return (
    <div className="card">
      <div className="card-title">取込・入力の履歴（元資料の原本）</div>
      {files.error && <ErrorBox message={files.error} />}
      {files.data && files.data.length === 0 && <p className="muted">まだ取り込んでいません。</p>}
      {files.data && files.data.length > 0 && (
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th>日時</th><th>入れ方</th><th>ファイル名</th><th className="hide-sp">SHA-256</th><th /></tr></thead>
            <tbody>
              {files.data.map((f, i) => (
                <tr key={f.id}>
                  <td className="nowrap">{formatDateTime(f.uploaded_at)}{i === 0 && <span className="badge status-checked" style={{ marginLeft: 6 }}>最新</span>}</td>
                  <td className="nowrap">{packageSource ? '収集パッケージ' : FILE_TYPE_LABELS[f.file_type] ?? f.file_type}</td>
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
  )
}
