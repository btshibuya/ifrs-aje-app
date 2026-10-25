import { describe, expect, it } from 'vitest'
import { isBalanced } from './common'
import { calcDepreciation, type DepreciationInput } from './depreciation'
import { calcPaidLeave } from './paidLeave'
import type { CalcResult, PriorBalance } from './types'

const step = (r: CalcResult, itemKey: string | null, stepNo: number) =>
  r.steps.find((s) => s.itemKey === itemKey && s.stepNo === stepNo)?.value

const net = (r: CalcResult, account: string) =>
  r.entries.flatMap((e) => e.lines).filter((l) => l.account === account)
    .reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0)

describe('有給休暇引当金', () => {
  const items = [
    { id: '1', itemKey: 'E001', data: { unused_days: 10, daily_wage: 20000 } },
    { id: '2', itemKey: 'E002', data: { unused_days: 5, daily_wage: 15000 } },
  ]
  const r = calcPaidLeave({ items, expectedUsageRate: 0.6, socialInsuranceRate: 0.15, taxRate: 0.3062, priorBalances: [{ itemKey: 'E001', balanceType: 'main', jgaapAmount: 0, ifrsAmount: 1, temporaryDifference: 1, movementType: 'new', extra: {} }] })

  it('残日数 × 消化見込率 × 日額 × (1 + 法定福利費率) で計算する', () => {
    expect(step(r, 'E001', 4)).toBe(138000) // 10 × 0.6 × 20,000 × 1.15
    expect(step(r, 'E002', 4)).toBe(51750) // 5 × 0.6 × 15,000 × 1.15
    expect(step(r, null, 1)).toBe(189750)
  })

  it('期末の全額を計上し、税効果も全額で出す', () => {
    expect(net(r, 'PL_SALARY')).toBe(189750)
    expect(net(r, 'BS_ACCRUED_LEAVE')).toBe(-189750)
    expect(net(r, 'BS_DTA')).toBe(58101) // 189,750 × 30.62% = 58,101.45
    expect(r.entries.every(isBalanced)).toBe(true)
  })

  it('前期にいた人は継続、いない人は新規', () => {
    expect(r.balances.map((b) => b.movementType)).toEqual(['continuing', 'new'])
  })
})

describe('減価償却', () => {
  const base: Omit<DepreciationInput, 'items' | 'priorBalances' | 'hasPriorFinal'> = {
    periodStart: '2025-04-01', periodEnd: '2026-03-31',
    ruleFor: (t) => (t === '機械装置' ? { usefulLifeYears: 12, residualRate: 0 } : null),
    taxRate: 0.3, priorTaxRate: 0.3,
  }
  // 2020年4月取得 1,200万円、税法10年（年120万円）、IFRS 12年（年100万円）
  const machine = (data: Record<string, unknown>) => ({
    id: 'x', itemKey: 'M1',
    data: { asset_type: '機械装置', acquired_on: '2020-04-01', cost: 12_000_000, ...data },
  })

  it('初年度：取得時から計算した期首差額を利益剰余金に計上し、当期の変動を出す', () => {
    const r = calcDepreciation({
      ...base, hasPriorFinal: false, priorBalances: [],
      items: [machine({ jgaap_opening_bv: 6_000_000, jgaap_depreciation: 1_200_000, jgaap_closing_bv: 4_800_000 })],
    })
    expect(step(r, 'M1', 2)).toBe(7_000_000) // 1,200万 − 100万 × 5年
    expect(step(r, 'M1', 5)).toBe(1_000_000)
    expect(step(r, 'M1', 12)).toBe(1_200_000) // 600万 − 480万
    expect(net(r, 'BS_PPE_ADJ')).toBe(1_200_000) // 期首100万 ＋ 当期20万
    expect(net(r, 'BS_RETAINED')).toBe(-1_000_000 + 300_000) // 期首差額 − 期首の繰延税金
    expect(net(r, 'PL_DEPRECIATION')).toBe(-200_000)
    expect(net(r, 'BS_DTL')).toBe(-360_000) // 120万 × 30%
    expect(net(r, 'PL_DEFERRED_TAX')).toBe(60_000)
    expect(r.entries.every(isBalanced)).toBe(true)
  })

  const prior: PriorBalance = {
    itemKey: 'M1', balanceType: 'main', jgaapAmount: 4_800_000, ifrsAmount: 6_000_000,
    temporaryDifference: 1_200_000, movementType: 'continuing',
    extra: { useful_life_years: 12, remaining_months: 72 },
  }

  it('2年目：前期末のIFRS帳簿価額から続けて計算し、変動分だけを出す', () => {
    const r = calcDepreciation({
      ...base, periodStart: '2026-04-01', periodEnd: '2027-03-31', hasPriorFinal: true, priorBalances: [prior],
      items: [machine({ jgaap_opening_bv: 4_800_000, jgaap_depreciation: 1_200_000, jgaap_closing_bv: 3_600_000 })],
    })
    expect(step(r, 'M1', 2)).toBe(6_000_000)
    expect(net(r, 'BS_RETAINED')).toBe(0)
    expect(net(r, 'BS_PPE_ADJ')).toBe(200_000)
    expect(net(r, 'BS_DTL')).toBe(-60_000)
    expect(r.warnings).toEqual([])
  })

  it('期中に除却：除却月までの償却と、除却時の帳簿価額の差を除却損で調整する', () => {
    const r = calcDepreciation({
      ...base, periodStart: '2026-04-01', periodEnd: '2027-03-31', hasPriorFinal: true, priorBalances: [prior],
      items: [machine({ jgaap_opening_bv: 4_800_000, jgaap_depreciation: 600_000, jgaap_closing_bv: 0, disposed_on: '2026-09-15' })],
    })
    expect(step(r, 'M1', 4)).toBe(6)
    expect(step(r, 'M1', 5)).toBe(500_000)
    expect(step(r, 'M1', 11)).toBe(1_300_000) // IFRS 550万 − 日本基準 420万
    expect(net(r, 'PL_DEPRECIATION')).toBe(-100_000)
    expect(net(r, 'PL_DISPOSAL_LOSS')).toBe(1_300_000)
    expect(net(r, 'BS_PPE_ADJ')).toBe(-1_200_000) // 前期末の差額がすべて消える
    expect(r.balances[0].movementType).toBe('disposed')
    expect(r.entries.every(isBalanced)).toBe(true)
  })

  it('前期末にあった資産が台帳にないと警告する', () => {
    const r = calcDepreciation({
      ...base, periodStart: '2026-04-01', periodEnd: '2027-03-31', hasPriorFinal: true, priorBalances: [prior], items: [],
    })
    expect(r.warnings[0]).toContain('M1')
  })

  it('税率が変わると、期首は前期の税率、期末は当期の税率で繰延税金を計算する', () => {
    const r = calcDepreciation({
      ...base, periodStart: '2026-04-01', periodEnd: '2027-03-31', taxRate: 0.35, hasPriorFinal: true, priorBalances: [prior],
      items: [machine({ jgaap_opening_bv: 4_800_000, jgaap_depreciation: 1_200_000, jgaap_closing_bv: 3_600_000 })],
    })
    expect(step(r, null, 5)).toBe(360_000)
    expect(step(r, null, 6)).toBe(490_000) // 140万 × 35%
    expect(net(r, 'PL_DEFERRED_TAX')).toBe(130_000)
  })
})
