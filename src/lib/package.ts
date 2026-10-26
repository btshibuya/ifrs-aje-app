// 収集パッケージと資料の提出状況の読み書き

import type { MasterData, PeriodRow } from './masters'
import { MATERIALS, PACKAGE_FORMS, shiftMonthEnd, type Material, type PackageForm, type PkgField } from './materials'
import { must, supabase } from './supabase'

export type EntryStatus = 'draft' | 'submitted' | 'confirmed'

export interface EntryData {
  fields?: Record<string, unknown>
  rows?: Record<string, unknown>[]
  reasons?: Record<string, string> // 前期から大きく変わった項目の理由
  none?: boolean // 明細の様式で「該当なし」
  note?: string
}

export interface PackageEntry {
  id: string
  company_id: string
  as_of: string
  form_code: string
  issue_code: string
  data: EntryData
  status: EntryStatus
  entered_by: string | null
  submitted_at: string | null
  confirmed_at: string | null
  confirmed_by: string | null
  return_note: string | null
  updated_at: string
}

export const ENTRY_STATUS_LABELS: Record<EntryStatus | 'todo', string> = {
  todo: '未着手',
  draft: '入力中',
  submitted: '提出済',
  confirmed: '確認済',
}

export async function fetchEntries(companyId: string, asOfs: string[]): Promise<PackageEntry[]> {
  if (asOfs.length === 0) return []
  return must(
    await supabase.from('package_entries').select('*').eq('company_id', companyId).in('as_of', asOfs),
  ) as PackageEntry[]
}

// 下書きとして保存する（なければ作る）
export async function saveDraft(companyId: string, asOf: string, form: PackageForm, data: EntryData, enteredBy: string) {
  return must(
    await supabase.from('package_entries').upsert({
      company_id: companyId, as_of: asOf, form_code: form.code, issue_code: form.issueCode,
      data, entered_by: enteredBy || null, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,as_of,form_code' }).select('*').single(),
  ) as PackageEntry
}

export async function setEntryStatus(id: string, status: EntryStatus, extra: Partial<PackageEntry> = {}) {
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status, updated_at: now }
  if (status === 'submitted') Object.assign(patch, { submitted_at: now, confirmed_at: null, confirmed_by: null, return_note: null })
  if (status === 'confirmed') patch.confirmed_at = now
  if (status === 'draft') Object.assign(patch, { submitted_at: null, confirmed_at: null, confirmed_by: null })
  // 呼び出し側の指定（入力者・確認者・差し戻した人と理由）を最後に重ねる
  Object.assign(patch, extra)
  return must(await supabase.from('package_entries').update(patch).eq('id', id).select('*').single()) as PackageEntry
}

// ---------------------------------------------------------------------------
// 比べる時点：残高（BS）は前年度末、損益（PL）は前年同期。どちらも直前四半期も並べる
// ---------------------------------------------------------------------------

export interface CompareDates { priorYearEnd: string; priorSamePeriod: string; prevQuarter: string }

export function compareDates(asOf: string, period: PeriodRow): CompareDates {
  return {
    priorYearEnd: shiftMonthEnd(period.start_date, -1),
    priorSamePeriod: shiftMonthEnd(asOf, -12),
    prevQuarter: shiftMonthEnd(asOf, -3),
  }
}

export const firstCompareDate = (f: PkgField, d: CompareDates) => (f.basis === 'flow' ? d.priorSamePeriod : d.priorYearEnd)

// ---------------------------------------------------------------------------
// 数値の入力：全角・カンマ・円・△（マイナス）を受け付ける
// ---------------------------------------------------------------------------

export function parseNumber(raw: string): number | null | 'error' {
  const s = raw
    .replace(/[０-９．－＋，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,\s円％%日年人個株]/g, '')
    .replace(/^[△▲]/, '-')
    .replace(/^ー/, '-')
  if (s === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : 'error'
}

const pad2 = (n: number) => String(n).padStart(2, '0')

// 日付：2024/4/1、2024-04-01、2024年4月1日、2024/04（年月だけなら1日）を受け付ける
export function parseDateInput(raw: string, monthOnly = false): string | null | 'error' {
  const s = raw.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  if (s === '') return null
  const m = s.match(/^(\d{4})[/\-.年](\d{1,2})(?:[/\-.月](\d{1,2})日?)?月?$/)
  if (!m) return 'error'
  const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1]
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 'error'
  return `${y}-${pad2(mo)}-${pad2(monthOnly ? 1 : d)}`
}

export function formatNumber(v: unknown, type: PkgField['type']): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v === null || v === undefined ? '' : String(v)
  const digits = type === 'percent' || type === 'years' ? 2 : type === 'days' ? 1 : 0
  return v.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

export const UNIT: Record<PkgField['type'], string> = {
  yen: '円', percent: '%', days: '日', years: '年', count: '', text: '', date: '', select: '',
}

export const isNumeric = (f: PkgField) => ['yen', 'percent', 'days', 'years', 'count'].includes(f.type)

// 前期から大きく変わったか（理由の入力を求める）
export const VARIANCE_THRESHOLD = 0.3

export function variance(cur: unknown, prior: unknown): number | null {
  if (typeof cur !== 'number' || typeof prior !== 'number' || prior === 0) return null
  return (cur - prior) / Math.abs(prior)
}

// 増減の言い方：「100%減（−2,100,000円）」。マイナスの値が大きくなったときに「−100%」と読み違えないよう、向きと金額で示す
export function describeChange(cur: number, prior: number, unit: string): string {
  const diff = cur - prior
  const pct = Math.round((Math.abs(diff) / Math.abs(prior)) * 100)
  const amount = `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}${unit}`
  return `${pct}%${diff >= 0 ? '増' : '減'}（${amount}）`
}

// 自動計算の項目を反映した値
export function withComputed(form: PackageForm, fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields }
  for (const f of form.fields ?? []) if (f.compute) out[f.key] = f.compute(out)
  return out
}

// 整合チェック用：様式のすべての項目を、数値か null にそろえる（未入力は null）
export function numericFields(form: PackageForm, fields: Record<string, unknown>): Record<string, number | null> {
  return Object.fromEntries((form.fields ?? []).map((f) => [f.key, typeof fields[f.key] === 'number' ? (fields[f.key] as number) : null]))
}

// ---------------------------------------------------------------------------
// 入力のチェック（提出してよいか）
// ---------------------------------------------------------------------------

export interface Problem { key: string; message: string }

// priorValue：その項目の比較先（残高は前年度末、損益は前年同期。期首残高は前年度末の期末残高）の値
export function validate(form: PackageForm, data: EntryData, priorValue: (f: PkgField) => unknown = () => undefined): Problem[] {
  const problems: Problem[] = []
  const checkValue = (f: PkgField, v: unknown, where: string, key: string) => {
    const empty = v === null || v === undefined || v === ''
    if (f.required && empty && !f.compute) problems.push({ key, message: `${where}「${f.label}」を入力してください` })
    if (!empty && isNumeric(f) && typeof v !== 'number') problems.push({ key, message: `${where}「${f.label}」は数字で入力してください` })
    if (typeof v === 'number' && f.min !== undefined && v < f.min) problems.push({ key, message: `${where}「${f.label}」は ${f.min} 以上です` })
    if (typeof v === 'number' && f.max !== undefined && v > f.max) problems.push({ key, message: `${where}「${f.label}」は ${f.max} 以下です（単位を確認してください）` })
    if (!empty && f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) problems.push({ key, message: `${where}「${f.label}」は 2035-03-31 の形で入力してください` })
  }
  if (form.fields) {
    const fields = withComputed(form, data.fields ?? {})
    for (const f of form.fields) {
      checkValue(f, fields[f.key], '', f.key)
      const pv = priorValue(f)
      if (f.carryFrom && typeof pv === 'number' && typeof fields[f.key] === 'number' && Math.abs(pv - (fields[f.key] as number)) >= 1) {
        problems.push({ key: f.key, message: `「${f.label}」が前年度末の期末残高 ${pv.toLocaleString('ja-JP')} と一致しません` })
        continue
      }
      const vr = f.carryFrom ? null : variance(fields[f.key], pv)
      if (!f.compute && vr !== null && Math.abs(vr) >= VARIANCE_THRESHOLD && !data.reasons?.[f.key]?.trim()) {
        problems.push({ key: f.key, message: `「${f.label}」が前期から${describeChange(fields[f.key] as number, pv as number, UNIT[f.type])}。理由を入力してください` })
      }
    }
    for (const c of form.checks ?? []) {
      const nums = numericFields(form, fields)
      const exp = c.expected(nums)
      const act = nums[c.actualKey]
      if (exp !== null && act !== null && Math.abs(exp - act) >= 1) problems.push({ key: c.actualKey, message: `「${c.label}」が合いません（${c.formula}）` })
    }
  }
  if (form.table) {
    const rows = data.rows ?? []
    if (!data.none && rows.length === 0) problems.push({ key: 'rows', message: `明細を1行以上入力するか、「${form.table.emptyLabel}」にチェックしてください` })
    if (!data.none) {
      rows.forEach((r, i) => form.table!.columns.forEach((c) => checkValue(c, r[c.key], `${i + 1}行目の`, `rows.${i}.${c.key}`)))
      const keys = rows.map((r) => String(r[form.table!.keyColumn] ?? '').trim()).filter(Boolean)
      const dup = keys.filter((k, i) => keys.indexOf(k) !== i)
      if (dup.length) problems.push({ key: 'rows', message: `「${dup[0]}」が2行あります（同じ名前は1行にまとめてください）` })
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// 資料の提出状況（資料一覧・進捗一覧で使う）
// ---------------------------------------------------------------------------

export type MaterialStatus = 'not_needed' | 'todo' | 'draft' | 'submitted' | 'confirmed'

export const MATERIAL_STATUS_LABELS: Record<MaterialStatus, string> = {
  not_needed: '不要',
  todo: '未提出',
  draft: '入力中',
  submitted: '提出済',
  confirmed: '確認済',
}

export interface MaterialState {
  material: Material
  status: MaterialStatus
  applicability: string | null
  updatedAt: string | null
  detail: string | null // 「取込済（計算済）」など
}

interface SourceFileRow { period_id: string; issue_code: string | null; source_kind: string; uploaded_at: string; file_name: string }
interface WorkRow { period_id: string; issue_code: string; status: string }
interface PolicyRow { period_id: string; issue_code: string; applicability: string | null }

export interface StatusContext {
  hiddenIssues: Set<string>
  files: SourceFileRow[]
  work: WorkRow[]
  policies: PolicyRow[]
  entries: { company_id: string; as_of: string; form_code: string; status: EntryStatus; updated_at: string }[]
}

// 指定した期の資料の状況をまとめて読む
// visibleIssues：表示している論点（マスタで非表示にした論点の資料は数えない）。呼び出し側が読んだマスタから渡す
export async function fetchStatusContext(periodIds: string[], companyIds: string[], asOfs: string[], visibleIssues: string[]): Promise<StatusContext> {
  const [files, work, policies, entries] = await Promise.all([
    supabase.from('source_files').select('period_id, issue_code, source_kind, uploaded_at, file_name').in('period_id', periodIds).order('uploaded_at', { ascending: false }),
    supabase.from('work_status').select('period_id, issue_code, status').in('period_id', periodIds),
    supabase.from('v_policy_matrix').select('period_id, issue_code, applicability').in('period_id', periodIds),
    supabase.from('package_entries').select('company_id, as_of, form_code, status, updated_at').in('company_id', companyIds).in('as_of', asOfs),
  ])
  const visible = new Set(visibleIssues)
  return {
    hiddenIssues: new Set(MATERIALS.map((m) => m.issueCode).filter((c) => !visible.has(c))),
    files: must(files) as SourceFileRow[],
    work: must(work) as WorkRow[],
    policies: must(policies) as PolicyRow[],
    entries: must(entries) as StatusContext['entries'],
  }
}

const WORK_LABELS: Record<string, string> = { imported: '取込済', checked: '明細チェック済', calculated: '計算済', locked: '確定' }

export function materialStates(ctx: StatusContext, period: PeriodRow): MaterialState[] {
  return MATERIALS.filter((m) => !ctx.hiddenIssues.has(m.issueCode)).map((m) => {
    const applicability = ctx.policies.find((p) => p.period_id === period.id && p.issue_code === m.issueCode)?.applicability ?? null
    if (applicability !== 'applied') return { material: m, status: 'not_needed' as const, applicability, updatedAt: null, detail: null }
    if (m.kind === 'package') {
      const e = ctx.entries.find((x) => x.company_id === period.company_id && x.as_of === period.end_date && x.form_code === m.formCode)
      return { material: m, status: e ? e.status : 'todo', applicability, updatedAt: e?.updated_at ?? null, detail: null }
    }
    // 会計システム等から出すファイル：取り込んだら提出済、明細チェックまで進んだら確認済
    const f = ctx.files.find((x) => x.period_id === period.id && x.source_kind === m.sourceKind)
    if (!f) return { material: m, status: 'todo' as const, applicability, updatedAt: null, detail: null }
    const w = m.importable ? ctx.work.find((x) => x.period_id === period.id && x.issue_code === m.issueCode)?.status : undefined
    const confirmed = w === 'checked' || w === 'calculated' || w === 'locked'
    return { material: m, status: confirmed ? 'confirmed' : 'submitted', applicability, updatedAt: f.uploaded_at, detail: w ? WORK_LABELS[w] ?? null : null }
  })
}

// 会社ごとの集計（不要の資料は数えない。試算表・固定資産台帳など複数の論点で使うファイルは1件と数える）
export function summarize(states: MaterialState[]) {
  const counts: Record<string, number> = {}
  const seen = new Set<string>()
  for (const s of states) {
    if (s.status === 'not_needed') continue
    const key = s.material.kind === 'system' ? `file:${s.material.sourceKind}` : s.material.code
    if (seen.has(key)) continue
    seen.add(key)
    counts[s.status] = (counts[s.status] ?? 0) + 1
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const done = (counts.submitted ?? 0) + (counts.confirmed ?? 0)
  return { counts, total, done }
}

// 複数の会社の合計（会社ごとに数えてから足す）
export function summarizeCompanies(perCompany: MaterialState[][]) {
  const counts: Record<string, number> = {}
  let total = 0
  let done = 0
  for (const states of perCompany) {
    const s = summarize(states)
    for (const [k, v] of Object.entries(s.counts)) counts[k] = (counts[k] ?? 0) + v
    total += s.total
    done += s.done
  }
  return { counts, total, done }
}

// 進捗一覧などから、各社の期の資料の状況をまとめて読む
export async function fetchAllMaterialStates(m: MasterData, periods: PeriodRow[]) {
  const ctx = await fetchStatusContext(periods.map((p) => p.id), m.companies.map((c) => c.id), periods.map((p) => p.end_date), m.issues.map((i) => i.code))
  return new Map(periods.map((p) => [p.company_id, materialStates(ctx, p)]))
}

// 会計システム等から出したファイル（取込の機能がないもの：試算表など）の原本を保存する
export async function uploadSourceFile(period: PeriodRow, material: Material, file: File) {
  const buf = await file.arrayBuffer()
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('')
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'bin'
  const path = `${period.id}/${material.sourceKind}/${Date.now()}_${hash.slice(0, 12)}.${ext}`
  must(await supabase.storage.from('source-files').upload(path, buf, { contentType: file.type || 'application/octet-stream' }))
  must(await supabase.from('source_files').insert({
    period_id: period.id, issue_code: null, source_kind: material.sourceKind, file_name: file.name,
    file_type: ext === 'xlsx' || ext === 'xls' ? 'excel' : ext === 'pdf' ? 'pdf' : 'csv', storage_path: path, sha256: hash,
  }))
}

export const formsForIssues = (issueCodes: Set<string>) => PACKAGE_FORMS.filter((f) => issueCodes.has(f.issueCode))
