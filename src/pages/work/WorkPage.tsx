import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApplicabilityBadge, ErrorBox, Loading, StatusBadge, Tabs } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import { ISSUE_CONFIGS, STATUS_LABELS } from '../../lib/issues'
import { must, supabase } from '../../lib/supabase'
import { fetchActiveRun, fetchItems, fetchPeriod, fetchPolicy, fetchWorkStatus, itemsHash } from '../../lib/workflow'
import CalcTab from './CalcTab'
import ImportTab from './ImportTab'
import ItemsTab from './ItemsTab'
import JournalTab from './JournalTab'

type TabKey = 'import' | 'items' | 'calc' | 'journal'
const STEPS = ['imported', 'checked', 'calculated', 'locked']

export default function WorkPage() {
  const { periodId = '', issueCode = '' } = useParams()
  const cfg = ISSUE_CONFIGS[issueCode]
  const [tab, setTab] = useState<TabKey | null>(null)

  const { data, error, loading, reload } = useAsync(async () => {
    const [period, policy, ws, items, run, issue] = await Promise.all([
      fetchPeriod(periodId), fetchPolicy(periodId, issueCode), fetchWorkStatus(periodId, issueCode),
      fetchItems(periodId, issueCode), fetchActiveRun(periodId, issueCode),
      supabase.from('issues').select('name, no, standard_ref').eq('code', issueCode).single(),
    ])
    const [next] = must(await supabase.from('periods').select('id, label').eq('prior_period_id', periodId)) as { id: string; label: string }[]
    const prior = period.prior_period_id
      ? (must(await supabase.from('periods').select('id, label').eq('id', period.prior_period_id).single()) as { id: string; label: string })
      : null
    const stale = run ? (await itemsHash(items)) !== run.input_hash : false
    return { period, policy, ws, items, run, stale, issue: must(issue) as { name: string; no: number; standard_ref: string }, next, prior }
  }, [periodId, issueCode])


  if (!cfg) return <ErrorBox message="この論点の作業画面はまだ実装していません" />
  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null

  const { period, policy, ws, items, run, stale, issue } = data
  const status = ws?.status ?? 'not_started'
  const locked = status === 'locked'
  const stepIdx = STEPS.indexOf(status)
  // タブを選ぶまでは、進み具合に合わせたタブを開く
  const activeTab: TabKey = tab ?? (status === 'not_started' ? 'import' : status === 'imported' ? 'items' : status === 'checked' ? 'calc' : 'journal')

  return (
    <>
      <div className="breadcrumb">
        <Link to="/">進捗一覧</Link> ／ {period.companies.code} {period.companies.name} ／ {period.label}
      </div>
      <div className="page-header">
        <h1>
          <span className="issue-no-lg">{issue.no}</span>
          {issue.name} <span className="muted small">{issue.standard_ref}</span>
        </h1>
        <div className="page-header-tools">
          {data.prior && <Link className="btn" to={`/work/${data.prior.id}/${issueCode}`}>← 前期（{data.prior.label}）</Link>}
          {data.next && <Link className="btn" to={`/work/${data.next.id}/${issueCode}`}>翌期（{data.next.label}）→</Link>}
        </div>
      </div>

      <div className="work-meta">
        <div>方針：<ApplicabilityBadge value={policy.applicability} /> {policy.is_company_override && <span className="small muted">（会社ごとの上書き）</span>}</div>
        <div>状況：<StatusBadge status={status} /></div>
        <ol className="stepper">
          {STEPS.map((s, i) => (
            <li key={s} className={i <= stepIdx ? 'done' : ''}>{STATUS_LABELS[s]}</li>
          ))}
        </ol>
      </div>
      {policy.applicability && policy.applicability !== 'applied' && (
        <div className="alert alert-info">この会社・期では「{policy.applicability === 'immaterial' ? '重要性なし' : '対象外'}」です（理由：{policy.reason ?? '—'}）。デモのため作業はできます。</div>
      )}

      <Tabs<TabKey>
        active={activeTab}
        onChange={setTab}
        tabs={[
          { key: 'import', label: '1. 取込' },
          { key: 'items', label: `2. 明細チェック（${items.filter((i) => i.review_status === 'checked').length}/${items.length}）` },
          { key: 'calc', label: '3. 計算シート' },
          { key: 'journal', label: '4. 仕訳・確定' },
        ]}
      />
      <div className="tab-body">
        {activeTab === 'import' && <ImportTab period={period} cfg={cfg} locked={locked} onDone={() => { reload(); setTab('items') }} />}
        {activeTab === 'items' && <ItemsTab periodId={period.id} cfg={cfg} items={items} locked={locked} onDone={reload} />}
        {activeTab === 'calc' && <CalcTab period={period} issueCode={issueCode} items={items} run={run} stale={stale} locked={locked} onDone={reload} />}
        {activeTab === 'journal' && <JournalTab period={period} issueCode={issueCode} issueName={issue.name} run={run} locked={locked} stale={stale} onDone={reload} />}
      </div>
    </>
  )
}
