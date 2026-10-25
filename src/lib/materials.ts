// 論点ごとに担当者が用意する資料と、収集パッケージの様式（入力例・説明・チェック付き）
//
// 資料は2種類
//   system  : 会計システム等から出力したファイルをそのまま使う（試算表、固定資産台帳など）
//   package : 収集パッケージの様式に入力してもらう（会計システムから直接は出ない情報）
//
// 収集パッケージの比較（前期の値を並べて見る）
//   stock（残高・率）  : 前年度末の値と比べる（BS）
//   flow （期間の金額）: 前年同期の値と比べる（PL）
//   どちらも、直前四半期の値も並べる

export type Basis = 'stock' | 'flow'
export type PkgFieldType = 'yen' | 'percent' | 'days' | 'years' | 'count' | 'text' | 'date' | 'select'

export interface PkgField {
  key: string
  label: string
  type: PkgFieldType
  basis?: Basis // 数値のとき、前期のどの時点と比べるか
  required?: boolean
  example: string | number // 入力例（既定で表示する）
  help: string // 何を入れるか（専門用語をかみくだいて）
  where?: string // どの資料のどこを見るか
  options?: string[]
  min?: number
  max?: number
  // 自動計算する項目（入力しない）
  compute?: (v: Record<string, unknown>) => number | null
}

export interface PkgTable {
  keyColumn: string // 行を前期と突き合わせる列（銘柄名など）
  columns: PkgField[]
  example: Record<string, string | number>[]
  emptyLabel: string // 該当がないときのチェックの文言
}

// 入力値どうしの整合チェック（例：期首＋増減＝期末）
export interface CrossCheck {
  label: string
  formula: string
  expected: (v: Record<string, number | null>) => number | null
  actualKey: string
}

export interface PackageForm {
  code: string
  issueCode: string
  title: string
  intro: string
  fields?: PkgField[]
  table?: PkgTable
  checks?: CrossCheck[]
}

export interface Material {
  code: string
  issueCode: string
  name: string
  kind: 'system' | 'package'
  source: string // どこから出す・誰に聞く
  format: string // ファイル形式・提出方法
  prepare: string // 担当者が用意するときの注意
  sourceKind?: string // system：取込の種類（source_files.source_kind）
  importable?: boolean // system：作業画面で取り込んで計算まで進める
  formCode?: string // package：様式
}

export const KIND_LABELS: Record<Material['kind'], string> = {
  system: '会計システム等から出力',
  package: '収集パッケージに入力',
}

const n = (v: Record<string, unknown>, k: string) => {
  const x = v[k]
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

export const PACKAGE_FORMS: PackageForm[] = [
  {
    code: 'LEAVE_USAGE',
    issueCode: 'PAID_LEAVE',
    title: '有給休暇の消化実績',
    intro: '有給休暇引当金の「消化見込率」を見直すために使います。人事・給与システムの集計表から転記してください。',
    fields: [
      { key: 'granted_days', label: '前期に付与した日数の合計', type: 'days', basis: 'flow', required: true, example: 2400, help: '前期中に全従業員へ新しく付与した有給休暇の日数の合計です（繰越分は含めません）。', where: '人事・給与システム「有給休暇 付与・取得集計表」の付与日数' },
      { key: 'used_days', label: '前期に消化した日数の合計', type: 'days', basis: 'flow', required: true, example: 1440, help: '前期中に全従業員が実際に取得した有給休暇の日数の合計です。', where: '同じ集計表の取得日数' },
      { key: 'usage_rate', label: '消化率（自動計算）', type: 'percent', basis: 'flow', example: 60, help: '消化した日数 ÷ 付与した日数。入力は不要です。', compute: (v) => { const g = n(v, 'granted_days'); const u = n(v, 'used_days'); return g && u !== null ? Math.round((u / g) * 1000) / 10 : null } },
      { key: 'employees', label: '期末の従業員数', type: 'count', basis: 'stock', required: true, example: 120, help: '期末日に在籍している従業員（有給休暇の対象者）の人数です。', where: '人事・給与システムの在籍者数' },
      { key: 'social_insurance_rate', label: '法定福利費率', type: 'percent', basis: 'stock', required: true, example: 15, min: 0, max: 30, help: '給与に対する会社負担の社会保険料等の割合です。わからない場合は経理責任者に確認してください。', where: '給与台帳の法定福利費 ÷ 給与総額' },
    ],
  },
  {
    code: 'LEVY',
    issueCode: 'LEVY',
    title: '固定資産税・均等割',
    intro: 'IFRSでは、固定資産税は賦課期日（1月1日）に1年分を負債として計上します。納税通知書の金額を入力してください。',
    fields: [
      { key: 'property_tax_annual', label: '固定資産税の年税額', type: 'yen', basis: 'flow', required: true, example: 3600000, help: '当年度の納税通知書に記載された1年分の税額です（償却資産税を含みます）。', where: '固定資産税の納税通知書「年税額」' },
      { key: 'property_tax_unpaid', label: '期末時点の未納付額', type: 'yen', basis: 'stock', required: true, example: 900000, help: '期末日時点でまだ納付していない固定資産税の額です。全額納付済みなら 0 を入力します。', where: '納付書の控え（第1期〜第4期）' },
      { key: 'per_capita_annual', label: '住民税均等割の年額', type: 'yen', basis: 'flow', required: true, example: 290000, help: '事業所ごとの均等割の合計（1年分）です。', where: '法人住民税の申告書の均等割額' },
    ],
    checks: [
      { label: '未納付額は年税額以下', formula: '未納付額 ≦ 年税額', expected: (v) => (v.property_tax_unpaid !== null && v.property_tax_annual !== null && v.property_tax_unpaid > v.property_tax_annual ? v.property_tax_annual : v.property_tax_unpaid), actualKey: 'property_tax_unpaid' },
    ],
  },
  {
    code: 'RETIREMENT_ACTUARIAL',
    issueCode: 'RETIREMENT_1',
    title: '退職給付の数理計算結果',
    intro: '年金数理人（信託銀行・生命保険会社など）から受け取る「退職給付債務の計算結果報告書」の金額を転記します。報告書のPDFも保管しておいてください。',
    fields: [
      { key: 'dbo_open', label: '期首の退職給付債務', type: 'yen', basis: 'stock', required: true, example: 480000000, help: '前期末時点の退職給付債務（将来払う退職金のうち、これまでの勤務で発生した分の現在価値）です。', where: '計算結果報告書「期首退職給付債務」' },
      { key: 'service_cost', label: '勤務費用', type: 'yen', basis: 'flow', required: true, example: 32000000, help: '当期の勤務で新たに発生した退職給付の額です。', where: '同「勤務費用」' },
      { key: 'interest_cost', label: '利息費用', type: 'yen', basis: 'flow', required: true, example: 5760000, help: '期首の債務に割引率を掛けた、時の経過による増加分です。', where: '同「利息費用」' },
      { key: 'actuarial_loss', label: '数理計算上の差異の発生額', type: 'yen', basis: 'flow', required: true, example: -4200000, help: '見積りと実績のずれや、割引率の変更で生じた差額です。債務が減った場合はマイナスで入力します。', where: '同「数理計算上の差異（当期発生額）」' },
      { key: 'benefits_paid', label: '退職給付の支払額', type: 'yen', basis: 'flow', required: true, example: 28000000, help: '当期に退職者へ支払った退職金・年金の額です（プラスで入力）。', where: '同「給付支払額」' },
      { key: 'dbo_close', label: '期末の退職給付債務', type: 'yen', basis: 'stock', required: true, example: 485560000, help: '期末時点の退職給付債務です。', where: '同「期末退職給付債務」' },
      { key: 'plan_assets_close', label: '期末の年金資産', type: 'yen', basis: 'stock', required: true, example: 310000000, help: '外部に積み立てている年金資産の期末の時価です。退職一時金のみで積立がなければ 0 を入力します。', where: '同「年金資産（期末）」' },
    ],
    checks: [
      {
        label: '期首から期末へのつながり',
        formula: '期首債務 ＋ 勤務費用 ＋ 利息費用 ＋ 数理計算上の差異 − 支払額 ＝ 期末債務',
        expected: (v) => [v.dbo_open, v.service_cost, v.interest_cost, v.actuarial_loss, v.benefits_paid].some((x) => x === null)
          ? null
          : v.dbo_open! + v.service_cost! + v.interest_cost! + v.actuarial_loss! - v.benefits_paid!,
        actualKey: 'dbo_close',
      },
    ],
  },
  {
    code: 'RETIREMENT_ASSUMPTIONS',
    issueCode: 'RETIREMENT_2',
    title: '退職給付の計算前提',
    intro: '割引率と、退職給付を各期に割り振る方法（期間帰属）を確認します。計算結果報告書の「計算基礎」のページを見てください。',
    fields: [
      { key: 'discount_rate', label: '割引率', type: 'percent', basis: 'stock', required: true, example: 1.2, min: 0, max: 5, help: '将来の支払額を現在価値に直すときの利率です。IFRSでは優良社債の利回りを基礎にします。', where: '計算結果報告書「計算基礎：割引率」' },
      { key: 'discount_basis', label: '割引率の決め方', type: 'select', required: true, example: '国債の利回り', options: ['国債の利回り', '優良社債の利回り', 'その他'], help: '日本基準では国債の利回りを使う会社が多いです。IFRSへの調整が必要かの判断に使います。' },
      { key: 'duration', label: '債務の平均残存期間（デュレーション）', type: 'years', basis: 'stock', required: true, example: 11.5, min: 0, max: 40, help: '支払いまでの平均的な期間です。割引率を選ぶ期間の目安になります。', where: '計算結果報告書「デュレーション」' },
      { key: 'attribution', label: '期間帰属の方法', type: 'select', required: true, example: '給付算定式基準', options: ['給付算定式基準', '期間定額基準'], help: 'IFRSでは原則として給付算定式基準です。期間定額基準の場合は調整が必要です。' },
    ],
  },
  {
    code: 'EQUITY_HOLDINGS',
    issueCode: 'EQUITY_INSTRUMENT',
    title: '保有株式の明細',
    intro: '期末に保有しているすべての株式（上場・非上場）を1行ずつ入力します。子会社株式・関連会社株式は除きます。',
    table: {
      keyColumn: 'name',
      emptyLabel: '期末に保有している株式はない',
      columns: [
        { key: 'name', label: '銘柄名', type: 'text', required: true, example: '〇〇銀行', help: '株式の発行会社の名前です。前期と同じ表記にしてください（前期の値と突き合わせます）。' },
        { key: 'listed', label: '上場区分', type: 'select', required: true, example: '上場', options: ['上場', '非上場'], help: '非上場株式も時価で評価するため、評価方法の確認に使います。' },
        { key: 'shares', label: '株数', type: 'count', basis: 'stock', required: true, example: 10000, help: '期末の保有株数です。' },
        { key: 'cost', label: '取得原価', type: 'yen', basis: 'stock', required: true, example: 8500000, help: '帳簿上の取得価額です（日本基準で減損した場合は減損前の額）。', where: '有価証券台帳' },
        { key: 'fair_value', label: '期末の時価', type: 'yen', basis: 'stock', required: true, example: 12300000, help: '上場株式は期末日の終値 × 株数。非上場株式は評価額（不明なら空欄で備考に記載）。', where: '証券会社の残高報告書など' },
        { key: 'classification', label: '保有目的', type: 'select', required: true, example: '政策保有（売る予定なし）', options: ['政策保有（売る予定なし）', '売買目的'], help: '政策保有はFVOCI（評価差額をその他の包括利益に計上）、売買目的はFVTPL（損益に計上）になります。' },
      ],
      example: [
        { name: '〇〇銀行', listed: '上場', shares: 10000, cost: 8500000, fair_value: 12300000, classification: '政策保有（売る予定なし）' },
      ],
    },
  },
  {
    code: 'GOODWILL',
    issueCode: 'GOODWILL',
    title: 'のれん',
    intro: 'IFRSではのれんを償却しません。日本基準で計上した償却額を戻すために使います。のれんがなければ 0 を入力します。',
    fields: [
      { key: 'goodwill_close', label: 'のれんの期末残高', type: 'yen', basis: 'stock', required: true, example: 45000000, help: '日本基準の帳簿上の、期末ののれん残高です。', where: '試算表「のれん」' },
      { key: 'amortization', label: '当期ののれん償却額', type: 'yen', basis: 'flow', required: true, example: 5000000, help: '当期に費用計上したのれん償却額です。', where: '試算表「のれん償却額」' },
      { key: 'impairment_indicator', label: '減損の兆候', type: 'select', required: true, example: 'なし', options: ['なし', 'あり', '判断がつかない'], help: '対象事業の業績悪化、経営環境の大きな変化などがあれば「あり」です。迷ったら「判断がつかない」を選んでください。' },
    ],
  },
  {
    code: 'COMPRESSION_LIST',
    issueCode: 'COMPRESSION',
    title: '圧縮記帳の明細',
    intro: '補助金や保険差益で圧縮記帳をした資産を1行ずつ入力します。IFRSでは圧縮記帳を取り消します。',
    table: {
      keyColumn: 'asset_no',
      emptyLabel: '圧縮記帳をした資産はない',
      columns: [
        { key: 'asset_no', label: '資産番号', type: 'text', required: true, example: 'A012', help: '固定資産台帳の資産番号です。' },
        { key: 'asset_name', label: '資産名', type: 'text', required: true, example: '省エネ空調設備', help: '固定資産台帳の資産名称です。' },
        { key: 'method', label: '圧縮の方法', type: 'select', required: true, example: '直接減額', options: ['直接減額', '積立金'], help: '取得価額から直接差し引いた場合は「直接減額」、剰余金の処分で積み立てた場合は「積立金」です。' },
        { key: 'amount', label: '圧縮額', type: 'yen', basis: 'stock', required: true, example: 5000000, help: '圧縮した金額（補助金の額など）です。' },
        { key: 'subsidy', label: '補助金等の名称', type: 'text', required: false, example: '省エネルギー投資促進補助金', help: '交付決定通知書などに記載の名称です。' },
      ],
      example: [
        { asset_no: 'A012', asset_name: '省エネ空調設備', method: '直接減額', amount: 5000000, subsidy: '省エネルギー投資促進補助金' },
      ],
    },
  },
  {
    code: 'ARO_LIST',
    issueCode: 'ARO',
    title: '資産除去債務の明細',
    intro: '賃借している建物の原状回復義務などを1件ずつ入力します。IFRSでは割引率を毎期見直します。',
    table: {
      keyColumn: 'site',
      emptyLabel: '資産除去債務はない',
      columns: [
        { key: 'site', label: '対象（物件名）', type: 'text', required: true, example: '本社事務所', help: '原状回復の対象になる物件・設備の名前です。' },
        { key: 'estimate', label: '将来の支出見込額', type: 'yen', basis: 'stock', required: true, example: 12000000, help: '除去・原状回復に将来かかる見込みの金額（割引前）です。', where: '見積書・賃貸借契約' },
        { key: 'settle_date', label: '履行予定日', type: 'date', required: true, example: '2035-03-31', help: '退去・除去の予定日です。年月日の形（例 2035-03-31）で入力します。' },
        { key: 'discount_rate', label: '割引率', type: 'percent', basis: 'stock', required: true, example: 0.8, min: 0, max: 10, help: '計上時に使った割引率です。' },
        { key: 'balance', label: '期末の計上額', type: 'yen', basis: 'stock', required: true, example: 11100000, help: '日本基準の帳簿上の資産除去債務の期末残高です。', where: '試算表「資産除去債務」' },
      ],
      example: [
        { site: '本社事務所', estimate: 12000000, settle_date: '2035-03-31', discount_rate: 0.8, balance: 11100000 },
      ],
    },
  },
  {
    code: 'SO_GRANTS',
    issueCode: 'SHARE_BASED',
    title: 'ストックオプション等の付与状況',
    intro: '役員・従業員に付与したストックオプションや譲渡制限付株式を、付与の回ごとに入力します。',
    table: {
      keyColumn: 'series',
      emptyLabel: '株式報酬の付与はない',
      columns: [
        { key: 'series', label: '回次', type: 'text', required: true, example: '第3回新株予約権', help: '発行決議の名称です。' },
        { key: 'grant_date', label: '付与日', type: 'date', required: true, example: '2024-07-01', help: '割当日です。' },
        { key: 'units', label: '期末の残数（個）', type: 'count', basis: 'stock', required: true, example: 800, help: '期末時点で失効・行使されずに残っている個数です。' },
        { key: 'fair_value', label: '1個あたりの公正価値', type: 'yen', required: true, example: 45000, help: '付与日の公正価値（算定書の金額）です。', where: 'オプション価値の算定報告書' },
        { key: 'vesting_date', label: '権利確定日', type: 'date', required: true, example: '2026-07-01', help: 'この日以降に行使できるようになる日です。' },
      ],
      example: [
        { series: '第3回新株予約権', grant_date: '2024-07-01', units: 800, fair_value: 45000, vesting_date: '2026-07-01' },
      ],
    },
  },
  {
    code: 'LOANS',
    issueCode: 'EIR',
    title: '借入金と手数料の明細',
    intro: '借入時に支払った手数料（アレンジメントフィーなど）がある借入金を入力します。IFRSでは手数料を借入期間にわたって配分します。',
    table: {
      keyColumn: 'lender',
      emptyLabel: '手数料を支払った借入金はない',
      columns: [
        { key: 'lender', label: '借入先・契約名', type: 'text', required: true, example: '△△銀行 シンジケートローン', help: '契約ごとに1行です。' },
        { key: 'borrow_date', label: '借入日', type: 'date', required: true, example: '2025-10-01', help: '実行日です。' },
        { key: 'maturity', label: '返済期日', type: 'date', required: true, example: '2030-09-30', help: '最終の返済日です。' },
        { key: 'principal', label: '借入額（元本）', type: 'yen', basis: 'stock', required: true, example: 500000000, help: '借入時の元本です。' },
        { key: 'fee', label: '支払手数料', type: 'yen', required: true, example: 7500000, help: '借入のために支払った手数料の合計です。', where: '金銭消費貸借契約・請求書' },
        { key: 'balance', label: '期末の残高', type: 'yen', basis: 'stock', required: true, example: 450000000, help: '期末時点の借入残高です。' },
      ],
      example: [
        { lender: '△△銀行 シンジケートローン', borrow_date: '2025-10-01', maturity: '2030-09-30', principal: 500000000, fee: 7500000, balance: 450000000 },
      ],
    },
  },
  {
    code: 'DEV_PROJECTS',
    issueCode: 'DEVELOPMENT',
    title: '開発費の明細',
    intro: 'IFRSでは、一定の要件を満たす開発費を資産に計上します。当期に支出した開発費をプロジェクトごとに入力します。',
    table: {
      keyColumn: 'project',
      emptyLabel: '当期に開発費の支出はない',
      columns: [
        { key: 'project', label: 'プロジェクト名', type: 'text', required: true, example: '次世代検査装置の開発', help: '社内のプロジェクト名です。' },
        { key: 'spend', label: '当期の支出額', type: 'yen', basis: 'flow', required: true, example: 18000000, help: '当期に費用処理した開発費（人件費・外注費など）の合計です。', where: '試算表「研究開発費」の内訳' },
        { key: 'criteria', label: '資産計上の要件', type: 'select', required: true, example: '判断中', options: ['満たす', '満たさない', '判断中'], help: '技術的に完成できる・販売や使用の意思と能力がある・将来の収益が見込める・支出を区分して測れる、のすべてに当てはまれば「満たす」です。' },
      ],
      example: [
        { project: '次世代検査装置の開発', spend: 18000000, criteria: '判断中' },
      ],
    },
  },
  {
    code: 'TAX',
    issueCode: 'TAX_EFFECT',
    title: '税効果の基礎情報',
    intro: '繰延税金資産の回収可能性の判断に使います。税効果の計算シート（日本基準）から転記してください。',
    fields: [
      { key: 'statutory_rate', label: '法定実効税率', type: 'percent', basis: 'stock', required: true, example: 30.62, min: 0, max: 50, help: '税効果の計算に使っている税率です。' },
      { key: 'company_class', label: '回収可能性の会社分類', type: 'select', required: true, example: '分類2', options: ['分類1', '分類2', '分類3', '分類4', '分類5'], help: '日本基準の「繰延税金資産の回収可能性に関する適用指針」による分類です。' },
      { key: 'deductible_td', label: '将来減算一時差異の合計', type: 'yen', basis: 'stock', required: true, example: 85000000, help: '賞与引当金・減価償却超過額など、将来の税金を減らす差異の合計です。', where: '税効果計算シート「将来減算一時差異 合計」' },
      { key: 'tax_loss', label: '税務上の繰越欠損金', type: 'yen', basis: 'stock', required: true, example: 0, help: '法人税申告書 別表七(一) の翌期繰越額です。なければ 0 です。', where: '別表七(一)' },
      { key: 'valuation_allowance', label: '評価性引当額', type: 'yen', basis: 'stock', required: true, example: 12000000, help: '回収できないと判断して繰延税金資産から控除した額です。', where: '税効果計算シート「評価性引当額」' },
    ],
  },
]

// 論点ごとの資料（上から用意する順）
export const MATERIALS: Material[] = [
  { code: 'LEAVE_LIST', issueCode: 'PAID_LEAVE', name: '有給休暇の残日数一覧', kind: 'system', source: '人事・給与システム', format: 'CSV（社員番号・氏名・残日数・日額給与）', prepare: '期末日時点の一覧を出力してください。退職者は除きます。', sourceKind: 'paid_leave', importable: true },
  { code: 'LEAVE_USAGE', issueCode: 'PAID_LEAVE', name: '有給休暇の消化実績', kind: 'package', source: '人事・給与システムの集計表', format: '収集パッケージ', prepare: '前期の付与日数と取得日数を転記します。', formCode: 'LEAVE_USAGE' },
  { code: 'TB_LEVY', issueCode: 'LEVY', name: '試算表', kind: 'system', source: '会計システム', format: 'Excel・CSV（期末残高と当期発生額）', prepare: '決算整理後の試算表を出力してください。', sourceKind: 'trial_balance' },
  { code: 'LEVY', issueCode: 'LEVY', name: '固定資産税・均等割', kind: 'package', source: '納税通知書・申告書', format: '収集パッケージ', prepare: '納税通知書の年税額と、期末の未納付額を入力します。', formCode: 'LEVY' },
  { code: 'FA_LEDGER', issueCode: 'DEPRECIATION', name: '固定資産台帳', kind: 'system', source: '会計システム（固定資産管理）', format: 'Excel・CSV（資産ごとの取得価額・償却額・帳簿価額）', prepare: '期中に除却した資産も含めて、期末日時点の台帳を出力してください。', sourceKind: 'fixed_assets', importable: true },
  { code: 'RETIREMENT_ACTUARIAL', issueCode: 'RETIREMENT_1', name: '退職給付の数理計算結果', kind: 'package', source: '年金数理人の計算結果報告書', format: '収集パッケージ', prepare: '報告書の金額を転記します。報告書のPDFも保管してください。', formCode: 'RETIREMENT_ACTUARIAL' },
  { code: 'RETIREMENT_ASSUMPTIONS', issueCode: 'RETIREMENT_2', name: '退職給付の計算前提', kind: 'package', source: '計算結果報告書の「計算基礎」', format: '収集パッケージ', prepare: '割引率・デュレーション・期間帰属の方法を入力します。', formCode: 'RETIREMENT_ASSUMPTIONS' },
  { code: 'EQUITY_HOLDINGS', issueCode: 'EQUITY_INSTRUMENT', name: '保有株式の明細', kind: 'package', source: '有価証券台帳・証券会社の残高報告書', format: '収集パッケージ', prepare: '銘柄ごとに株数・取得原価・期末の時価を入力します。', formCode: 'EQUITY_HOLDINGS' },
  { code: 'TB_GOODWILL', issueCode: 'GOODWILL', name: '試算表', kind: 'system', source: '会計システム', format: 'Excel・CSV（期末残高と当期発生額）', prepare: '決算整理後の試算表を出力してください。', sourceKind: 'trial_balance' },
  { code: 'GOODWILL', issueCode: 'GOODWILL', name: 'のれん', kind: 'package', source: '試算表・のれんの管理表', format: '収集パッケージ', prepare: 'のれんの残高・償却額と、減損の兆候の有無を入力します。', formCode: 'GOODWILL' },
  { code: 'FA_LEDGER_COMP', issueCode: 'COMPRESSION', name: '固定資産台帳', kind: 'system', source: '会計システム（固定資産管理）', format: 'Excel・CSV', prepare: '減価償却と同じ台帳です（1回の提出で足ります）。', sourceKind: 'fixed_assets' },
  { code: 'COMPRESSION_LIST', issueCode: 'COMPRESSION', name: '圧縮記帳の明細', kind: 'package', source: '固定資産台帳・補助金の交付決定通知書', format: '収集パッケージ', prepare: '圧縮記帳をした資産ごとに入力します。', formCode: 'COMPRESSION_LIST' },
  { code: 'ARO_LIST', issueCode: 'ARO', name: '資産除去債務の明細', kind: 'package', source: '賃貸借契約・原状回復の見積書', format: '収集パッケージ', prepare: '物件ごとに見込額・履行予定日・割引率を入力します。', formCode: 'ARO_LIST' },
  { code: 'SO_GRANTS', issueCode: 'SHARE_BASED', name: 'ストックオプション等の付与状況', kind: 'package', source: '発行決議・オプション価値の算定報告書', format: '収集パッケージ', prepare: '付与の回ごとに入力します。', formCode: 'SO_GRANTS' },
  { code: 'LOANS', issueCode: 'EIR', name: '借入金と手数料の明細', kind: 'package', source: '金銭消費貸借契約・手数料の請求書', format: '収集パッケージ', prepare: '手数料を支払った借入金を契約ごとに入力します。', formCode: 'LOANS' },
  { code: 'TB_DEV', issueCode: 'DEVELOPMENT', name: '試算表', kind: 'system', source: '会計システム', format: 'Excel・CSV（期末残高と当期発生額）', prepare: '研究開発費の内訳がわかる試算表を出力してください。', sourceKind: 'trial_balance' },
  { code: 'DEV_PROJECTS', issueCode: 'DEVELOPMENT', name: '開発費の明細', kind: 'package', source: 'プロジェクト別の原価集計表', format: '収集パッケージ', prepare: 'プロジェクトごとの支出額と資産計上の要件を入力します。', formCode: 'DEV_PROJECTS' },
  { code: 'TAX', issueCode: 'TAX_EFFECT', name: '税効果の基礎情報', kind: 'package', source: '税効果計算シート・法人税申告書', format: '収集パッケージ', prepare: '税率・会社分類・一時差異の合計などを転記します。', formCode: 'TAX' },
]

export const formByCode = (code: string) => PACKAGE_FORMS.find((f) => f.code === code)

// 基準日（四半期末）の一覧：決算期の開始日から3か月ごとの末日
export function quarterEnds(start: string, end: string): string[] {
  const out: string[] = []
  const [y, m] = start.split('-').map(Number)
  for (let i = 1; i <= 4; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i * 3, 0))
    const s = d.toISOString().slice(0, 10)
    if (s <= end) out.push(s)
  }
  return out
}

// 日付を nか月ずらした月末
export function shiftMonthEnd(date: string, months: number): string {
  const [y, m] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1 + months + 1, 0)).toISOString().slice(0, 10)
}

export const formatAsOf = (d: string) => {
  const [y, m, day] = d.split('-').map(Number)
  return `${y}年${m}月${day}日`
}
