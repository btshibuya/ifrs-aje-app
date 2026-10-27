// 会社×期×論点の作業（取込 → チェック → 計算 → 確定）とDBの読み書き

import { calcDepreciation, type AssetRule } from '../calc/depreciation'
import { calcPaidLeave } from '../calc/paidLeave'
import type { CalcResult, DetailItem, PriorBalance } from '../calc/types'
import { calcPackageIssue, packageCsv, PACKAGE_CALCS, type ItemRowData } from './packageCalc'
import { formByCode } from './materials'
import type { PackageEntry } from './package'
import type { IssueConfig } from './issues'
// 取込ファイルの読み取り（Excel・CSVの読み取りライブラリ）は大きいため、取り込むときにだけ読み込む
import type { MappedRow } from './parse'
import { sha256 } from './hash'
const loadParser = () => import('./parse')
import { must, supabase } from './supabase'

export interface Company {
  id: string
  code: string
  name: string
  fiscal_year_end_month: number
  accounting_software: string | null
}

export interface Period {
  id: string
  company_id: string
  label: string
  start_date: string
  end_date: string
  prior_period_id: string | null
  period_type: 'Q1' | 'Q2' | 'Q3' | 'FY'
  companies: Company
}

export interface TimelinePoint { id: string; label: string; start_date: string; end_date: string; period_type: string; status: string }

// 会社のすべての時点（古い順）と、指定した論点の状況
export async function fetchTimeline(companyId: string, issueCode: string): Promise<TimelinePoint[]> {
  const ps = must(
    await supabase.from('periods').select('id, label, start_date, end_date, period_type').eq('company_id', companyId).order('end_date'),
  ) as Omit<TimelinePoint, 'status'>[]
  const ws = must(
    await supabase.from('work_status').select('period_id, status').eq('issue_code', issueCode).in('period_id', ps.map((p) => p.id)),
  ) as { period_id: string; status: string }[]
  const st = new Map(ws.map((w) => [w.period_id, w.status]))
  return ps.map((p) => ({ ...p, status: st.get(p.id) ?? 'not_started' }))
}

export interface Policy {
  applicability: string | null
  params: Record<string, unknown>
  reason: string | null
  is_company_override: boolean
}

export interface WorkStatus {
  status: string
  locked_at: string | null
  updated_at: string
}

export interface ItemRow {
  id: string
  item_key: string
  data: Record<string, unknown>
  source_row_no: number | null
  review_status: 'pending' | 'checked'
  checked_at: string | null
  source_file_id: string | null
}

export interface Run {
  id: string
  status: 'draft' | 'final' | 'superseded'
  assumptions_snapshot: Record<string, unknown>
  input_hash: string
  run_at: string
}

export async function fetchPeriod(periodId: string): Promise<Period> {
  return must(await supabase.from('periods').select('*, companies(*)').eq('id', periodId).single()) as Period
}

export async function fetchPolicy(periodId: string, issueCode: string): Promise<Policy> {
  const row = must(
    await supabase.from('v_policy_matrix').select('applicability, params, reason, is_company_override')
      .eq('period_id', periodId).eq('issue_code', issueCode).maybeSingle(),
  )
  return (row as Policy | null) ?? { applicability: null, params: {}, reason: null, is_company_override: false }
}

export async function fetchTaxRate(periodId: string | null): Promise<number | null> {
  if (!periodId) return null
  const p = await fetchPolicy(periodId, 'TAX_EFFECT')
  const r = Number(p.params.effective_tax_rate)
  return Number.isFinite(r) && r > 0 ? r : null
}

export async function fetchWorkStatus(periodId: string, issueCode: string): Promise<WorkStatus | null> {
  return must(
    await supabase.from('work_status').select('status, locked_at, updated_at')
      .eq('period_id', periodId).eq('issue_code', issueCode).maybeSingle(),
  ) as WorkStatus | null
}

async function setStatus(periodId: string, issueCode: string, status: string) {
  must(
    await supabase.from('work_status').upsert(
      { period_id: periodId, issue_code: issueCode, status, locked_at: status === 'locked' ? new Date().toISOString() : null, updated_at: new Date().toISOString() },
      { onConflict: 'period_id,issue_code' },
    ),
  )
}

// 列マッピング：会社×会計ソフト ＞ 会社 ＞ グループ共通×会計ソフト ＞ グループ共通
export async function fetchColumnMapping(period: Period, sourceKind: string) {
  const rows = must(
    // 非表示にした列マッピングは使わない
    await supabase.from('column_mappings').select('company_id, software, header_row, mapping').eq('source_kind', sourceKind).eq('is_hidden', false),
  ) as { company_id: string | null; software: string; header_row: number; mapping: Record<string, string> }[]
  const sw = period.companies.accounting_software ?? ''
  const score = (r: (typeof rows)[number]) =>
    (r.company_id === period.company_id ? 2 : r.company_id === null ? 0 : -99) + (r.software === sw ? 1 : r.software === '' ? 0 : -99)
  const best = rows.filter((r) => score(r) >= 0).sort((a, b) => score(b) - score(a))[0]
  if (!best) throw new Error('列マッピングが登録されていません')
  return {
    ...best,
    scope: `${best.company_id ? '会社ごとの設定' : 'グループ共通'}${best.software ? `（${best.software}）` : ''}`,
  }
}

export interface ImportPreview {
  file: File
  buf: ArrayBuffer
  rows: MappedRow[]
  missingColumns: string[]
  mappingScope: string
  duplicateKeys: string[]
  // 列名が合わないときに、画面で列を選び直せるようにする
  table: unknown[][]
  headerRow: number
  headers: string[]
  mapping: Record<string, string>
}

const findDuplicates = (rows: { itemKey: string }[]) => {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.itemKey)) dup.add(r.itemKey)
    seen.add(r.itemKey)
  }
  return [...dup]
}

// 列名の言い換え（列マッピングと違う列名のファイルで、候補を自動で選ぶ）
const SYNONYMS: Record<string, string[]> = {
  employee_no: ['社員番号', '社員コード', '従業員番号', '従業員コード', '社員No', '個人コード', 'ID'],
  name: ['氏名', '名前', '資産名', '資産名称', '名称'],
  unused_days: ['有給残日数', '残日数', '有給残', '残高日数', '未消化日数'],
  daily_wage: ['日額給与', '日額', '日給', '日額単価', '1日あたり'],
  asset_no: ['資産番号', '資産コード', '資産No', '固定資産番号'],
  asset_type: ['資産種類', '種類', '勘定科目', '資産区分'],
  acquired_on: ['取得年月日', '取得日', '取得年月', '事業供用日'],
  cost: ['取得価額', '取得価格', '取得原価'],
  jgaap_life: ['耐用年数'],
  jgaap_opening_bv: ['期首帳簿価額', '期首簿価', '期首残高'],
  jgaap_depreciation: ['当期償却額', '償却額', '減価償却費'],
  jgaap_closing_bv: ['期末帳簿価額', '期末簿価', '期末残高'],
  disposed_on: ['除却年月日', '除却日', '売却日'],
}

// 見出しの行と列の対応の候補：列マッピングの列名、なければ言い換えで探す。見出しは先頭10行から、合う列が最も多い行
export function suggestMapping(table: unknown[][], cfg: IssueConfig, base: Record<string, string>) {
  const norm = (v: unknown) => String(v ?? '').trim()
  let best = { row: 1, score: -1, mapping: base }
  for (let r = 1; r <= Math.min(10, table.length); r++) {
    const headers = (table[r - 1] ?? []).map(norm).filter((h) => h !== '')
    const mapping: Record<string, string> = {}
    let score = 0
    for (const f of cfg.fields) {
      const exact = headers.find((h) => h === base[f.key])
      const syn = exact ?? (SYNONYMS[f.key] ?? []).map((w) => headers.find((h) => h === w) ?? headers.find((h) => h.includes(w))).find(Boolean)
      if (syn && !Object.values(mapping).includes(syn)) { mapping[f.key] = syn; score += f.required ? 2 : 1 }
    }
    if (score > best.score) best = { row: r, score, mapping }
  }
  return best
}

export async function previewImport(period: Period, cfg: IssueConfig, file: File): Promise<ImportPreview & { suggested: boolean }> {
  const mapping = await fetchColumnMapping(period, cfg.sourceKind)
  const { readRows } = await loadParser()
  const table = await readRows(file)
  const base = { file, buf: await file.arrayBuffer(), table, mappingScope: mapping.scope }
  const first = await remapPreview(cfg, base, mapping.header_row, mapping.mapping)
  if (first.missingColumns.length === 0) return { ...first, suggested: false }
  // 列名が合わないときは、見出しの行と列の候補を自動で選んで読み直す（画面で確かめて直せる）
  const s = suggestMapping(table, cfg, mapping.mapping)
  return { ...(await remapPreview(cfg, base, s.row, s.mapping)), suggested: true }
}

// 見出しの行・列の対応を変えて読み直す（ファイルは読み直さない）
export async function remapPreview(
  cfg: IssueConfig, base: { file: File; buf: ArrayBuffer; table: unknown[][]; mappingScope: string }, headerRow: number, mapping: Record<string, string>,
): Promise<ImportPreview> {
  const { mapRows } = await loadParser()
  const table = base.table as Parameters<typeof mapRows>[0]
  const { rows, missingColumns } = mapRows(table, headerRow, mapping, cfg.fields, cfg.keyField)
  const headers = (table[headerRow - 1] ?? []).map((h) => String(h ?? '').trim()).filter((h) => h !== '')
  return { ...base, rows, missingColumns, duplicateKeys: findDuplicates(rows), headerRow, headers, mapping }
}

// 画面で選び直した列の対応を、この会社の列マッピングとして保存する（次回から自動で読める）
export async function saveCompanyMapping(period: Period, cfg: IssueConfig, headerRow: number, mapping: Record<string, string>) {
  const software = period.companies.accounting_software ?? ''
  const existing = must(
    await supabase.from('column_mappings').select('id').eq('company_id', period.company_id).eq('source_kind', cfg.sourceKind).eq('software', software).maybeSingle(),
  ) as { id: string } | null
  const row = { company_id: period.company_id, source_kind: cfg.sourceKind, software, header_row: headerRow, mapping, is_hidden: false, updated_at: new Date().toISOString() }
  if (existing) must(await supabase.from('column_mappings').update(row).eq('id', existing.id))
  else must(await supabase.from('column_mappings').insert(row))
}

export interface RowsToSave {
  fileName: string
  buf: ArrayBuffer
  fileType: 'excel' | 'csv' | 'manual'
  contentType: string
  rows: { rowNo: number; itemKey: string; data: Record<string, unknown> }[]
}

// 取込を確定する：原本を保存し、明細を入れ替える（確定前の計算は「再計算待ち」として残す）
export async function commitImport(period: Period, cfg: IssueConfig, p: ImportPreview) {
  const ext = p.file.name.split('.').pop()?.toLowerCase() ?? 'bin'
  return commitRows(period, cfg, {
    fileName: p.file.name, buf: p.buf, fileType: ext === 'xlsx' ? 'excel' : 'csv', contentType: p.file.type || 'application/octet-stream',
    rows: p.rows.filter((r) => r.errors.length === 0 && r.itemKey !== ''),
  })
}

// ファイル取込・手入力の共通：元資料（手入力はCSVにして）を保存し、明細を入れ替える
export async function commitRows(period: Period, cfg: Pick<IssueConfig, 'code' | 'sourceKind'>, p: RowsToSave) {
  const hash = await sha256(p.buf)
  const ext = p.fileName.split('.').pop()?.toLowerCase() ?? 'bin'
  const path = `${period.id}/${cfg.code}/${Date.now()}_${hash.slice(0, 12)}.${ext}`
  must(await supabase.storage.from('source-files').upload(path, p.buf, { contentType: p.contentType }))
  const sf = must(
    await supabase.from('source_files').insert({
      period_id: period.id, issue_code: cfg.code, source_kind: cfg.sourceKind, file_name: p.fileName,
      file_type: p.fileType, storage_path: path, sha256: hash,
    }).select('id').single(),
  ) as { id: string }

  // 置き換え済みの古い計算は消す（仕訳明細が計算ステップを参照しているため、計算より先に仕訳を消す）
  const oldRuns = must(
    await supabase.from('calculation_runs').select('id, status').eq('period_id', period.id).eq('issue_code', cfg.code).neq('status', 'final'),
  ) as { id: string; status: string }[]
  const superseded = oldRuns.filter((r) => r.status === 'superseded').map((r) => r.id)
  if (superseded.length > 0) {
    must(await supabase.from('journal_entries').delete().in('run_id', superseded))
    must(await supabase.from('calculation_runs').delete().in('id', superseded))
  }
  // いまの下書きの計算は「再計算待ち」として残す（仕訳は再計算するまで連結精算表に残り、再計算のときに上書き前後を比べられる）
  // 明細を入れ替えるため、計算シートから明細への参照だけを外す
  const drafts = oldRuns.filter((r) => r.status === 'draft').map((r) => r.id)
  if (drafts.length > 0) must(await supabase.from('calculation_steps').update({ detail_item_id: null }).in('run_id', drafts))
  must(await supabase.from('detail_items').delete().eq('period_id', period.id).eq('issue_code', cfg.code))
  if (p.rows.length > 0) {
    must(
      await supabase.from('detail_items').insert(
        p.rows.map((r) => ({
          period_id: period.id, issue_code: cfg.code, item_key: r.itemKey, source_file_id: sf.id,
          source_row_no: r.rowNo, data: r.data,
        })),
      ),
    )
  }
  await setStatus(period.id, cfg.code, 'imported')
  return p.rows.length
}

// ---------------------------------------------------------------------------
// 収集パッケージから明細を作る論点：様式の入力を明細として取り込む
// ---------------------------------------------------------------------------

export interface PackageSource {
  entry: PackageEntry | null // 同じ基準日の様式
  others: Record<string, PackageEntry | null> // 計算に使うほかの様式
  rows: ItemRowData[]
  csv: string
  hash: string // いまの入力から作る元資料のハッシュ値
  lastHash: string | null // 最後に取り込んだ元資料のハッシュ値
}

export async function fetchPackageSource(period: Period, issueCode: string): Promise<PackageSource> {
  const def = PACKAGE_CALCS[issueCode]
  const forms = [def.formCode, ...(def.otherForms ?? [])]
  const [entries, files] = await Promise.all([
    supabase.from('package_entries').select('*').eq('company_id', period.company_id).eq('as_of', period.end_date).in('form_code', forms),
    supabase.from('source_files').select('sha256').eq('period_id', period.id).eq('issue_code', issueCode).order('uploaded_at', { ascending: false }).limit(1),
  ])
  const list = must(entries) as PackageEntry[]
  const of = (code: string) => list.find((e) => e.form_code === code) ?? null
  const entry = of(def.formCode)
  const rows = entry ? def.toRows(entry.data, (code) => of(code)?.data) : []
  const csv = packageCsv(def, rows)
  return {
    entry, others: Object.fromEntries((def.otherForms ?? []).map((c) => [c, of(c)])), rows, csv,
    hash: await sha256(new TextEncoder().encode(csv).buffer as ArrayBuffer), lastHash: (must(files) as { sha256: string }[])[0]?.sha256 ?? null,
  }
}

// 提出済・確認済の様式だけを取り込める（入力中は子会社がまだ直している途中のため）
export async function importFromPackage(period: Period, issueCode: string, src?: PackageSource) {
  const def = PACKAGE_CALCS[issueCode]
  const s = src ?? await fetchPackageSource(period, issueCode)
  const form = formByCode(def.formCode)
  if (!s.entry) throw new Error(`収集パッケージ「${form?.title ?? def.formCode}」がまだ入力されていません`)
  if (s.entry.status === 'draft') throw new Error(`収集パッケージ「${form?.title ?? def.formCode}」がまだ提出されていません（入力中）`)
  // 計算に使うほかの様式（退職給付②の数理計算結果）も、提出済・確認済であること
  for (const [code, e] of Object.entries(s.others)) {
    if (!e || e.status === 'draft') throw new Error(`計算に使う収集パッケージ「${formByCode(code)?.title ?? code}」がまだ提出されていません`)
  }
  if (s.rows.length === 0) throw new Error('収集パッケージに明細がありません（該当がないときは様式で「該当なし」にしてください）')
  return commitRows(period, { code: issueCode, sourceKind: 'package' }, {
    fileName: `${period.companies.code}_収集パッケージ_${form?.title ?? def.formCode}_${period.end_date}.csv`,
    buf: new TextEncoder().encode(s.csv).buffer as ArrayBuffer, fileType: 'csv', contentType: 'text/csv',
    // 行番号は元資料（CSV）の行。1行目は見出し
    rows: s.rows.map((r, i) => ({ rowNo: i + 2, itemKey: r.itemKey, data: r.data })),
  })
}

export async function fetchItems(periodId: string, issueCode: string): Promise<ItemRow[]> {
  return must(
    await supabase.from('detail_items')
      .select('id, item_key, data, source_row_no, review_status, checked_at, source_file_id')
      .eq('period_id', periodId).eq('issue_code', issueCode).order('item_key'),
  ) as ItemRow[]
}

export async function fetchSourceFiles(periodId: string, issueCode: string) {
  return must(
    await supabase.from('source_files').select('id, file_name, file_type, sha256, uploaded_at, storage_path')
      .eq('period_id', periodId).eq('issue_code', issueCode).order('uploaded_at', { ascending: false }),
  ) as { id: string; file_name: string; file_type: string; sha256: string; uploaded_at: string; storage_path: string }[]
}

export async function downloadSourceFile(storagePath: string) {
  return must(await supabase.storage.from('source-files').createSignedUrl(storagePath, 60))?.signedUrl ?? null
}

export async function setChecked(periodId: string, issueCode: string, ids: string[], checked: boolean) {
  must(
    await supabase.from('detail_items')
      .update({ review_status: checked ? 'checked' : 'pending', checked_at: checked ? new Date().toISOString() : null })
      .in('id', ids),
  )
  const items = await fetchItems(periodId, issueCode)
  const allChecked = items.length > 0 && items.every((i) => i.review_status === 'checked')
  const ws = await fetchWorkStatus(periodId, issueCode)
  // チェックを外したら、計算済でも「取込済」に戻す
  if (allChecked && ws?.status === 'imported') await setStatus(periodId, issueCode, 'checked')
  if (!allChecked && ws && ['checked', 'calculated'].includes(ws.status)) await setStatus(periodId, issueCode, 'imported')
}

export async function fetchActiveRun(periodId: string, issueCode: string): Promise<Run | null> {
  return must(
    await supabase.from('calculation_runs').select('id, status, assumptions_snapshot, input_hash, run_at')
      .eq('period_id', periodId).eq('issue_code', issueCode).in('status', ['draft', 'final']).maybeSingle(),
  ) as Run | null
}

export const itemsHash = (items: ItemRow[]) =>
  sha256(JSON.stringify(items.map((i) => [i.item_key, i.data]).sort()))

async function fetchPriorFinal(period: Period, issueCode: string) {
  if (!period.prior_period_id) return { run: null, balances: [] as PriorBalance[] }
  const run = must(
    await supabase.from('calculation_runs').select('id').eq('period_id', period.prior_period_id)
      .eq('issue_code', issueCode).eq('status', 'final').maybeSingle(),
  ) as { id: string } | null
  if (!run) return { run: null, balances: [] as PriorBalance[] }
  const rows = must(
    await supabase.from('item_balances')
      .select('item_key, balance_type, jgaap_amount, ifrs_amount, temporary_difference, movement_type, extra')
      .eq('run_id', run.id),
  ) as { item_key: string; balance_type: string; jgaap_amount: number; ifrs_amount: number; temporary_difference: number | null; movement_type: string; extra: Record<string, unknown> }[]
  return {
    run,
    balances: rows.map((r) => ({
      itemKey: r.item_key, balanceType: r.balance_type, jgaapAmount: Number(r.jgaap_amount),
      ifrsAmount: Number(r.ifrs_amount), temporaryDifference: r.temporary_difference === null ? null : Number(r.temporary_difference),
      movementType: r.movement_type, extra: r.extra,
    })),
  }
}

async function fetchAssetRules(period: Period) {
  const rows = must(
    await supabase.from('asset_class_rules').select('company_id, source_asset_type, useful_life_years, residual_rate, effective_from, note')
      .or(`company_id.is.null,company_id.eq.${period.company_id}`).lte('effective_from', period.end_date).eq('is_hidden', false)
      .order('effective_from', { ascending: false }),
  ) as { company_id: string | null; source_asset_type: string; useful_life_years: number; residual_rate: number; effective_from: string; note: string | null }[]
  const rules: Record<string, AssetRule & { scope: string; note: string | null }> = {}
  // 会社ごとの上書きを優先し、その中で適用開始日が新しいものを使う
  for (const r of [...rows].sort((a, b) => Number(b.company_id !== null) - Number(a.company_id !== null))) {
    if (rules[r.source_asset_type]) continue
    rules[r.source_asset_type] = {
      usefulLifeYears: Number(r.useful_life_years), residualRate: Number(r.residual_rate),
      scope: r.company_id ? '会社ごとの上書き' : 'グループ共通', note: r.note,
    }
  }
  return rules
}

export interface CalcPlan {
  result: CalcResult
  assumptions: Record<string, unknown>
}

// 計算する（DBには保存しない）。保存は saveCalculation で行う
export async function planCalculation(period: Period, issueCode: string, items: ItemRow[]): Promise<CalcPlan> {
  const [policy, taxRate, prior] = await Promise.all([fetchPolicy(period.id, issueCode), fetchTaxRate(period.id), fetchPriorFinal(period, issueCode)])
  const def = PACKAGE_CALCS[issueCode]
  const noTaxRate = '税効果の方針に実効税率（effective_tax_rate）が設定されていません'
  if (taxRate === null && def?.taxCategory) throw new Error(noTaxRate)
  const detail: DetailItem[] = items.map((i) => ({ id: i.id, itemKey: i.item_key, data: i.data }))

  if (def) {
    const missing = def.requires?.(policy.params)
    if (missing) throw new Error(missing)
    const result = calcPackageIssue(def, {
      items: detail, asOf: period.end_date, periodStart: period.start_date, params: policy.params, taxRate, priorBalances: prior.balances,
    })
    if (period.prior_period_id && !prior.run) {
      result.warnings.unshift('前期の計算が確定していないため、期首の調整額を0として計算します（アプリ初年度の扱い。期首の残高は当期の変動に入ります）')
    }
    if (prior.run && prior.balances.length === 0) {
      // 明細から計算する前の形（仕訳だけ）で確定した前期の計算：開始仕訳には入るのに期首の調整額が0になり、二重に計上される
      result.warnings.unshift('前期の確定した計算に明細ごとの残高がありません（明細から計算する前の形）。期首の調整額が0になり、開始仕訳と二重になります。前期を取り込み直して再計算・確定してから計算してください')
    }
    return {
      result,
      assumptions: { policy, tax_rate: taxRate, params_used: def.params?.(policy.params) ?? [], prior_run_id: prior.run?.id ?? null },
    }
  }
  if (taxRate === null) throw new Error(noTaxRate)

  if (issueCode === 'PAID_LEAVE') {
    const expectedUsageRate = Number(policy.params.expected_usage_rate)
    const socialInsuranceRate = Number(policy.params.social_insurance_rate ?? 0)
    if (!Number.isFinite(expectedUsageRate)) throw new Error('有給休暇の方針に消化見込率（expected_usage_rate）が設定されていません')
    const result = calcPaidLeave({ items: detail, expectedUsageRate, socialInsuranceRate, taxRate, priorBalances: prior.balances })
    return {
      result,
      assumptions: { policy, tax_rate: taxRate, expected_usage_rate: expectedUsageRate, social_insurance_rate: socialInsuranceRate, prior_run_id: prior.run?.id ?? null },
    }
  }
  if (issueCode === 'DEPRECIATION') {
    const rules = await fetchAssetRules(period)
    const priorTaxRate = (await fetchTaxRate(period.prior_period_id)) ?? taxRate
    const result = calcDepreciation({
      items: detail, periodStart: period.start_date, periodEnd: period.end_date,
      ruleFor: (t) => rules[t] ?? null, priorBalances: prior.balances, hasPriorFinal: prior.run !== null,
      taxRate, priorTaxRate,
    })
    if (period.prior_period_id && !prior.run) {
      result.warnings.unshift('前期の計算が確定していないため、期首の累積差額は台帳から算定し、利益剰余金に計上します（アプリ初年度の扱い）')
    }
    return {
      result,
      assumptions: { policy, tax_rate: taxRate, prior_tax_rate: priorTaxRate, asset_class_rules: rules, prior_run_id: prior.run?.id ?? null },
    }
  }
  throw new Error('この論点の計算はまだ実装していません')
}

export async function saveCalculation(period: Period, issueCode: string, items: ItemRow[], plan: CalcPlan) {
  const { result } = plan
  // 有効な計算は1つだけ：既存の下書きを置き換える
  must(
    await supabase.from('calculation_runs').update({ status: 'superseded' })
      .eq('period_id', period.id).eq('issue_code', issueCode).in('status', ['draft', 'final']),
  )
  const run = must(
    await supabase.from('calculation_runs').insert({
      period_id: period.id, issue_code: issueCode, assumptions_snapshot: { ...plan.assumptions, warnings: result.warnings },
      input_hash: await itemsHash(items),
    }).select('id').single(),
  ) as { id: string }

  const steps = must(
    await supabase.from('calculation_steps').insert(
      result.steps.map((s) => ({
        run_id: run.id, item_key: s.itemKey, step_no: s.stepNo, label: s.label, formula: s.formula,
        value: s.value, detail_item_id: s.detailItemId ?? null,
      })),
    ).select('id, item_key, step_no'),
  ) as { id: string; item_key: string | null; step_no: number }[]
  const stepId = new Map(steps.map((s) => [`${s.item_key ?? ''}#${s.step_no}`, s.id]))

  if (result.balances.length > 0) {
    must(
      await supabase.from('item_balances').insert(
        result.balances.map((b) => ({
          run_id: run.id, period_id: period.id, issue_code: issueCode, item_key: b.itemKey, balance_type: b.balanceType,
          jgaap_amount: b.jgaapAmount, ifrs_amount: b.ifrsAmount, oci_accumulated: b.ociAccumulated,
          temporary_difference: b.temporaryDifference, movement_type: b.movementType, extra: b.extra,
        })),
      ),
    )
  }

  for (const [i, e] of result.entries.entries()) {
    const entry = must(
      await supabase.from('journal_entries').insert({
        run_id: run.id, period_id: period.id, issue_code: issueCode, category_code: e.categoryCode,
        entry_no: i + 1, description: e.description,
      }).select('id').single(),
    ) as { id: string }
    must(
      await supabase.from('journal_lines').insert(
        e.lines.map((l, j) => ({
          entry_id: entry.id, line_no: j + 1, side: l.side, group_account_code: l.account, amount: l.amount, memo: l.memo ?? null,
          calculation_step_id: l.stepRef ? stepId.get(`${l.stepRef.itemKey ?? ''}#${l.stepRef.stepNo}`) ?? null : null,
        })),
      ),
    )
  }
  await setStatus(period.id, issueCode, 'calculated')
  return run.id
}

export async function lockIssue(periodId: string, issueCode: string, runId: string) {
  must(await supabase.from('calculation_runs').update({ status: 'final' }).eq('id', runId))
  await setStatus(periodId, issueCode, 'locked')
}

export async function unlockIssue(periodId: string, issueCode: string, runId: string) {
  await setStatus(periodId, issueCode, 'calculated')
  must(await supabase.from('calculation_runs').update({ status: 'draft' }).eq('id', runId))
}

export interface StepRow {
  id: string
  item_key: string | null
  step_no: number
  label: string
  formula: string | null
  value: number | null
}

export async function fetchSteps(runId: string): Promise<StepRow[]> {
  return must(
    await supabase.from('calculation_steps').select('id, item_key, step_no, label, formula, value')
      .eq('run_id', runId).order('item_key', { nullsFirst: true }).order('step_no'),
  ) as StepRow[]
}

export interface EntryRow {
  id: string
  entry_no: number
  description: string
  category_code: string
  journal_categories: { name: string; carry_method: string; is_tax_effect: boolean }
  journal_lines: {
    line_no: number
    side: 'debit' | 'credit'
    amount: number
    memo: string | null
    group_account_code: string
    calculation_step_id: string | null
    group_accounts: { name: string; statement: string; bs_class: string | null; pl_class: string | null }
  }[]
}

export async function fetchEntries(runId: string): Promise<EntryRow[]> {
  const rows = must(
    await supabase.from('journal_entries')
      .select('id, entry_no, description, category_code, journal_categories(name, carry_method, is_tax_effect), journal_lines(line_no, side, amount, memo, group_account_code, calculation_step_id, group_accounts(name, statement, bs_class, pl_class))')
      .eq('run_id', runId).order('entry_no'),
  ) as unknown as EntryRow[]
  for (const r of rows) r.journal_lines.sort((a, b) => a.line_no - b.line_no)
  return rows
}

export async function fetchBalances(runId: string) {
  return must(
    await supabase.from('item_balances')
      .select('item_key, balance_type, jgaap_amount, ifrs_amount, difference, temporary_difference, movement_type, extra')
      .eq('run_id', runId).order('item_key'),
  ) as { item_key: string; jgaap_amount: number; ifrs_amount: number; difference: number; temporary_difference: number | null; movement_type: string; extra: Record<string, unknown> }[]
}

export async function fetchMissingCarryforward(periodId: string, issueCode: string) {
  return must(
    await supabase.from('v_missing_carryforward').select('item_key, balance_type, prior_closing_difference')
      .eq('period_id', periodId).eq('issue_code', issueCode),
  ) as { item_key: string; balance_type: string; prior_closing_difference: number }[]
}
