// テストデータ：全17論点を、全社（S01〜S10）の前期（1Q〜期末）と当期（1Q〜期末）に入れる／全て消す
// 当期期末は、収集パッケージの入力（金額）だけを入れ、入力中にしておく（提出・取込・計算を画面で試せるように）
//
// 入れるもの
//   収集パッケージの入力（全様式。期によって確認済・提出済・入力中）と、試算表の提出
//   有給休暇・減価償却：取込 → 明細チェック → 計算 → 確定を、アプリの処理そのもので行う（S01は手で試すため空ける）
//   そのほかの論点：収集パッケージの入力を明細として取り込み、明細チェック・計算・確定する
//     計算はアプリと同じ（packageCalc）。件数が多いため、メモリで計算してから表ごとにまとめて保存する
//     入力中（提出前）の様式と、画面で入力した様式の会社×時点×論点は、取り込まずに空ける
//   会社ごとの方針の上書き：のれん・株式報酬・借入手数料を一部の会社で「適用」にする
//   連結精算表の集計の記録（当期2Q）と、そのあとの S03 有給休暇の訂正（上書き前後を見せる）
// 入れたものには is_demo_seed を付ける。「全て消す」は、画面で入力したものも含めてマスタ以外を消し、方針の上書きを元に戻す

import type { CalcResult, PriorBalance } from '../calc/types'
import { fetchConsolidation, saveSnapshot } from './consolidation'
import { sha256 } from './hash'
import { ISSUE_CONFIGS } from './issues'
import { fetchMasters, type MasterData, type PeriodRow } from './masters'
import { PACKAGE_FORMS } from './materials'
import type { EntryData } from './package'
import { calcPackageIssue, packageCsv, PACKAGE_CALCS, type ItemRowData } from './packageCalc'
import { fetchAll, must, supabase } from './supabase'
import { commitRows, fetchItems, fetchPeriod, itemsHash, lockIssue, planCalculation, saveCalculation, setChecked, type ItemRow } from './workflow'

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

// 会社×時点（前期 1Q〜期末、当期 1Q〜期末）
interface Point { slot: string; period: PeriodRow; fy: PeriodRow; months: number; year: 0 | 1 }
const SLOTS = ['prior:Q1', 'prior:Q2', 'prior:Q3', 'prior:FY', 'current:Q1', 'current:Q2', 'current:Q3', 'current:FY'] as const
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
      discount_rate: [0.8, 0.85, 0.9, 0.9, 1.0, 1.1, 1.15, 1.2][SLOTS.indexOf(pt.slot as (typeof SLOTS)[number])] ?? 1,
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
// 収集パッケージの論点：様式の入力を明細にし、アプリと同じ計算をメモリで行う
// ---------------------------------------------------------------------------

interface PkgPlan {
  companyCode: string
  period: PeriodRow
  issue: string
  year: 0 | 1
  final: boolean
  rows: ItemRowData[]
  csv: string
  result: CalcResult // 明細のidは仮（行の番号）。保存のときに入れ替える
  prior?: PkgPlan // 期首の調整額に使った前期（前年度末）の計算
  assumptions: Record<string, unknown>
}

// 前期の確定した計算の残高として渡す（DBに保存して読み直したときと同じ形）
const toPrior = (r: CalcResult): PriorBalance[] =>
  r.balances.map((b) => ({ itemKey: b.itemKey, balanceType: b.balanceType, jgaapAmount: b.jgaapAmount, ifrsAmount: b.ifrsAmount, temporaryDifference: b.temporaryDifference, movementType: b.movementType, extra: b.extra }))

function planPackageIssue(x: {
  companyCode: string; pt: Point; issue: string; data: EntryData; other: (formCode: string) => EntryData | undefined
  policy: { applicability: string | null; params: Record<string, unknown> }; taxRate: number; prior: PkgPlan | undefined; final: boolean
}): PkgPlan | null {
  const def = PACKAGE_CALCS[x.issue]
  if (def.requires?.(x.policy.params)) return null
  const rows = def.toRows(x.data, x.other)
  if (rows.length === 0) return null
  const result = calcPackageIssue(def, {
    items: rows.map((r, i) => ({ id: String(i), itemKey: r.itemKey, data: r.data })), asOf: x.pt.period.end_date, periodStart: x.pt.period.start_date,
    params: x.policy.params, taxRate: x.taxRate, priorBalances: x.prior ? toPrior(x.prior.result) : [],
  })
  // 作業画面の計算（planCalculation）と同じ確認事項・前提値
  if (x.pt.period.prior_period_id && !x.prior) result.warnings.unshift('前期の計算が確定していないため、期首の調整額を0として計算します（アプリ初年度の扱い。期首の残高は当期の変動に入ります）')
  return {
    companyCode: x.companyCode, period: x.pt.period, prior: x.prior, issue: x.issue, year: x.pt.year, final: x.final, rows, csv: packageCsv(def, rows), result,
    assumptions: { policy: x.policy, tax_rate: x.taxRate, params_used: def.params?.(x.policy.params) ?? [], warnings: result.warnings },
  }
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
        // 当期期末は入力中（金額は入れておき、提出から先を画面で試す）
        const status = pt.slot === 'current:FY' ? 'draft' : cur2 && (Q2_PACKAGE_DRAFT.has(key) || Q2_PACKAGE_RETURNED.has(key)) ? 'draft' : cur2 && Q2_PACKAGE_SUBMITTED.has(key) ? 'submitted' : 'confirmed'
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

  // ---- 収集パッケージの論点：様式の入力を明細として取り込み、計算・確定する ----
  progress('収集パッケージの論点を計算しています', 0.16)
  const pkgStatus = new Map(pkgRows.map((x) => [`${x.company_id}|${x.as_of}|${x.form_code}`, String(x.status)]))
  // 画面で入れた明細・計算・状況がある会社×時点×論点は、テストデータで上書きしない
  const pkgIssues = Object.keys(PACKAGE_CALCS)
  type PI = { period_id: string; issue_code: string }
  const userOwned = new Set((await Promise.all([
    fetchAll<PI>((f, t) => supabase.from('detail_items').select('period_id, issue_code').eq('is_demo_seed', false).in('issue_code', pkgIssues).order('id').range(f, t)),
    fetchAll<PI>((f, t) => supabase.from('calculation_runs').select('period_id, issue_code').eq('is_demo_seed', false).in('issue_code', pkgIssues).in('status', ['draft', 'final']).order('id').range(f, t)),
    fetchAll<PI>((f, t) => supabase.from('work_status').select('period_id, issue_code').eq('is_demo_seed', false).in('issue_code', pkgIssues).order('id').range(f, t)),
  ])).flat().map((x) => `${x.period_id}|${x.issue_code}`))
  const policyOf = (pid: string, issue: string) => {
    const x = pol.find((p) => p.period_id === pid && p.issue_code === issue)
    return { applicability: x?.applicability ?? null, params: x?.params ?? {} }
  }
  const plans: PkgPlan[] = []
  for (const c of m.companies) {
    const pts = points.get(c.id)!
    for (const [issue, def] of Object.entries(PACKAGE_CALCS)) {
      let priorFy: PkgPlan | undefined
      for (const pt of pts) {
        if (!applied(pt.period.id, issue) || userOwned.has(`${pt.period.id}|${issue}`)) continue
        const key = `${c.id}|${pt.period.end_date}|${def.formCode}`
        const data = dataOf.get(`${c.id}|${def.formCode}|${pt.period.id}`)
        // 入力中（提出前）の様式と、画面で入力した様式は取り込まない
        if (!data || taken.has(key) || pkgStatus.get(key) === 'draft') continue
        // 計算に使うほかの様式も、テストデータで提出済みのものだけ（画面の取込と同じ条件）
        const otherKeys = (def.otherForms ?? []).map((fc) => `${c.id}|${pt.period.end_date}|${fc}`)
        if (otherKeys.some((k) => taken.has(k) || !pkgStatus.has(k) || pkgStatus.get(k) === 'draft')) continue
        const plan = planPackageIssue({
          companyCode: c.code, pt, issue, data, other: (fc) => dataOf.get(`${c.id}|${fc}|${pt.period.id}`),
          policy: policyOf(pt.period.id, issue), taxRate: taxOf(pt.period.id), prior: pt.year === 1 ? priorFy : undefined,
          final: !(pt.slot === 'current:Q2' && Q2_DRAFT.has(`${c.code}|${issue}`)),
        })
        if (!plan) continue
        plans.push(plan)
        if (pt.slot === 'prior:FY') priorFy = plan
      }
    }
  }
  await savePackagePlans(plans, (r) => progress('収集パッケージの論点の明細・計算・仕訳を保存しています', 0.16 + 0.12 * r))

  // ---- 有給休暇・減価償却（S01 は手で試すため空ける） ----
  const chains: (() => Promise<void>)[] = []
  for (const c of m.companies) {
    if (c.code === 'S01') continue
    for (const issue of ['PAID_LEAVE', 'DEPRECIATION'] as const) {
      // 当期期末は収集パッケージが入力中のため計算しない
      const pts = points.get(c.id)!.filter((pt) => applied(pt.period.id, issue) && pt.slot !== 'current:FY')
      if (!pts.length) continue
      // 前期は1Q→期末、当期は前期末の確定から。会社×論点ごとに順に、会社どうしは同時に進める
      chains.push(async () => {
        for (const pt of pts) await calcOne(c.code, issue, pt.period, !(pt.slot === 'current:Q2' && Q2_DRAFT.has(`${c.code}|${issue}`)))
      })
    }
  }
  let done = 0
  const total = chains.length
  progress(`有給休暇・減価償却を計算しています（0/${total}）`, 0.3)
  await Promise.all(chains.map(async (run) => {
    await run()
    done++
    progress(`有給休暇・減価償却を計算しています（${done}/${total}）`, 0.3 + 0.6 * (done / total))
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

// 同時にいくつかずつ動かす（Storage・DBへの送信が一度に集中しないように）
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

// 行が多い表は、500行ずつ4本並べて入れる。返す行は入れた順とは限らないため、呼び出し側は値で突き合わせる
async function insertMany<T>(table: string, rows: Record<string, unknown>[], columns?: string): Promise<T[]> {
  const chunks: Record<string, unknown>[][] = []
  for (let i = 0; i < rows.length; i += 500) chunks.push(rows.slice(i, i + 500))
  const out: T[] = []
  await pool(chunks, 4, async (c) => {
    if (columns) out.push(...(must(await supabase.from(table).insert(c).select(columns)) as T[]))
    else must(await supabase.from(table).insert(c))
  })
  return out
}

// 収集パッケージの論点：元資料 → 明細（チェック済）→ 計算・計算シート・残高 → 仕訳 → 状況（確定）の順に、表ごとにまとめて保存する
// 確定のロックは最後に入れる（ロック中は明細・計算・仕訳を入れられないため）
async function savePackagePlans(plans: PkgPlan[], progress: (ratio: number) => void) {
  if (plans.length === 0) return
  const now = new Date().toISOString()
  const pk = (p: { period: PeriodRow; issue: string }) => `${p.period.id}|${p.issue}`

  // 1. 元資料（入力をCSVにした原本）
  const files = new Map<string, { path: string; hash: string }>()
  let uploaded = 0
  await pool(plans, 8, async (p) => {
    const buf = new TextEncoder().encode(p.csv)
    const hash = await sha256(buf.buffer as ArrayBuffer)
    const path = `${p.period.id}/${p.issue}/test_${hash.slice(0, 16)}.csv`
    // 原本を置けなかったときは止める（ハッシュ値だけ残ると、原本の確認で不一致になるため）
    must(await supabase.storage.from('source-files').upload(path, buf, { contentType: 'text/csv', upsert: true }))
    files.set(pk(p), { path, hash })
    if (++uploaded % 50 === 0) progress(0.4 * (uploaded / plans.length))
  })
  const sf = await insertMany<{ id: string; storage_path: string }>('source_files', plans.map((p) => {
    const f = files.get(pk(p))!
    const title = PACKAGE_FORMS.find((x) => x.code === PACKAGE_CALCS[p.issue].formCode)?.title ?? p.issue
    return { period_id: p.period.id, issue_code: p.issue, source_kind: 'package', file_name: `${p.companyCode}_収集パッケージ_${title}_${p.period.end_date}.csv`, file_type: 'csv', storage_path: f.path, sha256: f.hash, is_demo_seed: true }
  }), 'id, storage_path')
  const fileId = new Map(sf.map((x) => [x.storage_path, x.id]))
  progress(0.45)

  // 2. 明細（親会社の確認済み）。入力のハッシュ値は、DBから読み直したときと同じ形（jsonb）の値で計算する
  const items = await insertMany<{ id: string; period_id: string; issue_code: string; item_key: string; data: Record<string, unknown> }>('detail_items', plans.flatMap((p) => p.rows.map((r, i) => ({
    period_id: p.period.id, issue_code: p.issue, item_key: r.itemKey, source_file_id: fileId.get(files.get(pk(p))!.path), source_row_no: i + 2, data: r.data,
    review_status: 'checked', checked_at: now, is_demo_seed: true,
  }))), 'id, period_id, issue_code, item_key, data')
  const itemId = new Map(items.map((x) => [`${x.period_id}|${x.issue_code}|${x.item_key}`, x.id]))
  const hashOf = new Map<string, string>()
  await Promise.all(plans.map(async (p) => {
    const own = items.filter((x) => x.period_id === p.period.id && x.issue_code === p.issue)
    hashOf.set(pk(p), await itemsHash(own as unknown as ItemRow[]))
  }))
  progress(0.55)

  // 3. 計算（前期の計算のidを前提値に残すため、前期 → 当期の順）
  const runId = new Map<PkgPlan, string>()
  for (const year of [0, 1] as const) {
    const list = plans.filter((p) => p.year === year)
    const runs = await insertMany<{ id: string; period_id: string; issue_code: string }>('calculation_runs', list.map((p) => ({
      period_id: p.period.id, issue_code: p.issue, status: p.final ? 'final' : 'draft', input_hash: hashOf.get(pk(p)), is_demo_seed: true, note: 'テストデータ',
      assumptions_snapshot: { ...p.assumptions, prior_run_id: p.prior ? runId.get(p.prior) ?? null : null },
    })), 'id, period_id, issue_code')
    for (const p of list) runId.set(p, runs.find((r) => r.period_id === p.period.id && r.issue_code === p.issue)!.id)
  }
  progress(0.62)

  // 4. 計算シートの行（明細の行は明細のidを持つ）と、明細ごとの残高
  const steps = await insertMany<{ id: string; run_id: string; item_key: string | null; step_no: number }>('calculation_steps', plans.flatMap((p) => p.result.steps.map((s) => ({
    run_id: runId.get(p), item_key: s.itemKey, step_no: s.stepNo, label: s.label, formula: s.formula, value: s.value,
    detail_item_id: s.detailItemId !== undefined ? itemId.get(`${pk(p)}|${p.rows[Number(s.detailItemId)].itemKey}`) ?? null : null,
  }))), 'id, run_id, item_key, step_no')
  const stepId = new Map(steps.map((s) => [`${s.run_id}|${s.item_key ?? ''}|${s.step_no}`, s.id]))
  await insertMany('item_balances', plans.flatMap((p) => p.result.balances.map((b) => ({
    run_id: runId.get(p), period_id: p.period.id, issue_code: p.issue, item_key: b.itemKey, balance_type: b.balanceType,
    jgaap_amount: b.jgaapAmount, ifrs_amount: b.ifrsAmount, oci_accumulated: b.ociAccumulated, temporary_difference: b.temporaryDifference,
    movement_type: b.movementType, extra: b.extra,
  }))))
  progress(0.8)

  // 5. 仕訳（各行は計算シートの集計行を指す）
  const entries = await insertMany<{ id: string; run_id: string; entry_no: number }>('journal_entries', plans.flatMap((p) => p.result.entries.map((e, i) => ({
    run_id: runId.get(p), period_id: p.period.id, issue_code: p.issue, category_code: e.categoryCode, entry_no: i + 1, description: e.description,
  }))), 'id, run_id, entry_no')
  const entryId = new Map(entries.map((e) => [`${e.run_id}|${e.entry_no}`, e.id]))
  await insertMany('journal_lines', plans.flatMap((p) => p.result.entries.flatMap((e, i) => e.lines.map((l, j) => ({
    entry_id: entryId.get(`${runId.get(p)}|${i + 1}`), line_no: j + 1, side: l.side, group_account_code: l.account, amount: l.amount, memo: l.memo ?? null,
    calculation_step_id: l.stepRef ? stepId.get(`${runId.get(p)}|${l.stepRef.itemKey ?? ''}|${l.stepRef.stepNo}`) ?? null : null,
  })))))
  progress(0.92)

  // 6. 状況（確定・計算済）
  await insertMany('work_status', plans.map((p) => ({
    period_id: p.period.id, issue_code: p.issue, status: p.final ? 'locked' : 'calculated', locked_at: p.final ? now : null, updated_at: now, is_demo_seed: true,
  })))
  progress(1)
}