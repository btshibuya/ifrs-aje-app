// 収集パッケージから明細を作る論点（有給休暇・減価償却以外）の共通の計算
//
// 明細ごとに「調整額」を出す：借方の科目・貸方の科目の組と金額（プラス＝借方、マイナス＝貸借が逆）
//   残高の論点（balance）：期末の調整額を明細から計算する。当期の変動 ＝ 期末 − 期首
//   期間の論点（flow）  ：当期の発生額（期首からの累計）を明細から計算する。期末 ＝ 期首 ＋ 当期の発生額
// 期首の調整額は、前期（前年度末）の確定した計算の、同じ明細の期末の調整額
//   前期末にあって当期にない明細：残高の論点は調整を戻し（期末0）、期間の論点は期首のまま引き継ぐ
// 仕訳：累積の区分は当期の変動、洗替の区分は期末の全額（前期分の戻入れは開始実現仕訳で行う）
// 税効果：損益（またはOCI）に入る調整額 × 実効税率 を繰延税金資産とし、期首（前期の確定した値）との差を仕訳にする

import { EntryBuilder, fmt, pct, yen } from './common'
import type { Balance, CalcResult, Entry, PriorBalance, Step } from './types'

export interface AdjStep { label: string; formula: string | null; value: number | null }

// 論点ごとの計算（明細1件分）の結果
export interface AdjItem {
  itemKey: string
  name: string
  detailItemId?: string
  dr: string
  cr: string
  amount: number | null // 残高の論点は期末の調整額、期間の論点は当期の発生額。null は計算できない
  steps: AdjStep[] // 入力と計算の過程（最大15行）
  jgaap?: number // 日本基準の期末の金額（参考）
  ifrs?: number // IFRSの期末の金額（参考）
}

export interface AdjConfig {
  title: string
  mode: 'balance' | 'flow'
  carry: 'cumulative' | 'reversing'
  mainCategory: string
  taxCategory?: string // 税効果を計上する論点だけ
  taxOn?: 'PL' | 'OCI' // 税効果の対象（損益に入る調整額か、OCIに入る調整額か）
  taxCounter?: string // 繰延税金の相手科目（OCI のときはその科目）
}

export interface AdjInput {
  items: AdjItem[]
  priorBalances: PriorBalance[]
  taxRate: number | null
  accountName: (code: string) => string
}

// 明細の計算過程の行番号（論点ごとの行は1〜15）
const S = { open: 21, close: 22, move: 23, base: 24, taxOpen: 25, taxClose: 26, taxMove: 27 }
// 集計行：組ごとに10行ずつ（期首 1・変動 2・期末 3）。税効果は91〜93
const SUM_TAX = { open: 91, close: 92, move: 93 }

const signed = (code: string, prefix: string) => code.startsWith(prefix)

export function calcAdjustments(cfg: AdjConfig, input: AdjInput): CalcResult {
  const steps: Step[] = []
  const balances: Balance[] = []
  const warnings: string[] = []
  const name = input.accountName
  const prior = new Map(input.priorBalances.filter((b) => b.balanceType === 'main').map((b) => [b.itemKey, b]))
  const rate = input.taxRate
  const taxPrefix = cfg.taxOn === 'OCI' ? 'OCI_' : 'PL_'

  type Row = { key: string; dr: string; cr: string; open: number; close: number; move: number; taxOpen: number; taxClose: number }
  const rows: Row[] = []
  const groupLabel = (dr: string, cr: string) => `（${name(dr)}／${name(cr)}）`

  // 前期末にあって当期にない明細も、計算の対象にする（残高の論点は戻し、期間の論点は引き継ぐ）
  // 科目の組が変わった明細（株式の保有目的・借入の種類の変更など）は、前期末の組の分を別の行にして同じように扱う
  const currentKeys = new Set(input.items.map((i) => i.itemKey))
  const missing: AdjItem[] = []
  for (const p of [...prior.values()]) {
    const dr = String(p.extra.dr ?? '')
    const cr = String(p.extra.cr ?? '')
    const open = Number(p.extra.adj_close ?? 0)
    if (!dr || !cr) continue
    const cur = input.items.find((i) => i.itemKey === p.itemKey)
    if (cur && cur.dr === dr && cur.cr === cr) continue
    if (open === 0 && Number(p.extra.tax_close ?? 0) === 0) continue
    const key = cur ? `${p.itemKey}（科目の組の変更前）` : p.itemKey
    if (cur) prior.set(key, { ...p, itemKey: key })
    missing.push({ itemKey: key, name: String(p.extra.name ?? ''), dr, cr, amount: 0, steps: [] })
    const what = cur
      ? `${p.itemKey}：前期末と科目の組が変わりました（${name(dr)}／${name(cr)} → ${name(cur.dr)}／${name(cur.cr)}）。前期末の組の調整額 ${fmt(open)}円は`
      : `${p.itemKey}：前期末にあった明細が当期の収集パッケージにありません。期首の調整額 ${fmt(open)}円は`
    warnings.push(`${what}${cfg.mode === 'balance' ? '戻します' : 'そのまま引き継ぎます'}`)
  }

  for (const item of [...input.items, ...missing]) {
    const k = item.itemKey
    const d = item.detailItemId
    const isMissing = !currentKeys.has(k)
    const p = prior.get(k)
    const g = groupLabel(item.dr, item.cr)
    const s = (stepNo: number, label: string, formula: string | null, value: number | null) =>
      steps.push({ itemKey: k, stepNo, label, formula, value, detailItemId: d })
    item.steps.slice(0, 15).forEach((x, i) => s(i + 1, x.label, x.formula, x.value))

    // 期首：前期の確定した計算の、同じ明細の期末の調整額（借方・貸方の組が同じときだけ引き継ぐ）
    const samePair = p && p.extra.dr === item.dr && p.extra.cr === item.cr
    const open = samePair ? Number(p.extra.adj_close ?? 0) : 0
    let close: number
    let move: number
    let closeFormula: string
    let moveFormula: string
    if (item.amount === null) {
      // 計算できない明細は、期首の調整額のまま（誤って戻さない）
      close = open
      move = 0
      closeFormula = '計算できないため、期首の調整額のまま'
      moveFormula = '計算できないため0'
      warnings.push(`${k}：入力が足りないか読み取れないため計算できません（期首の調整額のまま）`)
    } else if (cfg.mode === 'balance') {
      close = isMissing ? 0 : yen(item.amount)
      move = close - open
      closeFormula = isMissing ? '当期の収集パッケージにないため0（調整を戻す）' : `上の計算（${item.steps.at(-1)?.label ?? '調整額'}）`
      moveFormula = '期末の調整額 − 期首の調整額'
    } else {
      move = isMissing ? 0 : yen(item.amount)
      close = open + move
      closeFormula = '期首の調整額 ＋ 当期の変動'
      moveFormula = isMissing ? '当期の収集パッケージにないため0（期首のまま引き継ぐ）' : `当期の発生額（期首からの累計）：${item.steps.at(-1)?.label ?? ''}`
    }
    const openFormula = p ? (samePair ? '前期末の調整額（前期の確定した計算）' : '前期末と科目の組が違うため0（前期末の組の分は別の行）') : '前期の確定した計算にないため0'
    const sign = `借方 ${name(item.dr)} ／ 貸方 ${name(item.cr)}。プラスは借方`
    s(S.open, `期首の調整額${g}`, `${openFormula}。${sign}`, open)
    if (cfg.mode === 'balance') {
      s(S.close, `期末の調整額${g}`, closeFormula, close)
      s(S.move, `当期の変動${g}`, moveFormula, move)
    } else {
      s(S.close, `当期の変動${g}`, moveFormula, move)
      s(S.move, `期末の調整額${g}`, closeFormula, close)
    }

    let taxOpen = 0
    let taxClose = 0
    if (cfg.taxCategory) {
      // 損益（OCI）に入る調整額：損益の科目が借方ならプラス（費用が増える）、貸方ならマイナス
      const base = (signed(item.dr, taxPrefix) ? close : 0) - (signed(item.cr, taxPrefix) ? close : 0)
      taxOpen = samePair ? Number(p.extra.tax_close ?? 0) : 0
      taxClose = rate === null ? 0 : yen(base * rate)
      s(S.base, '税効果の対象額', `期末の調整額のうち${cfg.taxOn === 'OCI' ? 'その他の包括利益' : '損益'}に入る額（費用・損失が増える向きをプラス）`, base)
      s(S.taxOpen, '繰延税金資産（期首）', samePair ? '前期の確定した計算の期末の繰延税金資産' : p ? '前期末と科目の組が違うため0（前期末の組の分は別の行）' : '前期の確定した計算にないため0', taxOpen)
      s(S.taxClose, '繰延税金資産（期末）', rate === null ? '実効税率がないため0' : `税効果の対象額 ${fmt(base)} × 実効税率 ${pct(rate)}`, taxClose)
      s(S.taxMove, '繰延税金資産の当期変動', '期末 − 期首', taxClose - taxOpen)
    }

    rows.push({ key: `${item.dr}|${item.cr}`, dr: item.dr, cr: item.cr, open, close, move, taxOpen, taxClose })
    balances.push({
      itemKey: k, balanceType: 'main', jgaapAmount: isMissing ? 0 : yen(item.jgaap ?? 0), ifrsAmount: isMissing ? 0 : yen(item.ifrs ?? 0), ociAccumulated: 0,
      temporaryDifference: close, movementType: isMissing && cfg.mode === 'balance' ? 'disposed' : p ? 'continuing' : 'new',
      extra: { name: item.name || (p?.extra.name ?? null), dr: item.dr, cr: item.cr, adj_open: open, adj_close: close, adj_move: move, tax_close: taxClose },
    })
  }

  // 集計（借方・貸方の組ごと）と仕訳。組の順は明細の並びによらず決める（再計算の検証で、集計行の番号がそろうように）
  const groups = [...new Set(rows.map((r) => r.key))].sort()
  const entries: (Entry | null)[] = []
  groups.forEach((key, j) => {
    const rs = rows.filter((r) => r.key === key)
    const { dr, cr } = rs[0]
    const g = groupLabel(dr, cr)
    const sum = (f: (r: Row) => number) => rs.reduce((a, r) => a + f(r), 0)
    const [open, move, close] = [sum((r) => r.open), sum((r) => r.move), sum((r) => r.close)]
    const base = j * 10
    steps.push(
      { itemKey: null, stepNo: base + 1, label: `期首の調整額 合計${g}`, formula: '各明細の期首の調整額の合計（前期の確定した計算）', value: open },
      { itemKey: null, stepNo: base + 2, label: `当期の変動 合計${g}`, formula: cfg.mode === 'balance' ? '各明細の当期の変動（期末 − 期首）の合計' : '各明細の当期の発生額（期首からの累計）の合計', value: move },
      { itemKey: null, stepNo: base + 3, label: `期末の調整額 合計${g}`, formula: '期首 ＋ 当期の変動', value: close },
    )
    const [amount, ref, what] = cfg.carry === 'reversing' ? [close, base + 3, '期末の調整額'] : [move, base + 2, '当期の変動']
    entries.push(
      new EntryBuilder(cfg.mainCategory, `${cfg.title}：${cfg.carry === 'reversing' ? '期末の全額' : '当期の変動'}${g}`)
        .add(dr, amount, what, { itemKey: null, stepNo: ref })
        .add(cr, -amount, what, { itemKey: null, stepNo: ref })
        .build(),
    )
  })

  if (cfg.taxCategory) {
    const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0)
    const [open, close] = [sum((r) => r.taxOpen), sum((r) => r.taxClose)]
    const counter = cfg.taxCounter ?? 'PL_DEFERRED_TAX'
    steps.push(
      { itemKey: null, stepNo: SUM_TAX.open, label: '繰延税金資産（期首） 合計', formula: '各明細の期首の繰延税金資産の合計（前期の確定した計算）', value: open },
      { itemKey: null, stepNo: SUM_TAX.close, label: '繰延税金資産（期末） 合計', formula: rate === null ? '実効税率がないため0' : `各明細の税効果の対象額 × 実効税率 ${pct(rate)} の合計`, value: close },
      { itemKey: null, stepNo: SUM_TAX.move, label: '繰延税金資産の当期変動 合計', formula: '期末 − 期首', value: close - open },
    )
    const [amount, ref] = cfg.carry === 'reversing' ? [close, SUM_TAX.close] : [close - open, SUM_TAX.move]
    entries.push(
      new EntryBuilder(cfg.taxCategory, `${cfg.title}：税効果（${cfg.carry === 'reversing' ? '期末の全額' : '当期の変動'}）`)
        .add('BS_DTA', amount, '繰延税金資産', { itemKey: null, stepNo: ref })
        .add(counter, -amount, '繰延税金資産', { itemKey: null, stepNo: ref })
        .build(),
    )
  }

  return { steps, balances, entries: entries.filter((e): e is Entry => e !== null), warnings }
}
