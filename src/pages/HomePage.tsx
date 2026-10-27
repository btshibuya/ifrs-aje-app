// ホーム：作業の流れと各段階の件数、いま対応が必要なことを1画面で見せる

import { Link } from 'react-router-dom'
import { StackedBar } from '../components/charts'
import { ErrorBox, Loading, PageHeader, SlotToggle, formatDateTime } from '../components/ui'
import { useAsync, useSlot } from '../lib/hooks'
import { hasCalc } from '../lib/packageCalc'
import { fetchMasters, type PeriodRow } from '../lib/masters'
import { formByCode } from '../lib/materials'
import { fetchStatusContext, materialStates, summarize, summarizeCompanies } from '../lib/package'
import { fetchAll, must, supabase } from '../lib/supabase'

type Severity = 'critical' | 'warning' | 'info'
interface Todo { severity: Severity; who: string; title: string; detail: string; to: string }

const SEVERITY_LABELS: Record<Severity, string> = { critical: '要修正', warning: '要確認', info: '対応待ち' }
const SEVERITY_ICONS: Record<Severity, string> = { critical: '!', warning: '△', info: '●' }

export default function HomePage() {
  const [slot, setSlot] = useSlot()
  const { data, error, loading } = useAsync(async () => {
    const m = await fetchMasters()
    const periods = m.companies.map((c) => m.periodFor(c.id, slot)).filter((p): p is PeriodRow => !!p)
    const pids = periods.map((p) => p.id)
    // 連結の基準日（親会社の時点）の、最新の集計の記録
    const asOf = periods.map((p) => p.end_date).sort().at(-1) ?? ''
    const [ctx, missing, unbalanced, entries, snap] = await Promise.all([
      fetchStatusContext(pids, m.companies.map((c) => c.id), periods.map((p) => p.end_date), m.issues.map((i) => i.code)),
      fetchAll<{ period_id: string; issue_code: string; item_key: string }>((from, to) => supabase.from('v_missing_carryforward').select('period_id, issue_code, item_key').in('period_id', pids).order('period_id').order('issue_code').order('item_key').range(from, to)),
      supabase.from('v_unbalanced_entries').select('period_id, issue_code, entry_no').in('period_id', pids),
      supabase.from('package_entries').select('company_id, as_of, form_code, status, return_note').in('company_id', m.companies.map((c) => c.id)).in('as_of', periods.map((p) => p.end_date)),
      supabase.from('consolidation_snapshots').select('created_at, created_by').eq('as_of', asOf).order('created_at', { ascending: false }).limit(1),
    ])
    return {
      m, periods, ctx,
      missing,
      unbalanced: must(unbalanced) as { period_id: string; issue_code: string; entry_no: number }[],
      entries: must(entries) as { company_id: string; as_of: string; form_code: string; status: string; return_note: string | null }[],
      snapshot: (must(snap) as { created_at: string; created_by: string | null }[])[0] ?? null,
    }
  }, [slot])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { m, periods, ctx } = data
  const company = (id: string) => m.companies.find((c) => c.id === id)
  const periodOf = (pid: string) => periods.find((p) => p.id === pid)
  const issueName = (code: string) => m.issues.find((i) => i.code === code)?.name ?? code

  // 段階ごとの件数（適用の会社×論点）
  const applied = ctx.policies.filter((p) => p.applicability === 'applied' && hasCalc(p.issue_code))
  const statusOf = (pid: string, ic: string) => ctx.work.find((w) => w.period_id === pid && w.issue_code === ic)?.status ?? 'not_started'
  const reached = (min: string[]) => applied.filter((p) => min.includes(statusOf(p.period_id, p.issue_code))).length
  // 資料は会社ごとに数えて合計する（同じファイルを1件と数えるのは会社の中だけ）
  const materials = summarizeCompanies(periods.map((p) => materialStates(ctx, p)))

  const stages = [
    { key: 'collect', no: 1, title: '資料を集める', note: '子会社の担当者が提出', done: materials.done, total: materials.total, to: '/materials' },
    { key: 'import', no: 2, title: '取り込み・明細チェック', note: '親会社が内容を確認', done: reached(['checked', 'calculated', 'locked']), total: applied.length, to: '/progress' },
    { key: 'calc', no: 3, title: '計算する', note: '計算シートで根拠を確認', done: reached(['calculated', 'locked']), total: applied.length, to: '/progress' },
    { key: 'lock', no: 4, title: '仕訳を確定する', note: '確定するとDBでロック', done: reached(['locked']), total: applied.length, to: '/progress' },
    {
      key: 'consolidate', no: 5, title: '連結精算表で集計する', done: reached(['locked']), total: applied.length, to: '/consolidation',
      note: data.snapshot ? `集計済み：${formatDateTime(data.snapshot.created_at)}（${data.snapshot.created_by ?? '—'}）` : 'まだ集計していません（親会社）',
    },
  ]

  // いま対応が必要なこと
  const todos: Todo[] = []
  for (const e of data.entries) {
    const c = company(e.company_id)
    const form = formByCode(e.form_code)
    if (!c || !form) continue
    if (e.status === 'draft' && e.return_note) todos.push({ severity: 'critical', who: '子会社', title: `差し戻された様式を直す：${form.title}`, detail: `${c.code} ${c.name} ／ 理由：${e.return_note}`, to: `/package/${c.code}/${e.as_of}/${e.form_code}` })
    if (e.status === 'submitted') todos.push({ severity: 'info', who: '親会社', title: `提出された様式を確認する：${form.title}`, detail: `${c.code} ${c.name}`, to: `/package/${c.code}/${e.as_of}/${e.form_code}` })
  }
  for (const u of data.unbalanced) {
    const p = periodOf(u.period_id)
    if (p) todos.push({ severity: 'critical', who: '親会社', title: `貸借が一致しない仕訳がある（仕訳 No.${u.entry_no}）`, detail: `${company(p.company_id)?.code} ${company(p.company_id)?.name} ／ ${issueName(u.issue_code)}`, to: `/work/${p.id}/${u.issue_code}` })
  }
  const missingBy = new Map<string, string[]>()
  // まだ計算していない（未着手の）会社×論点は、当期の計算がないため数えない
  for (const x of data.missing.filter((r) => statusOf(r.period_id, r.issue_code) !== 'not_started')) missingBy.set(`${x.period_id}|${x.issue_code}`, [...(missingBy.get(`${x.period_id}|${x.issue_code}`) ?? []), x.item_key])
  for (const [k, keys] of missingBy) {
    const [pid, ic] = k.split('|')
    const p = periodOf(pid)
    if (p) todos.push({ severity: 'warning', who: '親会社', title: `前期末にあって当期に出てこない明細が${keys.length}件ある`, detail: `${company(p.company_id)?.code} ${company(p.company_id)?.name} ／ ${issueName(ic)}：${keys.join('、')}（除却・売却の処理漏れの可能性）`, to: `/work/${p.id}/${ic}` })
  }
  for (const w of ctx.work.filter((x) => x.status === 'calculated')) {
    const p = periodOf(w.period_id)
    if (p) todos.push({ severity: 'info', who: '親会社', title: '計算済みで、まだ確定していない', detail: `${company(p.company_id)?.code} ${company(p.company_id)?.name} ／ ${issueName(w.issue_code)}`, to: `/work/${p.id}/${w.issue_code}` })
  }
  const order: Severity[] = ['critical', 'warning', 'info']
  todos.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity))

  // 資料の提出が遅れている会社（提出率の低い順）
  const laggards = periods
    .map((p) => ({ p, c: company(p.company_id)!, s: summarize(materialStates(ctx, p)) }))
    .filter((x) => x.s.total > 0)
    .sort((a, b) => a.s.done / a.s.total - b.s.done / b.s.total)

  return (
    <div className="stack">
      <PageHeader title="ホーム">
        <SlotToggle slot={slot} onChange={setSlot} years={m.yearLabels} />
      </PageHeader>

      <section aria-label="作業の流れ">
        <h2 className="section-title">作業の流れと進み具合</h2>
        <ol className="flow">
          {stages.map((s) => {
            const rate = s.total ? Math.round((s.done / s.total) * 100) : 0
            return (
              <li key={s.key} className="flow-step">
                <Link to={s.to} className="flow-card">
                  <div className="flow-head"><span className="flow-no">{s.no}</span>{s.title}</div>
                  <div className="flow-value">{rate}%<small>{s.done} / {s.total}</small></div>
                  <StackedBar height={8} segments={[
                    { key: 'done', label: '済', value: s.done, color: 'var(--viz-st-locked)' },
                    { key: 'rest', label: '未', value: Math.max(s.total - s.done, 0), color: 'var(--viz-st-not_started)' },
                  ]} />
                  <div className="small muted">{s.note}</div>
                </Link>
              </li>
            )
          })}
        </ol>
        <p className="small muted">2〜5 は、適用の会社×論点（全17論点）の件数です。どの段階も、押すと一覧に移ります。</p>
      </section>

      <div className="home-grid">
        <section className="card" aria-label="対応が必要なこと">
          <div className="card-title">対応が必要なこと<span className="small muted">{todos.length}件</span></div>
          {todos.length === 0 ? (
            <div className="empty-ok"><span aria-hidden>✓</span> いま対応が必要なことはありません。</div>
          ) : (
            <ul className="todo-list">
              {todos.slice(0, 12).map((t, i) => (
                <li key={i}>
                  <Link to={t.to} className="todo">
                    <span className={`sev sev-${t.severity}`}><span aria-hidden>{SEVERITY_ICONS[t.severity]}</span>{SEVERITY_LABELS[t.severity]}</span>
                    <span className="todo-body">
                      <b>{t.title}</b>
                      <span className="small muted">{t.detail}</span>
                    </span>
                    <span className="todo-who small">{t.who}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {todos.length > 12 && <p className="small muted">ほか {todos.length - 12}件。チェック画面・進捗一覧で確認できます。</p>}
        </section>

        <section className="card" aria-label="資料の提出状況">
          <div className="card-title">資料の提出（遅れている順）<Link className="small" to="/materials">資料一覧へ</Link></div>
          <ul className="lag-list">
            {laggards.map(({ p, c, s }) => (
              <li key={p.id}>
                <Link to={`/materials/${c.code}`} className="lag">
                  <span className="lag-name">{c.code} {c.name}</span>
                  <span className="lag-bar">
                    <StackedBar height={8} segments={[
                      { key: 'done', label: '提出済', value: s.done, color: 'var(--mst-submitted)' },
                      { key: 'draft', label: '入力中', value: s.counts.draft ?? 0, color: 'var(--mst-draft)' },
                      { key: 'todo', label: '未提出', value: s.counts.todo ?? 0, color: 'var(--mst-todo)' },
                    ]} />
                  </span>
                  <span className="small nowrap">{s.done}/{s.total}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
