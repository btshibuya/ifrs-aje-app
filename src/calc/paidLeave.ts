// 論点1 有給休暇引当金（IAS19）
// 仕訳区分は洗替：当期末時点の全額を出力する（前期分の戻入れはBTrexの開始仕訳で行う）

import { EntryBuilder, fmt, pct, yen } from './common'
import type { Balance, CalcResult, DetailItem, Entry, PriorBalance, Step } from './types'

export interface PaidLeaveInput {
  items: DetailItem[]
  expectedUsageRate: number // 消化見込率
  socialInsuranceRate: number // 法定福利費率
  taxRate: number
  priorBalances: PriorBalance[] // 前期の確定した計算（なければ空）
}

export function calcPaidLeave(input: PaidLeaveInput): CalcResult {
  const { items, expectedUsageRate: u, socialInsuranceRate: s, taxRate } = input
  const steps: Step[] = []
  const balances: Balance[] = []
  const warnings: string[] = []
  const priorKeys = new Set(input.priorBalances.map((b) => b.itemKey))
  let total = 0

  for (const item of items) {
    const days = Number(item.data.unused_days)
    const wage = Number(item.data.daily_wage)
    if (!Number.isFinite(days) || !Number.isFinite(wage)) {
      warnings.push(`${item.itemKey}：有給残日数または日額給与が数値ではありません`)
      continue
    }
    const expectedDays = days * u
    const amount = yen(expectedDays * wage * (1 + s))
    total += amount
    const k = item.itemKey
    const d = item.id
    steps.push(
      { itemKey: k, stepNo: 1, label: '有給残日数', formula: '取込データ', value: days, detailItemId: d },
      { itemKey: k, stepNo: 2, label: '日額給与', formula: '取込データ', value: wage, detailItemId: d },
      { itemKey: k, stepNo: 3, label: '消化見込日数', formula: `有給残日数 ${days} × 消化見込率 ${pct(u)}`, value: expectedDays, detailItemId: d },
      {
        itemKey: k, stepNo: 4, label: '未払有給休暇（IFRS）',
        formula: `消化見込日数 × 日額給与 ${fmt(wage)} × (1 + 法定福利費率 ${pct(s)})`, value: amount, detailItemId: d,
      },
    )
    balances.push({
      itemKey: k, balanceType: 'main', jgaapAmount: 0, ifrsAmount: amount, ociAccumulated: 0,
      temporaryDifference: amount, movementType: priorKeys.has(k) ? 'continuing' : 'new',
      extra: { name: item.data.name ?? null },
    })
  }

  const tax = yen(total * taxRate)
  steps.push(
    { itemKey: null, stepNo: 1, label: '未払有給休暇 合計', formula: '各人の未払有給休暇（IFRS）の合計', value: total },
    { itemKey: null, stepNo: 2, label: '繰延税金資産', formula: `合計 ${fmt(total)} × 実効税率 ${pct(taxRate)}`, value: tax },
  )

  const entries = [
    new EntryBuilder('PAID_LEAVE_MAIN', '有給休暇引当金の計上（期末全額）')
      .add('PL_SALARY', total, '未払有給休暇', { itemKey: null, stepNo: 1 })
      .add('BS_ACCRUED_LEAVE', -total, '未払有給休暇', { itemKey: null, stepNo: 1 })
      .build(),
    new EntryBuilder('PAID_LEAVE_TAX', '有給休暇引当金の税効果（期末全額）')
      .add('BS_DTA', tax, '繰延税金資産', { itemKey: null, stepNo: 2 })
      .add('PL_DEFERRED_TAX', -tax, '繰延税金資産', { itemKey: null, stepNo: 2 })
      .build(),
  ].filter((e): e is Entry => e !== null)

  return { steps, balances, entries, warnings }
}
