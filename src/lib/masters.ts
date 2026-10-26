// 一覧画面で共通に使うマスタの読み込み

import { parseSlot, type Slot } from './hooks'
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
  period_type: 'Q1' | 'Q2' | 'Q3' | 'FY'
}

export interface MasterData {
  issues: Issue[]
  companies: Company[]
  periods: PeriodRow[]
  // 会社ごとの、指定した時点の期（前期・当期 × 四半期・期末）
  periodFor: (companyId: string, slot: Slot) => PeriodRow | undefined
  // 前期・当期の年度名（画面の切り替えに出す。3月決算の会社の名前を代表にする）
  yearLabels: { prior: string; current: string }
}

// 年度（本決算の期）だけを、古い順に並べる
export const fiscalYears = (periods: PeriodRow[], companyId: string) =>
  periods.filter((p) => p.company_id === companyId && p.period_type === 'FY')

export async function fetchMasters(): Promise<MasterData> {
  const [issues, companies, periods] = await Promise.all([
    // 非表示にした論点は、一覧・集計に出さない
    supabase.from('issues').select('*').eq('is_hidden', false).order('no'),
    supabase.from('companies').select('*').eq('is_active', true).order('code'),
    supabase.from('periods').select('id, company_id, label, start_date, end_date, prior_period_id, period_type').order('end_date'),
  ])
  const ps = must(periods) as PeriodRow[]
  return {
    issues: must(issues) as Issue[],
    companies: must(companies) as Company[],
    periods: ps,
    periodFor: (companyId, slot) => {
      const { fy, q } = parseSlot(slot)
      const years = fiscalYears(ps, companyId)
      const year = fy === 'current' ? years[years.length - 1] : years[years.length - 2]
      if (!year || q === 'FY') return year
      return ps.find((p) => p.company_id === companyId && p.period_type === q && p.start_date === year.start_date)
    },
    yearLabels: (() => {
      const cs = must(companies) as Company[]
      const rep = cs.find((c) => c.fiscal_year_end_month === 3) ?? cs[0]
      const years = rep ? fiscalYears(ps, rep.id) : []
      return { prior: years.at(-2)?.label ?? '前期', current: years.at(-1)?.label ?? '当期' }
    })(),
  }
}
