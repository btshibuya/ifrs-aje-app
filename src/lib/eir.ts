// 償却原価（実効金利法）の計算：元本を満期に一括で返し、利息を毎月払う契約として、月単位で計算する
//
// 当初の帳簿価額 = 公正価値（金利が市場より低いときは、市場金利で割り引いた額。それ以外は元本） − 手数料・発行費用
// 実効金利     = 将来の支払い（利息と元本）を割り引いた額が、当初の帳簿価額と一致する利率
// 期末の償却原価 = 残りの支払いを、実効金利で割り引いた額
// 日本基準では手数料を支払時（受取時）に損益とし、帳簿価額は元本のままとする前提で、差額を調整する

export interface EirInput {
  start: string // 実行日 YYYY-MM-DD
  maturity: string // 返済期日
  principal: number
  couponRate: number // 年利（0.01 = 1%）
  fee: number // 手数料・発行費用
  marketRate?: number | null // 市場金利（契約の金利が低いときだけ）
}

export interface EirResult {
  months: number // 契約期間（月）
  initial: number // 当初の帳簿価額（IFRS）
  monthlyRate: number // 実効金利（月）
  annualRate: number // 実効金利（年換算）
  amortizedCost: (asOf: string) => number // その日の償却原価
}

const monthIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1

// 月ごとの支払い（1〜nか月目）。最後の月に元本
function cashFlows(n: number, principal: number, couponRate: number) {
  const coupon = (principal * couponRate) / 12
  return Array.from({ length: n }, (_, i) => coupon + (i === n - 1 ? principal : 0))
}

const pv = (cfs: number[], r: number, from = 0) => cfs.slice(from).reduce((s, c, i) => s + c / (1 + r) ** (i + 1), 0)

export function computeEir(x: EirInput): EirResult | null {
  const n = monthIdx(x.maturity) - monthIdx(x.start)
  if (!(n >= 1) || !(x.principal > 0)) return null
  const cfs = cashFlows(n, x.principal, x.couponRate)
  const fair = x.marketRate !== null && x.marketRate !== undefined && x.marketRate > x.couponRate ? pv(cfs, x.marketRate / 12) : x.principal
  const initial = fair - x.fee
  // 二分法：割り引いた額は利率が上がるほど小さくなる
  let lo = -0.05
  let hi = 0.5
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (pv(cfs, mid) > initial) lo = mid
    else hi = mid
  }
  const r = (lo + hi) / 2
  return {
    months: n,
    initial,
    monthlyRate: r,
    annualRate: (1 + r) ** 12 - 1,
    amortizedCost: (asOf) => {
      const k = Math.min(Math.max(monthIdx(asOf) - monthIdx(x.start), 0), n)
      if (k >= n) return 0
      return pv(cfs, r, k)
    },
  }
}
