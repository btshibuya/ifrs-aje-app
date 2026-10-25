// 計算ロジックの入出力。DBに保存する形（calculation_steps / item_balances / journal_*）に合わせる

export interface DetailItem {
  id: string
  itemKey: string
  data: Record<string, unknown>
}

export interface Step {
  itemKey: string | null // null は論点全体の集計行
  stepNo: number
  label: string
  formula: string | null
  value: number | null
  detailItemId?: string
}

export interface Balance {
  itemKey: string
  balanceType: string
  jgaapAmount: number
  ifrsAmount: number
  ociAccumulated: number
  temporaryDifference: number | null
  movementType: 'new' | 'continuing' | 'disposed'
  extra: Record<string, unknown>
}

export interface Line {
  side: 'debit' | 'credit'
  account: string
  amount: number
  memo?: string
  // 計算根拠の行（集計行を指す）
  stepRef?: { itemKey: string | null; stepNo: number }
}

export interface Entry {
  categoryCode: string
  description: string
  lines: Line[]
}

export interface CalcResult {
  steps: Step[]
  balances: Balance[]
  entries: Entry[]
  warnings: string[]
}

// 前期の確定した計算の明細残高
export interface PriorBalance {
  itemKey: string
  balanceType: string
  jgaapAmount: number
  ifrsAmount: number
  temporaryDifference: number | null
  movementType: string
  extra: Record<string, unknown>
}
