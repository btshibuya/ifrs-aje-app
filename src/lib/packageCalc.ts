// 収集パッケージから明細を作り、明細ごとに計算する論点（有給休暇・減価償却以外の15論点）
//
// 取込：確認済・提出済の収集パッケージの行（明細の様式）や項目（1件の様式）を明細にする。入力の内容はCSVにして元資料として保存する
// 計算：明細ごとに調整額を出し、共通の計算（calc/adjustments）で期首・当期の変動・期末・税効果と仕訳にする
// 計算の考え方は、収集パッケージの仕訳のプレビュー（preview.ts）と同じ

import { calcAdjustments, type AdjConfig, type AdjItem, type AdjStep } from '../calc/adjustments'
import { pct } from '../calc/common'
import type { CalcResult, DetailItem, PriorBalance } from '../calc/types'
import { computeEir } from './eir'
import type { FieldDef } from './issues'
import { formByCode, type PkgField } from './materials'
import type { EntryData } from './package'
import { FALLBACK_ACCOUNT_NAMES } from './preview'

export interface PkgCalcCtx {
  asOf: string
  periodStart: string
  params: Record<string, unknown> // この論点の方針の前提値
}

export interface ItemRowData { itemKey: string; data: Record<string, unknown> }

export interface PackageCalcDef extends AdjConfig {
  issueCode: string
  formCode: string
  otherForms?: string[] // ほかの様式の値も使う（退職給付②は数理計算結果の期末債務）
  pair: [string, string] // 明細がないとき（該当なし）の借方・貸方の組
  fields: FieldDef[] // 明細チェックで見せる項目
  toRows: (data: EntryData, other: (formCode: string) => EntryData | undefined) => ItemRowData[]
  itemize: (item: DetailItem, ctx: PkgCalcCtx) => Omit<AdjItem, 'itemKey' | 'detailItemId'>
  params?: (p: Record<string, unknown>) => { label: string; value: string }[] // 計算に使う方針の前提値（表示用）
  requires?: (p: Record<string, unknown>) => string | null // 足りない方針の前提値
}

// ---------------------------------------------------------------------------
// 共通の部品
// ---------------------------------------------------------------------------

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const monthIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1
const monthsBetween = (from: string, to: string) => monthIdx(to) - monthIdx(from)
const NONE_KEY = '該当なし'

const fieldType = (t: PkgField['type']): FieldDef['type'] => (t === 'date' ? 'date' : t === 'text' || t === 'select' ? 'text' : 'number')
const toField = (f: PkgField, required = !!f.required): FieldDef => ({ key: f.key, label: f.label, type: fieldType(f.type), required })

// 明細の様式：列をそのまま明細の項目にする
function tableFields(formCode: string): FieldDef[] {
  return formByCode(formCode)?.table?.columns.map((c) => toField(c)) ?? []
}

// 1件の様式：明細の名前の列と、使う項目
function singleFields(formCode: string, keys: string[], extra: FieldDef[] = []): FieldDef[] {
  const form = formByCode(formCode)
  return [
    { key: 'item', label: '明細', type: 'text', required: true },
    ...keys.map((k) => form?.fields?.find((f) => f.key === k)).filter((f): f is PkgField => !!f).map((f) => toField(f)),
    ...extra,
  ]
}

// 明細の様式の行を明細にする。番号は「前期と突き合わせる列」（銘柄名など）。空や重複には番号を足す
function fromTable(formCode: string) {
  return (data: EntryData): ItemRowData[] => {
    if (data.none) return [{ itemKey: NONE_KEY, data: { none: true } }]
    const key = formByCode(formCode)?.table?.keyColumn ?? ''
    const used = new Set<string>()
    return (data.rows ?? [])
      .filter((r) => Object.values(r).some((v) => v !== null && v !== undefined && String(v).trim() !== ''))
      .map((r, i) => {
        const base = str(r[key]).trim() || `${i + 1}行目`
        let itemKey = base
        for (let n = 2; used.has(itemKey); n++) itemKey = `${base}（${n}）`
        used.add(itemKey)
        return { itemKey, data: { ...r } }
      })
  }
}

// 1件の様式：入力した項目を、名前を付けた1件の明細にする
function single(itemKey: string, keys: string[]) {
  return (data: EntryData): ItemRowData[] => {
    const f = data.fields ?? {}
    return [{ itemKey, data: { item: itemKey, ...Object.fromEntries(keys.map((k) => [k, f[k] ?? null])) } }]
  }
}

const input = (label: string, value: number | null, unit = ''): AdjStep => ({ label, formula: `収集パッケージの入力${unit}`, value })
const noneItem = (pair: [string, string]) => ({ name: NONE_KEY, dr: pair[0], cr: pair[1], amount: 0, steps: [{ label: NONE_KEY, formula: '収集パッケージで「該当なし」', value: 0 }] })

// ---------------------------------------------------------------------------
// 論点ごとの定義
// ---------------------------------------------------------------------------

// 予想信用損失の区分（様式の項目と、明細の名前）
const ECL_BUCKETS: [string, string][] = [
  ['not_due', '期日前'], ['past_30', '30日以内'], ['past_90', '31〜90日'], ['past_180', '91〜180日'], ['past_over', '181日以上'], ['credit_impaired', '破産・更生など'],
]

const DEFS: PackageCalcDef[] = [
  {
    issueCode: 'LEVY', formCode: 'LEVY', title: '固定資産税（IFRIC21）', mode: 'balance', carry: 'reversing',
    mainCategory: 'LEVY_PROPERTY_TAX', taxCategory: 'LEVY_PROPERTY_TAX_TAX', taxOn: 'PL', pair: ['PL_TAXES', 'BS_ACCRUED_LEVY'],
    fields: singleFields('LEVY', ['property_tax_annual', 'property_tax_unpaid']),
    toRows: single('固定資産税', ['property_tax_annual', 'property_tax_unpaid']),
    itemize: (it) => {
      const annual = num(it.data.property_tax_annual)
      const unpaid = num(it.data.property_tax_unpaid)
      return {
        name: '固定資産税', dr: 'PL_TAXES', cr: 'BS_ACCRUED_LEVY', amount: unpaid, jgaap: 0, ifrs: unpaid ?? 0,
        steps: [
          input('年税額', annual),
          input('期末時点の未納付額', unpaid),
          { label: '日本基準の未払額', formula: '納付時に費用処理しているため0', value: 0 },
          { label: 'IFRSの未払賦課金', formula: '賦課期日（1月1日）に1年分を負債にし、納付した分を減らす＝期末の未納付額', value: unpaid },
        ],
      }
    },
  },
  {
    issueCode: 'RETIREMENT_1', formCode: 'RETIREMENT_ACTUARIAL', title: '数理計算上の差異の即時認識', mode: 'flow', carry: 'cumulative',
    mainCategory: 'RET1_MAIN', taxCategory: 'RET1_TAX', taxOn: 'OCI', taxCounter: 'OCI_REMEASUREMENT', pair: ['OCI_REMEASUREMENT', 'BS_RETIREMENT_LIAB'],
    fields: singleFields('RETIREMENT_ACTUARIAL', ['dbo_open', 'service_cost', 'interest_cost', 'actuarial_loss', 'benefits_paid', 'dbo_close']),
    toRows: single('確定給付制度', ['dbo_open', 'service_cost', 'interest_cost', 'actuarial_loss', 'benefits_paid', 'dbo_close']),
    itemize: (it) => {
      const [open, sc, ic, al, bp, close] = ['dbo_open', 'service_cost', 'interest_cost', 'actuarial_loss', 'benefits_paid', 'dbo_close'].map((k) => num(it.data[k]))
      const gap = [open, sc, ic, al, bp, close].every((x) => x !== null) ? open! + sc! + ic! + al! - bp! - close! : null
      return {
        name: '確定給付制度', dr: 'OCI_REMEASUREMENT', cr: 'BS_RETIREMENT_LIAB', amount: al,
        steps: [
          input('期首の退職給付債務', open), input('勤務費用', sc), input('利息費用', ic), input('支払額', bp), input('期末の退職給付債務', close),
          { label: '期首から期末へのつながりの差', formula: '期首 ＋ 勤務費用 ＋ 利息費用 ＋ 数理計算上の差異 − 支払額 − 期末（0になるはず）', value: gap },
          { label: '数理計算上の差異の発生額', formula: '収集パッケージの入力（損失はプラス）。日本基準では数年で費用処理する差異を、IFRSでは発生時に全額OCIに計上する', value: al },
        ],
      }
    },
  },
  {
    issueCode: 'RETIREMENT_2', formCode: 'RETIREMENT_ASSUMPTIONS', otherForms: ['RETIREMENT_ACTUARIAL'], title: '割引率の違いによる退職給付債務の調整',
    mode: 'balance', carry: 'cumulative', mainCategory: 'RET2_MAIN', pair: ['OCI_REMEASUREMENT', 'BS_RETIREMENT_LIAB'],
    fields: singleFields('RETIREMENT_ASSUMPTIONS', ['discount_rate', 'duration', 'attribution'], [{ key: 'dbo_close', label: '期末の退職給付債務（数理計算結果）', type: 'number', required: true }]),
    toRows: (data, other) => [{
      itemKey: '確定給付制度',
      data: {
        item: '確定給付制度', discount_rate: data.fields?.discount_rate ?? null, duration: data.fields?.duration ?? null,
        attribution: data.fields?.attribution ?? null, dbo_close: other('RETIREMENT_ACTUARIAL')?.fields?.dbo_close ?? null,
      },
    }],
    params: (p) => [{ label: 'IFRSの割引率', value: num(p.discount_rate) === null ? '—' : pct(num(p.discount_rate)!) }],
    requires: (p) => (num(p.discount_rate) === null ? '会社別方針に、IFRSの割引率（退職給付②の discount_rate）が設定されていません' : null),
    itemize: (it, ctx) => {
      const jr = num(it.data.discount_rate)
      const dur = num(it.data.duration)
      const dbo = num(it.data.dbo_close)
      const ir = num(ctx.params.discount_rate)
      const amount = jr === null || dur === null || dbo === null || ir === null ? null : dbo * dur * (jr / 100 - ir)
      return {
        name: '確定給付制度', dr: 'OCI_REMEASUREMENT', cr: 'BS_RETIREMENT_LIAB', amount,
        steps: [
          { label: '期末の退職給付債務', formula: '収集パッケージ「退職給付の数理計算結果」の入力', value: dbo },
          input('デュレーション（年）', dur),
          { label: '日本基準の割引率（%）', formula: '収集パッケージの入力', value: jr },
          { label: 'IFRSの割引率（%）', formula: '会社別方針（優良社債の利回り）', value: ir === null ? null : ir * 100 },
          { label: '割引率の違いによる債務の調整', formula: `債務 × デュレーション × (日本基準 ${jr ?? '—'}% − IFRS ${ir === null ? '—' : (ir * 100).toFixed(2)}%)。債務が増える向きをプラス（近似。正式には年金数理人の再計算）${str(it.data.attribution) === '期間定額基準' ? '。期間帰属（期間定額基準）の調整は含めていない' : ''}`, value: amount },
        ],
      }
    },
  },
  {
    issueCode: 'EQUITY_INSTRUMENT', formCode: 'EQUITY_HOLDINGS', title: '株式の公正価値評価', mode: 'balance', carry: 'cumulative',
    mainCategory: 'EQ_MAIN', pair: ['BS_INVESTMENTS', 'OCI_FVOCI'],
    fields: tableFields('EQUITY_HOLDINGS'), toRows: fromTable('EQUITY_HOLDINGS'),
    itemize: (it) => {
      if (it.data.none) return noneItem(['BS_INVESTMENTS', 'OCI_FVOCI'])
      const cost = num(it.data.cost)
      const fv = num(it.data.fair_value)
      const trading = it.data.classification === '売買目的'
      const unlisted = it.data.listed === '非上場'
      const diff = cost === null || fv === null ? null : fv - cost
      const [dr, cr, amount, formula] = trading
        ? ['OCI_FVOCI', 'PL_FINANCE_INCOME', diff, '売買目的（FVTPL）：日本基準で純資産に入れている評価差額を、損益に振り替える']
        : unlisted
          ? ['BS_INVESTMENTS', 'OCI_FVOCI', diff, '非上場の政策保有（FVOCI）：日本基準は取得原価のまま。IFRSは時価にし、差額をOCIに計上する']
          : ['BS_INVESTMENTS', 'OCI_FVOCI', diff === null ? null : 0, '上場の政策保有：日本基準でも時価で評価し差額を純資産に入れているため、調整なし']
      return {
        name: str(it.data.name), dr, cr, amount, jgaap: unlisted ? cost ?? 0 : fv ?? 0, ifrs: fv ?? 0,
        steps: [input('取得原価', cost), input('期末の時価', fv), { label: '評価差額', formula: '時価 − 取得原価', value: diff }, { label: '調整額', formula, value: amount }],
      }
    },
  },
  {
    issueCode: 'GOODWILL', formCode: 'GOODWILL', title: 'のれん償却の取消し', mode: 'flow', carry: 'cumulative',
    mainCategory: 'GOODWILL_MAIN', pair: ['BS_GOODWILL', 'PL_GOODWILL_AMORT'],
    fields: singleFields('GOODWILL', ['goodwill_close', 'amortization', 'impairment_indicator']),
    toRows: single('のれん', ['goodwill_close', 'amortization', 'impairment_indicator']),
    itemize: (it) => {
      const am = num(it.data.amortization)
      return {
        name: 'のれん', dr: 'BS_GOODWILL', cr: 'PL_GOODWILL_AMORT', amount: am, jgaap: num(it.data.goodwill_close) ?? 0,
        steps: [
          input('のれんの期末残高（日本基準）', num(it.data.goodwill_close)),
          { label: '減損の兆候', formula: `収集パッケージの入力：${str(it.data.impairment_indicator) || '—'}${it.data.impairment_indicator && it.data.impairment_indicator !== 'なし' ? '（IFRSでは毎期の減損テストが必要。この計算には含めていない）' : ''}`, value: null },
          { label: '当期ののれん償却額', formula: '収集パッケージの入力（期首からの累計）。IFRSでは償却しないため取り消す。のれんには税効果を認識しない', value: am },
        ],
      }
    },
  },
  {
    issueCode: 'COMPRESSION', formCode: 'COMPRESSION_LIST', title: '圧縮記帳の取消し', mode: 'balance', carry: 'cumulative',
    mainCategory: 'COMP_MAIN', pair: ['BS_PPE_ADJ', 'BS_DEFERRED_INCOME'],
    fields: tableFields('COMPRESSION_LIST'), toRows: fromTable('COMPRESSION_LIST'),
    itemize: (it) => {
      if (it.data.none) return noneItem(['BS_PPE_ADJ', 'BS_DEFERRED_INCOME'])
      const amount = num(it.data.amount)
      const direct = it.data.method === '直接減額'
      return {
        name: str(it.data.asset_name), dr: 'BS_PPE_ADJ', cr: 'BS_DEFERRED_INCOME', amount: direct ? amount : amount === null ? null : 0,
        steps: [
          input('圧縮額', amount),
          { label: '取り消す額', formula: direct ? '直接減額：取得価額から差し引いた額を戻し、補助金は繰延収益にする（当期の償却額の調整は減価償却で行う）' : '積立金方式：資産の額を変えていないため調整なし', value: direct ? amount : 0 },
        ],
      }
    },
  },
  {
    issueCode: 'ARO', formCode: 'ARO_LIST', title: '資産除去債務の割引率の見直し', mode: 'balance', carry: 'cumulative',
    mainCategory: 'ARO_MAIN', pair: ['BS_PPE_ADJ', 'BS_ARO'],
    fields: tableFields('ARO_LIST'), toRows: fromTable('ARO_LIST'),
    params: (p) => [{ label: 'IFRSの割引率（資産除去債務）', value: num(p.discount_rate) === null ? '—' : pct(num(p.discount_rate)!) }],
    requires: (p) => (num(p.discount_rate) === null ? '会社別方針に、IFRSの割引率（資産除去債務の discount_rate）が設定されていません' : null),
    itemize: (it, ctx) => {
      if (it.data.none) return noneItem(['BS_PPE_ADJ', 'BS_ARO'])
      const est = num(it.data.estimate)
      const bal = num(it.data.balance)
      const r0 = num(ctx.params.discount_rate)
      const settle = isDate(it.data.settle_date) ? it.data.settle_date : null
      const years = settle ? Math.max(monthsBetween(ctx.asOf, settle) / 12, 0) : null
      const pv = est === null || years === null || r0 === null ? null : Math.round(est / (1 + r0) ** years)
      return {
        name: str(it.data.site), dr: 'BS_PPE_ADJ', cr: 'BS_ARO', amount: pv === null || bal === null ? null : pv - bal, jgaap: bal ?? 0, ifrs: pv ?? 0,
        steps: [
          input('将来の支出見込額', est),
          { label: '履行までの年数（年）', formula: `基準日 ${ctx.asOf} から履行予定日 ${settle ?? '—'} まで（月数 ÷ 12）`, value: years },
          { label: 'IFRSの割引率（%）', formula: '会社別方針', value: r0 === null ? null : r0 * 100 },
          { label: 'IFRSの資産除去債務', formula: `見込額 ÷ (1 + ${r0 === null ? '—' : pct(r0)})^年数`, value: pv },
          input('日本基準の計上額', bal),
          { label: '調整額', formula: 'IFRSの債務 − 日本基準の計上額（債務が増える向きをプラス。相手は有形固定資産）', value: pv === null || bal === null ? null : pv - bal },
        ],
      }
    },
  },
  {
    issueCode: 'SHARE_BASED', formCode: 'SO_GRANTS', title: '株式報酬：失効見込みの反映', mode: 'flow', carry: 'cumulative',
    mainCategory: 'SBP_MAIN', pair: ['BS_SHARE_OPTIONS', 'PL_SHARE_COMP'],
    fields: tableFields('SO_GRANTS'), toRows: fromTable('SO_GRANTS'),
    params: (p) => [{ label: '失効見込率', value: pct(num(p.forfeiture_rate) ?? 0.05) + (num(p.forfeiture_rate) === null ? '（方針に設定がないため既定値）' : '') }],
    itemize: (it, ctx) => {
      if (it.data.none) return noneItem(['BS_SHARE_OPTIONS', 'PL_SHARE_COMP'])
      const units = num(it.data.units)
      const fv = num(it.data.fair_value)
      const g = isDate(it.data.grant_date) ? it.data.grant_date : null
      const v = isDate(it.data.vesting_date) ? it.data.vesting_date : null
      const rate = num(ctx.params.forfeiture_rate) ?? 0.05
      const total = g && v ? monthsBetween(g, v) : null
      // 当期（期首から基準日まで）のうち、権利確定期間に入っている月数
      const overlap = g && v ? Math.max(0, Math.min(monthIdx(ctx.asOf) + 1, monthIdx(v)) - Math.max(monthIdx(ctx.periodStart), monthIdx(g))) : null
      const cost = units === null || fv === null || !total || overlap === null ? null : (units * fv * overlap) / total
      return {
        name: str(it.data.series), dr: 'BS_SHARE_OPTIONS', cr: 'PL_SHARE_COMP', amount: cost === null ? null : cost * rate,
        steps: [
          input('期末の残数（個）', units), input('1個あたりの公正価値', fv),
          { label: '権利確定期間の月数', formula: `付与日 ${g ?? '—'} から権利確定日 ${v ?? '—'} まで`, value: total },
          { label: '当期の費用計上の月数', formula: '期首から基準日までのうち、権利確定期間に入る月数', value: overlap },
          { label: '当期の株式報酬費用（日本基準）', formula: '残数 × 公正価値 × 当期の月数 ÷ 権利確定期間の月数', value: cost },
          { label: '失効見込みによる費用の減額', formula: `当期の費用 × 失効見込率 ${pct(rate)}（日本基準は失効が確定した時に戻し入れ、IFRSは見込みで減らす）`, value: cost === null ? null : cost * rate },
        ],
      }
    },
  },
  {
    issueCode: 'EIR', formCode: 'LOANS', title: '償却原価（実効金利法）', mode: 'balance', carry: 'cumulative',
    mainCategory: 'EIR_MAIN', taxCategory: 'EIR_TAX', taxOn: 'PL', pair: ['BS_BORROWINGS', 'PL_FINANCE_COST'],
    fields: tableFields('LOANS'), toRows: fromTable('LOANS'),
    itemize: (it, ctx) => {
      if (it.data.none) return noneItem(['BS_BORROWINGS', 'PL_FINANCE_COST'])
      const kind = str(it.data.kind) || '借入金'
      const [dr, cr] = kind === '貸付金' ? ['PL_FINANCE_INCOME', 'BS_LOANS_RECEIVABLE'] : [kind === '社債' ? 'BS_BONDS' : 'BS_BORROWINGS', 'PL_FINANCE_COST']
      const principal = num(it.data.principal)
      const coupon = num(it.data.coupon_rate)
      const fee = num(it.data.fee) ?? 0
      const market = num(it.data.market_rate)
      const b = isDate(it.data.borrow_date) ? it.data.borrow_date : null
      const m = isDate(it.data.maturity) ? it.data.maturity : null
      const base = { name: str(it.data.lender), dr, cr }
      if (b && b > ctx.asOf) return { ...base, amount: 0, steps: [{ label: '対象外', formula: `実行日 ${b} が基準日より後のため0`, value: 0 }] }
      const e = principal !== null && coupon !== null && b && m ? computeEir({ start: b, maturity: m, principal, couponRate: coupon / 100, fee, marketRate: market === null ? null : market / 100 }) : null
      if (!e || principal === null) return { ...base, amount: null, steps: [input('元本', principal)] }
      const matured = ctx.asOf >= m!
      const ac = matured ? 0 : Math.round(e.amortizedCost(ctx.asOf))
      const jg = matured ? 0 : principal
      const diff = ac - jg
      // 借入金・社債は負債が小さくなる（費用を後に回す）向き、貸付金は資産が小さくなる（収益を後に回す）向き
      const amount = -diff
      return {
        ...base, amount, jgaap: jg, ifrs: ac,
        steps: [
          input('元本', principal), { label: '契約上の金利（%）', formula: '収集パッケージの入力', value: coupon },
          input('手数料・発行費用', fee),
          ...(market !== null ? [{ label: '市場金利（%）', formula: '収集パッケージの入力（契約の金利が低いとき）', value: market }] : []),
          { label: '当初の帳簿価額（IFRS）', formula: `${market !== null && market > (coupon ?? 0) ? '市場金利で割り引いた額' : '元本'} − 手数料・発行費用`, value: Math.round(e.initial) },
          { label: '実効金利（年率%）', formula: '将来の支払い（利息と元本）を割り引いた額が当初の帳簿価額と一致する利率（月単位で計算し年換算）', value: Math.round(e.annualRate * 100000) / 1000 },
          { label: 'IFRSの期末の償却原価', formula: matured ? '満期を過ぎているため0' : `残りの支払いを実効金利で割り引いた額（基準日 ${ctx.asOf}）`, value: ac },
          { label: '日本基準の帳簿価額', formula: matured ? '満期を過ぎているため0' : '元本のまま（手数料は支払時・受取時の損益）', value: jg },
          { label: '調整額', formula: `−(IFRSの償却原価 − 日本基準の帳簿価額)。${kind === '貸付金' ? '貸付金が小さくなる＝収益を後の期に回す' : '負債が小さくなる＝費用を後の期に回す'}`, value: amount },
        ],
      }
    },
  },
  {
    issueCode: 'DEVELOPMENT', formCode: 'DEV_PROJECTS', title: '開発費の資産計上', mode: 'flow', carry: 'cumulative',
    mainCategory: 'DEV_MAIN', taxCategory: 'DEV_TAX', taxOn: 'PL', pair: ['BS_INTANGIBLE', 'PL_RND'],
    fields: tableFields('DEV_PROJECTS'), toRows: fromTable('DEV_PROJECTS'),
    itemize: (it) => {
      if (it.data.none) return noneItem(['BS_INTANGIBLE', 'PL_RND'])
      const spend = num(it.data.spend)
      const ok = it.data.criteria === '満たす'
      return {
        name: str(it.data.project), dr: 'BS_INTANGIBLE', cr: 'PL_RND', amount: ok ? spend : spend === null ? null : 0,
        steps: [
          input('当期の支出額', spend),
          { label: '資産に計上する額', formula: ok ? '資産計上の要件を「満たす」ため、当期の支出額を資産にする（期首からの累計）' : `資産計上の要件：${str(it.data.criteria) || '—'}のため0${it.data.criteria === '判断中' ? '（親会社と相談して決める）' : ''}`, value: ok ? spend : 0 },
        ],
      }
    },
  },
  {
    issueCode: 'TAX_EFFECT', formCode: 'TAX', title: '回収可能性の見直し（繰延税金資産の追加計上）', mode: 'balance', carry: 'cumulative',
    mainCategory: 'TAX_RECOVERABILITY', pair: ['BS_DTA', 'PL_DEFERRED_TAX'],
    fields: singleFields('TAX', ['company_class', 'deductible_td', 'valuation_allowance']),
    toRows: single('税効果', ['company_class', 'deductible_td', 'valuation_allowance']),
    params: (p) => [{ label: '評価性引当額のうちIFRSで認める割合', value: pct(num(p.recognizable_ratio) ?? 0.25) + (num(p.recognizable_ratio) === null ? '（方針に設定がないため既定値）' : '') }],
    itemize: (it, ctx) => {
      const va = num(it.data.valuation_allowance)
      const ratio = num(ctx.params.recognizable_ratio) ?? 0.25
      return {
        name: '税効果', dr: 'BS_DTA', cr: 'PL_DEFERRED_TAX', amount: va === null ? null : va * ratio,
        steps: [
          { label: '回収可能性の会社分類', formula: `収集パッケージの入力：${str(it.data.company_class) || '—'}`, value: null },
          input('将来減算一時差異の合計', num(it.data.deductible_td)),
          input('評価性引当額', va),
          { label: '追加で認める繰延税金資産', formula: `評価性引当額 × ${pct(ratio)}（IFRSは将来の課税所得の見込みで判断する）`, value: va === null ? null : va * ratio },
        ],
      }
    },
  },
  {
    issueCode: 'ECL', formCode: 'RECEIVABLES_AGING', title: '予想信用損失', mode: 'balance', carry: 'reversing',
    mainCategory: 'ECL_MAIN', taxCategory: 'ECL_TAX', taxOn: 'PL', pair: ['PL_BAD_DEBT', 'BS_ALLOWANCE'],
    fields: [
      { key: 'item', label: '区分', type: 'text', required: true },
      { key: 'amount', label: '金額', type: 'number', required: true },
    ],
    toRows: (data) => {
      const f = data.fields ?? {}
      return [...ECL_BUCKETS.map(([key, label]) => ({ itemKey: label, data: { item: label, bucket: key, amount: f[key] ?? null } })),
        { itemKey: '日本基準の貸倒引当金', data: { item: '日本基準の貸倒引当金', bucket: 'jgaap_allowance', amount: f.jgaap_allowance ?? null } }]
    },
    params: (p) => {
      const rates = p.loss_rates as number[] | undefined
      return [
        { label: '延滞日数ごとの損失率', value: Array.isArray(rates) ? ECL_BUCKETS.slice(0, 5).map(([, l], i) => `${l} ${pct(rates[i])}`).join('・') : '—' },
        { label: '破産・更生などの損失率', value: pct(num(p.credit_impaired_rate) ?? 1) },
      ]
    },
    requires: (p) => (!Array.isArray(p.loss_rates) || (p.loss_rates as unknown[]).length < 5 ? '会社別方針に、延滞日数ごとの損失率（予想信用損失の loss_rates）が設定されていません' : null),
    itemize: (it, ctx) => {
      const amount = num(it.data.amount)
      if (it.data.bucket === 'jgaap_allowance') {
        return {
          name: '日本基準の貸倒引当金', dr: 'PL_BAD_DEBT', cr: 'BS_ALLOWANCE', amount: amount === null ? null : -amount, jgaap: amount ?? 0,
          steps: [input('日本基準の貸倒引当金', amount), { label: '差し引く額', formula: '日本基準の引当金を取り消す（マイナス）', value: amount === null ? null : -amount }],
        }
      }
      const i = ECL_BUCKETS.findIndex(([k]) => k === it.data.bucket)
      const rates = ctx.params.loss_rates as number[]
      const rate = i === 5 ? num(ctx.params.credit_impaired_rate) ?? 1 : Number(rates?.[i])
      const ecl = amount === null || !Number.isFinite(rate) ? null : amount * rate
      return {
        name: ECL_BUCKETS[i]?.[1] ?? str(it.data.item), dr: 'PL_BAD_DEBT', cr: 'BS_ALLOWANCE', amount: ecl, ifrs: ecl ?? 0,
        steps: [input('期末の残高', amount), { label: '損失率（%）', formula: '会社別方針（引当マトリクス）', value: Number.isFinite(rate) ? rate * 100 : null }, { label: '予想信用損失', formula: `残高 × 損失率 ${Number.isFinite(rate) ? pct(rate) : '—'}`, value: ecl }],
      }
    },
  },
  {
    issueCode: 'IMPAIRMENT', formCode: 'IMPAIRMENT_TEST', title: 'IFRSだけで必要な減損損失', mode: 'balance', carry: 'cumulative',
    mainCategory: 'IMP_MAIN', taxCategory: 'IMP_TAX', taxOn: 'PL', pair: ['PL_IMPAIRMENT', 'BS_PPE_ADJ'],
    fields: tableFields('IMPAIRMENT_TEST'), toRows: fromTable('IMPAIRMENT_TEST'),
    itemize: (it) => {
      if (it.data.none) return noneItem(['PL_IMPAIRMENT', 'BS_PPE_ADJ'])
      const bv = num(it.data.book_value)
      const ucf = num(it.data.undiscounted_cf)
      const rec = num(it.data.recoverable)
      const ok = bv !== null && ucf !== null && rec !== null
      // 日本基準は割引前CFが帳簿価額を下回るときだけ減損する。上回っていて回収可能価額が下回る分が、IFRSだけの減損
      const jgaapImpairs = ok && ucf! < bv!
      const ifrsOnly = ok && !jgaapImpairs && rec! < bv!
      const amount = !ok ? null : ifrsOnly ? bv! - rec! : 0
      return {
        name: str(it.data.group), dr: 'PL_IMPAIRMENT', cr: 'BS_PPE_ADJ', amount, jgaap: bv ?? 0, ifrs: ifrsOnly ? rec! : bv ?? 0,
        steps: [
          input('帳簿価額', bv), input('割引前の将来キャッシュ・フロー', ucf), input('回収可能価額', rec),
          { label: '日本基準の判定', formula: !ok ? '入力が足りない' : jgaapImpairs ? '割引前CFが帳簿価額を下回る：日本基準でも減損する（差はないものとする）' : '割引前CFが帳簿価額以上：日本基準では減損しない', value: null },
          { label: 'IFRSだけの減損損失', formula: ifrsOnly ? '帳簿価額 − 回収可能価額（減損後の減価償却の違いは含めていない）' : 'IFRSだけの減損はない', value: amount },
        ],
      }
    },
  },
  {
    issueCode: 'PROVISION', formCode: 'PROVISIONS_LIST', title: 'IFRSで計上できない引当金の取消し', mode: 'balance', carry: 'cumulative',
    mainCategory: 'PROV_MAIN', taxCategory: 'PROV_TAX', taxOn: 'PL', pair: ['BS_PROVISIONS', 'PL_PROVISION_EXP'],
    fields: tableFields('PROVISIONS_LIST'), toRows: fromTable('PROVISIONS_LIST'),
    itemize: (it) => {
      if (it.data.none) return noneItem(['BS_PROVISIONS', 'PL_PROVISION_EXP'])
      const bal = num(it.data.balance)
      const cancel = it.data.ifrs === '計上できない'
      return {
        name: str(it.data.name), dr: 'BS_PROVISIONS', cr: 'PL_PROVISION_EXP', amount: cancel ? bal : bal === null ? null : 0, jgaap: bal ?? 0, ifrs: cancel ? 0 : bal ?? 0,
        steps: [
          input('期末残高', bal),
          { label: '取り消す額', formula: cancel ? 'IFRSでは「いまの義務」がないため計上できない：期末残高を取り消す' : `IFRSで計上できるか：${str(it.data.ifrs) || '—'}のため調整なし${it.data.ifrs === '判断中' ? '（親会社と相談して決める）' : ''}`, value: cancel ? bal : 0 },
        ],
      }
    },
  },
  {
    issueCode: 'LT_BENEFITS', formCode: 'LT_BENEFITS', title: 'その他の長期従業員給付の負債計上', mode: 'balance', carry: 'cumulative',
    mainCategory: 'LTB_MAIN', taxCategory: 'LTB_TAX', taxOn: 'PL', pair: ['PL_SALARY', 'BS_LT_BENEFITS'],
    fields: tableFields('LT_BENEFITS'), toRows: fromTable('LT_BENEFITS'),
    itemize: (it) => {
      if (it.data.none) return noneItem(['PL_SALARY', 'BS_LT_BENEFITS'])
      const pay = num(it.data.future_payment)
      const avg = num(it.data.avg_years)
      const req = num(it.data.req_years)
      const jg = num(it.data.jgaap_balance) ?? 0
      const obligation = pay === null || avg === null || !req ? null : Math.round(pay * Math.min(1, avg / req))
      return {
        name: str(it.data.plan), dr: 'PL_SALARY', cr: 'BS_LT_BENEFITS', amount: obligation === null ? null : obligation - jg, jgaap: jg, ifrs: obligation ?? 0,
        steps: [
          input('支給見込額の合計', pay), input('平均の勤続年数（年）', avg), input('支給までの勤続年数（年）', req),
          { label: 'IFRSの負債', formula: '支給見込額 × 平均の勤続年数 ÷ 支給までの勤続年数（これまでの勤務の分。簡易のため割り引かない）', value: obligation },
          input('日本基準の計上額', jg),
          { label: '調整額', formula: 'IFRSの負債 − 日本基準の計上額', value: obligation === null ? null : obligation - jg },
        ],
      }
    },
  },
]

export const PACKAGE_CALCS: Record<string, PackageCalcDef> = Object.fromEntries(DEFS.map((d) => [d.issueCode, d]))

// 計算まで実装している論点（有給休暇・減価償却と、収集パッケージから明細を作る論点）
export const hasCalc = (issueCode: string) => issueCode === 'PAID_LEAVE' || issueCode === 'DEPRECIATION' || issueCode in PACKAGE_CALCS

export const accountName = (code: string) => FALLBACK_ACCOUNT_NAMES[code] ?? code

// 収集パッケージの入力を、元資料として保存するCSVにする（明細の番号＋様式の項目）
export function packageCsv(def: PackageCalcDef, rows: ItemRowData[]) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = ['明細', ...def.fields.filter((f) => f.key !== 'item').map((f) => f.label)]
  const body = rows.map((r) => [r.itemKey, ...def.fields.filter((f) => f.key !== 'item').map((f) => (r.data.none ? '' : r.data[f.key]))])
  return '﻿' + [head, ...body].map((r) => r.map(esc).join(',')).join('\r\n')
}

// 計算する（DBは使わない）
export function calcPackageIssue(def: PackageCalcDef, x: {
  items: DetailItem[]; asOf: string; periodStart: string; params: Record<string, unknown>; taxRate: number | null; priorBalances: PriorBalance[]
}): CalcResult {
  const ctx: PkgCalcCtx = { asOf: x.asOf, periodStart: x.periodStart, params: x.params }
  const items: AdjItem[] = x.items.map((i) => ({ ...def.itemize(i, ctx), itemKey: i.itemKey, detailItemId: i.id }))
  return calcAdjustments(def, { items, priorBalances: x.priorBalances, taxRate: x.taxRate, accountName })
}

