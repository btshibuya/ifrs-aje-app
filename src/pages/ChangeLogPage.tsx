import { Fragment, useState } from 'react'
import { ErrorBox, Loading, PageHeader, formatDateTime } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { must, supabase } from '../lib/supabase'

interface LogRow {
  id: number
  table_name: string
  record_id: string | null
  action: string
  before_data: Record<string, unknown> | null
  after_data: Record<string, unknown> | null
  changed_by: string | null
  changed_at: string
}

const TABLE_LABELS: Record<string, string> = {
  companies: '会社', periods: '決算期', journal_categories: '仕訳区分', group_accounts: 'グループ統一科目',
  account_mappings: '科目マッピング', column_mappings: '列マッピング', asset_class_rules: '区分マッピング', policies: '会計方針',
  source_files: '元資料', detail_items: '明細', field_reviews: 'PDF項目の確認', item_key_links: '明細番号の新旧対応',
  calculation_runs: '計算の実行', item_balances: '明細の期末残高', journal_entries: '仕訳', journal_lines: '仕訳明細',
  btrex_opening_balances: 'BTrex開始仕訳', work_status: '進捗・確定',
}
const ACTION_LABELS: Record<string, string> = { INSERT: '追加', UPDATE: '変更', DELETE: '削除' }

// 変更前後で値が変わった項目だけを出す
function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...keys]
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
    .map((k) => ({ k, before: before?.[k], after: after?.[k] }))
}

const show = (v: unknown) => (v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export default function ChangeLogPage() {
  const [table, setTable] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const { data, error, loading } = useAsync(async () => {
    let q = supabase.from('change_logs').select('*').order('id', { ascending: false }).limit(300)
    if (table) q = q.eq('table_name', table)
    return must(await q) as LogRow[]
  }, [table])

  return (
    <>
      <PageHeader title="変更履歴">
        <select value={table} onChange={(e) => setTable(e.target.value)} aria-label="テーブルで絞り込む">
          <option value="">すべて</option>
          {Object.entries(TABLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </PageHeader>
      <p className="muted small">主なテーブルへの追加・変更・削除をDB側で自動記録しています（新しい順に300件）。履歴は画面から変更できません。行を押すと変更内容を表示します。</p>
      {loading && !data && <Loading />}
      {error && <ErrorBox message={error} />}
      {data && (
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th>日時</th><th>対象</th><th>操作</th><th>変更者</th><th>内容</th></tr></thead>
            <tbody>
              {data.map((r) => {
                const d = diff(r.before_data, r.after_data)
                const summary = r.action === 'UPDATE'
                  ? d.filter((x) => x.k !== 'updated_at').map((x) => `${x.k}: ${show(x.before)} → ${show(x.after)}`).join('、')
                  : String((r.after_data ?? r.before_data)?.description ?? (r.after_data ?? r.before_data)?.item_key ?? (r.after_data ?? r.before_data)?.name ?? (r.after_data ?? r.before_data)?.file_name ?? '')
                return (
                  <Fragment key={r.id}>
                    <tr className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td className="nowrap">{formatDateTime(r.changed_at)}</td>
                      <td>{TABLE_LABELS[r.table_name] ?? r.table_name}</td>
                      <td><span className={`badge action-${r.action}`}>{ACTION_LABELS[r.action] ?? r.action}</span></td>
                      <td className="small muted">{r.changed_by ?? '（ログインなし）'}</td>
                      <td className="small ellipsis">{summary}</td>
                    </tr>
                    {open === r.id && (
                      <tr className="detail-row">
                        <td colSpan={5}>
                          <table className="compact">
                            <thead><tr><th>項目</th><th>変更前</th><th>変更後</th></tr></thead>
                            <tbody>{d.map((x) => <tr key={x.k}><td>{x.k}</td><td className="mono small">{show(x.before)}</td><td className="mono small">{show(x.after)}</td></tr>)}</tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
