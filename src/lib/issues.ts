// アプリで計算まで実装している論点と、取込ファイルの項目定義

export type FieldType = 'text' | 'number' | 'date'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  required: boolean
}

export interface IssueConfig {
  code: string
  sourceKind: string
  sourceLabel: string
  keyField: string
  fields: FieldDef[]
  sampleFiles: { label: string; path: string }[]
}

export const ISSUE_CONFIGS: Record<string, IssueConfig> = {
  PAID_LEAVE: {
    code: 'PAID_LEAVE',
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
