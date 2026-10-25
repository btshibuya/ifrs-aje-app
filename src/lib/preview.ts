// 収集パッケージの仕訳プレビュー：入力中の値から、IFRS調整仕訳を簡易計算する
// 各金額は、どの入力を参照したか（refs）を持つ。画面では金額を押すと、その入力欄を色で強調する
// ※ プレビューは入力と仕訳の関係を示すための簡易計算。正式な仕訳は各論点の計算で作る

import type { PackageForm } from './materials'
import type { EntryData } from './package'

// 参照：様式の項目（明細の様式は行番号つき）、または様式の外の値（方針の率・他の様式・取り込んだ明細）
export interface Ref { key: string; row?: number }
export interface PreviewLine { side: 'debit' | 'credit'; account: string; amount: number; formula: string; refs: Ref[]; external: string[] }
export interface PreviewEntry { title: string; note?: string; lines: PreviewLine[] }
export interface PreviewResult { entries: PreviewEntry[]; message?: string }

export interface PreviewContext {
  asOf: string
  periodStart: string
  taxRate: number | null // 実効税率（会社別方針の税効果）
  params: Record<string, Record<string, unknown>> // 論点ごとの方針の前提値
  leave?: { count: number; base: number } // 取り込んだ有給残日数一覧：人数と Σ(残日数×日額給与)
  other: (formCode: string) => EntryData | undefined // 同じ基準日のほかの様式
}

const yen = (v: number) => Math.round(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const fmt = (v: number) => Math.round(v).toLocaleString('ja-JP')
const pct = (v: number) => `${(v * 100).toFixed(2)}%`

// 借方・貸方の1組。金額がマイナスなら借貸を入れ替える。0なら作らない
function pair(debit: string, credit: string, amount: number, formula: string, refs: Ref[], external: string[] = []): PreviewLine[] {
  const a = yen(amount)
  if (a === 0) return []
  const [d, c] = a > 0 ? [debit, credit] : [credit, debit]
  return [
    { side: 'debit', account: d, amount: Math.abs(a), formula, refs, external },
    { side: 'credit', account: c, amount: Math.abs(a), formula, refs, external },
  ]
}

// 損益の調整（費用が増える＝プラス）に対する税効果：繰延税金資産 ／ 法人税等調整額
function taxEntry(expenseIncrease: number, ctx: PreviewContext, refs: Ref[], external: string[], title = '税効果'): PreviewEntry | null {
  if (ctx.taxRate === null) return null
  const t = expenseIncrease * ctx.taxRate
  const lines = pair('BS_DTA', 'PL_DEFERRED_TAX', t, `調整額 ${fmt(expenseIncrease)} × 実効税率 ${pct(ctx.taxRate)}`, refs, [...external, `実効税率 ${pct(ctx.taxRate)}（会社別方針）`])
  return lines.length ? { title, lines } : null
}

const monthsBetween = (from: string, to: string) => {
  const [y1, m1] = from.split('-').map(Number)
  const [y2, m2] = to.split('-').map(Number)
  return (y2 - y1) * 12 + (m2 - m1)
}

type Rule = (data: EntryData, ctx: PreviewContext) => PreviewResult

const RULES: Record<string, Rule> = {
  LEAVE_USAGE: (d, ctx) => {
    const f = d.fields ?? {}
    const granted = num(f.granted_days)
    const used = num(f.used_days)
    const s = num(f.social_insurance_rate)
    if (!ctx.leave) return { entries: [], message: '有給休暇の残日数一覧を取り込むと、この消化率・法定福利費率で有給休暇引当金の仕訳を計算して表示します。' }
    if (!granted || used === null || s === null) return { entries: [], message: '付与日数・消化日数・法定福利費率を入力すると、仕訳を表示します。' }
    const rate = used / granted
    const amount = ctx.leave.base * rate * (1 + s / 100)
    const refs = [{ key: 'granted_days' }, { key: 'used_days' }, { key: 'usage_rate' }, { key: 'social_insurance_rate' }]
    const ext = [`取り込んだ残日数一覧（${ctx.leave.count}名、Σ残日数×日額給与 ${fmt(ctx.leave.base)}円）`]
    const entries: PreviewEntry[] = [{
      title: '有給休暇引当金（洗替：期末の全額）',
      lines: pair('PL_SALARY', 'BS_ACCRUED_LEAVE', amount, `Σ(残日数×日額給与) ${fmt(ctx.leave.base)} × 消化率 ${(rate * 100).toFixed(1)}% × (1 + 法定福利費率 ${s}%)`, refs, ext),
    }]
    const t = taxEntry(amount, ctx, refs, ext)
    if (t) entries.push(t)
    return { entries }
  },

  LEVY: (d, ctx) => {
    const f = d.fields ?? {}
    const unpaid = num(f.property_tax_unpaid)
    if (unpaid === null) return { entries: [], message: '期末時点の未納付額を入力すると、仕訳を表示します。' }
    const refs = [{ key: 'property_tax_unpaid' }]
    const entries: PreviewEntry[] = [{
      title: '固定資産税（IFRIC21：賦課期日に1年分を負債計上）',
      note: '日本基準で納付時に費用計上している前提で、期末に未納付の分を費用と負債に計上します。',
      lines: pair('PL_TAXES', 'BS_ACCRUED_LEVY', unpaid, `期末の未納付額 ${fmt(unpaid)}`, refs),
    }]
    const t = taxEntry(unpaid, ctx, refs, [])
    if (t) entries.push(t)
    return { entries }
  },

  RETIREMENT_ACTUARIAL: (d, ctx) => {
    const f = d.fields ?? {}
    const al = num(f.actuarial_loss)
    if (al === null) return { entries: [], message: '数理計算上の差異の発生額を入力すると、仕訳を表示します。' }
    const refs = [{ key: 'actuarial_loss' }]
    const entries: PreviewEntry[] = [{
      title: '数理計算上の差異の即時認識（その他の包括利益）',
      note: '日本基準では数年で費用処理する差異を、IFRSでは発生時に全額その他の包括利益（OCI）に計上します。',
      lines: pair('OCI_REMEASUREMENT', 'BS_RETIREMENT_LIAB', al, `数理計算上の差異の発生額 ${fmt(al)}（損失はプラス）`, refs),
    }]
    if (ctx.taxRate !== null) {
      const t = al * ctx.taxRate
      const lines = pair('BS_DTA', 'OCI_REMEASUREMENT', t, `${fmt(al)} × 実効税率 ${pct(ctx.taxRate)}`, refs, [`実効税率 ${pct(ctx.taxRate)}（会社別方針）`])
      if (lines.length) entries.push({ title: '税効果（その他の包括利益）', lines })
    }
    return { entries }
  },

  RETIREMENT_ASSUMPTIONS: (d, ctx) => {
    const f = d.fields ?? {}
    const jr = num(f.discount_rate)
    const dur = num(f.duration)
    const ir = num(ctx.params.RETIREMENT_2?.discount_rate)
    const dbo = num(ctx.other('RETIREMENT_ACTUARIAL')?.fields?.dbo_close)
    if (jr === null || dur === null) return { entries: [], message: '割引率とデュレーションを入力すると、仕訳を表示します。' }
    if (ir === null) return { entries: [], message: '会社別方針に、IFRSの割引率（退職給付②）が設定されていません。' }
    if (dbo === null) return { entries: [], message: '「退職給付の数理計算結果」の期末の退職給付債務を入力すると、割引率の違いによる影響を表示します。' }
    // 債務の変化 ≒ 債務 × デュレーション × (日本基準の割引率 − IFRSの割引率)
    const change = dbo * dur * (jr / 100 - ir)
    const refs = [{ key: 'discount_rate' }, { key: 'duration' }]
    const ext = [`期末の退職給付債務 ${fmt(dbo)}円（退職給付の数理計算結果）`, `IFRSの割引率 ${pct(ir)}（会社別方針）`]
    const entries: PreviewEntry[] = [{
      title: '割引率の違いによる退職給付債務の調整（その他の包括利益）',
      note: '債務 × デュレーション × 割引率の差 で近似します。正式には年金数理人の再計算によります。',
      lines: pair('OCI_REMEASUREMENT', 'BS_RETIREMENT_LIAB', change, `債務 ${fmt(dbo)} × デュレーション ${dur}年 × (日本基準 ${jr}% − IFRS ${(ir * 100).toFixed(2)}%)`, refs, ext),
    }]
    if (Math.round(change) === 0) return { entries: [], message: '日本基準とIFRSの割引率が同じため、調整はありません。' }
    return { entries }
  },

  EQUITY_HOLDINGS: (d) => {
    if (d.none) return { entries: [], message: '保有している株式がないため、仕訳はありません。' }
    const rows = d.rows ?? []
    const unlisted: PreviewLine[] = []
    const fvtpl: PreviewLine[] = []
    rows.forEach((r, i) => {
      const fv = num(r.fair_value)
      const cost = num(r.cost)
      if (fv === null || cost === null) return
      const refs = [{ key: 'fair_value', row: i }, { key: 'cost', row: i }, { key: 'listed', row: i }, { key: 'classification', row: i }]
      const name = String(r.name ?? `${i + 1}行目`)
      if (r.classification === '売買目的') {
        // 日本基準で純資産に計上している評価差額を、IFRS（FVTPL）では損益に振り替える
        fvtpl.push(...pair('OCI_FVOCI', 'PL_FINANCE_INCOME', fv - cost, `${name}：時価 ${fmt(fv)} − 取得原価 ${fmt(cost)}`, refs))
      } else if (r.listed === '非上場') {
        // 日本基準で取得原価のままの非上場株式を、IFRS（FVOCI）では時価にする
        unlisted.push(...pair('BS_INVESTMENTS', 'OCI_FVOCI', fv - cost, `${name}：時価 ${fmt(fv)} − 取得原価 ${fmt(cost)}`, refs))
      }
    })
    const entries: PreviewEntry[] = []
    if (unlisted.length) entries.push({ title: '非上場株式の時価評価（FVOCI）', note: '日本基準では取得原価のままの非上場株式を、IFRSでは時価で評価し、差額をその他の包括利益に計上します。', lines: unlisted })
    if (fvtpl.length) entries.push({ title: '売買目的の株式の評価差額を損益へ（FVTPL）', lines: fvtpl })
    if (entries.length === 0) return { entries, message: rows.length ? '上場・政策保有の株式は、日本基準でも時価評価し評価差額を純資産に計上しているため、調整はありません。' : '明細を入力すると、仕訳を表示します。' }
    return { entries }
  },

  GOODWILL: (d) => {
    const am = num(d.fields?.amortization)
    if (am === null) return { entries: [], message: '当期ののれん償却額を入力すると、仕訳を表示します。' }
    return {
      entries: [{
        title: 'のれん償却の取消し（IFRSでは償却しない）',
        note: 'のれんには税効果を認識しません。',
        lines: pair('BS_GOODWILL', 'PL_GOODWILL_AMORT', am, `当期ののれん償却額 ${fmt(am)}`, [{ key: 'amortization' }]),
      }],
    }
  },

  COMPRESSION_LIST: (d) => {
    if (d.none) return { entries: [], message: '圧縮記帳をした資産がないため、仕訳はありません。' }
    const lines: PreviewLine[] = []
    ;(d.rows ?? []).forEach((r, i) => {
      const amount = num(r.amount)
      if (amount === null || r.method !== '直接減額') return
      lines.push(...pair('BS_PPE_ADJ', 'BS_DEFERRED_INCOME', amount, `${String(r.asset_name ?? r.asset_no ?? `${i + 1}行目`)}：圧縮額 ${fmt(amount)}`, [{ key: 'amount', row: i }, { key: 'method', row: i }]))
    })
    if (lines.length === 0) return { entries: [], message: '「直接減額」の明細を入力すると、仕訳を表示します（積立金方式は資産の額を変えないため調整なし）。' }
    return { entries: [{ title: '圧縮記帳の取消し（補助金は繰延収益に）', note: '当期の償却額の調整は、減価償却の計算で行います。', lines }] }
  },

  ARO_LIST: (d, ctx) => {
    if (d.none) return { entries: [], message: '資産除去債務がないため、仕訳はありません。' }
    const r0 = num(ctx.params.ARO?.discount_rate)
    if (r0 === null) return { entries: [], message: '会社別方針に、IFRSの割引率（資産除去債務）が設定されていません。' }
    const lines: PreviewLine[] = []
    ;(d.rows ?? []).forEach((r, i) => {
      const est = num(r.estimate)
      const bal = num(r.balance)
      const settle = typeof r.settle_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.settle_date) ? r.settle_date : null
      if (est === null || bal === null || !settle) return
      const years = Math.max(monthsBetween(ctx.asOf, settle) / 12, 0)
      const ifrs = est / (1 + r0) ** years
      lines.push(...pair('BS_PPE_ADJ', 'BS_ARO', ifrs - bal,
        `${String(r.site ?? `${i + 1}行目`)}：見込額 ${fmt(est)} ÷ (1 + ${pct(r0)})^${years.toFixed(1)}年 − 計上額 ${fmt(bal)}`,
        [{ key: 'estimate', row: i }, { key: 'settle_date', row: i }, { key: 'balance', row: i }], [`IFRSの割引率 ${pct(r0)}（会社別方針）`]))
    })
    if (lines.length === 0) return { entries: [], message: '明細を入力すると、仕訳を表示します。' }
    return { entries: [{ title: '割引率の見直しによる資産除去債務の調整', lines }] }
  },

  DEV_PROJECTS: (d, ctx) => {
    if (d.none) return { entries: [], message: '開発費の支出がないため、仕訳はありません。' }
    const lines: PreviewLine[] = []
    let total = 0
    const refsAll: Ref[] = []
    ;(d.rows ?? []).forEach((r, i) => {
      const spend = num(r.spend)
      if (spend === null || r.criteria !== '満たす') return
      const refs = [{ key: 'spend', row: i }, { key: 'criteria', row: i }]
      lines.push(...pair('BS_INTANGIBLE', 'PL_RND', spend, `${String(r.project ?? `${i + 1}行目`)}：当期の支出額 ${fmt(spend)}`, refs))
      total += spend
      refsAll.push(...refs)
    })
    if (lines.length === 0) return { entries: [], message: '資産計上の要件を「満たす」とした明細があると、仕訳を表示します（「判断中」は親会社と相談してください）。' }
    const entries: PreviewEntry[] = [{ title: '開発費の資産計上', lines }]
    const t = taxEntry(-total, ctx, refsAll, [])
    if (t) entries.push(t)
    return { entries }
  },

  LOANS: (d, ctx) => {
    if (d.none) return { entries: [], message: '手数料を支払った借入金がないため、仕訳はありません。' }
    const lines: PreviewLine[] = []
    let total = 0
    const refsAll: Ref[] = []
    ;(d.rows ?? []).forEach((r, i) => {
      const fee = num(r.fee)
      const b = typeof r.borrow_date === 'string' ? r.borrow_date : ''
      const m = typeof r.maturity === 'string' ? r.maturity : ''
      if (fee === null || !b || !m || b < ctx.periodStart || b > ctx.asOf) return
      const term = Math.max(monthsBetween(b, m), 1)
      const elapsed = Math.min(Math.max(monthsBetween(b, ctx.asOf) + 1, 1), term)
      const deferred = fee * (1 - elapsed / term)
      const refs = [{ key: 'fee', row: i }, { key: 'borrow_date', row: i }, { key: 'maturity', row: i }]
      lines.push(...pair('BS_BORROWINGS', 'PL_FINANCE_COST', deferred, `${String(r.lender ?? `${i + 1}行目`)}：手数料 ${fmt(fee)} × 残り ${term - elapsed}か月 ÷ ${term}か月`, refs))
      total += deferred
      refsAll.push(...refs)
    })
    if (lines.length === 0) return { entries: [], message: '当期に借り入れた明細を入力すると、仕訳を表示します。' }
    const entries: PreviewEntry[] = [{ title: '借入手数料を借入期間に配分（実効金利法の簡易計算）', lines }]
    const t = taxEntry(-total, ctx, refsAll, [])
    if (t) entries.push(t)
    return { entries }
  },

  SO_GRANTS: () => ({ entries: [], message: '株式報酬は日本基準でも権利確定期間にわたり費用計上しているため、通常は調整がありません（失効の見積りを見直したときに調整します）。' }),
  TAX: () => ({ entries: [], message: 'この様式は税効果の前提（税率・会社分類など）です。仕訳は作らず、各論点の税効果の計算に使います。' }),
}

export function previewFor(form: PackageForm, data: EntryData, ctx: PreviewContext): PreviewResult {
  const rule = RULES[form.code]
  return rule ? rule(data, ctx) : { entries: [], message: 'この様式の仕訳のプレビューはまだありません。' }
}

// プレビューで使う科目名（統一科目のマスタにない場合の予備）
export const FALLBACK_ACCOUNT_NAMES: Record<string, string> = {
  PL_SALARY: '給料手当', BS_ACCRUED_LEAVE: '未払有給休暇', BS_DTA: '繰延税金資産', BS_DTL: '繰延税金負債', PL_DEFERRED_TAX: '法人税等調整額',
  BS_PPE_ADJ: '有形固定資産（IFRS調整）', PL_TAXES: '租税公課', BS_ACCRUED_LEVY: '未払賦課金', OCI_REMEASUREMENT: '確定給付制度の再測定',
  BS_RETIREMENT_LIAB: '退職給付に係る負債', BS_INVESTMENTS: '投資有価証券', OCI_FVOCI: 'FVOCI資本性金融商品の公正価値の変動', PL_FINANCE_INCOME: '金融収益',
  BS_GOODWILL: 'のれん', PL_GOODWILL_AMORT: 'のれん償却額', BS_DEFERRED_INCOME: '繰延収益（政府補助金）', BS_ARO: '資産除去債務',
  BS_INTANGIBLE: '無形資産（開発資産）', PL_RND: '研究開発費', BS_BORROWINGS: '借入金', PL_FINANCE_COST: '金融費用',
}
