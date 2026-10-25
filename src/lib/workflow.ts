// 会社×期×論点の作業（取込 → チェック → 計算 → 確定）とDBの読み書き

import { calcDepreciation, type AssetRule } from '../calc/depreciation'
import { calcPaidLeave } from '../calc/paidLeave'
import type { CalcResult, DetailItem, PriorBalance } from '../calc/types'
import type { IssueConfig } from './issues'
import { mapRows, readRows, sha256, type MappedRow } from './parse'
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
  companies: Company
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
    await supabase.from('column_mappings').select('company_id, software, header_row, mapping').eq('source_kind', sourceKind),
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
}

export async function previewImport(period: Period, cfg: IssueConfig, file: File): Promise<ImportPreview> {
  const mapping = await fetchColumnMapping(period, cfg.sourceKind)
  const table = await readRows(file)
  const { rows, missingColumns } = mapRows(table, mapping.header_row, mapping.mapping, cfg.fields, cfg.keyField)
  const seen = new Set<string>()
  const duplicateKeys = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.itemKey)) duplicateKeys.add(r.itemKey)
    seen.add(r.itemKey)
  }
  return { file, buf: await file.arrayBuffer(), rows, missingColumns, mappingScope: mapping.scope, duplicateKeys: [...duplicateKeys] }
}

// 取込を確定する：原本を保存し、明細を入れ替える（確定前の計算は削除する）
export async function commitImport(period: Period, cfg: IssueConfig, p: ImportPreview) {
  const hash = await sha256(p.buf)
  const ext = p.file.name.split('.').pop()?.toLowerCase() ?? 'bin'
  const path = `${period.id}/${cfg.code}/${Date.now()}_${hash.slice(0, 12)}.${ext}`
  must(await supabase.storage.from('source-files').upload(path, p.buf, { contentType: p.file.type || 'application/octet-stream' }))
  const sf = must(
    await supabase.from('source_files').insert({
      period_id: period.id, issue_code: cfg.code, source_kind: cfg.sourceKind, file_name: p.file.name,
      file_type: ext === 'xlsx' ? 'excel' : 'csv', storage_path: path, sha256: hash,
    }).select('id').single(),
  ) as { id: string }

  must(await supabase.from('calculation_runs').delete().eq('period_id', period.id).eq('issue_code', cfg.code).neq('status', 'final'))
  must(await supabase.from('detail_items').delete().eq('period_id', period.id).eq('issue_code', cfg.code))
  const valid = p.rows.filter((r) => r.errors.length === 0 && r.itemKey !== '')
  if (valid.length > 0) {
    must(
      await supabase.from('detail_items').insert(
        valid.map((r) => ({
          period_id: period.id, issue_code: cfg.code, item_key: r.itemKey, source_file_id: sf.id,
          source_row_no: r.rowNo, data: r.data,
        })),
      ),
    )
  }
  await setStatus(period.id, cfg.code, 'imported')
  return valid.length
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
    await supabase.from('source_files').select('id, file_name, sha256, uploaded_at, storage_path')
      .eq('period_id', periodId).eq('issue_code', issueCode).order('uploaded_at', { ascending: false }),
  ) as { id: string; file_name: string; sha256: string; uploaded_at: string; storage_path: string }[]
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
      .or(`company_id.is.null,company_id.eq.${period.company_id}`).lte('effective_from', period.end_date)
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
  const policy = await fetchPolicy(period.id, issueCode)
  const taxRate = await fetchTaxRate(period.id)
  if (taxRate === null) throw new Error('税効果の方針に実効税率（effective_tax_rate）が設定されていません')
  const prior = await fetchPriorFinal(period, issueCode)
  const detail: DetailItem[] = items.map((i) => ({ id: i.id, itemKey: i.item_key, data: i.data }))

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
    group_accounts: { name: string; statement: string }
  }[]
}

export async function fetchEntries(runId: string): Promise<EntryRow[]> {
  const rows = must(
    await supabase.from('journal_entries')
      .select('id, entry_no, description, category_code, journal_categories(name, carry_method, is_tax_effect), journal_lines(line_no, side, amount, memo, group_account_code, calculation_step_id, group_accounts(name, statement))')
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
