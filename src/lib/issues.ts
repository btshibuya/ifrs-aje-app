// ファイルを取り込んで計算する論点（有給休暇・減価償却）の取込の項目定義

export type FieldType = 'text' | 'number' | 'date'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  required: boolean
}

// 手入力（明細を1件ずつ／合計で）。会計ソフトから出せない・ファイルがないときの代わりの入り口
export interface ManualConfig {
  unitLabel: string // 明細1件の呼び名（従業員・資産）
  detailTips: string[]
  aggregate: {
    title: string
    lead: string
    countLabel: string // 人数・件数
    labels: Partial<Record<string, string>> // 合計で入力するときの項目名
    placeholders: Partial<Record<string, string>>
    autoKey?: 'asset_group' // 番号を自動で付ける（資産の種類＋取得年月）
    helper?: 'weighted_wage' // 残日数×日額給与の合計から、加重平均の日額給与を出す
    tips: string[]
  }
}

export interface IssueConfig {
  code: string
  manual: ManualConfig
  sourceKind: string
  sourceLabel: string
  keyField: string
  fields: FieldDef[]
  sampleFiles: { label: string; path: string }[]
}

export const ISSUE_CONFIGS: Record<string, IssueConfig> = {
  PAID_LEAVE: {
    code: 'PAID_LEAVE',
    manual: {
      unitLabel: '従業員',
      detailTips: ['1行に1人です。勤怠システムの画面や紙の一覧から、社員番号・残日数・日額給与を入れます。', 'Excel の表をコピーして、最初の欄に貼り付けると、まとめて入ります。'],
      aggregate: {
        title: '区分ごとの合計で入力する',
        lead: '人数が多い、または1人ずつの一覧が出せないときは、管理職・一般職・パートなどの区分ごとに、残日数の合計と日額給与を入れます。',
        countLabel: '人数',
        labels: { employee_no: '区分', name: '区分の説明（任意）', unused_days: '有給残日数の合計', daily_wage: '日額給与（残日数で加重平均）' },
        placeholders: { employee_no: '例：管理職', name: '例：課長以上', unused_days: '例：412.5', daily_wage: '例：28,400' },
        helper: 'weighted_wage',
        tips: [
          '日額給与は「残日数×日額給与の合計 ÷ 残日数の合計」（残日数で加重平均）にすると、1人ずつ計算したときと同じ金額になります。',
          'Excel では =SUMPRODUCT(残日数の列, 日額給与の列) / SUM(残日数の列) で求められます。右の「残日数×日額給与の合計」に入れると、自動で計算します。',
          '単純平均（人数で割る）を使うと、残日数の多い人の給与が反映されず、誤差が出ます。',
        ],
      },
    },
    sourceKind: 'paid_leave',
    sourceLabel: '有給休暇の残日数一覧',
    keyField: 'employee_no',
    fields: [
      { key: 'employee_no', label: '社員番号', type: 'text', required: true },
      { key: 'name', label: '氏名', type: 'text', required: false },
      { key: 'unused_days', label: '有給残日数', type: 'number', required: true },
      { key: 'daily_wage', label: '日額給与', type: 'number', required: true },
    ],
    sampleFiles: [
      { label: 'S01 2026年3月期', path: 'samples/S01_有給残日数_2026年3月期.csv' },
      { label: 'S01 2027年3月期', path: 'samples/S01_有給残日数_2027年3月期.csv' },
      { label: 'S02 2026年3月期', path: 'samples/S02_有給残日数_2026年3月期.csv' },
    ],
  },
  DEPRECIATION: {
    code: 'DEPRECIATION',
    manual: {
      unitLabel: '資産',
      detailTips: ['1行に1件の資産です。固定資産台帳の画面や紙の台帳から入れます。', 'Excel の表をコピーして、最初の欄に貼り付けると、まとめて入ります。'],
      aggregate: {
        title: '資産の種類×取得年月ごとの合計で入力する',
        lead: '資産が多いときは、資産の種類と取得年月が同じ資産をまとめて、金額の合計を入れます。番号は自動で付けます。',
        countLabel: '件数',
        labels: {
          asset_no: '番号（自動）', name: 'まとめの名前（任意）', acquired_on: '取得年月', cost: '取得価額の合計',
          jgaap_opening_bv: '期首帳簿価額の合計', jgaap_depreciation: '当期償却額の合計', jgaap_closing_bv: '期末帳簿価額の合計', disposed_on: '除却年月日',
        },
        placeholders: { asset_no: '自動', name: '例：PC 2024年4月取得分', asset_type: '例：工具器具備品', acquired_on: '例：2024/04', cost: '例：3,600,000' },
        autoKey: 'asset_group',
        tips: [
          '資産の種類と取得年月が同じ資産をまとめると、定額法・月割りのため、1件ずつ入れたときと同じ結果になります。',
          '取得年月が違う資産をまとめると、償却する月数がずれて誤差が出ます。',
          '当期に除却・売却した資産は、まとめずに1件ずつ入れてください（除却損の調整を正しく出すため）。',
        ],
      },
    },
    sourceKind: 'fixed_assets',
    sourceLabel: '固定資産台帳',
    keyField: 'asset_no',
    fields: [
      { key: 'asset_no', label: '資産番号', type: 'text', required: true },
      { key: 'name', label: '資産名称', type: 'text', required: false },
      { key: 'asset_type', label: '資産種類', type: 'text', required: true },
      { key: 'acquired_on', label: '取得年月日', type: 'date', required: true },
      { key: 'cost', label: '取得価額', type: 'number', required: true },
      { key: 'jgaap_life', label: '耐用年数（日本基準）', type: 'number', required: false },
      { key: 'jgaap_opening_bv', label: '期首帳簿価額', type: 'number', required: false },
      { key: 'jgaap_depreciation', label: '当期償却額', type: 'number', required: true },
      { key: 'jgaap_closing_bv', label: '期末帳簿価額', type: 'number', required: true },
      { key: 'disposed_on', label: '除却年月日', type: 'date', required: false },
    ],
    sampleFiles: [
      { label: 'S01 2026年3月期', path: 'samples/S01_固定資産台帳_2026年3月期.xlsx' },
      { label: 'S01 2027年3月期', path: 'samples/S01_固定資産台帳_2027年3月期.xlsx' },
      { label: 'S04 2026年3月期（弥生会計の列名）', path: 'samples/S04_固定資産台帳_2026年3月期.xlsx' },
    ],
  },
}

export const STATUS_LABELS: Record<string, string> = {
  not_started: '未着手',
  imported: '取込済',
  checked: 'チェック済',
  calculated: '計算済',
  locked: '確定',
}

export const APPLICABILITY_LABELS: Record<string, string> = {
  applied: '適用',
  not_applicable: '対象外',
  immaterial: '重要性なし',
}

export const CARRY_METHOD_LABELS: Record<string, string> = {
  cumulative: '累積',
  reversing: '洗替',
  reclass: '組換',
}
