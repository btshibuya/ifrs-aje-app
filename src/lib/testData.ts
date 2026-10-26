// テストデータ：全13論点を、全社（S01〜S10）の前期（1Q〜期末）と当期（1Q・2Q）に入れる／全て消す
//
// 入れるもの
//   収集パッケージの入力（全様式。期によって確認済・提出済・入力中）と、試算表の提出
//   有給休暇・減価償却：取込 → 明細チェック → 計算 → 確定を、アプリの処理そのもので行う（S01は手で試すため空ける）
//   そのほかの論点：収集パッケージの入力から仕訳を簡易計算し、計算・仕訳・確定として保存する
//     期間の金額の論点（のれん償却・開発費・数理差異・株式報酬）は当期の累計、
//     残高の論点（割引率・株式・圧縮記帳・資産除去債務・借入手数料・回収可能性）は前年度末からの増減、洗替（固定資産税）は期末の全額
//   会社ごとの方針の上書き：のれん・株式報酬・借入手数料を一部の会社で「適用」にする
//   連結精算表の集計の記録（当期2Q）と、そのあとの S03 有給休暇の訂正（上書き前後を見せる）
// 入れたものには is_demo_seed を付ける。「全て消す」は、画面で入力したものも含めてマスタ以外を消し、方針の上書きを元に戻す

import { fetchConsolidation, saveSnapshot } from './consolidation'
import { ISSUE_CONFIGS } from './issues'
import { fetchMasters, type MasterData, type PeriodRow } from './masters'
import { PACKAGE_FORMS, type PackageForm } from './materials'
import type { EntryData } from './package'
import { previewFor, type PreviewContext, type PreviewEntry } from './preview'
import { must, supabase } from './supabase'
import { commitRows, fetchItems, fetchPeriod, lockIssue, planCalculation, saveCalculation, setChecked } from './workflow'

export type Progress = (message: string, ratio: number) => void

// ---------------------------------------------------------------------------
// 件数（画面に出す）
// ---------------------------------------------------------------------------

const TABLES = ['package_entries', 'calculation_runs', 'detail_items', 'source_files', 'consolidation_snapshots', 'work_status'] as const
export type Counts = Record<(typeof TABLES)[number] | 'policies', { test: number; other: number }>

// DBの関数で、テストデータと画面で入力したものの件数を1回で数える
export async function countData(): Promise<Counts> {
  return must(await supabase.rpc('test_data_counts')) as Counts
}

// ---------------------------------------------------------------------------
// 消す
//   test：テストデータ（is_demo_seed の付いたもの）だけ。画面で入力したものは残す
//   all ：マスタ以外を全て（画面で入力したものも）。方針はテスト用の上書きだけ消す
// 確定のロックはDBが守っているため、状況（work_status）を先に消してから、仕訳・計算・明細の順に消す
// ---------------------------------------------------------------------------

export type DeleteScope = 'test' | 'all'

export async function deleteAllData(progress: Progress = () => {}, scope: DeleteScope = 'test') {
  // 対象の行だけに絞る（all は全行。delete は条件が必要なため id が空でない行とする）
  const del = (table: string) => {
    const q = supabase.from(table).delete()
    return scope === 'test' ? q.eq('is_demo_seed', true) : q.not('id', 'is', null)
  }
  const sel = (table: string, cols: string) => {
    const q = supabase.from(table).select(cols)
    return scope === 'test' ? q.eq('is_demo_seed', true) : q.not('id', 'is', null)
  }
  progress('確定のロックを外しています', 0.05)
  must(await del('work_status'))
  progress('仕訳と計算を消しています', 0.2)
  for (;;) {
    const runs = must(await sel('calculation_runs', 'id').limit(300)) as unknown as { id: string }[]
    if (runs.length === 0) break
    const ids = runs.map((r) => r.id)
    must(await supabase.from('journal_entries').delete().in('run_id', ids))
    must(await supabase.from('calculation_runs').delete().in('id', ids))
  }
  progress('明細を消しています', 0.45)
  if (scope === 'all') {
    must(await supabase.from('item_key_links').delete().not('id', 'is', null))
    must(await supabase.from('btrex_opening_balances').delete().not('id', 'is', null))
  }
  must(await del('detail_items'))
  progress('元資料の原本を消しています', 0.6)
  // 原本（Storage）は、元資料の行から場所を集めて消す（1回に100件まで）
  for (;;) {
    const files = must(await sel('source_files', 'id, storage_path').limit(300)) as unknown as { id: string; storage_path: string }[]
    if (files.length === 0) break
    for (let i = 0; i < files.length; i += 100) {
      const part = files.slice(i, i + 100)
      await supabase.storage.from('source-files').remove(part.map((f) => f.storage_path))
      must(await supabase.from('source_files').delete().in('id', part.map((f) => f.id)))
    }
  }
  progress('収集パッケージの入力と集計の記録を消しています', 0.8)
  must(await del('package_entries'))
  must(await del('consolidation_snapshots'))
  progress('方針の上書きを元に戻しています', 0.92)
  must(await supabase.from('policies').delete().eq('is_demo_seed', true))
  progress('消しました', 1)
}

// ---------------------------------------------------------------------------
// 決まった並びの乱数（何度作っても同じデータになる）
// ---------------------------------------------------------------------------

function rng(seed: string) {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
const monthIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1
const r1000 = (v: number) => Math.round(v / 1000) * 1000

// 会社×時点（前期 1Q〜期末、当期 1Q・2Q）
interface Point { slot: string; period: PeriodRow; fy: PeriodRow; months: number; year: 0 | 1 }
const SLOTS = ['prior:Q1', 'prior:Q2', 'prior:Q3', 'prior:FY', 'current:Q1', 'current:Q2'] as const
function pointsOf(m: MasterData, companyId: string): Point[] {
  return SLOTS.map((slot) => {
    const period = m.periodFor(companyId, slot)!
    const fy = m.periodFor(companyId, slot.startsWith('prior') ? 'prior:FY' : 'current:FY')!
    return { slot, period, fy, months: monthIdx(period.end_date) - monthIdx(period.start_date) + 1, year: slot.startsWith('prior') ? 0 : 1 }
  }).filter((p) => p.period && p.fy) as Point[]
}

// ---------------------------------------------------------------------------
// 方針の上書き（のれん・株式報酬・借入手数料を一部の会社で適用にする）
// ---------------------------------------------------------------------------

const POLICY_OVERRIDES: [string, string, Record<string, unknown>][] = [
  ['S02', 'GOODWILL', {}], ['S05', 'GOODWILL', {}], ['S08', 'GOODWILL', {}],
  ['S03', 'SHARE_BASED', {}], ['S09', 'SHARE_BASED', {}],
  ['S04', 'EIR', {}], ['S06', 'EIR', {}], ['S10', 'EIR', {}],
]

// ---------------------------------------------------------------------------
// 収集パッケージの入力（様式ごと。会社の規模 k と、期首からの月数で金額を変える）
// ---------------------------------------------------------------------------

type Gen = (c: { code: string; k: number; r: () => number; pt: Point; prev?: EntryData; taxRate: number }) => EntryData

const BANKS = ['東都銀行', '中央信託銀行', '北辰証券', '浪速銀行', '湘南信用金庫']
const GEN: Record<string, Gen> = {
  LEAVE_USAGE: ({ k, r, pt }) => {
    const employees = Math.round(60 * k + pt.year * 4)
    const granted = employees * 19
    return { fields: { granted_days: granted, used_days: Math.round(granted * (0.52 + r() * 0.12)), employees, social_insurance_rate: 14.8 + pt.year * 0.4 } }
  },
  LEVY: ({ k, pt }) => {
    // 固定資産税は1月1日に1年分が確定し、4・7・12・2月に納付する（3月決算の各四半期末の未納付割合）
    const q = pt.period.period_type
    const unpaid = { Q1: 0.75, Q2: 0.5, Q3: 0.25, FY: 0 }[q] ?? 0
    const annual = r1000(3_600_000 * k * (1 + pt.year * 0.04))
    return { fields: { property_tax_annual: annual, property_tax_unpaid: Math.round(annual * unpaid), per_capita_annual: r1000(290_000 * Math.min(k, 1.5)) } }
  },
  RETIREMENT_ACTUARIAL: ({ k, r, pt, prev }) => {
    const f = pt.months / 12
    const open = Number(prev?.fields?.dbo_close ?? r1000(480_000_000 * k))
    const sc = r1000(32_000_000 * k * f)
    const ic = r1000(open * 0.012 * f)
    const al = r1000((r() * 7_000_000 - 4_500_000) * k * f)
    const bp = r1000(28_000_000 * k * f)
    return { fields: { dbo_open: open, service_cost: sc, interest_cost: ic, actuarial_loss: al, benefits_paid: bp, dbo_close: open + sc + ic + al - bp, plan_assets_close: r1000(310_000_000 * k * (1 + pt.year * 0.03)) } }
  },
  RETIREMENT_ASSUMPTIONS: ({ code, pt }) => ({
    fields: {
      discount_rate: [0.8, 0.85, 0.9, 0.9, 1.0, 1.1][SLOTS.indexOf(pt.slot as (typeof SLOTS)[number])] ?? 1,
      discount_basis: '国債の利回り', duration: code === 'S09' ? 9.5 : 11.5, attribution: ['S02', 'S05'].includes(code) ? '期間定額基準' : '給付算定式基準',
    },
  }),
  EQUITY_HOLDINGS: ({ code, k, r, pt }) => {
    const n = 2 + Math.floor(r() * 2)
    const rows: Record<string, unknown>[] = []
    for (let i = 0; i < n; i++) {
      const cost = r1000((6_000_000 + r() * 14_000_000) * k)
      rows.push({ name: BANKS[(i + code.charCodeAt(2)) % BANKS.length], listed: '上場', shares: 1000 * (5 + i * 7), cost, fair_value: r1000(cost * (1.1 + r() * 0.5 + pt.year * 0.08)), classification: '政策保有（売る予定なし）' })
    }
    // 非上場株式：日本基準は取得原価のまま。IFRSは時価（評価額）
    const uc = r1000(5_000_000 * k)
    rows.push({ name: `${code}地域開発（非上場）`, listed: '非上場', shares: 100, cost: uc, fair_value: r1000(uc * (1.15 + SLOTS.indexOf(pt.slot as (typeof SLOTS)[number]) * 0.03)), classification: '政策保有（売る予定なし）' })
    if (['S04', 'S08'].includes(code)) rows.push({ name: '短期運用ファンド', listed: '上場', shares: 2000, cost: r1000(3_000_000 * k), fair_value: r1000(3_000_000 * k * (1.02 + pt.year * 0.05)), classification: '売買目的' })
    return { rows }
  },
  GOODWILL: ({ k, pt }) => {
    const f = pt.months / 12
    const annual = r1000(5_000_000 * k)
    return { fields: { goodwill_close: r1000(45_000_000 * k - annual * (pt.year + f)), amortization: r1000(annual * f), impairment_indicator: 'なし' } }
  },
  COMPRESSION_LIST: ({ code, k, pt }) => {
    const rows: Record<string, unknown>[] = [{ asset_no: `${code}-C01`, asset_name: '省エネ空調設備', method: '直接減額', amount: r1000(4_000_000 * k), subsidy: '省エネルギー投資促進補助金' }]
    if (pt.year === 1 && pt.months >= 6 && ['S02', 'S06'].includes(code)) rows.push({ asset_no: `${code}-C02`, asset_name: '太陽光発電設備', method: '直接減額', amount: r1000(2_500_000 * k), subsidy: '再エネ導入補助金' })
    if (code === 'S07') rows.push({ asset_no: `${code}-C03`, asset_name: '倉庫', method: '積立金', amount: 1_800_000, subsidy: '' })
    return { rows }
  },
  ARO_LIST: ({ code, k, pt }) => ({
    rows: [
      { site: '本社事務所（賃借）', estimate: r1000(12_000_000 * k), settle_date: '2035-03-31', discount_rate: 0.8, balance: r1000(12_000_000 * k / 1.008 ** (9 - pt.year)) },
      ...(['S03', 'S07', 'S08'].includes(code) ? [{ site: '物流センターの土地（借地）', estimate: r1000(30_000_000 * k), settle_date: '2042-03-31', discount_rate: 1.1, balance: r1000(30_000_000 * k / 1.011 ** (16 - pt.year)) }] : []),
    ],
  }),
  SO_GRANTS: ({ code, pt }) => ({
    rows: [
      { series: '第3回新株予約権', grant_date: '2024-07-01', units: 800 - pt.year * 40, fair_value: 45000, vesting_date: '2026-07-01' },
      ...(code === 'S09' ? [{ series: '第4回新株予約権', grant_date: '2025-07-01', units: 500, fair_value: 52000, vesting_date: '2027-07-01' }] : []),
    ],
  }),
  LOANS: ({ code, k, pt }) => ({
    rows: [
      { kind: '借入金', lender: `${code === 'S10' ? 'アジア開発銀行' : '東都銀行'} シンジケートローン`, borrow_date: '2025-10-01', maturity: '2030-10-01', principal: r1000(500_000_000 * k), coupon_rate: 1.0, fee: r1000(7_500_000 * k) },
      ...(pt.year === 1 ? [{ kind: '借入金', lender: '中央信託銀行 タームローン', borrow_date: '2026-05-01', maturity: '2031-05-01', principal: r1000(200_000_000 * k), coupon_rate: 1.2, fee: r1000(3_000_000 * k) }] : []),
      ...(['S04', 'S10'].includes(code) ? [{ kind: '貸付金', lender: '関連会社への貸付（無利息）', borrow_date: '2025-04-01', maturity: '2028-04-01', principal: r1000(50_000_000 * k), coupon_rate: 0, fee: 0, market_rate: 2.0 }] : []),
      ...(code === 'S06' ? [{ kind: '社債', lender: '第1回無担保社債', borrow_date: '2025-07-01', maturity: '2030-07-01', principal: 300_000_000, coupon_rate: 0.8, fee: 4_200_000 }] : []),
    ],
  }),
  DEV_PROJECTS: ({ code, k, pt }) => {
    const f = pt.months / 12
    return {
      rows: [
        { project: '次世代検査装置の開発', spend: r1000(18_000_000 * k * f), criteria: '満たす' },
        { project: `${code}基礎研究`, spend: r1000(9_000_000 * k * f), criteria: pt.year === 1 && pt.months >= 6 ? '判断中' : '満たさない' },
      ],
    }
  },
  RECEIVABLES_AGING: ({ code, k, r, pt }) => {
    const base = 900_000_000 * k * (1 + pt.year * 0.05)
    const late = ['S05', 'S08'].includes(code) ? 2 : 1 // 延滞が多い会社
    const f = { not_due: r1000(base * 0.9), past_30: r1000(base * 0.06 * late), past_90: r1000(base * 0.02 * late), past_180: r1000(base * 0.006 * late), past_over: r1000(base * 0.002 * late * (1 + r())), credit_impaired: r1000(3_000_000 * k * late) }
    // 日本基準：一般債権は過去の貸倒実績率（0.5%）、破産更生債権等は全額
    const general = f.not_due + f.past_30 + f.past_90 + f.past_180 + f.past_over
    return { fields: { ...f, jgaap_allowance: r1000(general * 0.005 + f.credit_impaired) } }
  },
  IMPAIRMENT_TEST: ({ code, k, pt }) => {
    // 業績が悪い拠点：割引前CFは帳簿価額を上回る（日本基準は減損しない）が、回収可能価額は下回る
    if (!['S03', 'S05', 'S07', 'S09'].includes(code)) return { none: true }
    const bv = r1000(380_000_000 * k * (1 - pt.year * 0.04))
    return { rows: [{ group: code === 'S03' ? '大阪物流センター' : '第2工場', book_value: bv, undiscounted_cf: r1000(bv * 1.08), recoverable: r1000(bv * (0.86 - pt.year * 0.03)), jgaap_loss: 0 }] }
  },
  PROVISIONS_LIST: ({ code, k, pt }) => ({
    rows: [
      { name: '賞与引当金', purpose: '夏季賞与', ifrs: '計上できる', balance: r1000(60_000_000 * k) },
      { name: '修繕引当金', purpose: '設備の定期修繕', ifrs: '計上できない', balance: r1000(30_000_000 * k * (1 + pt.year * 0.15 + pt.months / 48)) },
      ...(['S02', 'S06', 'S07'].includes(code) ? [{ name: '特別修繕引当金', purpose: '船舶・炉の定期検査', ifrs: '計上できない', balance: r1000(18_000_000 * k * (1 + pt.months / 24)) }] : []),
    ],
  }),
  LT_BENEFITS: ({ code, k, pt }) => ({
    rows: [
      { plan: '永年勤続表彰', people: Math.round(150 * k), future_payment: r1000(30_000_000 * k * (1 + pt.year * 0.03)), avg_years: 11 + pt.year, req_years: 20, jgaap_balance: 0 },
      ...(['S01', 'S04', 'S09'].includes(code) ? [{ plan: 'リフレッシュ休暇', people: Math.round(120 * k), future_payment: r1000(12_000_000 * k), avg_years: 6, req_years: 10, jgaap_balance: 0 }] : []),
    ],
  }),
  TAX: ({ k, pt, taxRate }) => ({
    fields: { statutory_rate: Math.round(taxRate * 10000) / 100, company_class: '分類2', deductible_td: r1000(85_000_000 * k * (1 + pt.year * 0.05)), tax_loss: 0, valuation_allowance: r1000(12_000_000 * k * (1 - pt.year * 0.1)) },
  }),
}

// ---------------------------------------------------------------------------
// 収集パッケージから仕訳を簡易計算する（有給休暇・減価償却以外）
// ---------------------------------------------------------------------------

type Mode = 'flow' | 'balance' | 'full'
interface IssueRule { form: string; mode: Mode; main: string; tax?: string }
export const PACKAGE_ISSUES: Record<string, IssueRule> = {
  LEVY: { form: 'LEVY', mode: 'full', main: 'LEVY_PROPERTY_TAX', tax: 'LEVY_PROPERTY_TAX_TAX' },
  RETIREMENT_1: { form: 'RETIREMENT_ACTUARIAL', mode: 'flow', main: 'RET1_MAIN', tax: 'RET1_TAX' },
  RETIREMENT_2: { form: 'RETIREMENT_ASSUMPTIONS', mode: 'balance', main: 'RET2_MAIN', tax: 'RET2_TAX' },
  EQUITY_INSTRUMENT: { form: 'EQUITY_HOLDINGS', mode: 'balance', main: 'EQ_MAIN', tax: 'EQ_TAX' },
  GOODWILL: { form: 'GOODWILL', mode: 'flow', main: 'GOODWILL_MAIN' },
  COMPRESSION: { form: 'COMPRESSION_LIST', mode: 'balance', main: 'COMP_MAIN', tax: 'COMP_TAX' },
  ARO: { form: 'ARO_LIST', mode: 'balance', main: 'ARO_MAIN', tax: 'ARO_TAX' },
  SHARE_BASED: { form: 'SO_GRANTS', mode: 'flow', main: 'SBP_MAIN' },
  EIR: { form: 'LOANS', mode: 'balance', main: 'EIR_MAIN', tax: 'EIR_TAX' },
  DEVELOPMENT: { form: 'DEV_PROJECTS', mode: 'flow', main: 'DEV_MAIN', tax: 'DEV_TAX' },
  TAX_EFFECT: { form: 'TAX', mode: 'balance', main: 'TAX_RECOVERABILITY' },
  ECL: { form: 'RECEIVABLES_AGING', mode: 'full', main: 'ECL_MAIN', tax: 'ECL_TAX' },
  IMPAIRMENT: { form: 'IMPAIRMENT_TEST', mode: 'balance', main: 'IMP_MAIN', tax: 'IMP_TAX' },
  PROVISION: { form: 'PROVISIONS_LIST', mode: 'balance', main: 'PROV_MAIN', tax: 'PROV_TAX' },
  LT_BENEFITS: { form: 'LT_BENEFITS', mode: 'balance', main: 'LTB_MAIN', tax: 'LTB_TAX' },
}

// プレビューにない計算（株式報酬・回収可能性）
function customEntries(issue: string, d: EntryData, months: number): PreviewEntry[] | null {
  const ln = (side: 'debit' | 'credit', account: string, amount: number, formula: string) => ({ side, account, amount, formula, refs: [], external: [] })
  const pair = (dr: string, cr: string, v: number, formula: string, title: string): PreviewEntry[] => {
    const a = Math.round(v)
    if (a === 0) return []
    return [{ title, lines: a > 0 ? [ln('debit', dr, a, formula), ln('credit', cr, a, formula)] : [ln('debit', cr, -a, formula), ln('credit', dr, -a, formula)] }]
  }
  if (issue === 'SHARE_BASED') {
    // 失効見込みの見直し：日本基準は失効が確定した時に戻し入れ、IFRSは見込みで費用を減らす（ここでは期間の費用の5%）
    const cost = (d.rows ?? []).reduce((s, r) => s + Number(r.units ?? 0) * Number(r.fair_value ?? 0) / 24 * months, 0)
    return pair('BS_SHARE_OPTIONS', 'PL_SHARE_COMP', cost * 0.05, `費用 ${Math.round(cost).toLocaleString('ja-JP')} × 失効見込み 5%`, '株式報酬：失効見込みの反映')
  }
  if (issue === 'TAX_EFFECT') {
    // IFRSでは将来の課税所得の見込みで判断し、評価性引当額の一部（25%）を繰延税金資産として認める
    const va = Number(d.fields?.valuation_allowance ?? 0)
    return pair('BS_DTA', 'PL_DEFERRED_TAX', va * 0.25, `評価性引当額 ${va.toLocaleString('ja-JP')} × 25%`, '回収可能性の見直し（繰延税金資産の追加計上）')
  }
  return null
}

// 1つの時点の仕訳（区分ごとに、科目の借方プラスの金額）
function journalAt(issue: string, form: PackageForm, d: EntryData, ctx: PreviewContext, months: number) {
  const rule = PACKAGE_ISSUES[issue]
  const entries = customEntries(issue, d, months) ?? previewFor(form, d, ctx).entries
  const out = new Map<string, { title: string; formula: string; net: Map<string, number> }>()
  for (const e of entries) {
    const cat = /税効果/.test(e.title) && rule.tax ? rule.tax : rule.main
    const x = out.get(cat) ?? { title: e.title, formula: e.lines[0]?.formula ?? '', net: new Map<string, number>() }
    for (const l of e.lines) x.net.set(l.account, (x.net.get(l.account) ?? 0) + (l.side === 'debit' ? l.amount : -l.amount))
    out.set(cat, x)
  }
  return out
}

// ---------------------------------------------------------------------------
// 有給休暇・減価償却：アプリの取込・計算・確定の処理で作る
// ---------------------------------------------------------------------------

function leaveRows(code: string, p: PeriodRow, version = 0) {
  const r = rng(`leave-${code}`)
  const n = 18 + Math.floor(r() * 30)
  const q = monthIdx(p.end_date) - monthIdx(p.start_date)
  return Array.from({ length: n }, (_, i) => {
    const base = Math.round((6 + r() * 30) * 2) / 2
    const wage = Math.round((12000 + r() * 30000) / 100) * 100
    // 四半期が進むと消化して減り、期末に付与で戻る。version は訂正（一部の人の残日数）
    const days = Math.max(0, Math.round((base - (q % 12) * 0.9 * r() + (version && i % 5 === 0 ? 4.5 : 0)) * 2) / 2)
    return { employee_no: `${code}-${String(i + 1).padStart(4, '0')}`, name: `従業員${i + 1}`, unused_days: days, daily_wage: wage }
  })
}

const ASSET_TYPES: [string, number][] = [['建物', 38], ['建物附属設備', 15], ['機械装置', 10], ['車両運搬具', 6], ['工具器具備品', 6], ['ソフトウェア', 5]]
function deprRows(code: string, p: PeriodRow) {
  const r = rng(`depr-${code}`)
  const n = 8 + Math.floor(r() * 8)
  const s = monthIdx(p.start_date)
  const e = monthIdx(p.end_date)
  const rows = []
  for (let i = 0; i < n; i++) {
    const [type, life] = ASSET_TYPES[Math.floor(r() * ASSET_TYPES.length)]
    const acquired = `${2014 + Math.floor(r() * 12)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-01`
    const a = monthIdx(acquired)
    const cost = Math.round((type === '建物' ? 80e6 : type === '機械装置' ? 25e6 : 4e6) * (0.4 + r()) / 1000) * 1000
    if (a > e) continue
    const monthly = cost / (life * 12)
    const bv = (m: number) => Math.max(1, Math.round(cost - monthly * Math.max(0, m - a + 1)))
    const inPeriod = a >= s
    const opening = inPeriod ? null : bv(s - 1)
    const closing = bv(e)
    rows.push({ asset_no: `${code}-A${String(i + 1).padStart(3, '0')}`, name: `${type}${i + 1}`, asset_type: type, acquired_on: acquired, cost, jgaap_life: life, jgaap_opening_bv: opening, jgaap_depreciation: (inPeriod ? cost : opening!) - closing, jgaap_closing_bv: closing, disposed_on: null })
  }
  return rows
}

async function calcOne(code: string, issue: 'PAID_LEAVE' | 'DEPRECIATION', p: PeriodRow, final: boolean, version = 0) {
  const cfg = ISSUE_CONFIGS[issue]
  const period = await fetchPeriod(p.id)
  const rows = (issue === 'PAID_LEAVE' ? leaveRows(code, p, version) : deprRows(code, p)) as Record<string, unknown>[]
  const csv = '﻿' + [cfg.fields.map((f) => f.label), ...rows.map((x) => cfg.fields.map((f) => x[f.key] ?? ''))].map((r) => r.join(',')).join('\r\n')
  await commitRows(period, cfg, {
    fileName: `${code}_${cfg.sourceLabel}_${p.label}${version ? '_訂正' : ''}.csv`, buf: new TextEncoder().encode(csv).buffer as ArrayBuffer, fileType: 'csv', contentType: 'text/csv',
    rows: rows.map((x, i) => ({ rowNo: i + 2, itemKey: String(x[cfg.keyField]), data: x })),
  })
  await Promise.all([
    supabase.from('source_files').update({ is_demo_seed: true }).eq('period_id', p.id).eq('issue_code', issue).then(must),
    supabase.from('detail_items').update({ is_demo_seed: true }).eq('period_id', p.id).eq('issue_code', issue).then(must),
  ])
  const items = await fetchItems(p.id, issue)
  await setChecked(p.id, issue, items.map((i) => i.id), true)
  const checked = await fetchItems(p.id, issue)
  const runId = await saveCalculation(period, issue, checked, await planCalculation(period, issue, checked))
  must(await supabase.from('calculation_runs').update({ is_demo_seed: true }).eq('id', runId))
  if (final) await lockIssue(p.id, issue, runId)
  must(await supabase.from('work_status').update({ is_demo_seed: true }).eq('period_id', p.id).eq('issue_code', issue))
}

// ---------------------------------------------------------------------------
// 入れる
// ---------------------------------------------------------------------------

// 当期2Qで下書き（親会社の確認待ち）にする会社×論点
const Q2_DRAFT = new Set(['S03|PAID_LEAVE', 'S07|DEPRECIATION', 'S10|PAID_LEAVE', 'S04|RETIREMENT_1', 'S06|EQUITY_INSTRUMENT', 'S09|DEVELOPMENT'])
// 当期2Qの収集パッケージで、提出前（入力中）・差し戻しにする会社×様式
const Q2_PACKAGE_DRAFT = new Set(['S05|DEV_PROJECTS', 'S08|ARO_LIST', 'S01|EQUITY_HOLDINGS'])
const Q2_PACKAGE_RETURNED = new Set(['S06|LEVY'])
const Q2_PACKAGE_SUBMITTED = new Set(['S02|RETIREMENT_ACTUARIAL', 'S04|TAX', 'S09|COMPRESSION_LIST', 'S10|LOANS'])

export async function insertTestData(progress: Progress = () => {}) {
  // 前に入れたテストデータだけを入れ替える（画面で入力したものは残す）
  progress('前に入れたテストデータを消しています', 0.01)
  await deleteAllData(() => {}, 'test')
  progress('方針の上書きを入れています', 0.04)
  let m = await fetchMasters()
  const cid = (code: string) => m.companies.find((c) => c.code === code)?.id
  must(await supabase.from('policies').insert(POLICY_OVERRIDES.filter(([c]) => cid(c)).map(([c, issue, params]) => ({
    company_id: cid(c), issue_code: issue, effective_from: '2020-01-02', applicability: 'applied', params, reason: 'テストデータ', is_demo_seed: true,
  }))))
  m = await fetchMasters()

  // 会社×時点、適用の論点、税率・前提値
  const points = new Map(m.companies.map((c) => [c.id, pointsOf(m, c.id)]))
  const pids = [...points.values()].flat().map((p) => p.period.id)
  // 時点×論点は1000行（1回の応答の上限）を超えるため、20時点ずつ読む
  type Pol = { period_id: string; issue_code: string; applicability: string | null; params: Record<string, unknown> }
  const pol: Pol[] = []
  for (let i = 0; i < pids.length; i += 20) {
    pol.push(...(must(await supabase.from('v_policy_matrix').select('period_id, issue_code, applicability, params').in('period_id', pids.slice(i, i + 20))) as Pol[]))
  }
  const applied = (pid: string, issue: string) => pol.some((x) => x.period_id === pid && x.issue_code === issue && x.applicability === 'applied')
  const paramsOf = (pid: string) => Object.fromEntries(pol.filter((x) => x.period_id === pid).map((x) => [x.issue_code, x.params ?? {}])) as Record<string, Record<string, unknown>>
  const taxOf = (pid: string) => Number(paramsOf(pid).TAX_EFFECT?.effective_tax_rate ?? 0.3062)

  // ---- 収集パッケージ ----
  progress('収集パッケージの入力を作っています', 0.07)
  const pkgRows: Record<string, unknown>[] = []
  const dataOf = new Map<string, EntryData>() // company|form|period_id
  for (const c of m.companies) {
    const k = 0.6 + rng(`size-${c.code}`)() * 1.2
    let prevActuarial: EntryData | undefined
    for (const pt of points.get(c.id)!) {
      for (const form of PACKAGE_FORMS) {
        if (!applied(pt.period.id, form.issueCode)) continue
        const r = rng(`${c.code}-${form.code}-${pt.slot}`)
        // 退職給付の期首は前年度末の期末（年度の中では同じ期首）
        const prev = form.code === 'RETIREMENT_ACTUARIAL' && pt.year === 1 ? prevActuarial : undefined
        const data = GEN[form.code]({ code: c.code, k, r, pt, prev, taxRate: taxOf(pt.period.id) })
        if (form.code === 'RETIREMENT_ACTUARIAL' && pt.slot === 'prior:FY') prevActuarial = data
        dataOf.set(`${c.id}|${form.code}|${pt.period.id}`, data)
        const key = `${c.code}|${form.code}`
        const cur2 = pt.slot === 'current:Q2'
        const status = cur2 && (Q2_PACKAGE_DRAFT.has(key) || Q2_PACKAGE_RETURNED.has(key)) ? 'draft' : cur2 && Q2_PACKAGE_SUBMITTED.has(key) ? 'submitted' : 'confirmed'
        const at = `${pt.period.end_date}T09:00:00+09:00`
        pkgRows.push({
          company_id: c.id, as_of: pt.period.end_date, form_code: form.code, issue_code: form.issueCode, data, status,
          entered_by: `${c.code} 経理担当（テスト）`, submitted_at: status === 'draft' ? null : at, confirmed_at: status === 'confirmed' ? at : null,
          confirmed_by: status === 'confirmed' ? '連結 山田（テスト）' : null,
          return_note: Q2_PACKAGE_RETURNED.has(key) && cur2 ? '未納付額が納付書の控えと合いません。第2期の納付を確認してください。' : null, is_demo_seed: true,
        })
      }
    }
  }
  // 画面で入力した様式（同じ会社・基準日・様式）があれば、そちらを残す
  const mine = must(await supabase.from('package_entries').select('company_id, as_of, form_code')) as { company_id: string; as_of: string; form_code: string }[]
  const taken = new Set(mine.map((x) => `${x.company_id}|${x.as_of}|${x.form_code}`))
  const fresh = pkgRows.filter((x) => !taken.has(`${x.company_id}|${x.as_of}|${x.form_code}`))
  for (let i = 0; i < fresh.length; i += 200) must(await supabase.from('package_entries').insert(fresh.slice(i, i + 200)))

  // ---- 試算表の提出（資料一覧で提出済にする） ----
  progress('試算表を提出しています', 0.12)
  await Promise.all([...points.entries()].flatMap(([companyId, pts]) => pts.map(async (pt) => {
    const code = m.companies.find((c) => c.id === companyId)!.code
    const csv = `﻿勘定科目,期末残高\r\n現金及び預金,${Math.round(rng(code + pt.slot)() * 1e9)}\r\n`
    const buf = new TextEncoder().encode(csv)
    const path = `${pt.period.id}/trial_balance/test_${pt.period.end_date}.csv`
    await supabase.storage.from('source-files').upload(path, buf, { contentType: 'text/csv', upsert: true })
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('')
    must(await supabase.from('source_files').insert({ period_id: pt.period.id, issue_code: null, source_kind: 'trial_balance', file_name: `${code}_試算表_${pt.period.label}.csv`, file_type: 'csv', storage_path: path, sha256: hash, is_demo_seed: true }))
  })))

  // ---- 収集パッケージの論点の計算・仕訳 ----
  progress('収集パッケージの論点の仕訳を作っています', 0.16)
  type Plan = { period: PeriodRow; issue: string; final: boolean; entries: { cat: string; title: string; formula: string; net: Map<string, number> }[] }
  const plans: Plan[] = []
  for (const c of m.companies) {
    const pts = points.get(c.id)!
    for (const [issue, rule] of Object.entries(PACKAGE_ISSUES)) {
      const form = PACKAGE_FORMS.find((f) => f.code === rule.form)!
      const at = (pt: Point) => {
        const d = dataOf.get(`${c.id}|${form.code}|${pt.period.id}`)
        if (!d) return null
        const ctx: PreviewContext = {
          asOf: pt.period.end_date, periodStart: pt.period.start_date, taxRate: taxOf(pt.period.id), params: paramsOf(pt.period.id),
          other: (fc) => dataOf.get(`${c.id}|${fc}|${pt.period.id}`),
        }
        return journalAt(issue, form, d, ctx, pt.months)
      }
      for (const pt of pts) {
        if (!applied(pt.period.id, issue)) continue
        const now = at(pt)
        if (!now) continue
        // 残高の論点は、前年度末（確定）からの増減を当期の仕訳にする
        const base = rule.mode === 'balance' && pt.year === 1 ? at(pts.find((x) => x.slot === 'prior:FY')!) : null
        const entries = [...new Set([...now.keys(), ...(base?.keys() ?? [])])].map((cat) => {
          const a = now.get(cat)
          const b = base?.get(cat)
          const net = new Map<string, number>()
          for (const acc of new Set([...(a?.net.keys() ?? []), ...(b?.net.keys() ?? [])])) net.set(acc, (a?.net.get(acc) ?? 0) - (b?.net.get(acc) ?? 0))
          return { cat, title: (a ?? b)!.title + (base ? '（前年度末からの増減）' : ''), formula: (a ?? b)!.formula, net }
        }).filter((e) => [...e.net.values()].some((v) => Math.round(v) !== 0))
        plans.push({ period: pt.period, issue, final: !(pt.slot === 'current:Q2' && Q2_DRAFT.has(`${c.code}|${issue}`)), entries })
      }
    }
  }
  await savePlans(plans)

  // ---- 有給休暇・減価償却（S01 は手で試すため空ける） ----
  const chains: (() => Promise<void>)[] = []
  for (const c of m.companies) {
    if (c.code === 'S01') continue
    for (const issue of ['PAID_LEAVE', 'DEPRECIATION'] as const) {
      const pts = points.get(c.id)!.filter((pt) => applied(pt.period.id, issue))
      if (!pts.length) continue
      // 前期は1Q→期末、当期は前期末の確定から。会社×論点ごとに順に、会社どうしは同時に進める
      chains.push(async () => {
        for (const pt of pts) await calcOne(c.code, issue, pt.period, !(pt.slot === 'current:Q2' && Q2_DRAFT.has(`${c.code}|${issue}`)))
      })
    }
  }
  let done = 0
  const total = chains.length
  progress(`有給休暇・減価償却を計算しています（0/${total}）`, 0.25)
  await Promise.all(chains.map(async (run) => {
    await run()
    done++
    progress(`有給休暇・減価償却を計算しています（${done}/${total}）`, 0.25 + 0.65 * (done / total))
  }))

  // ---- 連結精算表：当期2Qを集計し、そのあとで S03 の有給休暇を訂正する ----
  progress('連結精算表を集計しています', 0.93)
  const d = await fetchConsolidation(m, 'current:Q2')
  await saveSnapshot(d, d.lines, '連結 山田（テスト）', 'テストデータの集計')
  must(await supabase.from('consolidation_snapshots').update({ is_demo_seed: true }).eq('as_of', d.asOf))
  const s03 = m.companies.find((x) => x.code === 'S03')
  const s03q2 = s03 && m.periodFor(s03.id, 'current:Q2')
  if (s03q2 && applied(s03q2.id, 'PAID_LEAVE')) await calcOne('S03', 'PAID_LEAVE', s03q2, false, 1)
  progress('テストデータを入れました', 1)
}

// 300行ずつ入れ、入れた行（選んだ列）を返す（1回の応答の行数の上限を超えないように）
async function insertChunked<T>(table: string, rows: Record<string, unknown>[], columns: string): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < rows.length; i += 300) out.push(...(must(await supabase.from(table).insert(rows.slice(i, i + 300)).select(columns)) as T[]))
  return out
}

// 計算・計算シートの行・仕訳・状況をまとめて保存する（件数が多いため、表ごとに一度に入れる）
async function savePlans(plans: { period: PeriodRow; issue: string; final: boolean; entries: { cat: string; title: string; formula: string; net: Map<string, number> }[] }[]) {
  // 調整がない時点も、計算して「調整なし」と記録する（確定の状況と計算をそろえる）
  const withEntries = plans
  const runs = await insertChunked<{ id: string; period_id: string; issue_code: string }>('calculation_runs', withEntries.map((p) => ({
    period_id: p.period.id, issue_code: p.issue, status: p.final ? 'final' : 'draft', input_hash: 'test-data', is_demo_seed: true,
    assumptions_snapshot: { source: 'テストデータ：収集パッケージの入力から簡易計算', warnings: [] }, note: 'テストデータ',
  })), 'id, period_id, issue_code')
  const runOf = (p: (typeof withEntries)[number]) => runs.find((r) => r.period_id === p.period.id && r.issue_code === p.issue)!.id

  const steps = await insertChunked<{ id: string; run_id: string; step_no: number }>('calculation_steps', withEntries.flatMap((p) => (p.entries.length ? p.entries.map((e, i) => ({
    run_id: runOf(p), item_key: null, step_no: i + 1, label: e.title, formula: `収集パッケージの入力から簡易計算：${e.formula}`,
    value: Math.round([...e.net.values()].filter((v) => v > 0).reduce((s, v) => s + v, 0)),
  })) : [{ run_id: runOf(p), item_key: null, step_no: 1, label: '調整なし', formula: '収集パッケージの入力から、この時点の調整はありません', value: 0 }])), 'id, run_id, step_no')

  const entryRows = withEntries.flatMap((p) => p.entries.map((e, i) => ({ run_id: runOf(p), period_id: p.period.id, issue_code: p.issue, category_code: e.cat, entry_no: i + 1, description: e.title })))
  const entries = await insertChunked<{ id: string; run_id: string; entry_no: number }>('journal_entries', entryRows, 'id, run_id, entry_no')
  const lines = withEntries.flatMap((p) => p.entries.flatMap((e, i) => {
    const runId = runOf(p)
    const entryId = entries.find((x) => x.run_id === runId && x.entry_no === i + 1)!.id
    const stepId = steps.find((x) => x.run_id === runId && x.step_no === i + 1)?.id ?? null
    // 円に丸め、丸めの差は金額の最も大きい行で調整する（貸借を必ず一致させる）。借方を先に並べる
    const rounded = [...e.net.entries()].map(([a, v]) => [a, Math.round(v)] as [string, number]).filter(([, v]) => v !== 0).sort(([, a], [, b]) => b - a)
    const diff = rounded.reduce((s2, [, v]) => s2 + v, 0)
    if (diff !== 0 && rounded.length) {
      const big = rounded.reduce((x, y) => (Math.abs(y[1]) > Math.abs(x[1]) ? y : x))
      big[1] -= diff
    }
    return rounded.filter(([, v]) => v !== 0).map(([account, v], j) => ({
      entry_id: entryId, line_no: j + 1, side: v > 0 ? 'debit' : 'credit', group_account_code: account, amount: Math.abs(v), calculation_step_id: stepId,
    }))
  }))
  for (let i = 0; i < lines.length; i += 500) must(await supabase.from('journal_lines').insert(lines.slice(i, i + 500)))
  // 確定のロックは最後に入れる（ロック中は仕訳を入れられないため）
  const now = new Date().toISOString()
  must(await supabase.from('work_status').insert(plans.map((p) => ({
    period_id: p.period.id, issue_code: p.issue, status: p.final ? 'locked' : 'calculated', locked_at: p.final ? now : null, updated_at: now, is_demo_seed: true,
  }))))
}
