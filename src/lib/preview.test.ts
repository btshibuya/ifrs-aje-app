import { describe, expect, it } from 'vitest'
import { formByCode } from './materials'
import { previewFor, type PreviewContext } from './preview'

const ctx: PreviewContext = {
  asOf: '2026-03-31', periodStart: '2025-04-01', taxRate: 0.3062,
  params: { RETIREMENT_2: { discount_rate: 0.012 }, ARO: { discount_rate: 0.01 } },
  other: () => undefined,
}
const net = (r: ReturnType<typeof previewFor>, account: string) =>
  r.entries.flatMap((e) => e.lines).filter((l) => l.account === account).reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0)

describe('仕訳のプレビュー', () => {
  it('固定資産税：期末の未納付額を費用と負債に計上し、税効果を付ける。参照は未納付額', () => {
    const r = previewFor(formByCode('LEVY')!, { fields: { property_tax_unpaid: 900_000 } }, ctx)
    expect(net(r, 'PL_TAXES')).toBe(900_000)
    expect(net(r, 'BS_ACCRUED_LEVY')).toBe(-900_000)
    expect(net(r, 'BS_DTA')).toBe(275_580)
    expect(r.entries[0].lines[0].refs).toEqual([{ key: 'property_tax_unpaid' }])
  })
  it('退職給付：数理計算上の差異が利得（マイナス）なら借貸が入れ替わる', () => {
    const r = previewFor(formByCode('RETIREMENT_ACTUARIAL')!, { fields: { actuarial_loss: -4_200_000 } }, ctx)
    expect(net(r, 'BS_RETIREMENT_LIAB')).toBe(4_200_000)
    expect(r.entries[0].lines.every((l) => l.amount > 0)).toBe(true)
  })
  it('保有株式：非上場の行だけ時価評価し、参照は行番号つき', () => {
    const r = previewFor(formByCode('EQUITY_HOLDINGS')!, {
      rows: [
        { name: 'A', listed: '上場', cost: 100, fair_value: 150, classification: '政策保有（売る予定なし）' },
        { name: 'B', listed: '非上場', cost: 5_000_000, fair_value: 6_200_000, classification: '政策保有（売る予定なし）' },
      ],
    }, ctx)
    expect(net(r, 'BS_INVESTMENTS')).toBe(1_200_000)
    expect(r.entries[0].lines[0].refs.every((x) => x.row === 1)).toBe(true)
  })
  it('割引率の違い：ほかの様式（数理計算結果）の期末債務を使い、様式の外の値として示す', () => {
    const r = previewFor(formByCode('RETIREMENT_ASSUMPTIONS')!, { fields: { discount_rate: 0.9, duration: 10 } },
      { ...ctx, other: (c) => (c === 'RETIREMENT_ACTUARIAL' ? { fields: { dbo_close: 100_000_000 } } : undefined) })
    // 100,000,000 × 10 × (0.9% − 1.2%) = −3,000,000（債務が減る）
    expect(net(r, 'BS_RETIREMENT_LIAB')).toBe(3_000_000)
    expect(r.entries[0].lines[0].external.some((x) => x.includes('期末の退職給付債務'))).toBe(true)
  })
  it('入力が足りないときは、仕訳を作らずに案内を出す', () => {
    const r = previewFor(formByCode('LEVY')!, { fields: {} }, ctx)
    expect(r.entries).toEqual([])
    expect(r.message).toContain('未納付額')
  })
})
