import { describe, expect, it } from 'vitest'
import { computeEir } from './eir'

describe('償却原価（実効金利法）', () => {
  it('手数料つきの借入：当初は元本−手数料、実効金利は契約の金利より高く、満期に向けて元本に近づく', () => {
    const e = computeEir({ start: '2025-10-01', maturity: '2030-10-01', principal: 500_000_000, couponRate: 0.01, fee: 7_500_000 })!
    expect(e.months).toBe(60)
    expect(Math.round(e.amortizedCost('2025-10-01'))).toBe(492_500_000)
    expect(e.annualRate).toBeGreaterThan(0.0130)
    expect(e.annualRate).toBeLessThan(0.0133)
    const mid = e.amortizedCost('2028-04-01')
    expect(mid).toBeGreaterThan(492_500_000)
    expect(mid).toBeLessThan(500_000_000)
    expect(Math.round(e.amortizedCost('2030-09-01'))).toBeGreaterThan(499_800_000)
  })
  it('無利息の貸付：市場金利で割り引いた額で当初に計上し、実効金利は市場金利になる', () => {
    const e = computeEir({ start: '2026-04-01', maturity: '2029-04-01', principal: 30_000_000, couponRate: 0, fee: 0, marketRate: 0.02 })!
    expect(Math.round(e.initial)).toBe(Math.round(30_000_000 / (1 + 0.02 / 12) ** 36))
    expect(e.monthlyRate).toBeCloseTo(0.02 / 12, 6)
  })
})
