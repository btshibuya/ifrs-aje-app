import { useState } from 'react'
import { InlineBar, Waterfall, useTooltip, type WaterfallStep } from '../../components/charts'
import { ErrorBox, Loading, Money, formatDateTime } from '../../components/ui'
import { reproduceCalculation, type CheckResult } from '../../lib/verify'
import { useAsync } from '../../lib/hooks'
import {
  fetchBalances, fetchMissingCarryforward, fetchSteps, planCalculation, saveCalculation,
  type ItemRow, type Period, type Run, type StepRow,
} from '../../lib/workflow'

const MOVEMENT_LABELS: Record<string, string> = { new: '新規', continuing: '継続', disposed: '除却' }

const pct = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—')

// 計算シートの値：月数・年数・日数は金額ではないので小数をそのまま出す
const isCount = (label: string) => /月数|年）|日数/.test(label)

// 減価償却の集計（期首差額 − 償却額の差 − 除却時の差 ＝ 期末差額）を橋渡しの図にする
function depreciationBridge(steps: StepRow[]): WaterfallStep[] | null {
  const v = (no: number) => Number(steps.find((s) => s.item_key === null && s.step_no === no)?.value ?? NaN)
  const [open, dep, disposal, close] = [v(1), v(2), v(3), v(4)]
  if ([open, dep, disposal, close].some((x) => Number.isNaN(x))) return null
  return [
    { key: 'open', label: '期首差額', value: open, kind: 'total' },
    { key: 'dep', label: '償却額の差', value: -dep, kind: 'delta' },
    { key: 'disposal', label: '除却時の差', value: -disposal, kind: 'delta' },
    { key: 'close', label: '期末差額', value: close, kind: 'total' },
  ]
}

function StepTable({ steps }: { steps: StepRow[] }) {
  return (
    <table className="compact steps">
      <thead><tr><th>#</th><th>項目</th><th>計算式・根拠</th><th className="num">値</th></tr></thead>
      <tbody>
        {steps.map((s) => (
          <tr key={s.id} id={`step-${s.id}`}>
            <td className="muted">{s.step_no}</td>
            <td>{s.label}</td>
            <td className="small formula">{s.formula ?? ''}</td>
            <td className="num">{isCount(s.label) ? Number(s.value).toLocaleString('ja-JP', { maximumFractionDigits: 2 }) : <Money value={s.value} />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default function CalcTab({ period, issueCode, items, run, stale, locked, onDone }: {
  period: Period; issueCode: string; items: ItemRow[]; run: Run | null; stale: boolean; locked: boolean; onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openItem, setOpenItem] = useState<string | null>(null)
  const [sortByDiff, setSortByDiff] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ at: string; checks: CheckResult[] } | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const onVerify = async () => {
    if (!run) return
    setVerifying(true)
    setVerifyError(null)
    try {
      setVerifyResult({ at: new Date().toISOString(), checks: await reproduceCalculation(period, issueCode, items, run) })
    } catch (e) {
      setVerifyError((e as Error).message)
    } finally {
      setVerifying(false)
    }
  }
  const tooltip = useTooltip()
  const details = useAsync(async () => {
    if (!run) return null
    const [steps, balances, missing] = await Promise.all([
      fetchSteps(run.id), fetchBalances(run.id), fetchMissingCarryforward(period.id, issueCode),
    ])
    return { steps, balances, missing }
  }, [run?.id])

  const allChecked = items.length > 0 && items.every((i) => i.review_status === 'checked')

  const onCalc = async () => {
    setBusy(true)
    setError(null)
    try {
      const plan = await planCalculation(period, issueCode, items)
      await saveCalculation(period, issueCode, items, plan)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 明細の差額の棒の目盛り
  const diffs = (details.data?.balances ?? []).map((b) => Math.round(Number(b.difference)))
  const diffScale = { maxAbs: Math.max(0, ...diffs.map(Math.abs)), mixed: diffs.some((d) => d > 0) && diffs.some((d) => d < 0) }

  const snap = (run?.assumptions_snapshot ?? {}) as Record<string, unknown>
  const warnings = (snap.warnings as string[] | undefined) ?? []
  const rules = snap.asset_class_rules as Record<string, { usefulLifeYears: number; residualRate: number; scope: string; note: string | null }> | undefined

  return (
    <div className="stack">
      <div className="toolbar">
        <div>
          {run ? (
            <>前回の計算：{formatDateTime(run.run_at)}　<span className={`badge run-${run.status}`}>{run.status === 'final' ? '確定' : '下書き'}</span></>
          ) : (
            <span className="muted">まだ計算していません</span>
          )}
        </div>
        {!locked && (
          <div className="actions">
            {!allChecked && <span className="small muted">すべての明細をチェックすると計算できます</span>}
            <button className="btn btn-primary" disabled={!allChecked || busy} onClick={onCalc}>
              {busy ? '計算中…' : run ? '再計算する' : '計算する'}
            </button>
          </div>
        )}
      </div>
      {error && <ErrorBox message={error} />}
      {stale && <div className="alert alert-warn">計算のあとで明細が変わりました。再計算してください。</div>}

      {issueCode === 'DEPRECIATION' && details.data && depreciationBridge(details.data.steps) && (
        <div className="card">
          <div className="card-title">差額（IFRS − 日本基準）の期首から期末への動き</div>
          {tooltip.node}
          <Waterfall steps={depreciationBridge(details.data!.steps)!} tooltip={tooltip} />
          <div className="viz-legend">
            <span><span className="viz-swatch" style={{ background: 'var(--viz-pos)' }} /> 差額を増やす要因</span>
            <span><span className="viz-swatch" style={{ background: 'var(--viz-neg)' }} /> 差額を減らす要因</span>
            <span><span className="viz-swatch" style={{ background: 'var(--viz-total)' }} /> 期首・期末の残高</span>
          </div>
        </div>
      )}
      {run && (
        <div className="card verify-card">
          <div className="card-title">
            <span>計算の検証（もう一度計算して、保存された結果と比べる）</span>
            <button className="btn btn-sm" disabled={verifying} onClick={() => void onVerify()}>{verifying ? '検証しています…' : verifyResult ? 'もう一度検証する' : 'この計算を検証する'}</button>
          </div>
          {!verifyResult && !verifyError && <p className="small muted" style={{ margin: 0 }}>保存されている計算結果が、同じ入力・同じ前提値から再現できるかを確かめます。DBの値を書き換えた場合などに不一致として見つかります。</p>}
          {verifyError && <ErrorBox message={verifyError} />}
          {verifyResult && (
            <>
              <ul className="verify-list">
                {verifyResult.checks.map((c) => (
                  <li key={c.label} className={c.ok ? 'ok' : 'ng'}>
                    <span className="verify-icon" aria-hidden>{c.ok ? '✓' : '!'}</span>
                    <span><b>{c.label}</b><span className="small muted"> {c.detail}</span></span>
                  </li>
                ))}
              </ul>
              <div className="small muted">
                {verifyResult.checks.every((c) => c.ok) ? 'すべて一致しました。この計算結果は、保存された入力と前提値から再現できます。' : '一致しない項目があります。内容を確認し、必要なら再計算してください。'}
                （検証 {formatDateTime(verifyResult.at)}）
              </div>
            </>
          )}
        </div>
      )}

      {run && (
        <div className="card">
          <div className="card-title">計算に使った前提値（計算時点のスナップショット）</div>
          <dl className="kv">
            <dt>実効税率</dt><dd>{pct(snap.tax_rate)}</dd>
            {'prior_tax_rate' in snap && <><dt>期首の実効税率</dt><dd>{pct(snap.prior_tax_rate)}</dd></>}
            {'expected_usage_rate' in snap && <><dt>消化見込率</dt><dd>{pct(snap.expected_usage_rate)}</dd></>}
            {'social_insurance_rate' in snap && <><dt>法定福利費率</dt><dd>{pct(snap.social_insurance_rate)}</dd></>}
            <dt>前期の確定した計算</dt><dd>{snap.prior_run_id ? 'あり（前期末の残高から引き継ぎ）' : 'なし'}</dd>
          </dl>
          {rules && (
            <table className="compact" style={{ marginTop: 8 }}>
              <thead><tr><th>資産の種類</th><th className="num">経済的耐用年数</th><th className="num">残存価額</th><th>設定</th><th>備考</th></tr></thead>
              <tbody>
                {Object.entries(rules).map(([t, r]) => (
                  <tr key={t}><td>{t}</td><td className="num">{r.usefulLifeYears}年</td><td className="num">{pct(r.residualRate)}</td><td>{r.scope}</td><td className="small muted">{r.note ?? ''}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="alert alert-warn">
          <b>確認事項（{warnings.length}件）</b>
          <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}

      {run && details.loading && <Loading />}
      {details.error && <ErrorBox message={details.error} />}
      {details.data && (
        <>
          {details.data.missing.length > 0 && (
            <div className="alert alert-warn">
              <b>期首チェック：前期末にあって当期の計算に出てこない明細（{details.data.missing.length}件）</b>
              <ul>
                {details.data.missing.map((m) => (
                  <li key={m.item_key}>{m.item_key}（前期末の差額 <Money value={m.prior_closing_difference} />円）</li>
                ))}
              </ul>
            </div>
          )}
          <div className="card">
            <div className="card-title">集計</div>
            <StepTable steps={details.data.steps.filter((s) => s.item_key === null)} />
          </div>
          <div className="card">
            <div className="card-title">
              明細ごとの計算シート（行を押すと計算過程を表示）
              <div className="segmented small" role="group" aria-label="並び順">
                <button className={!sortByDiff ? 'on' : ''} onClick={() => setSortByDiff(false)}>番号順</button>
                <button className={sortByDiff ? 'on' : ''} onClick={() => setSortByDiff(true)}>差額の大きい順</button>
              </div>
            </div>
            <div className="table-wrap">
              <table className="compact">
                <thead>
                  <tr><th>番号</th><th>名称</th><th className="hide-sp">区分</th><th className="num hide-sp">日本基準 期末</th><th className="num hide-sp">IFRS 期末</th><th className="num">差額</th><th>差額の大きさ</th></tr>
                </thead>
                <tbody>
                  {(sortByDiff
                    ? [...details.data.balances].sort((a, b) => Math.abs(Number(b.difference)) - Math.abs(Number(a.difference)))
                    : details.data.balances
                  ).map((b) => (
                    <FragmentRow key={b.item_key} open={openItem === b.item_key} onToggle={() => setOpenItem(openItem === b.item_key ? null : b.item_key)}
                      cells={[
                        b.item_key, String(b.extra.name ?? ''), MOVEMENT_LABELS[b.movement_type] ?? b.movement_type,
                        <Money value={b.jgaap_amount} />, <Money value={b.ifrs_amount} />, <Money value={b.difference} />,
                      ]}
                      bar={<InlineBar value={Number(b.difference)} maxAbs={diffScale.maxAbs} mixed={diffScale.mixed} />}
                      detail={<StepTable steps={details.data!.steps.filter((s) => s.item_key === b.item_key)} />}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function FragmentRow({ cells, bar, detail, open, onToggle }: { cells: React.ReactNode[]; bar: React.ReactNode; detail: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`clickable${open ? ' selected' : ''}`} onClick={onToggle}>
        {/* スマホ幅では区分・日本基準・IFRSの列を隠し、差額と棒を見せる（行を押すと計算過程に全部出る） */}
        {cells.map((c, i) => <td key={i} className={`${i >= 3 ? 'num' : ''}${i >= 2 && i <= 4 ? ' hide-sp' : ''}`}>{i === 0 ? <span className="nowrap">{open ? '▾' : '▸'} {c}</span> : c}</td>)}
        <td style={{ verticalAlign: 'middle' }}>{bar}</td>
      </tr>
      {open && <tr className="detail-row"><td colSpan={cells.length + 1}>{detail}</td></tr>}
    </>
  )
}
