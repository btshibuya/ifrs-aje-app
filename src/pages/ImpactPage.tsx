import { Link } from 'react-router-dom'
import { ErrorBox, Loading, Money, PageHeader, SlotToggle } from '../components/ui'
import { useAsync, useSlot } from '../lib/hooks'
import { fetchMasters } from '../lib/masters'
import { must, supabase } from '../lib/supabase'

interface ImpactRow { company_code: string; period_id: string; issue_code: string; statement: string; net_debit: number }

export default function ImpactPage() {
  const [slot, setSlot] = useSlot()
  const { data, error, loading } = useAsync(async () => {
    const [m, rows] = await Promise.all([fetchMasters(), supabase.from('v_impact_summary').select('*')])
    return { m, rows: must(rows) as ImpactRow[] }
  }, [])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { m } = data
  const periodIds = new Set(m.companies.map((c) => m.periodFor(c.id, slot)?.id))
  const rows = data.rows.filter((r) => periodIds.has(r.period_id))
  // 利益への影響：PL の借方合計の符号を反転（借方＝費用増＝利益減）
  const profit = (pid: string | undefined, issue: string | null) =>
    rows.filter((r) => r.period_id === pid && r.statement === 'PL' && (issue === null || r.issue_code === issue))
      .reduce((s, r) => s - Number(r.net_debit), 0)
  const issuesWithData = m.issues.filter((i) => rows.some((r) => r.issue_code === i.code))

  return (
    <>
      <PageHeader title="論点別影響額一覧">
        <SlotToggle slot={slot} onChange={setSlot} />
      </PageHeader>
      <p className="muted small">
        計算済み・確定済みの仕訳を集計した、当期純利益への影響額です（プラス＝利益が増える）。税効果（法人税等調整額）を含みます。
        累積の論点は当期の変動分、洗替の論点は期末の全額で、BTrexの開始仕訳による戻入れ・引継ぎは含みません。
      </p>
      {issuesWithData.length === 0 ? (
        <div className="alert alert-info">まだ計算した論点がありません。進捗一覧から作業画面を開いて計算してください。</div>
      ) : (
        <div className="table-wrap">
          <table className="compact">
            <thead>
              <tr>
                <th>会社</th>
                {issuesWithData.map((i) => <th key={i.code} className="num">{i.no}. {i.name}</th>)}
                <th className="num">合計</th>
              </tr>
            </thead>
            <tbody>
              {m.companies.map((c) => {
                const p = m.periodFor(c.id, slot)
                if (!rows.some((r) => r.period_id === p?.id)) return null
                return (
                  <tr key={c.id}>
                    <td>{c.code} {c.name} <span className="muted small">{p?.label}</span></td>
                    {issuesWithData.map((i) => (
                      <td key={i.code} className="num">
                        {rows.some((r) => r.period_id === p?.id && r.issue_code === i.code)
                          ? <Link to={`/work/${p!.id}/${i.code}`}><Money value={profit(p?.id, i.code)} signed /></Link>
                          : <span className="muted">—</span>}
                      </td>
                    ))}
                    <td className="num"><b><Money value={profit(p?.id, null)} signed /></b></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
