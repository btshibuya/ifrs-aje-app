import type { Entry, Line } from './types'

export const yen = (n: number) => Math.round(n)

export const fmt = (n: number) => yen(n).toLocaleString('ja-JP')

export const pct = (r: number) => `${(r * 100).toFixed(2).replace(/\.?0+$/, '')}%`

// 借方プラス・貸方マイナスの金額で仕訳明細を足していく。0円の行は出さない
export class EntryBuilder {
  private lines: Line[] = []
  private categoryCode: string
  private description: string
  constructor(categoryCode: string, description: string) {
    this.categoryCode = categoryCode
    this.description = description
  }

  add(account: string, signedDebit: number, memo?: string, stepRef?: Line['stepRef']) {
    const amount = yen(signedDebit)
    if (amount === 0) return this
    this.lines.push({ side: amount > 0 ? 'debit' : 'credit', account, amount: Math.abs(amount), memo, stepRef })
    return this
  }

  build(): Entry | null {
    if (this.lines.length === 0) return null
    // 借方を先に並べる
    const lines = [...this.lines].sort((a, b) => (a.side === b.side ? 0 : a.side === 'debit' ? -1 : 1))
    return { categoryCode: this.categoryCode, description: this.description, lines }
  }
}

export const isBalanced = (e: Entry) =>
  e.lines.reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0) === 0
