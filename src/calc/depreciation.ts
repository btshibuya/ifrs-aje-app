// 論点3 減価償却（経済的耐用年数、IAS16）
// 仕訳区分は累積：当期の変動分を出力する（期首の累積差額はBTrexの開始仕訳で入る）
// 前期の確定した計算にない既存資産（アプリでの初年度など）は、BTrexに期首残高がないため
// 期首の累積差額を利益剰余金に計上する
//
// 月割り：取得月・除却月はそれぞれ1か月として数える
// 見積りの変更（耐用年数の変更）は、期首のIFRS帳簿価額を残存月数で償却し、当期以降に反映する

import { EntryBuilder, fmt, pct, yen } from './common'
import type { Balance, CalcResult, DetailItem, Entry, PriorBalance, Step } from './types'

export interface AssetRule {
  usefulLifeYears: number
  residualRate: number
}

export interface DepreciationInput {
  items: DetailItem[]
  periodStart: string // YYYY-MM-DD
  periodEnd: string
  ruleFor: (assetType: string) => AssetRule | null
  priorBalances: PriorBalance[]
  hasPriorFinal: boolean // 前期の確定した計算があるか
  taxRate: number
  priorTaxRate: number // 期首の繰延税金の計算に使う（BTrexの開始仕訳と同じ税率）
}

const monthIndex = (date: string) => {
  const [y, m] = date.split('-').map(Number)
  return y * 12 + (m - 1)
}

const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : NaN
}

export function calcDepreciation(input: DepreciationInput): CalcResult {
  const steps: Step[] = []
  const balances: Balance[] = []
  const warnings: string[] = []
  const prior = new Map(input.priorBalances.filter((b) => b.balanceType === 'main').map((b) => [b.itemKey, b]))
  const startIdx = monthIndex(input.periodStart)
  const endIdx = monthIndex(input.periodEnd)
  const sum = { open: 0, openNew: 0, dep: 0, disposal: 0, close: 0 }

  for (const item of input.items) {
    const k = item.itemKey
    const d = item.id
    const data = item.data
    const assetType = String(data.asset_type ?? '')
    const rule = input.ruleFor(assetType)
    if (!rule) {
      warnings.push(`${k}：資産の種類「${assetType}」の経済的耐用年数が登録されていません（計算から除外）`)
      continue
    }
    const acquiredOn = String(data.acquired_on ?? '')
    const disposedOn = data.disposed_on ? String(data.disposed_on) : null
    const cost = num(data.cost)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(acquiredOn) || !Number.isFinite(cost)) {
      warnings.push(`${k}：取得年月日または取得価額が読み取れません（計算から除外）`)
      continue
    }
    const a = monthIndex(acquiredOn)
    if (a > endIdx) {
      warnings.push(`${k}：取得年月日が当期末より後です（計算から除外）`)
      continue
    }
    const dIdx = disposedOn ? monthIndex(disposedOn) : null
    const disposed = dIdx !== null && dIdx >= startIdx && dIdx <= endIdx
    const acquiredInPeriod = a >= startIdx
    const lifeMonths = rule.usefulLifeYears * 12
    const residual = yen(cost * rule.residualRate)
    const p = prior.get(k)

    // IFRSの期首帳簿価額と残存償却月数
    let ifrsOpen: number
    let remaining: number
    let openFormula: string
    if (acquiredInPeriod) {
      ifrsOpen = 0
      remaining = lifeMonths
      openFormula = '当期取得'
    } else if (p) {
      ifrsOpen = p.ifrsAmount
      const elapsed = startIdx - a
      const priorLife = Number(p.extra.useful_life_years)
      remaining = Math.max(lifeMonths - elapsed, 0)
      openFormula = '前期末のIFRS帳簿価額（前期の確定した計算）'
      if (priorLife && priorLife !== rule.usefulLifeYears) {
        warnings.push(`${k}：経済的耐用年数が${priorLife}年→${rule.usefulLifeYears}年に変わりました（当期以降に反映）`)
      }
    } else {
      const elapsed = startIdx - a
      ifrsOpen = Math.max(yen(cost - ((cost - residual) / lifeMonths) * elapsed), residual)
      remaining = Math.max(lifeMonths - elapsed, 0)
      openFormula = `取得価額 ${fmt(cost)} − (取得価額 − 残存価額) ÷ ${lifeMonths}か月 × 経過 ${elapsed}か月`
      if (input.hasPriorFinal) {
        warnings.push(`${k}：前期の確定した計算にない既存資産です（期首差額を台帳から算定し、利益剰余金に計上）`)
      }
    }

    const depMonths = (disposed ? dIdx! : endIdx) - Math.max(a, startIdx) + 1
    const base = acquiredInPeriod ? cost : ifrsOpen
    const depreciable = Math.max(base - residual, 0)
    const ifrsDep = remaining > 0 ? yen((depreciable / remaining) * Math.min(depMonths, remaining)) : 0

    const jgaapOpen = acquiredInPeriod ? 0 : num(data.jgaap_opening_bv)
    if (p && Math.abs(jgaapOpen - p.jgaapAmount) >= 1) {
      warnings.push(`${k}：日本基準の期首帳簿価額 ${fmt(jgaapOpen)} が前期末 ${fmt(p.jgaapAmount)} と一致しません`)
    }
    const jgaapDep = num(data.jgaap_depreciation)
    const acq = acquiredInPeriod ? cost : 0
    const ifrsBeforeDisposal = ifrsOpen + acq - ifrsDep
    const jgaapBeforeDisposal = jgaapOpen + acq - jgaapDep
    const ifrsClose = disposed ? 0 : ifrsBeforeDisposal
    const jgaapClose = disposed ? 0 : num(data.jgaap_closing_bv)
    if (!disposed && Math.abs(jgaapClose - jgaapBeforeDisposal) >= 1) {
      warnings.push(`${k}：日本基準の期末帳簿価額が「期首＋取得−償却」と一致しません（台帳を確認してください）`)
    }

    const diffOpen = ifrsOpen - jgaapOpen
    const depDiff = ifrsDep - jgaapDep
    const disposalDiff = disposed ? ifrsBeforeDisposal - jgaapBeforeDisposal : 0
    const diffClose = ifrsClose - jgaapClose
    sum.open += diffOpen
    if (!acquiredInPeriod && !p) sum.openNew += diffOpen
    sum.dep += depDiff
    sum.disposal += disposalDiff
    sum.close += diffClose

    const s = (stepNo: number, label: string, formula: string | null, value: number | null) =>
      steps.push({ itemKey: k, stepNo, label, formula, value, detailItemId: d })
    s(1, '経済的耐用年数（年）', `資産の種類「${assetType}」の区分マッピング、残存価額 ${pct(rule.residualRate)}`, rule.usefulLifeYears)
    s(2, 'IFRS期首帳簿価額', openFormula, ifrsOpen)
    s(3, '期首の残存償却月数', acquiredInPeriod ? `${lifeMonths}か月（当期取得）` : `${lifeMonths}か月 − 取得からの経過月数`, remaining)
    s(4, '当期の償却月数', disposed ? `除却月（${disposedOn}）まで` : '当期末まで（取得月を含む）', depMonths)
    s(5, 'IFRS償却額', `(${acquiredInPeriod ? '取得価額' : '期首帳簿価額'} ${fmt(base)} − 残存価額 ${fmt(residual)}) ÷ ${remaining}か月 × ${Math.min(depMonths, remaining)}か月`, ifrsDep)
    s(6, '日本基準 償却額', '取込データ', jgaapDep)
    s(7, 'IFRS期末帳簿価額', disposed ? '除却のため0' : 'IFRS期首帳簿価額 ＋ 当期取得 − IFRS償却額', ifrsClose)
    s(8, '日本基準 期末帳簿価額', disposed ? '除却のため0' : '取込データ', jgaapClose)
    s(9, '期首差額（IFRS − 日本基準）', null, diffOpen)
    s(10, '償却額の差（IFRS − 日本基準）', null, depDiff)
    if (disposed) s(11, '除却時の帳簿価額の差（除却損の調整）', '除却直前のIFRS帳簿価額 − 日本基準帳簿価額', disposalDiff)
    s(12, '期末差額（IFRS − 日本基準）', '期首差額 − 償却額の差 − 除却時の差', diffClose)

    balances.push({
      itemKey: k, balanceType: 'main', jgaapAmount: jgaapClose, ifrsAmount: ifrsClose, ociAccumulated: 0,
      temporaryDifference: diffClose,
      movementType: disposed ? 'disposed' : p ? 'continuing' : 'new',
      extra: {
        name: data.name ?? null, asset_type: assetType, useful_life_years: rule.usefulLifeYears,
        remaining_months: Math.max(remaining - depMonths, 0),
      },
    })
  }

  // 前期末にあって当期の台帳にない資産
  const currentKeys = new Set(input.items.map((i) => i.itemKey))
  for (const p of prior.values()) {
    if (p.movementType !== 'disposed' && !currentKeys.has(p.itemKey)) {
      warnings.push(`${p.itemKey}：前期末にあった資産が当期の台帳にありません（除却・売却の処理漏れの可能性。前期末差額 ${fmt(p.ifrsAmount - p.jgaapAmount)}円）`)
    }
  }

  const dtOpen = yen(sum.open * input.priorTaxRate)
  const dtClose = yen(sum.close * input.taxRate)
  const dtAccount = sum.close >= 0 ? 'BS_DTL' : 'BS_DTA'
  steps.push(
    { itemKey: null, stepNo: 1, label: '期首差額 合計', formula: '各資産の期首差額の合計', value: sum.open },
    { itemKey: null, stepNo: 8, label: '期首差額のうち前期の計算にない資産', formula: 'BTrexに期首残高がないため利益剰余金に計上', value: sum.openNew },
    { itemKey: null, stepNo: 9, label: '同上の繰延税金', formula: `× 期首の実効税率 ${pct(input.priorTaxRate)}`, value: yen(sum.openNew * input.priorTaxRate) },
    { itemKey: null, stepNo: 2, label: '償却額の差 合計', formula: '各資産の償却額の差の合計（プラス＝IFRSの償却が多い）', value: sum.dep },
    { itemKey: null, stepNo: 3, label: '除却時の差 合計', formula: '各資産の除却時の差の合計', value: sum.disposal },
    { itemKey: null, stepNo: 4, label: '期末差額 合計', formula: '期首差額 − 償却額の差 − 除却時の差', value: sum.close },
    { itemKey: null, stepNo: 5, label: '期首の繰延税金（負債プラス）', formula: `期首差額 合計 × 期首の実効税率 ${pct(input.priorTaxRate)}`, value: dtOpen },
    { itemKey: null, stepNo: 6, label: '期末の繰延税金（負債プラス）', formula: `期末差額 合計 × 実効税率 ${pct(input.taxRate)}`, value: dtClose },
    { itemKey: null, stepNo: 7, label: '繰延税金の当期変動', formula: '期末 − 期首', value: dtClose - dtOpen },
  )

  const dtOpenNew = yen(sum.openNew * input.priorTaxRate)
  const entries: (Entry | null)[] = [
    new EntryBuilder('DEPR_MAIN', '減価償却 期首の累積差額（前期の計算にない資産、利益剰余金に計上）')
      .add('BS_PPE_ADJ', sum.openNew, '期首差額', { itemKey: null, stepNo: 8 })
      .add('BS_RETAINED', -sum.openNew, '期首差額', { itemKey: null, stepNo: 8 })
      .build(),
    new EntryBuilder('DEPR_TAX', '減価償却 期首の繰延税金（前期の計算にない資産、利益剰余金に計上）')
      .add('BS_RETAINED', dtOpenNew, '期首の繰延税金', { itemKey: null, stepNo: 9 })
      .add(dtAccount, -dtOpenNew, '期首の繰延税金', { itemKey: null, stepNo: 9 })
      .build(),
  ]
  entries.push(
    new EntryBuilder('DEPR_MAIN', '減価償却 当期の変動（経済的耐用年数による償却・除却）')
      .add('PL_DEPRECIATION', sum.dep, '償却額の差', { itemKey: null, stepNo: 2 })
      .add('PL_DISPOSAL_LOSS', sum.disposal, '除却時の差', { itemKey: null, stepNo: 3 })
      .add('BS_PPE_ADJ', sum.close - sum.open, '差額の当期変動', { itemKey: null, stepNo: 4 })
      .build(),
    new EntryBuilder('DEPR_TAX', '減価償却 税効果の当期変動')
      .add('PL_DEFERRED_TAX', dtClose - dtOpen, '繰延税金の当期変動', { itemKey: null, stepNo: 7 })
      .add(dtAccount, -(dtClose - dtOpen), '繰延税金の当期変動', { itemKey: null, stepNo: 7 })
      .build(),
  )

  return { steps, balances, entries: entries.filter((e): e is Entry => e !== null), warnings }
}
