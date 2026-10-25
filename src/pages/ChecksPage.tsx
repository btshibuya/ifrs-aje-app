import { Link } from 'react-router-dom'
import { ErrorBox, Loading, Money, PageHeader } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { fetchMasters } from '../lib/masters'
import { must, supabase } from '../lib/supabase'

interface Missing { period_id: string; issue_code: string; item_key: string; balance_type: string; prior_closing_difference: number }
interface Unbalanced { entry_id: string; period_id: string; issue_code: string; entry_no: number; debit_total: number; credit_total: number }

export default function ChecksPage() {
  const { data, error, loading } = useAsync(async () => {
    const [m, missing, unbalanced] = await Promise.all([
      fetchMasters(), supabase.from('v_missing_carryforward').select('*'), supabase.from('v_unbalanced_entries').select('*'),
    ])
    return { m, missing: must(missing) as Missing[], unbalanced: must(unbalanced) as Unbalanced[] }
  }, [])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { m } = data
  const periodLabel = (pid: string) => {
    const p = m.periods.find((x) => x.id === pid)
    const c = m.companies.find((x) => x.id === p?.company_id)
    return `${c?.code} ${c?.name} ／ ${p?.label}`
  }
  const issueName = (code: string) => m.issues.find((i) => i.code === code)?.name ?? code

  return (
    <>
      <PageHeader title="チェック" />
      <div className="card">
        <div className="card-title">期首チェック：前期末にあって当期の計算に出てこない明細</div>
        <p className="small muted">前期の確定した計算の期末残高と、当期の計算を突き合わせています。除却・売却・退職などの処理漏れがないか確認してください。</p>
        {data.missing.length === 0 ? <p className="ok-text">該当なし</p> : (
          <table className="compact">
            <thead><tr><th>会社・期</th><th>論点</th><th>明細</th><th className="num">前期末の差額</th></tr></thead>
            <tbody>
              {data.missing.map((r) => (
                <tr key={`${r.period_id}${r.issue_code}${r.item_key}`}>
                  <td><Link to={`/work/${r.period_id}/${r.issue_code}`}>{periodLabel(r.period_id)}</Link></td>
                  <td>{issueName(r.issue_code)}</td><td>{r.item_key}</td><td className="num"><Money value={r.prior_closing_difference} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <div className="card-title">出力前チェック：貸借が一致しない仕訳</div>
        {data.unbalanced.length === 0 ? <p className="ok-text">該当なし</p> : (
          <table className="compact">
            <thead><tr><th>会社・期</th><th>論点</th><th>仕訳番号</th><th className="num">借方</th><th className="num">貸方</th></tr></thead>
            <tbody>
              {data.unbalanced.map((r) => (
                <tr key={r.entry_id}>
                  <td><Link to={`/work/${r.period_id}/${r.issue_code}`}>{periodLabel(r.period_id)}</Link></td>
                  <td>{issueName(r.issue_code)}</td><td>{r.entry_no}</td>
                  <td className="num"><Money value={r.debit_total} /></td><td className="num"><Money value={r.credit_total} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
