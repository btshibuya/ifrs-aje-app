import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApplicabilityBadge, ErrorBox, Loading, StatusBadge, Tabs } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import { ISSUE_CONFIGS, STATUS_LABELS } from '../../lib/issues'
import { must, supabase } from '../../lib/supabase'
import { fetchActiveRun, fetchTimeline, fetchItems, fetchPeriod, fetchPolicy, fetchWorkStatus, itemsHash } from '../../lib/workflow'
import CalcTab from './CalcTab'
import ImportTab from './ImportTab'
import ItemsTab from './ItemsTab'
import JournalTab from './JournalTab'
import PeriodTimeline from './PeriodTimeline'
import { PACKAGE_FORMS } from '../../lib/materials'
import { PACKAGE_CALCS } from '../../lib/packageCalc'
import PackageImportTab from './PackageImportTab'

const formOf = (issueCode: string) => PACKAGE_FORMS.find((f) => f.issueCode === issueCode)

type TabKey = 'import' | 'items' | 'calc' | 'journal'
const STEPS = ['imported', 'checked', 'calculated', 'locked']

export default function WorkPage() {
  const { periodId = '', issueCode = '' } = useParams()
  const cfg = ISSUE_CONFIGS[issueCode]
  // 収集パッケージから明細を作る論点
  const pkg = PACKAGE_CALCS[issueCode]
  const [tab, setTab] = useState<TabKey | null>(null)

  const { data, error, loading, reload } = useAsync(async () => {
    // 読み込みは並べて行う（前期は今期の情報が必要なので、そのあとで明細のハッシュ計算と並べる）
    const [period, policy, ws, items, run, issue] = await Promise.all([
      fetchPeriod(periodId), fetchPolicy(periodId, issueCode), fetchWorkStatus(periodId, issueCode),
      fetchItems(periodId, issueCode), fetchActiveRun(periodId, issueCode),
      supabase.from('issues').select('name, no, standard_ref').eq('code', issueCode).single(),
    ])
    // 同じ会社のすべての時点（四半期・期末）と、この論点の状況（時点の切り替えに出す）
    const [timeline, stale] = await Promise.all([
      fetchTimeline(period.company_id, issueCode),
      run ? itemsHash(items).then((h) => h !== run.input_hash) : Promise.resolve(false),
    ])
    return { period, policy, ws, items, run, stale, issue: must(issue) as { name: string; no: number; standard_ref: string }, timeline }
  }, [periodId, issueCode])


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
        <Link to="/progress">進捗一覧</Link> ／ <Link to={`/materials/${period.companies.code}`}>{period.companies.code} {period.companies.name} の資料</Link> ／ {period.label}
      </div>
      <div className="page-header">
        <h1>
          <span className="issue-no-lg">{issue.no}</span>
          {issue.name} <span className="muted small">{issue.standard_ref}</span>
        </h1>
        <div className="page-header-tools">
          <Link className="btn" to={`/help/${issueCode}`}>この論点の解説</Link>
          {data.run && (cfg || pkg) && <Link className="btn" to={`/report/${period.id}/${issueCode}`}>検証レポート</Link>}
        </div>
      </div>
      <PeriodTimeline timeline={data.timeline} currentId={period.id} issueCode={issueCode} />
      {period.period_type !== 'FY' && (
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          四半期は、期首（{period.start_date.replaceAll('-', '/')}）から四半期末（{period.end_date.replaceAll('-', '/')}）までの累計で計算します。累積の論点は前年度末の確定した残高から、洗替の論点は四半期末の全額です。
        </p>
      )}

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

      {!cfg && !pkg ? (
        <>
          {/* 計算をまだ実装していない論点：収集パッケージの入力から作った仕訳を見る・確定する */}
          <div className="alert alert-info">
            この論点は、収集パッケージの入力（{formOf(issueCode)?.title ?? '様式'}）から仕訳を作ります。この論点の計算はまだ実装していないため、仕訳の確認・確定だけができます。
            {formOf(issueCode) && <> <Link to={`/package/${period.companies.code}/${period.end_date}/${formOf(issueCode)!.code}`}>収集パッケージの入力を見る ›</Link></>}
          </div>
          <JournalTab period={period} issueCode={issueCode} issueName={issue.name} run={run} locked={locked} stale={false} onDone={reload} traceable={false} />
        </>
      ) : (<>
      <Tabs<TabKey>
        active={activeTab}
        onChange={setTab}
        tabs={[
          { key: 'import', label: pkg ? '1. 取込（収集パッケージ）' : '1. 取込' },
          { key: 'items', label: `2. 明細チェック（${items.filter((i) => i.review_status === 'checked').length}/${items.length}）` },
          { key: 'calc', label: '3. 計算シート' },
          { key: 'journal', label: '4. 仕訳・確定' },
        ]}
      />
      <div className="tab-body">
        {activeTab === 'import' && (pkg
          ? <PackageImportTab period={period} def={pkg} items={items} locked={locked} onDone={() => { reload(); setTab('items') }} />
          : <ImportTab period={period} cfg={cfg} items={items} locked={locked} onDone={() => { reload(); setTab('items') }} />)}
        {activeTab === 'items' && <ItemsTab periodId={period.id} cfg={pkg ? { code: issueCode, fields: pkg.fields } : cfg} items={items} locked={locked} onDone={reload} sourceLabel={pkg ? '収集パッケージから取り込んで' : undefined} />}
        {activeTab === 'calc' && <CalcTab period={period} issueCode={issueCode} items={items} run={run} stale={stale} locked={locked} onDone={reload} />}
        {activeTab === 'journal' && <JournalTab period={period} issueCode={issueCode} issueName={issue.name} run={run} locked={locked} stale={stale} onDone={reload} />}
      </div>
      </>)}
    </>
  )
}
