import { describe, expect, it } from 'vitest'
import { isBalanced } from '../calc/common'
import type { CalcResult, DetailItem, PriorBalance } from '../calc/types'
import { formByCode } from './materials'
import type { EntryData } from './package'
import { calcPackageIssue, PACKAGE_CALCS } from './packageCalc'
import { previewFor, type PreviewContext } from './preview'

const params: Record<string, Record<string, unknown>> = {
  RETIREMENT_2: { discount_rate: 0.012 }, ARO: { discount_rate: 0.01 }, ECL: { loss_rates: [0.003, 0.01, 0.05, 0.2, 0.5], credit_impaired_rate: 1 },
}
const at = { asOf: '2026-09-30', periodStart: '2026-04-01' }

// 収集パッケージの入力から明細を作り、計算する（DBの代わり）
function run(issue: string, data: EntryData, opt: { prior?: PriorBalance[]; taxRate?: number; other?: Record<string, EntryData>; asOf?: string; periodStart?: string } = {}) {
  const def = PACKAGE_CALCS[issue]
  const rows = def.toRows(data, (c) => opt.other?.[c])
  const items: DetailItem[] = rows.map((r, i) => ({ id: `d${i}`, itemKey: r.itemKey, data: r.data }))
  return calcPackageIssue(def, {
    items, asOf: opt.asOf ?? at.asOf, periodStart: opt.periodStart ?? at.periodStart, params: params[issue] ?? {},
    taxRate: opt.taxRate ?? 0.3062, priorBalances: opt.prior ?? [],
  })
}
const net = (r: CalcResult) => {
  const m = new Map<string, number>()
  for (const e of r.entries) for (const l of e.lines) m.set(l.account, (m.get(l.account) ?? 0) + (l.side === 'debit' ? l.amount : -l.amount))
  return m
}
// 前期の確定した計算の残高として渡す
const asPrior = (r: CalcResult): PriorBalance[] => r.balances.map((b) => ({ ...b, extra: b.extra }))

// プレビューと同じ入力（テストデータに近い値）
const SAMPLES: Record<string, { form: string; data: EntryData; other?: Record<string, EntryData> }> = {
  LEVY: { form: 'LEVY', data: { fields: { property_tax_annual: 3_600_000, property_tax_unpaid: 1_800_000 } } },
  RETIREMENT_1: { form: 'RETIREMENT_ACTUARIAL', data: { fields: { dbo_open: 480e6, service_cost: 16e6, interest_cost: 2.88e6, actuarial_loss: -1.2e6, benefits_paid: 14e6, dbo_close: 483.68e6 } } },
  RETIREMENT_2: { form: 'RETIREMENT_ASSUMPTIONS', data: { fields: { discount_rate: 0.9, duration: 11.5, attribution: '給付算定式基準' } }, other: { RETIREMENT_ACTUARIAL: { fields: { dbo_close: 483_680_000 } } } },
  EQUITY_INSTRUMENT: { form: 'EQUITY_HOLDINGS', data: { rows: [
    { name: '東都銀行', listed: '上場', cost: 8e6, fair_value: 11e6, classification: '政策保有（売る予定なし）' },
    { name: '地域開発', listed: '非上場', cost: 5e6, fair_value: 6.2e6, classification: '政策保有（売る予定なし）' },
    { name: '短期運用ファンド', listed: '上場', cost: 3e6, fair_value: 3.3e6, classification: '売買目的' },
  ] } },
  GOODWILL: { form: 'GOODWILL', data: { fields: { goodwill_close: 40e6, amortization: 2.5e6, impairment_indicator: 'なし' } } },
  COMPRESSION: { form: 'COMPRESSION_LIST', data: { rows: [
    { asset_no: 'C01', asset_name: '空調', method: '直接減額', amount: 4e6 }, { asset_no: 'C03', asset_name: '倉庫', method: '積立金', amount: 1.8e6 },
  ] } },
  ARO: { form: 'ARO_LIST', data: { rows: [{ site: '本社', estimate: 12e6, settle_date: '2035-03-31', discount_rate: 0.8, balance: 11.2e6 }] } },
  EIR: { form: 'LOANS', data: { rows: [
    { kind: '借入金', lender: 'X銀行', borrow_date: '2025-10-01', maturity: '2030-10-01', principal: 500e6, coupon_rate: 1, fee: 7.5e6 },
    { kind: '貸付金', lender: '関連会社', borrow_date: '2025-04-01', maturity: '2028-04-01', principal: 50e6, coupon_rate: 0, fee: 0, market_rate: 2 },
    { kind: '社債', lender: '第1回', borrow_date: '2025-07-01', maturity: '2030-07-01', principal: 300e6, coupon_rate: 0.8, fee: 4.2e6 },
  ] } },
  DEVELOPMENT: { form: 'DEV_PROJECTS', data: { rows: [{ project: '検査装置', spend: 9e6, criteria: '満たす' }, { project: '基礎研究', spend: 4.5e6, criteria: '判断中' }] } },
  ECL: { form: 'RECEIVABLES_AGING', data: { fields: { not_due: 1e6, past_30: 1e5, past_90: 0, past_180: 0, past_over: 1e4, credit_impaired: 2e3, jgaap_allowance: 5e3 } } },
  IMPAIRMENT: { form: 'IMPAIRMENT_TEST', data: { rows: [{ group: 'A', book_value: 100e6, undiscounted_cf: 120e6, recoverable: 70e6 }, { group: 'B', book_value: 100e6, undiscounted_cf: 80e6, recoverable: 60e6 }] } },
  PROVISION: { form: 'PROVISIONS_LIST', data: { rows: [{ name: '修繕引当金', ifrs: '計上できない', balance: 1e6 }, { name: '賞与引当金', ifrs: '計上できる', balance: 5e6 }] } },
  LT_BENEFITS: { form: 'LT_BENEFITS', data: { rows: [{ plan: '永年勤続表彰', future_payment: 20e6, avg_years: 10, req_years: 20, jgaap_balance: 1e6 }] } },
}

describe('収集パッケージの論点：明細から計算する', () => {
  it('15論点すべてに計算の定義がある', () => {
    expect(Object.keys(PACKAGE_CALCS).sort()).toEqual(['ARO', 'COMPRESSION', 'DEVELOPMENT', 'ECL', 'EIR', 'EQUITY_INSTRUMENT', 'GOODWILL', 'IMPAIRMENT', 'LEVY', 'LT_BENEFITS', 'PROVISION', 'RETIREMENT_1', 'RETIREMENT_2', 'SHARE_BASED', 'TAX_EFFECT'])
  })

  // 初年度（前期の確定した計算がない）は、期末の全額が当期の仕訳になり、プレビューの仕訳と科目ごとに一致する
  for (const [issue, s] of Object.entries(SAMPLES)) {
    it(`${issue}：プレビューと同じ金額になり、貸借が一致する`, () => {
      const r = run(issue, s.data, { other: s.other })
      const ctx: PreviewContext = { ...at, taxRate: 0.3062, params, other: (c) => s.other?.[c] }
      const p = previewFor(formByCode(s.form)!, s.data, ctx)
      const expected = new Map<string, number>()
      for (const e of p.entries) for (const l of e.lines) expected.set(l.account, (expected.get(l.account) ?? 0) + (l.side === 'debit' ? l.amount : -l.amount))
      const actual = net(r)
      for (const acc of new Set([...expected.keys(), ...actual.keys()])) {
        // 明細ごとに円に丸めるため、合計では数円ずれることがある
        expect(Math.abs((actual.get(acc) ?? 0) - (expected.get(acc) ?? 0)), `${issue} ${acc}`).toBeLessThanOrEqual(3)
      }
      expect(r.entries.every(isBalanced)).toBe(true)
    })
  }

  it('仕訳の行は、集計行（計算シート）を指し、集計行は明細の合計と一致する', () => {
    const r = run('EIR', SAMPLES.EIR.data)
    for (const e of r.entries) for (const l of e.lines) {
      const st = r.steps.find((x) => x.itemKey === null && x.stepNo === l.stepRef?.stepNo)!
      expect(Math.abs(Number(st.value))).toBe(l.amount)
      const itemLabel = st.label.replace(' 合計', '')
      const parts = r.steps.filter((x) => x.itemKey !== null && x.label === itemLabel)
      expect(parts.length).toBeGreaterThan(0)
      expect(parts.reduce((a, x) => a + Number(x.value), 0)).toBe(Number(st.value))
      expect(parts.every((x) => x.detailItemId)).toBe(true)
    }
  })

  it('累積・残高の論点：前期末の調整額から当期の変動だけを仕訳にする', () => {
    const prior = run('PROVISION', { rows: [{ name: '修繕引当金', ifrs: '計上できない', balance: 1_000_000 }] })
    const now = run('PROVISION', { rows: [{ name: '修繕引当金', ifrs: '計上できない', balance: 1_300_000 }] }, { prior: asPrior(prior) })
    expect(net(now).get('BS_PROVISIONS')).toBe(300_000)
    expect(net(now).get('PL_PROVISION_EXP')).toBe(-300_000)
    // 税効果も期首（前期の確定した値）との差：−1,300,000 × 30.62% − (−1,000,000 × 30.62%)
    expect(net(now).get('BS_DTA')).toBe(-398_060 + 306_200)
  })

  it('累積・残高の論点：前期末にあって当期にない明細は、調整を戻す', () => {
    const prior = run('PROVISION', { rows: [{ name: '修繕引当金', ifrs: '計上できない', balance: 1_000_000 }] })
    const now = run('PROVISION', { none: true }, { prior: asPrior(prior) })
    expect(net(now).get('BS_PROVISIONS')).toBe(-1_000_000)
    expect(now.balances.find((b) => b.itemKey === '修繕引当金')?.movementType).toBe('disposed')
    expect(now.warnings.some((w) => w.includes('戻します'))).toBe(true)
  })

  it('期間の論点：当期の発生額（期首からの累計）を仕訳にし、期末は期首に足して引き継ぐ', () => {
    const prior = run('GOODWILL', { fields: { amortization: 5_000_000 } })
    const now = run('GOODWILL', { fields: { amortization: 2_500_000 } }, { prior: asPrior(prior) })
    expect(net(now).get('BS_GOODWILL')).toBe(2_500_000)
    expect(now.balances[0].extra.adj_close).toBe(7_500_000)
    // 当期にない明細（開発プロジェクトの終了など）は、期首のまま引き継ぐ
    const dev0 = run('DEVELOPMENT', { rows: [{ project: 'P1', spend: 1_000_000, criteria: '満たす' }] })
    const dev1 = run('DEVELOPMENT', { rows: [{ project: 'P2', spend: 400_000, criteria: '満たす' }] }, { prior: asPrior(dev0) })
    expect(net(dev1).get('BS_INTANGIBLE')).toBe(400_000)
    expect(dev1.balances.find((b) => b.itemKey === 'P1')?.extra.adj_close).toBe(1_000_000)
  })

  it('洗替の論点：前期があっても、期末の全額を仕訳にする', () => {
    const prior = run('LEVY', { fields: { property_tax_unpaid: 900_000 } })
    const now = run('LEVY', { fields: { property_tax_unpaid: 1_800_000 } }, { prior: asPrior(prior) })
    expect(net(now).get('BS_ACCRUED_LEVY')).toBe(-1_800_000)
    expect(net(now).get('BS_DTA')).toBe(551_160)
  })

  it('税率が変わると、期首の繰延税金も新しい税率で測り直した差が出る', () => {
    const prior = run('PROVISION', { rows: [{ name: 'X', ifrs: '計上できない', balance: 1_000_000 }] }, { taxRate: 0.3 })
    const now = run('PROVISION', { rows: [{ name: 'X', ifrs: '計上できない', balance: 1_000_000 }] }, { prior: asPrior(prior), taxRate: 0.25 })
    expect(net(now).get('BS_PROVISIONS')).toBeUndefined()
    expect(net(now).get('BS_DTA')).toBe(50_000)
  })

  it('入力が足りない明細は、前期の調整を誤って戻さず、期首のまま残して知らせる', () => {
    const prior = run('PROVISION', { rows: [{ name: 'X', ifrs: '計上できない', balance: 1_000_000 }] })
    const now = run('PROVISION', { rows: [{ name: 'X', ifrs: '計上できない', balance: null }] }, { prior: asPrior(prior) })
    expect(now.entries).toEqual([])
    expect(now.warnings.some((w) => w.includes('計算できません'))).toBe(true)
  })

  it('株式報酬：権利確定期間のうち当期の月数で費用を出し、失効見込率で減らす', () => {
    const r = run('SHARE_BASED', { rows: [{ series: '第3回', grant_date: '2024-07-01', units: 800, fair_value: 45000, vesting_date: '2026-07-01' }] })
    // 2026年4〜6月の3か月（7月に権利確定）：800 × 45,000 × 3 ÷ 24 × 5%
    expect(net(r).get('PL_SHARE_COMP')).toBe(-225_000)
  })

  it('明細の番号：空は行番号、重複は番号を足して、前期と突き合わせられるようにする', () => {
    const rows = PACKAGE_CALCS.PROVISION.toRows({ rows: [{ name: 'A', balance: 1 }, { name: 'A', balance: 2 }, { balance: 3 }, {}] }, () => undefined)
    expect(rows.map((r) => r.itemKey)).toEqual(['A', 'A（2）', '3行目'])
    // 「A（2）」という名前の行があっても、番号は重ならない
    const r2 = PACKAGE_CALCS.PROVISION.toRows({ rows: [{ name: 'A' }, { name: 'A' }, { name: 'A（2）' }] }, () => undefined)
    expect(new Set(r2.map((r) => r.itemKey)).size).toBe(3)
  })

  it('科目の組が変わった明細（保有目的の変更）は、前期末の組の調整を戻し、新しい組で計上し直す', () => {
    const row = { name: 'X', listed: '非上場', cost: 1_000_000, fair_value: 2_000_000 }
    const prior = run('EQUITY_INSTRUMENT', { rows: [{ ...row, classification: '政策保有（売る予定なし）' }] })
    const now = run('EQUITY_INSTRUMENT', { rows: [{ ...row, fair_value: 2_500_000, classification: '売買目的' }] }, { prior: asPrior(prior) })
    const n = net(now)
    expect(n.get('BS_INVESTMENTS')).toBe(-1_000_000) // 前期末の時価評価（FVOCI）を戻す
    expect(n.get('PL_FINANCE_INCOME')).toBe(-1_500_000) // 新しい組（FVTPL）で全額
    expect(now.balances.find((b) => b.itemKey === 'X（科目の組の変更前）')?.movementType).toBe('disposed')
    expect(now.entries.every(isBalanced)).toBe(true)
  })

  it('前期末の調整が0の明細は、当期になくても行を作らない（期間の論点でも）', () => {
    const prior = run('DEVELOPMENT', { none: true })
    const now = run('DEVELOPMENT', { rows: [{ project: 'P', spend: 100, criteria: '満たす' }] }, { prior: asPrior(prior) })
    expect(now.balances.map((b) => b.itemKey)).toEqual(['P'])
    expect(now.warnings).toEqual([])
  })

  it('集計行の番号と仕訳の並びは、明細の並び順によらない（再計算の検証で一致する）', () => {
    const a = run('EIR', SAMPLES.EIR.data)
    const b = run('EIR', { rows: [...(SAMPLES.EIR.data.rows ?? [])].reverse() })
    const sums = (r: CalcResult) => r.steps.filter((s) => s.itemKey === null).map((s) => `${s.stepNo}:${s.label}:${s.value}`)
    expect(sums(b)).toEqual(sums(a))
    expect(b.entries.map((e) => e.description)).toEqual(a.entries.map((e) => e.description))
  })
})
