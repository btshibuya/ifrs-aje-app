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

describe('仕訳のプレビュー（追加した論点）', () => {
  const c2: PreviewContext = { ...ctx, asOf: '2026-09-30', periodStart: '2026-04-01', params: { ...ctx.params, ECL: { loss_rates: [0.003, 0.01, 0.05, 0.2, 0.5], credit_impaired_rate: 1 } } }
  it('予想信用損失：年齢別残高×損失率 − 日本基準の貸倒引当金', () => {
    const r = previewFor(formByCode('RECEIVABLES_AGING')!, { fields: { not_due: 1_000_000, past_30: 100_000, past_90: 0, past_180: 0, past_over: 10_000, credit_impaired: 2_000, jgaap_allowance: 5_000 } }, c2)
    // 3,000 + 1,000 + 5,000 + 2,000 = 11,000 − 5,000
    expect(net(r, 'PL_BAD_DEBT')).toBe(6_000)
    expect(net(r, 'BS_ALLOWANCE')).toBe(-6_000)
  })
  it('固定資産の減損：割引前CFが帳簿価額以上で、回収可能価額が下回る分だけIFRSで減損', () => {
    const r = previewFor(formByCode('IMPAIRMENT_TEST')!, { rows: [
      { group: 'A', book_value: 100, undiscounted_cf: 120, recoverable: 70 },
      { group: 'B', book_value: 100, undiscounted_cf: 80, recoverable: 60 }, // 日本基準でも減損するため差なし
    ] }, c2)
    expect(net(r, 'PL_IMPAIRMENT')).toBe(30)
  })
  it('引当金：計上できないものだけ取り消す', () => {
    const r = previewFor(formByCode('PROVISIONS_LIST')!, { rows: [
      { name: '修繕引当金', ifrs: '計上できない', balance: 1_000_000 }, { name: '賞与引当金', ifrs: '計上できる', balance: 5_000_000 },
    ] }, c2)
    expect(net(r, 'BS_PROVISIONS')).toBe(1_000_000)
  })
  it('長期の従業員給付：支給見込額を勤続年数で按分し、日本基準の計上額との差を負債に', () => {
    const r = previewFor(formByCode('LT_BENEFITS')!, { rows: [{ plan: '永年勤続表彰', future_payment: 20_000_000, avg_years: 10, req_years: 20, jgaap_balance: 1_000_000 }] }, c2)
    expect(net(r, 'BS_LT_BENEFITS')).toBe(-9_000_000)
  })
  it('借入金：期末の償却原価が元本より小さい分、借入金を減らす（手数料を後の期に回す）', () => {
    const r = previewFor(formByCode('LOANS')!, { rows: [{ kind: '借入金', lender: 'X銀行', borrow_date: '2025-10-01', maturity: '2030-10-01', principal: 500_000_000, coupon_rate: 1, fee: 7_500_000 }] }, c2)
    const adj = net(r, 'BS_BORROWINGS')
    expect(adj).toBeGreaterThan(0)
    expect(adj).toBeLessThan(7_500_000)
    expect(net(r, 'PL_FINANCE_COST')).toBe(-adj)
  })
})
