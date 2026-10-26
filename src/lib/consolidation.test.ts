import { describe, expect, it } from 'vitest'
import { buildCompanyLines, impacts, type Account, type Category, type RawEntry } from './consolidation'
import type { PeriodRow } from './masters'

const acc = (code: string, statement: Account['statement'], bs_class: string | null = null, pl_class: string | null = null): [string, Account] =>
  [code, { code, name: code, statement, bs_class, pl_class }]
const accounts = new Map<string, Account>([
  acc('BS_ACCRUED_LEAVE', 'BS', 'current_liability'), acc('BS_DTA', 'BS', 'noncurrent_asset'), acc('BS_PPE_ADJ', 'BS', 'noncurrent_asset'),
  acc('BS_RETAINED', 'BS', 'equity'), acc('BS_OCI_RESERVE', 'BS', 'equity'), acc('PL_SALARY', 'PL', null, 'operating'),
  acc('PL_DEFERRED_TAX', 'PL', null, 'income_tax'), acc('PL_DEPRECIATION', 'PL', null, 'operating'),
])
const cat = (code: string, carry: Category['carry_method']): [string, Category] => [code, { code, issue_code: 'X', name: code, carry_method: carry, is_tax_effect: false }]
const categories = new Map<string, Category>([cat('PAID_LEAVE_MAIN', 'reversing'), cat('DEPR_MAIN', 'cumulative'), cat('LEVY_PER_CAPITA', 'reclass')])
const period = (id: string, end: string, type: PeriodRow['period_type'] = 'FY'): PeriodRow =>
  ({ id, company_id: 'c', label: id, start_date: `${Number(end.slice(0, 4)) - 1}-04-01`, end_date: end, prior_period_id: null, period_type: type })
const fy1 = period('FY1', '2025-03-31')
const fy2 = period('FY2', '2026-03-31')
const q1 = { ...period('Q1', '2026-06-30', 'Q1'), start_date: '2026-04-01' }
const entry = (periodId: string, categoryCode: string, lines: [string, number][], status: 'draft' | 'final' = 'final'): RawEntry =>
  ({ runId: periodId + categoryCode, periodId, issueCode: categoryCode.split('_')[0], categoryCode, description: 'x', status, lines: lines.map(([account, amount]) => ({ account, amount })) })
const sum = (ls: { account: string; amount: number }[], a: string) => ls.filter((l) => l.account === a).reduce((s, l) => s + l.amount, 0)

describe('連結精算表の集計', () => {
  it('洗替：前年度末の全額を開始仕訳（PLは利益剰余金）に入れ、開始実現仕訳で戻し入れる', () => {
    const { lines } = buildCompanyLines({
      companyId: 'c', current: q1, priorYears: [fy1, fy2], categories, accounts, includeDraft: true,
      entries: [
        entry('FY1', 'PAID_LEAVE_MAIN', [['PL_SALARY', 80], ['BS_ACCRUED_LEAVE', -80]]), // 前々年度：開始仕訳に入れない
        entry('FY2', 'PAID_LEAVE_MAIN', [['PL_SALARY', 100], ['BS_ACCRUED_LEAVE', -100]]),
        entry('Q1', 'PAID_LEAVE_MAIN', [['PL_SALARY', 120], ['BS_ACCRUED_LEAVE', -120]]),
      ],
    })
    const opening = lines.filter((l) => l.kind === 'opening')
    expect(sum(opening, 'BS_RETAINED')).toBe(100)
    expect(sum(opening, 'BS_ACCRUED_LEAVE')).toBe(-100)
    const real = lines.filter((l) => l.kind === 'realization')
    expect(sum(real, 'BS_ACCRUED_LEAVE')).toBe(100)
    expect(sum(real, 'PL_SALARY')).toBe(-100)
    // 合計：負債は期末の全額、PLは当期の増減、利益剰余金は前年度末
    expect(sum(lines, 'BS_ACCRUED_LEAVE')).toBe(-120)
    expect(sum(lines, 'PL_SALARY')).toBe(20)
    expect(impacts(lines, accounts).balance).toBe(0)
  })
  it('累積：前年度までの確定した仕訳を累計し、PLを利益剰余金に置き換える。組換は引き継がない', () => {
    const { lines } = buildCompanyLines({
      companyId: 'c', current: q1, priorYears: [fy1, fy2], categories, accounts, includeDraft: true,
      entries: [
        entry('FY1', 'DEPR_MAIN', [['BS_PPE_ADJ', 300], ['BS_RETAINED', -300]]),
        entry('FY2', 'DEPR_MAIN', [['PL_DEPRECIATION', 50], ['BS_PPE_ADJ', -50]]),
        entry('FY2', 'LEVY_PER_CAPITA', [['PL_SALARY', 10], ['PL_DEFERRED_TAX', -10]]),
        entry('Q1', 'DEPR_MAIN', [['PL_DEPRECIATION', 12], ['BS_PPE_ADJ', -12]]),
      ],
    })
    const opening = lines.filter((l) => l.kind === 'opening')
    expect(sum(opening, 'BS_PPE_ADJ')).toBe(250)
    expect(sum(opening, 'BS_RETAINED')).toBe(-250)
    expect(opening.some((l) => l.categoryCode === 'LEVY_PER_CAPITA')).toBe(false)
    expect(lines.some((l) => l.kind === 'realization')).toBe(false)
    expect(sum(lines, 'BS_PPE_ADJ')).toBe(238)
  })
  it('前年度の下書きは開始仕訳に入れず、警告を出す。当期の下書きは指定で除ける', () => {
    const r = buildCompanyLines({
      companyId: 'c', current: q1, priorYears: [fy2], categories, accounts, includeDraft: false,
      entries: [
        entry('FY2', 'PAID_LEAVE_MAIN', [['PL_SALARY', 100], ['BS_ACCRUED_LEAVE', -100]], 'draft'),
        entry('Q1', 'PAID_LEAVE_MAIN', [['PL_SALARY', 120], ['BS_ACCRUED_LEAVE', -120]], 'draft'),
      ],
    })
    expect(r.lines).toEqual([])
    expect(r.warnings[0]).toContain('未確定')
  })
  it('利益・純資産への影響：開始（利益剰余金）＋ 開始実現（PL）＋ 当期 ＝ 期末の純資産', () => {
    const { lines } = buildCompanyLines({
      companyId: 'c', current: q1, priorYears: [fy2], categories, accounts, includeDraft: true,
      entries: [
        entry('FY2', 'PAID_LEAVE_MAIN', [['PL_SALARY', 100], ['BS_ACCRUED_LEAVE', -100]]),
        entry('Q1', 'PAID_LEAVE_MAIN', [['PL_SALARY', 120], ['BS_ACCRUED_LEAVE', -120]]),
      ],
    })
    const i = impacts(lines, accounts)
    expect(i.profit).toBe(-20)
    expect(i.netAssets).toBe(-120)
    expect(i.netAssetsByKind).toEqual({ opening: -100, realization: 100, current: -120 })
  })
})
