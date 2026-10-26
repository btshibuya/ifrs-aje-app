// デモ用の計算データ（S02〜S10）を、アプリの取込・計算・確定の処理そのもので作る
//   前期（2026年3月期・S10は2025年12月期）の期末：確定
//   当期の第1四半期：確定、第2四半期：一部は下書き（親会社の確認待ち）
//   第2四半期は集計の記録を作り、そのあとで S03 の有給休暇を上書きする（精算表の「上書き前後」を見せる）
// S01 は、README のデモの流れ（取込→計算→確定）を手で試すために空けておく
// 作ったデータには is_demo_seed を付け、試験データの片付けでは消さない

import { it } from 'vitest'
import { ISSUE_CONFIGS } from '../src/lib/issues'
import { fetchMasters, type PeriodRow } from '../src/lib/masters'
import { fetchConsolidation, saveSnapshot } from '../src/lib/consolidation'
import { must, supabase } from '../src/lib/supabase'
import { commitRows, fetchItems, fetchPeriod, lockIssue, planCalculation, saveCalculation, setChecked } from '../src/lib/workflow'

// 決まった並びの乱数（何度作っても同じデータになる）
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
const monthIdx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1

const LEAVE = ['S02', 'S03', 'S04', 'S06', 'S07', 'S08', 'S09', 'S10']
const DEPR = ['S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S10']
// 第2四半期を下書きのままにする会社×論点（親会社の確認待ち）
const Q2_DRAFT = new Set(['S03|PAID_LEAVE', 'S07|DEPRECIATION', 'S10|PAID_LEAVE'])

function leaveRows(code: string, p: PeriodRow, version = 0) {
  const r = rng([...code].reduce((s, c) => s * 31 + c.charCodeAt(0), 7))
  const n = 18 + Math.floor(r() * 30)
  const q = monthIdx(p.end_date) - monthIdx(p.start_date) // 期首からの月数
  return Array.from({ length: n }, (_, i) => {
    const base = Math.round((6 + r() * 30) * 2) / 2
    const wage = Math.round((12000 + r() * 30000) / 100) * 100
    // 四半期が進むと消化して減り、期末に付与で戻る。version は上書き（一部の人の残日数の訂正）
    const days = Math.max(0, Math.round((base - (q % 12) * 0.9 * r() + (version && i % 5 === 0 ? 4.5 : 0)) * 2) / 2)
    return { employee_no: `${code}-${String(i + 1).padStart(4, '0')}`, name: `従業員${i + 1}`, unused_days: days, daily_wage: wage }
  })
}

const TYPES: [string, number][] = [['建物', 38], ['建物附属設備', 15], ['機械装置', 10], ['車両運搬具', 6], ['工具器具備品', 6], ['ソフトウェア', 5]]
function deprRows(code: string, p: PeriodRow) {
  const r = rng([...code].reduce((s, c) => s * 17 + c.charCodeAt(0), 3))
  const n = 8 + Math.floor(r() * 8)
  const s = monthIdx(p.start_date)
  const e = monthIdx(p.end_date)
  const rows = []
  for (let i = 0; i < n; i++) {
    const [type, life] = TYPES[Math.floor(r() * TYPES.length)]
    const acqY = 2014 + Math.floor(r() * 12)
    const acqM = 1 + Math.floor(r() * 12)
    const acquired = `${acqY}-${String(acqM).padStart(2, '0')}-01`
    const a = monthIdx(acquired)
    if (a > e) continue
    const cost = Math.round((type === '建物' ? 80e6 : type === '機械装置' ? 25e6 : 4e6) * (0.4 + r()) / 1000) * 1000
    const monthly = cost / (life * 12)
    const bv = (m: number) => Math.max(1, Math.round(cost - monthly * Math.max(0, m - a + 1)))
    const inPeriod = a >= s
    const opening = inPeriod ? null : bv(s - 1)
    const closing = bv(e)
    const dep = (inPeriod ? cost : opening!) - closing
    rows.push({ asset_no: `${code}-A${String(i + 1).padStart(3, '0')}`, name: `${type}${i + 1}`, asset_type: type, acquired_on: acquired, cost, jgaap_life: life, jgaap_opening_bv: opening, jgaap_depreciation: dep, jgaap_closing_bv: closing, disposed_on: null })
  }
  return rows
}

async function seedOne(code: string, issue: 'PAID_LEAVE' | 'DEPRECIATION', p: PeriodRow, final: boolean, version = 0) {
  const cfg = ISSUE_CONFIGS[issue]
  const period = await fetchPeriod(p.id)
  const rows = (issue === 'PAID_LEAVE' ? leaveRows(code, p, version) : deprRows(code, p)) as Record<string, unknown>[]
  const head = cfg.fields.map((f) => f.label)
  const csv = '﻿' + [head, ...rows.map((x) => cfg.fields.map((f) => x[f.key] ?? ''))].map((r) => r.join(',')).join('\r\n')
  await commitRows(period, cfg, {
    fileName: `${code}_${cfg.sourceLabel}_${p.label}${version ? '_訂正' : ''}.csv`, buf: new TextEncoder().encode(csv).buffer as ArrayBuffer, fileType: 'csv', contentType: 'text/csv',
    rows: rows.map((x, i) => ({ rowNo: i + 2, itemKey: String(x[cfg.keyField]), data: x })),
  })
  must(await supabase.from('source_files').update({ is_demo_seed: true }).eq('period_id', p.id).eq('issue_code', issue))
  must(await supabase.from('detail_items').update({ is_demo_seed: true }).eq('period_id', p.id).eq('issue_code', issue))
  const items = await fetchItems(p.id, issue)
  await setChecked(p.id, issue, items.map((i) => i.id), true)
  const checked = await fetchItems(p.id, issue)
  const plan = await planCalculation(period, issue, checked)
  const runId = await saveCalculation(period, issue, checked, plan)
  must(await supabase.from('calculation_runs').update({ is_demo_seed: true }).eq('id', runId))
  if (final) await lockIssue(p.id, issue, runId)
  must(await supabase.from('work_status').update({ is_demo_seed: true }).eq('period_id', p.id).eq('issue_code', issue))
  console.log(`${code} ${issue} ${p.label}${final ? ' 確定' : ' 下書き'}`)
}

it('デモ用の計算データを作る', async () => {
  const m = await fetchMasters()
  const plan: [string, 'PAID_LEAVE' | 'DEPRECIATION'][] = [...LEAVE.map((c) => [c, 'PAID_LEAVE'] as [string, 'PAID_LEAVE']), ...DEPR.map((c) => [c, 'DEPRECIATION'] as [string, 'DEPRECIATION'])]
  for (const [code, issue] of plan) {
    const c = m.companies.find((x) => x.code === code)!
    const fy = m.periodFor(c.id, 'prior:FY')!
    const q1 = m.periodFor(c.id, 'current:Q1')!
    const q2 = m.periodFor(c.id, 'current:Q2')!
    await seedOne(code, issue, fy, true)
    await seedOne(code, issue, q1, true)
    await seedOne(code, issue, q2, !Q2_DRAFT.has(`${code}|${issue}`))
  }
  // 第2四半期の集計を記録し、そのあとで S03 の有給休暇（下書き）を訂正して上書きする
  const d = await fetchConsolidation(m, 'current:Q2')
  await saveSnapshot(d, d.lines, '連結 山田（デモ）', 'デモ用の集計')
  must(await supabase.from('consolidation_snapshots').update({ is_demo_seed: true }).eq('as_of', d.asOf))
  const s03 = m.companies.find((x) => x.code === 'S03')!
  await seedOne('S03', 'PAID_LEAVE', m.periodFor(s03.id, 'current:Q2')!, false, 1)
})
