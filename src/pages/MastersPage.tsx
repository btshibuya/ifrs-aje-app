import { useState } from 'react'
import { ErrorBox, Loading, PageHeader, Tabs } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { CARRY_METHOD_LABELS } from '../lib/issues'
import { KIND_LABELS, MATERIALS, formByCode } from '../lib/materials'
import { UNIT, formatNumber, isNumeric } from '../lib/package'
import { must, supabase } from '../lib/supabase'
import MasterTable, { type Row } from './masters/MasterTable'
import TestDataPanel from './masters/TestDataPanel'

type Key = 'companies' | 'periods' | 'issues' | 'materials' | 'categories' | 'accounts' | 'rules' | 'columns' | 'testdata'

const SOFTWARE = ['勘定奉行', '弥生会計', 'freee会計', 'マネーフォワード', 'PCA会計', 'その他'].map((v) => ({ value: v, label: v }))
const BS_CLASSES = [
  { value: 'current_asset', label: '流動資産' }, { value: 'noncurrent_asset', label: '非流動資産' },
  { value: 'current_liability', label: '流動負債' }, { value: 'noncurrent_liability', label: '非流動負債' }, { value: 'equity', label: '資本' },
]
const PL_CLASSES = [{ value: 'operating', label: '営業損益' }, { value: 'finance', label: '金融損益' }, { value: 'income_tax', label: '法人所得税' }]
const SOURCE_KINDS = [{ value: 'fixed_assets', label: '固定資産台帳' }, { value: 'paid_leave', label: '有給休暇の残日数一覧' }]

export default function MastersPage() {
  const [tab, setTab] = useState<Key>('companies')
  const { data, error, loading, reload } = useAsync(async () => {
    const [companies, periods, categories, accounts, rules, columns, issues] = await Promise.all([
      supabase.from('companies').select('*').order('code'),
      supabase.from('periods').select('*').order('end_date'),
      supabase.from('journal_categories').select('*').order('sort_order'),
      supabase.from('group_accounts').select('*').order('code'),
      supabase.from('asset_class_rules').select('*').order('source_asset_type'),
      supabase.from('column_mappings').select('*').order('source_kind'),
      supabase.from('issues').select('*').order('no'),
    ])
    return {
      companies: must(companies) as Row[], periods: must(periods) as Row[], categories: must(categories) as Row[],
      accounts: must(accounts) as Row[], rules: must(rules) as Row[], columns: must(columns) as Row[], issues: must(issues) as Row[],
    }
  }, [])

  const companyOptions = (data?.companies ?? []).map((c) => ({ value: String(c.id), label: `${c.code} ${c.name}` }))
  const companyLabel = (id: unknown) => (id ? companyOptions.find((o) => o.value === id)?.label ?? String(id) : 'グループ共通')
  const issueOptions = (data?.issues ?? []).map((i) => ({ value: String(i.code), label: `${i.no}. ${i.name}` }))
  const periodOptions = (data?.periods ?? []).filter((p) => p.period_type === 'FY').map((p) => ({ value: String(p.id), label: `${companyLabel(p.company_id).split(' ')[0]} ${p.label}` }))

  return (
    <>
      <PageHeader title="マスタ" />
      <p className="muted small">
        追加・編集・非表示・削除ができます。使わなくなったものは「非表示」にすると、一覧や計算に出なくなります（あとで表示に戻せます）。
        ほかのデータが使っているものは削除できません。変更はすべて変更履歴に残ります。
      </p>
      <Tabs<Key>
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'companies', label: '会社' },
          { key: 'periods', label: '決算期' },
          { key: 'issues', label: '論点' },
          { key: 'materials', label: '資料・収集様式' },
          { key: 'categories', label: '仕訳区分' },
          { key: 'accounts', label: 'グループ統一科目' },
          { key: 'rules', label: '経済的耐用年数' },
          { key: 'columns', label: '列マッピング' },
          { key: 'testdata', label: 'テストデータ' },
        ]}
      />
      <div className="tab-body">
        {tab === 'testdata' && <TestDataPanel onChanged={reload} />}
        {loading && !data && tab !== 'testdata' && <Loading />}
        {error && <ErrorBox message={error} />}
        {data && tab === 'companies' && (
          <MasterTable table="companies" title="会社" pk="id" rows={data.companies} onChanged={reload}
            hidden={{ column: 'is_active', inverted: true }}
            description="非表示にした会社は、進捗一覧・資料一覧などに出なくなります。"
            columns={[
              { key: 'code', label: 'コード', type: 'text', required: true, readOnlyOnEdit: true, placeholder: '例：S11' },
              { key: 'name', label: '会社名', type: 'text', required: true, width: 220 },
              { key: 'fiscal_year_end_month', label: '決算月', type: 'number', required: true, render: (r) => `${r.fiscal_year_end_month}月`, help: '1〜12' },
              { key: 'accounting_software', label: '会計ソフト', type: 'select', options: SOFTWARE },
            ]}
            defaults={() => ({ fiscal_year_end_month: 3 })}
            validate={(r) => (Number(r.fiscal_year_end_month) >= 1 && Number(r.fiscal_year_end_month) <= 12 ? null : '決算月は 1〜12 で入力してください')}
          />
        )}
        {data && tab === 'periods' && (
          <MasterTable table="periods" title="決算期" pk="id" rows={data.periods} onChanged={reload}
            description="会社ごとの決算期と四半期です。四半期の開始日は年度の開始日（累計期間）で、「前期」には前年度の期末を指定します。前期の確定した残高から、四半期末・期末までの累計で計算します。"
            defaults={() => ({ period_type: 'FY' })}
            columns={[
              { key: 'company_id', label: '会社', type: 'select', required: true, options: companyOptions, readOnlyOnEdit: true, width: 200 },
              { key: 'label', label: '名称', type: 'text', required: true, placeholder: '例：2028年3月期 第1四半期' },
              { key: 'period_type', label: '種類', type: 'select', required: true, options: [
                { value: 'Q1', label: '第1四半期' }, { value: 'Q2', label: '第2四半期' }, { value: 'Q3', label: '第3四半期' }, { value: 'FY', label: '期末（本決算）' },
              ] },
              { key: 'start_date', label: '開始日', type: 'date', required: true },
              { key: 'end_date', label: '終了日', type: 'date', required: true },
              { key: 'prior_period_id', label: '前期', type: 'select', options: periodOptions, width: 180 },
            ]}
            validate={(r) => (String(r.start_date ?? '') < String(r.end_date ?? '') ? null : '終了日は開始日より後にしてください')}
          />
        )}
        {data && tab === 'issues' && (
          <MasterTable table="issues" title="論点" pk="code" rows={data.issues} onChanged={reload}
            hidden={{ column: 'is_hidden' }}
            description="非表示にした論点は、進捗一覧・資料一覧・ホームなどに出なくなります。計算まで実装している論点は、有給休暇引当金・減価償却です。"
            columns={[
              { key: 'no', label: '番号', type: 'number', required: true },
              { key: 'code', label: 'コード', type: 'text', required: true, readOnlyOnEdit: true, placeholder: '例：LEASE' },
              { key: 'name', label: '論点名', type: 'text', required: true, width: 260 },
              { key: 'standard_ref', label: '基準', type: 'text', placeholder: '例：IFRS16' },
            ]}
            defaults={() => ({ no: Math.max(0, ...data.issues.map((i) => Number(i.no))) + 1 })}
            validate={(r, isNew) => (isNew && !/^[A-Z0-9_]+$/.test(String(r.code ?? '')) ? 'コードは半角の英大文字・数字・_ で入力してください' : null)}
          />
        )}
        {data && tab === 'materials' && (
          <div className="stack">
            <p className="small muted">論点ごとに子会社へ依頼する資料と、収集パッケージの様式（項目・入力例）です。定義は src/lib/materials.ts にあります。</p>
            {data.issues.filter((i) => !i.is_hidden).map((i) => {
              const list = MATERIALS.filter((m) => m.issueCode === i.code)
              return (
                <div className="card" key={String(i.code)}>
                  <div className="card-title"><span><span className="issue-no-sm">{String(i.no)}</span>{String(i.name)}</span></div>
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
          <MasterTable table="journal_categories" title="仕訳区分" pk="code" rows={data.categories} onChanged={reload}
            hidden={{ column: 'is_hidden' }}
            description="BTrexの開始仕訳の方式（累積・洗替・組換）と1対1で対応させます。"
            columns={[
              { key: 'code', label: 'コード', type: 'text', required: true, readOnlyOnEdit: true },
              { key: 'issue_code', label: '論点', type: 'select', required: true, options: issueOptions, width: 200 },
              { key: 'name', label: '仕訳区分', type: 'text', required: true, width: 200 },
              { key: 'carry_method', label: '方式', type: 'select', required: true, options: Object.entries(CARRY_METHOD_LABELS).map(([value, label]) => ({ value, label })),
                render: (r) => <span className={`badge method-${r.carry_method}`}>{CARRY_METHOD_LABELS[String(r.carry_method)]}</span> },
              { key: 'is_tax_effect', label: '税効果', type: 'bool' },
              { key: 'sort_order', label: '並び順', type: 'number' },
              { key: 'btrex_category_code', label: 'BTrex区分コード', type: 'text' },
            ]}
            defaults={() => ({ is_tax_effect: false, sort_order: 999 })}
          />
        )}
        {data && tab === 'accounts' && (
          <MasterTable table="group_accounts" title="グループ統一科目" pk="code" rows={data.accounts} onChanged={reload}
            hidden={{ column: 'is_hidden' }}
            columns={[
              { key: 'code', label: 'コード', type: 'text', required: true, readOnlyOnEdit: true, placeholder: '例：BS_LEASE_LIAB' },
              { key: 'name', label: '科目名', type: 'text', required: true, width: 220 },
              { key: 'statement', label: '区分', type: 'select', required: true, options: [{ value: 'BS', label: 'BS' }, { value: 'PL', label: 'PL' }, { value: 'OCI', label: 'OCI' }] },
              { key: 'bs_class', label: 'BS区分', type: 'select', options: BS_CLASSES },
              { key: 'pl_class', label: 'PL区分', type: 'select', options: PL_CLASSES },
              { key: 'btrex_account_code', label: 'BTrex科目コード', type: 'text' },
            ]}
            validate={(r) => (r.statement === 'BS') !== !!r.bs_class ? 'BS の科目だけ BS区分を選んでください（BS 以外は空欄）' : r.statement === 'PL' && !r.pl_class ? 'PL の科目は PL区分を選んでください' : null}
          />
        )}
        {data && tab === 'rules' && (
          <MasterTable table="asset_class_rules" title="経済的耐用年数" pk="id" rows={data.rules} onChanged={reload}
            hidden={{ column: 'is_hidden' }}
            description="台帳上の資産の種類ごとの、IFRSでの耐用年数です。会社を選ぶと、その会社だけの上書きになります。"
            columns={[
              { key: 'company_id', label: '適用範囲', type: 'select', options: companyOptions, render: (r) => companyLabel(r.company_id), width: 180 },
              { key: 'source_asset_type', label: '台帳上の種類', type: 'text', required: true },
              { key: 'asset_class', label: 'グループの資産区分', type: 'text', required: true },
              { key: 'useful_life_years', label: '経済的耐用年数（年）', type: 'number', required: true },
              { key: 'residual_rate', label: '残存価額', type: 'number', required: true, render: (r) => `${(Number(r.residual_rate) * 100).toFixed(0)}%`, help: '割合で入力（0.1 = 10%）' },
              { key: 'method', label: '償却方法', type: 'select', required: true, options: [{ value: 'straight_line', label: '定額法' }, { value: 'declining_balance', label: '定率法' }] },
              { key: 'effective_from', label: '適用開始日', type: 'date', required: true },
              { key: 'note', label: '備考', type: 'text', width: 200 },
            ]}
            defaults={() => ({ residual_rate: 0, method: 'straight_line', effective_from: '2020-01-01' })}
            validate={(r) => (Number(r.useful_life_years) > 0 ? Number(r.residual_rate) >= 0 && Number(r.residual_rate) <= 1 ? null : '残存価額は 0〜1 の割合で入力してください' : '耐用年数は 0 より大きい数で入力してください')}
          />
        )}
        {data && tab === 'columns' && (
          <MasterTable table="column_mappings" title="列マッピング" pk="id" rows={data.columns} onChanged={reload}
            hidden={{ column: 'is_hidden' }}
            description="取込ファイルの列名 → アプリの項目。会社・会計ソフトの指定がより細かいものを優先します。"
            columns={[
              { key: 'source_kind', label: '取込ファイル', type: 'select', required: true, options: SOURCE_KINDS },
              { key: 'company_id', label: '会社', type: 'select', options: companyOptions, render: (r) => companyLabel(r.company_id), width: 180 },
              { key: 'software', label: '会計ソフト', type: 'select', options: SOFTWARE, emptyValue: '', render: (r) => String(r.software || '（指定なし）') },
              { key: 'header_row', label: '見出しの行', type: 'number', required: true },
              { key: 'mapping', label: '対応（アプリの項目 = ファイルの列名）', type: 'mapping', required: true, width: 260,
                placeholder: 'asset_no = 資産番号\nname = 資産名称',
                render: (r) => <span className="small">{Object.entries((r.mapping ?? {}) as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('、')}</span> },
            ]}
            defaults={() => ({ header_row: 1 })}
          />
        )}
      </div>
    </>
  )
}
