import { useState } from 'react'
import { ErrorBox, Loading, PageHeader, Tabs } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { CARRY_METHOD_LABELS } from '../lib/issues'
import { must, supabase } from '../lib/supabase'

type Key = 'companies' | 'categories' | 'accounts' | 'rules' | 'columns'

export default function MastersPage() {
  const [tab, setTab] = useState<Key>('companies')
  const { data, error, loading } = useAsync(async () => {
    const [companies, periods, categories, accounts, rules, columns, issues] = await Promise.all([
      supabase.from('companies').select('*').order('code'),
      supabase.from('periods').select('*').order('end_date'),
      supabase.from('journal_categories').select('*').order('sort_order'),
      supabase.from('group_accounts').select('*').order('code'),
      supabase.from('asset_class_rules').select('*, companies(code, name)').order('source_asset_type'),
      supabase.from('column_mappings').select('*, companies(code, name)').order('source_kind'),
      supabase.from('issues').select('code, no, name').order('no'),
    ])
    return {
      companies: must(companies) as Record<string, string | number>[],
      periods: must(periods) as Record<string, string>[],
      categories: must(categories) as Record<string, string | boolean | number>[],
      accounts: must(accounts) as Record<string, string>[],
      rules: must(rules) as (Record<string, string | number> & { companies: { code: string; name: string } | null })[],
      columns: must(columns) as { id: string; source_kind: string; software: string; header_row: number; mapping: Record<string, string>; companies: { code: string; name: string } | null }[],
      issues: must(issues) as { code: string; no: number; name: string }[],
    }
  }, [])

  return (
    <>
      <PageHeader title="マスタ" />
      <p className="muted small">このプロトタイプでは参照のみです（変更はDBで行います）。</p>
      <Tabs<Key>
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'companies', label: '会社・決算期' },
          { key: 'categories', label: '仕訳区分' },
          { key: 'accounts', label: 'グループ統一科目' },
          { key: 'rules', label: '経済的耐用年数' },
          { key: 'columns', label: '列マッピング' },
        ]}
      />
      <div className="tab-body">
        {loading && !data && <Loading />}
        {error && <ErrorBox message={error} />}
        {data && tab === 'companies' && (
          <table className="compact">
            <thead><tr><th>コード</th><th>会社名</th><th>決算月</th><th>会計ソフト</th><th>決算期</th></tr></thead>
            <tbody>
              {data.companies.map((c) => (
                <tr key={c.id}>
                  <td>{c.code}</td><td>{c.name}</td><td>{c.fiscal_year_end_month}月</td><td>{c.accounting_software}</td>
                  <td>{data.periods.filter((p) => p.company_id === c.id).map((p) => `${p.label}（${p.start_date}〜${p.end_date}）`).join('、')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && tab === 'categories' && (
          <table className="compact">
            <thead><tr><th>論点</th><th>コード</th><th>仕訳区分</th><th>方式</th><th>税効果</th><th>BTrex区分コード</th></tr></thead>
            <tbody>
              {data.categories.map((c) => {
                const i = data.issues.find((x) => x.code === c.issue_code)
                return (
                  <tr key={String(c.code)}>
                    <td>{i?.no}. {i?.name}</td><td className="mono small">{c.code}</td><td>{c.name}</td>
                    <td><span className={`badge method-${c.carry_method}`}>{CARRY_METHOD_LABELS[String(c.carry_method)]}</span></td>
                    <td>{c.is_tax_effect ? '○' : ''}</td><td className="muted">{c.btrex_category_code ?? '未設定'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {data && tab === 'accounts' && (
          <table className="compact">
            <thead><tr><th>コード</th><th>科目名</th><th>区分</th><th>BS区分</th><th>PL区分</th></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.code}><td className="mono small">{a.code}</td><td>{a.name}</td><td>{a.statement}</td><td>{a.bs_class ?? ''}</td><td>{a.pl_class ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {data && tab === 'rules' && (
          <table className="compact">
            <thead><tr><th>適用範囲</th><th>台帳上の種類</th><th className="num">経済的耐用年数</th><th className="num">残存価額</th><th>適用開始日</th><th>備考</th></tr></thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={String(r.id)}>
                  <td>{r.companies ? `${r.companies.code} ${r.companies.name}` : 'グループ共通'}</td><td>{r.source_asset_type}</td>
                  <td className="num">{Number(r.useful_life_years)}年</td><td className="num">{(Number(r.residual_rate) * 100).toFixed(0)}%</td>
                  <td>{r.effective_from}</td><td className="small muted">{r.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && tab === 'columns' && (
          <div className="stack">
            {data.columns.map((c) => (
              <div className="card" key={c.id}>
                <div className="card-title">
                  {c.source_kind === 'fixed_assets' ? '固定資産台帳' : c.source_kind === 'paid_leave' ? '有給休暇の残日数一覧' : c.source_kind}
                  ／ {c.companies ? `${c.companies.code} ${c.companies.name}` : 'グループ共通'}{c.software ? `（${c.software}）` : ''}
                </div>
                <table className="compact">
                  <thead><tr><th>アプリの項目</th><th>ファイルの列名</th></tr></thead>
                  <tbody>{Object.entries(c.mapping).map(([k, v]) => <tr key={k}><td className="mono small">{k}</td><td>{v}</td></tr>)}</tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
