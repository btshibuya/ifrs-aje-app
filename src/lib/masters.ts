// 一覧画面で共通に使うマスタの読み込み

import type { Slot } from './hooks'
import { must, supabase } from './supabase'
import type { Company } from './workflow'

export interface Issue {
  code: string
  no: number
  name: string
  standard_ref: string | null
}

export interface PeriodRow {
  id: string
  company_id: string
  label: string
  start_date: string
  end_date: string
  prior_period_id: string | null
}

export interface MasterData {
  issues: Issue[]
  companies: Company[]
  periods: PeriodRow[]
  // 会社ごとの、指定した期（前期 or 当期）
  periodFor: (companyId: string, slot: Slot) => PeriodRow | undefined
}

export async function fetchMasters(): Promise<MasterData> {
  const [issues, companies, periods] = await Promise.all([
    // 非表示にした論点は、一覧・集計に出さない
    supabase.from('issues').select('*').eq('is_hidden', false).order('no'),
    supabase.from('companies').select('*').eq('is_active', true).order('code'),
    supabase.from('periods').select('id, company_id, label, start_date, end_date, prior_period_id').order('end_date'),
  ])
  const ps = must(periods) as PeriodRow[]
  return {
    issues: must(issues) as Issue[],
    companies: must(companies) as Company[],
    periods: ps,
    periodFor: (companyId, slot) => {
      const own = ps.filter((p) => p.company_id === companyId)
      return slot === 'current' ? own[own.length - 1] : own[own.length - 2]
    },
  }
}
