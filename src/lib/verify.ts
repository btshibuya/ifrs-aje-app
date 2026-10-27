// 検証：計算の根拠をたどる、原本が改ざんされていないか確かめる、計算を再現して一致を確かめる

import { PACKAGE_CALCS } from './packageCalc'
import { must, supabase } from './supabase'
import {
  fetchEntries, fetchSteps, itemsHash, planCalculation, type ItemRow, type Period, type Run, type StepRow,
} from './workflow'

export async function sha256Hex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 原本をダウンロードしてハッシュ値を計算し直し、取込時に記録した値と比べる
export async function verifySourceFile(storagePath: string, expected: string) {
  const res = await supabase.storage.from('source-files').download(storagePath)
  if (res.error || !res.data) {
    const m = res.error?.message ?? ''
    throw new Error(/not.?found|404|Object not found/i.test(m) || m === '{}' || m === ''
      ? '原本ファイルが保管場所に見つかりません（削除された可能性があります）。取込の記録とハッシュ値は残っています。'
      : `原本を読み込めませんでした：${m}`)
  }
  const actual = await sha256Hex(await res.data.arrayBuffer())
  return { ok: actual === expected, actual, size: res.data.size }
}

// 集計行と、それを構成する明細ごとの行の対応（論点ごと）
const TRACE_MAP: Record<string, Record<string, string>> = {
  DEPRECIATION: {
    '期首差額 合計': '期首差額（IFRS − 日本基準）',
    '償却額の差 合計': '償却額の差（IFRS − 日本基準）',
    '除却時の差 合計': '除却時の帳簿価額の差（除却損の調整）',
    '期末差額 合計': '期末差額（IFRS − 日本基準）',
  },
  PAID_LEAVE: {
    '未払有給休暇 合計': '未払有給休暇（IFRS）',
  },
}

export interface TraceItem { itemKey: string; value: number }

// 集計行を構成する明細の値（対応がない集計行は null：ほかの集計行から計算した値）
// 収集パッケージの論点は、集計行の名前から「 合計」を除いたものが明細ごとの行（例：当期の変動 合計（A／B） → 当期の変動（A／B））
export function contributingItems(issueCode: string, summary: StepRow, steps: StepRow[]): TraceItem[] | null {
  const itemLabel = PACKAGE_CALCS[issueCode] ? (summary.label.includes(' 合計') ? summary.label.replace(' 合計', '') : undefined) : TRACE_MAP[issueCode]?.[summary.label]
  if (!itemLabel) return null
  return steps
    .filter((s) => s.item_key !== null && s.label === itemLabel)
    .map((s) => ({ itemKey: s.item_key!, value: Number(s.value ?? 0) }))
}

// ---------------------------------------------------------------------------
// 計算の再現：同じ入力でもう一度計算し、保存された結果と比べる
// ---------------------------------------------------------------------------

export interface CheckResult { label: string; ok: boolean; detail: string }

const r = (v: unknown) => Math.round(Number(v ?? 0))

export async function reproduceCalculation(period: Period, issueCode: string, items: ItemRow[], run: Run): Promise<CheckResult[]> {
  const [plan, stored, entries] = await Promise.all([planCalculation(period, issueCode, items), fetchSteps(run.id), fetchEntries(run.id)])
  const checks: CheckResult[] = []

  // 1. 入力（取り込んだ明細）が計算時と同じか
  const hash = await itemsHash(items)
  checks.push({
    label: '入力（取り込んだ明細）が計算した時と同じ',
    ok: hash === run.input_hash,
    detail: hash === run.input_hash ? `明細 ${items.length}件のハッシュ値が一致（${hash.slice(0, 12)}…）` : '計算のあとで明細が変わっています。再計算してください',
  })

  // 2. 集計行の値
  const key = (itemKey: string | null, stepNo: number) => `${itemKey ?? ''}|${stepNo}`
  const storedMap = new Map(stored.map((s) => [key(s.item_key, s.step_no), s]))
  const summary = plan.result.steps.filter((s) => s.itemKey === null)
  const summaryDiff = summary.filter((s) => r(storedMap.get(key(null, s.stepNo))?.value) !== r(s.value))
  checks.push({
    label: '集計行の値が一致',
    ok: summaryDiff.length === 0,
    detail: summaryDiff.length === 0 ? `${summary.length}行すべて一致` : `不一致：${summaryDiff.map((s) => `${s.label}（保存 ${r(storedMap.get(key(null, s.stepNo))?.value).toLocaleString('ja-JP')} ／ 再計算 ${r(s.value).toLocaleString('ja-JP')}）`).join('、')}`,
  })

  // 3. 明細ごとの行
  const itemSteps = plan.result.steps.filter((s) => s.itemKey !== null)
  const itemDiff = itemSteps.filter((s) => {
    const st = storedMap.get(key(s.itemKey, s.stepNo))
    return !st || Math.abs(Number(st.value ?? 0) - Number(s.value ?? 0)) > 0.005
  })
  const storedItemCount = stored.filter((s) => s.item_key !== null).length
  checks.push({
    label: '明細ごとの計算過程が一致',
    ok: itemDiff.length === 0 && storedItemCount === itemSteps.length,
    detail: itemDiff.length === 0 && storedItemCount === itemSteps.length
      ? `${new Set(itemSteps.map((s) => s.itemKey)).size}明細・${itemSteps.length}行すべて一致`
      : `不一致 ${itemDiff.length}行（例：${itemDiff.slice(0, 3).map((s) => `${s.itemKey} ${s.label}`).join('、')}）`,
  })

  // 4. 仕訳（科目ごとの借方−貸方）
  const net = new Map<string, number>()
  for (const e of plan.result.entries) for (const l of e.lines) net.set(l.account, (net.get(l.account) ?? 0) + (l.side === 'debit' ? l.amount : -l.amount))
  const storedNet = new Map<string, number>()
  for (const e of entries) for (const l of e.journal_lines) storedNet.set(l.group_account_code, (storedNet.get(l.group_account_code) ?? 0) + (l.side === 'debit' ? 1 : -1) * Number(l.amount))
  const accounts = new Set([...net.keys(), ...storedNet.keys()])
  const accDiff = [...accounts].filter((a) => r(net.get(a)) !== r(storedNet.get(a)))
  checks.push({
    label: '仕訳の金額（科目ごと）が一致',
    ok: accDiff.length === 0,
    detail: accDiff.length === 0 ? `${accounts.size}科目すべて一致` : `不一致：${accDiff.map((a) => `${a}（保存 ${r(storedNet.get(a)).toLocaleString('ja-JP')} ／ 再計算 ${r(net.get(a)).toLocaleString('ja-JP')}）`).join('、')}`,
  })

  // 5. 前提値（税率など）が計算時と同じか
  const snap = run.assumptions_snapshot as Record<string, unknown>
  const now = plan.assumptions as Record<string, unknown>
  const keys = ['tax_rate', 'prior_tax_rate', 'expected_usage_rate', 'social_insurance_rate', 'params_used', 'prior_run_id'].filter((k) => k in now || k in snap)
  const changed = keys.filter((k) => JSON.stringify(now[k] ?? null) !== JSON.stringify(snap[k] ?? null))
  checks.push({
    label: '前提値（税率・方針・前期の計算）が計算した時と同じ',
    ok: changed.length === 0,
    detail: changed.length === 0 ? `${keys.length}項目が一致` : `計算のあとで変わった前提値：${changed.join('、')}（変更を反映するには再計算が必要です）`,
  })
  return checks
}

// ---------------------------------------------------------------------------
// 変更履歴（記録のタイムライン）
// ---------------------------------------------------------------------------

export interface LogRow {
  id: number
  action: 'INSERT' | 'UPDATE' | 'DELETE'
  before_data: Record<string, unknown> | null
  after_data: Record<string, unknown> | null
  changed_at: string
}

export async function fetchRecordLogs(tableName: string, recordId: string): Promise<LogRow[]> {
  return must(
    await supabase.from('change_logs').select('id, action, before_data, after_data, changed_at')
      .eq('table_name', tableName).eq('record_id', recordId).order('changed_at'),
  ) as LogRow[]
}
