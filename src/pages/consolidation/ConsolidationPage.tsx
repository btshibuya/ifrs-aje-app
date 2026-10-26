// 連結精算表（IFRS調整）：親会社の連結決算担当者向け
// 精算表（科目×仕訳の種類・論点・会社）、開始仕訳・開始実現仕訳・当期仕訳の一覧、
// 前回の集計との比較（仕訳を上書きしたら、精算表の金額がどう変わったか）

import { useMemo, useState } from 'react'
import { DivergingBars, Waterfall, useTooltip, yenText } from '../../components/charts'
import { useFeedback } from '../../components/feedback'
import { ErrorBox, Loading, PageHeader, SlotToggle, Tabs, formatDateTime } from '../../components/ui'
import {
  KINDS, KIND_LABELS, accountOrder, fetchConsolidation, impacts, saveSnapshot, type CLine, type Kind,
} from '../../lib/consolidation'
import { useAsync, useSlot } from '../../lib/hooks'
import { fetchMasters } from '../../lib/masters'
import JournalList from './JournalList'
import Worksheet, { type Axis } from './Worksheet'

type TabKey = 'sheet' | Kind

const readPref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    // 保存できなくても動作に支障はない
  }
}

export default function ConsolidationPage() {
  const [slot, setSlot] = useSlot()
  const fb = useFeedback()
  const tooltip = useTooltip()
  const [tab, setTab] = useState<TabKey>('sheet')
  const [companyFilter, setCompanyFilter] = useState<string[]>([]) // 空はすべて
  const [issueFilter, setIssueFilter] = useState<string[]>([])
  const [finalOnly, setFinalOnly] = useState(() => readPref('cons.finalOnly', '0') === '1')
  const [axis, setAxis] = useState<Axis>(() => (readPref('cons.axis', 'kind') as Axis))
  const [compare, setCompare] = useState(false)
  const [snapId, setSnapId] = useState<string | null>(null)

  const { data, error, loading, reload } = useAsync(async () => {
    const m = await fetchMasters()
    return { m, d: await fetchConsolidation(m, slot) }
  }, [slot])

  // 絞り込み（会社・論点・確定のみ）。前回の集計にも同じ絞り込みをかけて比べる
  const keep = useMemo(() => (l: Pick<CLine, 'companyId' | 'issueCode' | 'kind' | 'status'>) =>
    (companyFilter.length === 0 || companyFilter.includes(l.companyId)) &&
    (issueFilter.length === 0 || issueFilter.includes(l.issueCode)) &&
    (!finalOnly || l.kind !== 'current' || l.status === 'final'), [companyFilter, issueFilter, finalOnly])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { m, d } = data

  const lines = d.lines.filter(keep)
  const snapshot = d.snapshots.find((s) => s.id === snapId) ?? d.snapshots[0] ?? null
  const before = snapshot ? (snapshot.lines as CLine[]).filter(keep) : null
  const imp = impacts(lines, d.accounts)
  const impBefore = before ? impacts(before, d.accounts) : null

  const companyName = (id: string) => { const c = m.companies.find((x) => x.id === id); return c ? `${c.code} ${c.name}` : id }
  const companyCode = (id: string) => m.companies.find((x) => x.id === id)?.code ?? id
  const issue = (code: string) => m.issues.find((i) => i.code === code)
  const issueName = (code: string) => { const i = issue(code); return i ? `${i.no}. ${i.name}` : code }

  // 集計の対象（会社×論点の計算の状況）
  const counts = { final: 0, draft: 0, missing: 0 }
  for (const t of d.targets) { for (const s of t.status.values()) counts[s]++; counts.missing += t.missing.length }
  const missingList = d.targets.flatMap((t) => t.missing.map((i) => ({ t, i })))
  // 洗替の論点で当期の計算がないと、開始実現仕訳（戻入れ）だけが入り、当期利益への影響が大きく出る
  const reversingMissing = missingList.filter(({ t, i }) => d.lines.some((l) => l.kind === 'realization' && l.companyId === t.company.id && l.issueCode === i))
  const lagged = d.targets.filter((t) => t.period.end_date !== d.asOf)

  const presentIssues = [...new Set(d.lines.map((l) => l.issueCode))].sort((a, b) => (issue(a)?.no ?? 99) - (issue(b)?.no ?? 99))
  const presentCompanies = d.targets.filter((t) => d.lines.some((l) => l.companyId === t.company.id)).map((t) => t.company.id)

  const onSnapshot = async () => {
    const name = await fb.confirm({
      title: 'いまの金額で集計しますか？',
      confirmLabel: '集計する',
      input: { label: '集計した人', placeholder: '例：連結 山田', defaultValue: readPref('enteredBy', ''), rows: 1 },
      body: (
        <ul>
          <li>{d.label}（基準日 {d.asOf.replaceAll('-', '/')}）の全社・全論点の仕訳（下書きを含む）を記録します。</li>
          <li>あとで子会社の仕訳が上書きされたら、精算表の「上書き前後を表示」で、この集計との差を確かめられます。</li>
          {d.snapshots.length > 0 && <li>前回の集計（{formatDateTime(d.snapshots[0].created_at)}）は履歴に残ります。</li>}
        </ul>
      ),
    })
    if (name === null) return
    try {
      writePref('enteredBy', name)
      await saveSnapshot(d, d.lines, name, null)
      fb.toast('集計しました。今後の上書きは、この集計と比べて表示します')
      setSnapId(null)
      reload()
    } catch (e) {
      fb.toast((e as Error).message, 'error')
    }
  }

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  // 純資産への影響の橋渡し（開始 → 開始実現 → 当期 → 期末）
  const bridge = [
    { key: 'opening', label: '開始仕訳（期首）', value: imp.netAssetsByKind.opening, kind: 'total' as const },
    { key: 'realization', label: '開始実現仕訳', value: imp.netAssetsByKind.realization, kind: 'delta' as const },
    { key: 'current', label: '当期仕訳', value: imp.netAssetsByKind.current, kind: 'delta' as const },
    { key: 'close', label: '期末', value: imp.netAssets, kind: 'total' as const },
  ]
  // 当期利益への影響（論点別。会社別の切り口なら会社別）
  const byCompany = axis === 'company'
  const profitRows = (byCompany ? presentCompanies : presentIssues).map((k) => {
    const ls = lines.filter((l) => (byCompany ? l.companyId === k : l.issueCode === k))
    return { key: k, label: byCompany ? companyName(k) : issueName(k), value: impacts(ls, d.accounts).profit }
  }).filter((r) => r.value !== 0).sort((a, b) => Math.abs(b.value) - Math.abs(a.value))

  return (
    <>
      <PageHeader title="連結精算表（IFRS調整）">
        <SlotToggle slot={slot} onChange={(s) => { setSlot(s); setSnapId(null) }} years={m.yearLabels} />
      </PageHeader>
      <p className="muted small" style={{ marginTop: -4 }}>
        子会社ごと・論点ごとのIFRS調整仕訳を、連結の基準日 <b>{d.asOf.replaceAll('-', '/')}</b>（{d.label}）で集計します。
        開始仕訳は前年度までの<b>確定した</b>計算から作ります。{lagged.length > 0 && <>決算日が違う会社（{lagged.map((t) => `${t.company.code}：${t.period.label}`).join('、')}）は、3か月前までの期を使います。</>}
      </p>

      <div className="hero-row">
        <div className="stat">
          <div className="stat-label">当期利益への影響</div>
          <div className={`stat-value${imp.profit < 0 ? ' text-error' : ''}`}>{yenText(imp.profit, true)}<span className="small muted"> 円</span></div>
          {impBefore && compare && imp.profit !== impBefore.profit && <div className="small">前回の集計から <b className={imp.profit - impBefore.profit < 0 ? 'text-error' : 'ok-text'}>{yenText(imp.profit - impBefore.profit, true)}</b></div>}
        </div>
        <div className="stat">
          <div className="stat-label">期末の純資産への影響</div>
          <div className={`stat-value${imp.netAssets < 0 ? ' text-error' : ''}`}>{yenText(imp.netAssets, true)}<span className="small muted"> 円</span></div>
          {impBefore && compare && imp.netAssets !== impBefore.netAssets && <div className="small">前回の集計から <b className={imp.netAssets - impBefore.netAssets < 0 ? 'text-error' : 'ok-text'}>{yenText(imp.netAssets - impBefore.netAssets, true)}</b></div>}
        </div>
        <div className="stat">
          <div className="stat-label">貸借の検証</div>
          <div className={`stat-value ${Math.round(imp.balance) === 0 ? 'ok-text' : 'text-error'}`}>{Math.round(imp.balance) === 0 ? '✓ 一致' : `差 ${yenText(imp.balance)}`}</div>
          <div className="small muted">借方・貸方の合計</div>
        </div>
        <div className="stat">
          <div className="stat-label">当期の計算（会社×論点）</div>
          <div className="stat-value">{counts.final}<span className="small muted"> 確定</span> {counts.draft > 0 && <span className="warn-text">{counts.draft}<span className="small"> 下書き</span></span>} {counts.missing > 0 && <span className="text-error">{counts.missing}<span className="small"> 未計算</span></span>}</div>
          <div className="small muted">{d.targets.length}社が対象（計算まで実装している論点）</div>
        </div>
      </div>

      {missingList.length > 0 && (
        <details className={`alert ${reversingMissing.length ? 'alert-warn' : 'alert-info'} cons-missing`}>
          <summary>
            <b>当期の計算がまだない会社×論点が {missingList.length}件 あります。</b>
            {reversingMissing.length > 0 && <>うち洗替の {reversingMissing.length}件 は、開始実現仕訳（前年度末の戻入れ）だけが入るため、当期利益への影響が一時的に大きく出ます。</>}
          </summary>
          <ul className="cons-missing-list">
            {missingList.map(({ t, i }) => (
              <li key={`${t.company.id}|${i}`}><a href={`#/work/${t.period.id}/${i}`}>{t.company.code} {issueName(i)}（{t.period.label}）</a></li>
            ))}
          </ul>
        </details>
      )}
      {d.warnings.length > 0 && (
        <div className="alert alert-warn">
          <b>開始仕訳の注意（{d.warnings.length}件）</b>
          <ul>{d.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}

      <div className="card cons-filters">
        <div className="cons-filter-row">
          <span className="cons-filter-label">会社</span>
          <div className="chips">
            <button className={`chip${companyFilter.length === 0 ? ' on' : ''}`} onClick={() => setCompanyFilter([])}>すべて</button>
            {d.targets.map((t) => (
              <button key={t.company.id} className={`chip${companyFilter.includes(t.company.id) ? ' on' : ''}${presentCompanies.includes(t.company.id) ? '' : ' empty'}`}
                title={`${t.company.name}（${t.period.label}）${presentCompanies.includes(t.company.id) ? '' : '：仕訳なし'}`}
                aria-pressed={companyFilter.includes(t.company.id)} onClick={() => toggle(companyFilter, setCompanyFilter, t.company.id)}>
                {t.company.code}
              </button>
            ))}
          </div>
        </div>
        <div className="cons-filter-row">
          <span className="cons-filter-label">論点</span>
          <div className="chips">
            <button className={`chip${issueFilter.length === 0 ? ' on' : ''}`} onClick={() => setIssueFilter([])}>すべて</button>
            {presentIssues.map((code) => (
              <button key={code} className={`chip${issueFilter.includes(code) ? ' on' : ''}`} aria-pressed={issueFilter.includes(code)} onClick={() => toggle(issueFilter, setIssueFilter, code)}>
                {issueName(code)}
              </button>
            ))}
            {presentIssues.length === 0 && <span className="small muted">仕訳のある論点がありません</span>}
          </div>
        </div>
        <div className="cons-filter-row">
          <span className="cons-filter-label">当期仕訳</span>
          <label className="check-inline small">
            <input type="checkbox" checked={finalOnly} onChange={(e) => { setFinalOnly(e.target.checked); writePref('cons.finalOnly', e.target.checked ? '1' : '0') }} />
            確定した計算だけを集計する（下書きを除く）
          </label>
        </div>
      </div>

      <Tabs<TabKey>
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'sheet', label: '精算表' },
          ...KINDS.map((k) => ({ key: k, label: `${KIND_LABELS[k]}（${new Set(lines.filter((l) => l.kind === k).map((l) => `${l.companyId}|${l.categoryCode}`)).size}）` })),
        ]}
      />
      <div className="tab-body stack">
        {tab === 'sheet' && (
          <>
            {tooltip.node}
            {lines.length > 0 && (
              <div className="chart-grid">
                <div className="card">
                  <div className="card-title">純資産への影響（IFRS調整の累計）</div>
                  <Waterfall steps={bridge} tooltip={tooltip} />
                  <div className="viz-legend">
                    <span><span className="viz-swatch" style={{ background: 'var(--viz-pos)' }} /> 純資産を増やす</span>
                    <span><span className="viz-swatch" style={{ background: 'var(--viz-neg)' }} /> 純資産を減らす</span>
                    <span><span className="viz-swatch" style={{ background: 'var(--viz-total)' }} /> 期首・期末</span>
                  </div>
                </div>
                <div className="card">
                  <div className="card-title">{byCompany ? '会社別' : '論点別'}：当期利益への影響<span className="small muted">押すとその{byCompany ? '会社' : '論点'}に絞り込み</span></div>
                  {profitRows.length ? (
                    <DivergingBars rows={profitRows} tooltip={tooltip}
                      selected={byCompany ? (companyFilter.length === 1 ? companyFilter[0] : null) : (issueFilter.length === 1 ? issueFilter[0] : null)}
                      onSelect={(k) => (byCompany ? setCompanyFilter(companyFilter.length === 1 && companyFilter[0] === k ? [] : [k]) : setIssueFilter(issueFilter.length === 1 && issueFilter[0] === k ? [] : [k]))} />
                  ) : <p className="muted small">当期利益への影響はありません。</p>}
                </div>
              </div>
            )}

            <div className={`card snap-bar${compare ? ' on' : ''}`}>
              <div className="snap-info">
                {snapshot ? (
                  <>
                    <label className="check-inline">
                      <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                      <b>上書き前後を表示</b>
                    </label>
                    <span className="small muted">
                      比べる集計：
                      <select value={snapshot.id} onChange={(e) => setSnapId(e.target.value)} className="snap-select">
                        {d.snapshots.map((s, i) => <option key={s.id} value={s.id}>{formatDateTime(s.created_at)}（{s.created_by ?? '—'}）{i === 0 ? '・最新' : ''}</option>)}
                      </select>
                    </span>
                  </>
                ) : (
                  <span className="small muted">まだ集計していません。「集計する」を押すと、いまの金額を記録し、そのあとに仕訳が上書きされたとき、精算表で上書き前後を比べられます。</span>
                )}
              </div>
              <button className="btn btn-primary" onClick={() => void onSnapshot()}>{snapshot ? 'いまの金額で集計し直す' : '集計する'}</button>
            </div>

            <Worksheet
              lines={lines} before={compare && before ? before : null} accounts={d.accounts} categories={d.categories}
              axis={axis} onAxis={(a) => { setAxis(a); writePref('cons.axis', a) }}
              issueName={issueName} companyName={companyName} companyCode={companyCode}
              issueOrder={(c) => issue(c)?.no ?? 99} companyOrder={(id) => m.companies.findIndex((c) => c.id === id)}
              accountSort={(a, b) => accountOrder(a) - accountOrder(b)}
            />
          </>
        )}
        {tab !== 'sheet' && (
          <JournalList kind={tab} lines={lines.filter((l) => l.kind === tab)} accounts={d.accounts} categories={d.categories}
            issueName={issueName} companyName={companyName} companyCode={companyCode}
            issueOrder={(c) => issue(c)?.no ?? 99} companyOrder={(id) => m.companies.findIndex((c) => c.id === id)}
            label={d.label} tooltip={tooltip} />
        )}
      </div>
    </>
  )
}
