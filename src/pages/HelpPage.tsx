// 論点の解説：一覧と、論点ごとの基準の概要・日本基準とIFRSの違い
import { Link, useParams } from 'react-router-dom'
import { ErrorBox, Loading, PageHeader } from '../components/ui'
import { helpOf } from '../lib/help'
import { useAsync } from '../lib/hooks'
import { ISSUE_CONFIGS } from '../lib/issues'
import { fetchMasters } from '../lib/masters'
import { PACKAGE_FORMS } from '../lib/materials'

export default function HelpPage() {
  const { code } = useParams()
  const { data: m, error, loading } = useAsync(fetchMasters, [])
  if (loading && !m) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!m) return null
  // 論点マスタの順（非表示の論点は出さない）。解説がない論点は出さない
  const issues = m.issues.filter((i) => helpOf(i.code))

  if (!code) {
    return (
      <>
        <PageHeader title="論点の解説" />
        <p className="muted small" style={{ marginTop: -4 }}>
          論点ごとに、IFRSの基準の概要と、日本基準との主な違いをまとめています。細かい規定は基準書で確認してください。
        </p>
        <div className="help-grid">
          {issues.map((i) => {
            const h = helpOf(i.code)!
            return (
              <Link key={i.code} to={`/help/${i.code}`} className="card help-card">
                <div className="help-card-head"><span className="issue-no-lg">{i.no}</span><b>{i.name}</b></div>
                <div className="small muted">{h.standard}</div>
                <p className="small help-card-summary">{h.summary}</p>
                <span className="small help-card-more">違い {h.diffs.length}点を見る ›</span>
              </Link>
            )
          })}
        </div>
      </>
    )
  }

  const issue = m.issues.find((i) => i.code === code)
  const h = helpOf(code)
  if (!issue || !h) return <ErrorBox message="この論点の解説はありません。" />
  const idx = issues.findIndex((i) => i.code === code)
  const prev = issues[idx - 1]
  const next = issues[idx + 1]
  const form = PACKAGE_FORMS.find((f) => f.issueCode === code)

  return (
    <article className="help-page">
      <div className="breadcrumb"><Link to="/help">論点の解説</Link> ／ {issue.no}. {issue.name}</div>
      <div className="page-header">
        <h1><span className="issue-no-lg">{issue.no}</span>{issue.name}</h1>
        <div className="page-header-tools">
          <Link className="btn" to="/progress">進捗一覧で見る</Link>
        </div>
      </div>
      <p className="help-standard">{h.standard}</p>

      <section className="card">
        <h2 className="help-h2">基準の概要</h2>
        <p className="help-text">{h.summary}</p>
      </section>

      <section className="card">
        <h2 className="help-h2">日本基準とIFRSの主な違い</h2>
        <div className="table-wrap">
          <table className="compact help-diff">
            <thead><tr><th>項目</th><th>日本基準</th><th>IFRS</th></tr></thead>
            <tbody>
              {h.diffs.map((d) => (
                <tr key={d.topic}><th scope="row">{d.topic}</th><td>{d.jgaap}</td><td>{d.ifrs}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="help-two">
        <section className="card">
          <h2 className="help-h2">よくある調整仕訳</h2>
          <p className="help-journal">{h.journal}</p>
        </section>
        <section className="card">
          <h2 className="help-h2">このアプリでの扱い</h2>
          <p className="help-text">{h.inApp}</p>
          <p className="small" style={{ margin: '6px 0 0' }}>
            {ISSUE_CONFIGS[code] ? '作業画面で、取込・明細チェック・計算・確定まで行えます。' : '作業画面では、収集パッケージの入力から作った仕訳を確認・確定できます。'}
            {form && <> 集める様式：「{form.title}」</>}
          </p>
        </section>
      </div>

      <nav className="help-nav" aria-label="ほかの論点">
        {prev ? <Link to={`/help/${prev.code}`}>‹ {prev.no}. {prev.name}</Link> : <span />}
        <Link to="/help">一覧</Link>
        {next ? <Link to={`/help/${next.code}`}>{next.no}. {next.name} ›</Link> : <span />}
      </nav>
    </article>
  )
}
