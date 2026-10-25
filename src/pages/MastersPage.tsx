import { useState } from 'react'
import { ErrorBox, Loading, PageHeader, Tabs } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { CARRY_METHOD_LABELS } from '../lib/issues'
import { KIND_LABELS, MATERIALS, formByCode } from '../lib/materials'
import { UNIT, formatNumber, isNumeric } from '../lib/package'
import { must, supabase } from '../lib/supabase'

type Key = 'companies' | 'materials' | 'categories' | 'accounts' | 'rules' | 'columns'

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
          { key: 'materials', label: '資料・収集様式' },
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
        {data && tab === 'materials' && (
          <div className="stack">
            <p className="small muted">論点ごとに子会社へ依頼する資料と、収集パッケージの様式（項目・入力例）です。定義は src/lib/materials.ts にあります。</p>
            {data.issues.map((i) => {
              const list = MATERIALS.filter((m) => m.issueCode === i.code)
              return (
                <div className="card" key={i.code}>
                  <div className="card-title"><span><span className="issue-no-sm">{i.no}</span>{i.name}</span></div>
                  {list.length === 0 && <p className="small muted">資料の定義はまだありません。</p>}
                  {list.map((m) => {
                    const f = m.formCode ? formByCode(m.formCode) : undefined
                    const cols = f?.fields ?? f?.table?.columns ?? []
                    return (
                      <details key={m.code} className="master-material">
                        <summary><b>{m.name}</b> <span className={`badge kind-${m.kind}`}>{KIND_LABELS[m.kind]}</span> <span className="small muted">{m.source}</span></summary>
                        <p className="small">{m.prepare}</p>
                        {cols.length > 0 && (
                          <div className="table-wrap">
                            <table className="compact">
                              <thead><tr><th>項目</th><th>比べる値</th><th>入力例</th><th>説明</th></tr></thead>
                              <tbody>
                                {cols.map((c) => (
                                  <tr key={c.key}>
                                    <td className="nowrap">{c.label}{c.required && <span className="req">必須</span>}</td>
                                    <td className="small nowrap">{c.carryFrom ? '前年度末の期末残高' : c.basis === 'stock' ? '前年度末（BS）' : c.basis === 'flow' ? '前年同期（PL）' : '—'}</td>
                                    <td className="small nowrap">{isNumeric(c) ? `${formatNumber(c.example, c.type)}${UNIT[c.type]}` : String(c.example)}</td>
                                    <td className="small">{c.help}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </details>
                    )
                  })}
                </div>
              )
            })}
          </div>
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
