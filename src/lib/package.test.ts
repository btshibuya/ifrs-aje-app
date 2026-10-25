import { describe, expect, it } from 'vitest'
import { formByCode, quarterEnds, shiftMonthEnd } from './materials'
import { describeChange, parseNumber, summarize, summarizeCompanies, validate, withComputed, type MaterialState } from './package'

describe('数値の入力の読み替え', () => {
  it('全角・カンマ・円・△（マイナス）を読む', () => {
    expect(parseNumber('３２，０００，０００')).toBe(32_000_000)
    expect(parseNumber('1,234円')).toBe(1234)
    expect(parseNumber('△4,200,000')).toBe(-4_200_000)
    expect(parseNumber('▲100')).toBe(-100)
    expect(parseNumber('15%')).toBe(15)
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('abc')).toBe('error')
  })
})

describe('増減の言い方', () => {
  it('マイナスの値が大きくなったときは「減」と金額で示す（−100%と書かない）', () => {
    expect(describeChange(-4_200_000, -2_100_000, '円')).toBe('100%減（−2,100,000円）')
    expect(describeChange(28_000_000, 21_500_000, '円')).toBe('30%増（+6,500,000円）')
  })
})

describe('基準日', () => {
  it('3月決算の四半期末', () => {
    expect(quarterEnds('2025-04-01', '2026-03-31')).toEqual(['2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31'])
  })
  it('12月決算の四半期末', () => {
    expect(quarterEnds('2025-01-01', '2025-12-31')).toEqual(['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'])
  })
  it('前年同期・直前四半期・前年度末（月末にそろえる）', () => {
    expect(shiftMonthEnd('2026-03-31', -12)).toBe('2025-03-31')
    expect(shiftMonthEnd('2026-03-31', -3)).toBe('2025-12-31')
    expect(shiftMonthEnd('2025-04-01', -1)).toBe('2025-03-31')
    expect(shiftMonthEnd('2024-05-31', -3)).toBe('2024-02-29')
  })
})

describe('収集パッケージの入力チェック', () => {
  const retire = formByCode('RETIREMENT_ACTUARIAL')!
  const fields = { dbo_open: 480_080_000, service_cost: 32_000_000, interest_cost: 5_760_000, actuarial_loss: -4_200_000, benefits_paid: 28_000_000, dbo_close: 485_640_000, plan_assets_close: 310_000_000 }

  it('期首→期末のつながりが合えば、整合チェックの問題はない', () => {
    expect(validate(retire, { fields }).filter((p) => p.message.includes('つながり'))).toEqual([])
  })
  it('期末債務が合わなければ問題として出す', () => {
    const p = validate(retire, { fields: { ...fields, dbo_close: 485_000_000 } })
    expect(p.some((x) => x.message.includes('期首から期末へのつながり'))).toBe(true)
  })
  it('必須の未入力を出す', () => {
    const p = validate(retire, { fields: { ...fields, service_cost: null } })
    expect(p.some((x) => x.key === 'service_cost')).toBe(true)
  })
  it('期首残高が前年度末の期末残高と違えば出す', () => {
    const prior = (f: { key: string; carryFrom?: string }) => (f.carryFrom ? 480_000_000 : undefined)
    const p = validate(retire, { fields }, prior)
    expect(p.some((x) => x.key === 'dbo_open' && x.message.includes('一致しません'))).toBe(true)
  })
  it('前期から30%以上変わった項目は理由を求め、理由があれば通す', () => {
    const prior = (f: { key: string }) => (f.key === 'benefits_paid' ? 21_500_000 : undefined)
    expect(validate(retire, { fields }, prior).some((x) => x.key === 'benefits_paid')).toBe(true)
    expect(validate(retire, { fields, reasons: { benefits_paid: '定年退職者が多かった' } }, prior).some((x) => x.key === 'benefits_paid')).toBe(false)
  })
  it('明細の様式：該当なしでなければ1行以上、同じ名前の行は不可', () => {
    const eq = formByCode('EQUITY_HOLDINGS')!
    expect(validate(eq, { rows: [] }).some((x) => x.key === 'rows')).toBe(true)
    expect(validate(eq, { rows: [], none: true }).length).toBe(0)
    const row = { name: 'A銀行', listed: '上場', shares: 1, cost: 1, fair_value: 1, classification: '売買目的' }
    expect(validate(eq, { rows: [row, row] }).some((x) => x.message.includes('2行あります'))).toBe(true)
  })
  it('消化率を自動計算する', () => {
    const leave = formByCode('LEAVE_USAGE')!
    expect(withComputed(leave, { granted_days: 2400, used_days: 1440 }).usage_rate).toBe(60)
  })
})

describe('資料の数え方', () => {
  const st = (code: string, kind: 'system' | 'package', status: MaterialState['status'], sourceKind?: string): MaterialState =>
    ({ material: { code, issueCode: 'X', name: code, kind, source: '', format: '', prepare: '', sourceKind }, status, applicability: 'applied', updatedAt: null, detail: null })
  it('同じファイル（試算表など）は会社の中で1件と数え、不要は数えない', () => {
    const s = summarize([st('TB_A', 'system', 'todo', 'trial_balance'), st('TB_B', 'system', 'todo', 'trial_balance'), st('P', 'package', 'submitted'), st('N', 'package', 'not_needed')])
    expect(s.total).toBe(2)
    expect(s.done).toBe(1)
  })
  it('全社の合計は会社ごとに数えて足す', () => {
    const one = [st('TB_A', 'system', 'todo', 'trial_balance'), st('P', 'package', 'submitted')]
    expect(summarizeCompanies([one, one]).total).toBe(4)
  })
})
