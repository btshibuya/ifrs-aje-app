import { useState } from 'react'
import { Link } from 'react-router-dom'
import { DivergingBars, Waterfall, useTooltip, yenText, type WaterfallStep } from '../components/charts'
import { ErrorBox, Loading, Money, PageHeader, SlotToggle } from '../components/ui'
import { useAsync, useSlot } from '../lib/hooks'
import { fetchMasters } from '../lib/masters'
import { must, supabase } from '../lib/supabase'

interface ImpactRow { company_code: string; period_id: string; issue_code: string; statement: string; net_debit: number }

// PL の仕訳明細（科目別の内訳に使う）
interface PlLine {
  side: 'debit' | 'credit'
  amount: number
  group_account_code: string
  group_accounts: { name: string; pl_class: string | null }
  journal_entries: { period_id: string; issue_code: string }
}

export default function ImpactPage() {
  const [slot, setSlot] = useSlot()
  const [picked, setPicked] = useState<string | null>(null)
  const tooltip = useTooltip()
  const { data, error, loading } = useAsync(async () => {
    const m = await fetchMasters()
    // 対象の時点の期だけを読む（四半期を含めると行数が上限の1000行を超えるため）
    const pids = m.companies.map((c) => m.periodFor(c.id, slot)?.id).filter((x): x is string => !!x)
    const [rows, lines] = await Promise.all([
      supabase.from('v_impact_summary').select('*').in('period_id', pids),
      // 影響額の集計（v_impact_summary）と同じく、下書き・確定の計算の仕訳だけを使う
      supabase.from('journal_lines')
        .select('side, amount, group_account_code, group_accounts!inner(name, statement, pl_class), journal_entries!inner(period_id, issue_code, calculation_runs!inner(status))')
        .eq('group_accounts.statement', 'PL')
        .in('journal_entries.calculation_runs.status', ['draft', 'final'])
        .in('journal_entries.period_id', pids),
    ])
    return { m, rows: must(rows) as ImpactRow[], lines: must(lines) as unknown as PlLine[] }
  }, [slot])

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

  const companies = m.companies
    .map((c) => ({ c, p: m.periodFor(c.id, slot) }))
    .filter(({ p }) => p && rows.some((r) => r.period_id === p.id))
  const groupTotal = companies.reduce((s, { p }) => s + profit(p?.id, null), 0)

  // 内訳を出す会社：選んだ会社、なければ影響額の絶対値が最も大きい会社
  const ranked = [...companies].sort((a, b) => profit(b.p?.id, null) - profit(a.p?.id, null))
  const largest = [...companies].sort((a, b) => Math.abs(profit(b.p?.id, null)) - Math.abs(profit(a.p?.id, null)))[0]
  const focus = companies.find(({ c }) => c.id === picked) ?? largest

  // 科目別（利益への影響の向き）：税金以外の科目 → 税効果前の小計 → 法人税等調整額 → 当期純利益
  let steps: WaterfallStep[] = []
  if (focus) {
    const byAccount = new Map<string, { name: string; tax: boolean; value: number }>()
    for (const l of data.lines) {
      if (l.journal_entries.period_id !== focus.p!.id) continue
      const a = byAccount.get(l.group_account_code) ?? { name: l.group_accounts.name, tax: l.group_accounts.pl_class === 'income_tax', value: 0 }
      a.value += l.side === 'debit' ? -Number(l.amount) : Number(l.amount)
      byAccount.set(l.group_account_code, a)
    }
    const accounts = [...byAccount.entries()].filter(([, a]) => Math.round(a.value) !== 0)
    const pretax = accounts.filter(([, a]) => !a.tax).sort((x, y) => x[1].value - y[1].value)
    const tax = accounts.filter(([, a]) => a.tax)
    const pretaxTotal = pretax.reduce((s, [, a]) => s + a.value, 0)
    steps = [
      ...pretax.map(([code, a]) => ({ key: code, label: a.name, value: a.value, kind: 'delta' as const })),
      { key: 'pretax', label: '税効果前の影響', value: pretaxTotal, kind: 'total' },
      ...tax.map(([code, a]) => ({ key: code, label: a.name, value: a.value, kind: 'delta' as const })),
      { key: 'net', label: '当期純利益への影響', value: profit(focus.p?.id, null), kind: 'total' },
    ]
  }

  return (
    <>
      <PageHeader title="論点別影響額一覧">
        <SlotToggle slot={slot} onChange={setSlot} years={m.yearLabels} />
      </PageHeader>
      <p className="muted small">
        計算済み・確定済みの仕訳を集計した、当期純利益への影響額です（プラス＝利益が増える）。税効果（法人税等調整額）を含みます。
        累積の論点は当期の変動分、洗替の論点は期末の全額で、開始仕訳による戻入れ・引継ぎは含みません（開始仕訳・開始実現仕訳を含めた金額は<Link to="/consolidation">連結精算表</Link>で見られます）。
      </p>
      {issuesWithData.length === 0 ? (
        <div className="alert alert-info">まだ計算した論点がありません。進捗一覧から作業画面を開いて計算してください。</div>
      ) : (
        <div className="stack">
          <div className="hero-row">
            <div className="stat">
              <div className="stat-label">当期純利益への影響（計算済みの会社の合計）</div>
              <div className={`stat-value${groupTotal < 0 ? ' text-error' : ''}`}>{yenText(groupTotal, true)}<span className="small muted"> 円</span></div>
            </div>
            <div className="stat"><div className="stat-label">計算済みの会社</div><div className="stat-value">{companies.length}<span className="small muted"> 社</span></div></div>
          </div>
          {tooltip.node}
          <div className="chart-grid">
            <div className="card">
              <div className="card-title">会社別：当期純利益への影響<span className="small muted">行を押すと内訳を表示</span></div>
              <DivergingBars
                rows={ranked.map(({ c, p }) => ({ key: c.id, label: `${c.code} ${c.name}`, sub: p?.label, value: profit(p?.id, null) }))}
                selected={focus?.c.id}
                onSelect={setPicked}
                tooltip={tooltip}
              />
              <div className="viz-legend">
                <span><span className="viz-swatch" style={{ background: 'var(--viz-pos)' }} /> 利益が増える</span>
                <span><span className="viz-swatch" style={{ background: 'var(--viz-neg)' }} /> 利益が減る</span>
              </div>
            </div>
            {focus && (
              <div className="card">
                <div className="card-title">内訳：{focus.c.code} {focus.c.name}（{focus.p?.label}）</div>
                <Waterfall steps={steps} tooltip={tooltip} />
                <div className="viz-legend">
                  <span><span className="viz-swatch" style={{ background: 'var(--viz-pos)' }} /> 利益が増える科目</span>
                  <span><span className="viz-swatch" style={{ background: 'var(--viz-neg)' }} /> 利益が減る科目</span>
                  <span><span className="viz-swatch" style={{ background: 'var(--viz-total)' }} /> 小計・合計</span>
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">会社×論点の一覧（円）</div>
            <div className="table-wrap">
              <table className="compact impact-table">
                <thead>
                  <tr>
                    <th>会社</th>
                    {issuesWithData.map((i) => <th key={i.code} className="num">{i.no}. {i.name}</th>)}
                    <th className="num">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {companies.map(({ c, p }) => (
                    <tr key={c.id}>
                      <td>{c.code} {c.name}<div className="muted small">{p?.label}</div></td>
                      {issuesWithData.map((i) => (
                        <td key={i.code} className="num">
                          {rows.some((r) => r.period_id === p?.id && r.issue_code === i.code)
                            ? <Link to={`/work/${p!.id}/${i.code}`}><Money value={profit(p?.id, i.code)} signed /></Link>
                            : <span className="muted">—</span>}
                        </td>
                      ))}
                      <td className="num"><b><Money value={profit(p?.id, null)} signed /></b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
