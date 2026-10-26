// 連結精算表（IFRS調整）：会社×論点の仕訳を集計し、開始仕訳・開始実現仕訳・当期仕訳に分ける
//
// 開始仕訳（前期までの調整を期首に入れる）
//   累積の区分：前年度までの確定した計算の仕訳の累計（各年度は当期の変動分を出力しているため、足すと期首残高になる）
//   洗替の区分：前年度末の確定した計算の仕訳（期末の全額）
//   どちらも、損益（PL）は利益剰余金、その他の包括利益（OCI）はその他の資本の構成要素に置き換える
//   組換の区分：翌期に引き継がないため、開始仕訳はない
// 開始実現仕訳（洗替の区分だけ）：開始仕訳で入れた前年度末の全額を、期首に戻し入れる
//   前年度末の仕訳の貸借を逆にする（BSは開始仕訳と相殺され、PLは当期の損益に入る）
// 当期仕訳：選んだ時点（四半期末・期末）の計算の仕訳。四半期は期首からの累計
//
// 金額はすべて借方プラス・貸方マイナス

import { must, supabase } from './supabase'
import type { MasterData, PeriodRow } from './masters'
import type { Slot } from './hooks'

export type Kind = 'opening' | 'realization' | 'current'
export const KIND_LABELS: Record<Kind, string> = { opening: '開始仕訳', realization: '開始実現仕訳', current: '当期仕訳' }
export const KINDS: Kind[] = ['opening', 'realization', 'current']

export interface CLine {
  companyId: string
  issueCode: string
  categoryCode: string
  kind: Kind
  account: string
  amount: number // 借方プラス
  source?: string // 元の仕訳（年度・摘要）。表示用
  sourceAccount?: string // 開始仕訳で置き換える前の科目
  periodId?: string // 元の計算の期（作業画面へのリンク）
  status?: 'draft' | 'final'
}

export interface Account { code: string; name: string; statement: 'BS' | 'PL' | 'OCI'; bs_class: string | null; pl_class: string | null }
export interface Category { code: string; issue_code: string; name: string; carry_method: 'cumulative' | 'reversing' | 'reclass'; is_tax_effect: boolean }

// 借方はそのまま、貸方は△（精算表の書き方）
export const amt = (v: number, blankZero = true) =>
  (Math.round(v) === 0 ? (blankZero ? '' : '0') : `${v < 0 ? '△' : ''}${Math.round(Math.abs(v)).toLocaleString('ja-JP')}`)

export const RETAINED = 'BS_RETAINED'
export const OCI_RESERVE = 'BS_OCI_RESERVE'

export interface RawEntry {
  runId: string
  periodId: string
  issueCode: string
  categoryCode: string
  description: string
  status: 'draft' | 'final'
  lines: { account: string; amount: number }[] // 借方プラス
}

// 1社分の仕訳を、開始・開始実現・当期に分ける（DBを使わない計算。試験しやすくする）
export function buildCompanyLines(input: {
  companyId: string
  current: PeriodRow
  priorYears: PeriodRow[] // 選んだ時点より前の年度（本決算）。古い順
  entries: RawEntry[]
  categories: Map<string, Category>
  accounts: Map<string, Account>
  includeDraft: boolean
  issueName?: (code: string) => string
}): { lines: CLine[]; warnings: string[] } {
  const { companyId, current, priorYears, entries, categories, accounts } = input
  const lines: CLine[] = []
  const warnings: string[] = []
  const lastYear = priorYears[priorYears.length - 1]
  const toEquity = (code: string) => {
    const st = accounts.get(code)?.statement
    return st === 'PL' ? RETAINED : st === 'OCI' ? OCI_RESERVE : code
  }
  const yearLabel = new Map(priorYears.map((p) => [p.id, p.label]))

  for (const e of entries) {
    const cat = categories.get(e.categoryCode)
    if (!cat) continue
    if (e.periodId === current.id) {
      if (e.status === 'draft' && !input.includeDraft) continue
      for (const l of e.lines) {
        lines.push({ companyId, issueCode: e.issueCode, categoryCode: e.categoryCode, kind: 'current', account: l.account, amount: l.amount, source: e.description, periodId: e.periodId, status: e.status })
      }
      continue
    }
    if (!yearLabel.has(e.periodId)) continue
    // 開始仕訳は、確定した前年度までの計算だけを使う（BTrexの開始仕訳と同じ）
    if (e.status !== 'final') continue
    const isLast = e.periodId === lastYear?.id
    if (cat.carry_method === 'reclass') continue
    if (cat.carry_method === 'reversing' && !isLast) continue
    const src = `${yearLabel.get(e.periodId)}：${e.description}`
    for (const l of e.lines) {
      lines.push({ companyId, issueCode: e.issueCode, categoryCode: e.categoryCode, kind: 'opening', account: toEquity(l.account), amount: l.amount, source: src, sourceAccount: l.account, periodId: e.periodId, status: 'final' })
      if (cat.carry_method === 'reversing') {
        lines.push({ companyId, issueCode: e.issueCode, categoryCode: e.categoryCode, kind: 'realization', account: l.account, amount: -l.amount, source: src, periodId: e.periodId, status: 'final' })
      }
    }
  }

  // 前年度の計算が確定していない論点（開始仕訳に入らない）
  if (lastYear) {
    const finals = new Set(entries.filter((e) => e.periodId === lastYear.id && e.status === 'final').map((e) => e.issueCode))
    const drafts = new Set(entries.filter((e) => e.periodId === lastYear.id && e.status === 'draft').map((e) => e.issueCode))
    for (const i of drafts) if (!finals.has(i)) warnings.push(`${lastYear.label}の「${input.issueName?.(i) ?? i}」が未確定のため、開始仕訳に入っていません`)
  }
  return { lines, warnings }
}

// 行（科目）× 列の集計。列のキーは呼び出し側で決める（種類・論点・会社）
export function pivot(lines: CLine[], colOf: (l: CLine) => string) {
  const cells = new Map<string, Map<string, number>>()
  for (const l of lines) {
    const row = cells.get(l.account) ?? new Map<string, number>()
    const c = colOf(l)
    row.set(c, (row.get(c) ?? 0) + l.amount)
    cells.set(l.account, row)
  }
  return cells
}

// 科目の並び：BS（資産 → 負債 → 純資産）→ PL（営業 → 金融 → 税金）→ OCI。税効果の科目は区分の最後
const CLASS_ORDER = ['current_asset', 'noncurrent_asset', 'current_liability', 'noncurrent_liability', 'equity', 'operating', 'finance', 'income_tax']
const isTax = (code: string) => /_DT[AL]$/.test(code) || code === 'PL_DEFERRED_TAX'
export function accountOrder(a: Account) {
  const st = ['BS', 'PL', 'OCI'].indexOf(a.statement)
  const cls = CLASS_ORDER.indexOf(a.bs_class ?? a.pl_class ?? '')
  return st * 1000 + (cls < 0 ? 900 : cls * 10) + (isTax(a.code) ? 5 : 0)
}

export type Section = 'asset' | 'liability' | 'equity' | 'pl' | 'oci'
export const SECTION_LABELS: Record<Section, string> = { asset: '資産', liability: '負債', equity: '純資産', pl: '損益（PL）', oci: 'その他の包括利益（OCI）' }
export const sectionOf = (a: Account): Section =>
  a.statement === 'PL' ? 'pl' : a.statement === 'OCI' ? 'oci'
    : a.bs_class === 'equity' ? 'equity' : a.bs_class?.includes('asset') ? 'asset' : 'liability'

// 合計の指標（借方プラスの金額から、利益・純資産への影響に直す）
export function impacts(lines: CLine[], accounts: Map<string, Account>) {
  let pl = 0
  let oci = 0
  let equity = 0
  let all = 0
  const byKind: Record<Kind, number> = { opening: 0, realization: 0, current: 0 }
  for (const l of lines) {
    const a = accounts.get(l.account)
    all += l.amount
    if (!a) continue
    const sec = sectionOf(a)
    if (sec === 'pl') pl += l.amount
    if (sec === 'oci') oci += l.amount
    if (sec === 'equity') equity += l.amount
    if (sec === 'pl' || sec === 'oci' || sec === 'equity') byKind[l.kind] -= l.amount
  }
  return {
    profit: -pl, // 当期利益への影響（プラス＝利益が増える）
    comprehensive: -(pl + oci),
    netAssets: -(pl + oci + equity), // 期末の純資産への影響
    netAssetsByKind: byKind,
    balance: all, // 貸借の差（0になるはず）
  }
}

// ---------------------------------------------------------------------------
// DBから読む
// ---------------------------------------------------------------------------

export interface Target {
  company: MasterData['companies'][number]
  period: PeriodRow
  priorYears: PeriodRow[]
  status: Map<string, 'draft' | 'final'> // 論点 → 当期の計算の状況
  missing: string[] // 計算まで実装している論点のうち、適用なのに当期の計算がない論点
  stale: string[] // 計算のあとで明細が入れ替わり、再計算を待っている論点（前の仕訳のまま集計している）
}

export interface Snapshot { id: string; as_of: string; label: string; lines: CLine[]; note: string | null; created_by: string | null; created_at: string }

export interface ConsolidationData {
  asOf: string
  label: string
  targets: Target[]
  lines: CLine[] // 下書きも含む（画面で絞る）
  warnings: string[]
  accounts: Map<string, Account>
  categories: Map<string, Category>
  snapshots: Snapshot[] // 新しい順
}

// 計算まで実装している論点（当期の計算の有無を確かめる対象）
const implementedIssues = ['PAID_LEAVE', 'DEPRECIATION']

export async function fetchConsolidation(m: MasterData, slot: Slot): Promise<ConsolidationData> {
  const targets: Target[] = []
  for (const c of m.companies) {
    const period = m.periodFor(c.id, slot)
    if (!period) continue
    const priorYears = m.periods.filter((p) => p.company_id === c.id && p.period_type === 'FY' && p.end_date < period.start_date)
    targets.push({ company: c, period, priorYears, status: new Map(), missing: [], stale: [] })
  }
  const periodIds = targets.flatMap((t) => [t.period.id, ...t.priorYears.map((p) => p.id)])
  // 連結の基準日：親会社（3月決算）の時点。決算日が違う会社（12月決算）は3か月前の期を使う
  const asOf = targets.map((t) => t.period.end_date).sort().at(-1) ?? ''
  const rep = targets.find((t) => t.period.end_date === asOf)
  const label = rep?.period.label ?? ''

  const [runs, cats, accs, snaps, pols, wss] = await Promise.all([
    periodIds.length
      ? supabase.from('calculation_runs').select('id, period_id, issue_code, status').in('period_id', periodIds).in('status', ['draft', 'final'])
      : Promise.resolve({ data: [], error: null }),
    supabase.from('journal_categories').select('code, issue_code, name, carry_method, is_tax_effect'),
    supabase.from('group_accounts').select('code, name, statement, bs_class, pl_class'),
    asOf ? supabase.from('consolidation_snapshots').select('*').eq('as_of', asOf).order('created_at', { ascending: false }).limit(10) : Promise.resolve({ data: [], error: null }),
    // 当期の計算がまだない会社×論点を見つけるため、適用の論点を読む
    targets.length
      ? supabase.from('v_policy_matrix').select('period_id, issue_code, applicability').in('period_id', targets.map((t) => t.period.id)).in('issue_code', implementedIssues).eq('applicability', 'applied')
      : Promise.resolve({ data: [], error: null }),
    targets.length
      ? supabase.from('work_status').select('period_id, issue_code, status').in('period_id', targets.map((t) => t.period.id))
      : Promise.resolve({ data: [], error: null }),
  ])
  const ws = must(wss) as { period_id: string; issue_code: string; status: string }[]
  const applied = must(pols) as { period_id: string; issue_code: string }[]
  const runRows = must(runs) as { id: string; period_id: string; issue_code: string; status: 'draft' | 'final' }[]
  const runById = new Map(runRows.map((r) => [r.id, r]))
  const entries = runRows.length
    ? must(await supabase.from('journal_entries').select('run_id, period_id, issue_code, category_code, description, journal_lines(side, amount, group_account_code)').in('run_id', runRows.map((r) => r.id))) as unknown as {
      run_id: string; period_id: string; issue_code: string; category_code: string; description: string
      journal_lines: { side: 'debit' | 'credit'; amount: number; group_account_code: string }[]
    }[]
    : []
  const raw: RawEntry[] = entries.map((e) => ({
    runId: e.run_id, periodId: e.period_id, issueCode: e.issue_code, categoryCode: e.category_code, description: e.description,
    status: runById.get(e.run_id)?.status ?? 'draft',
    lines: e.journal_lines.map((l) => ({ account: l.group_account_code, amount: (l.side === 'debit' ? 1 : -1) * Number(l.amount) })),
  }))
  const categories = new Map((must(cats) as Category[]).map((c) => [c.code, c]))
  const accounts = new Map((must(accs) as Account[]).map((a) => [a.code, a]))

  const lines: CLine[] = []
  const warnings: string[] = []
  for (const t of targets) {
    for (const r of runRows) if (r.period_id === t.period.id) t.status.set(r.issue_code, r.status)
    // 下書きの計算があるのに状況が取込済・チェック済に戻っている＝明細を入れ替えたあと、まだ再計算していない
    t.stale = ws.filter((w) => w.period_id === t.period.id && ['imported', 'checked'].includes(w.status) && t.status.get(w.issue_code) === 'draft').map((w) => w.issue_code)
    t.missing = applied.filter((a) => a.period_id === t.period.id && !t.status.has(a.issue_code)).map((a) => a.issue_code)
    const ids = new Set([t.period.id, ...t.priorYears.map((p) => p.id)])
    const res = buildCompanyLines({
      companyId: t.company.id, current: t.period, priorYears: t.priorYears, entries: raw.filter((e) => ids.has(e.periodId)),
      categories, accounts, includeDraft: true, issueName: (code) => m.issues.find((i) => i.code === code)?.name ?? code,
    })
    lines.push(...res.lines)
    warnings.push(...res.warnings.map((w) => `${t.company.code}：${w}`))
  }
  return { asOf, label, targets, lines, warnings, accounts, categories, snapshots: must(snaps) as Snapshot[] }
}

export async function saveSnapshot(d: ConsolidationData, lines: CLine[], createdBy: string, note: string | null) {
  // 記録は集計に必要な項目だけ（表示用の摘要は持たない）
  // 当期仕訳は期も残す（作業画面で、その期の仕訳が集計済みかを確かめるため）
  const slim = lines.map(({ companyId, issueCode, categoryCode, kind, account, amount, status, periodId }) =>
    ({ companyId, issueCode, categoryCode, kind, account, amount, status, ...(kind === 'current' ? { periodId } : {}) }))
  must(await supabase.from('consolidation_snapshots').insert({ as_of: d.asOf, label: d.label, lines: slim, created_by: createdBy, note }))
}
