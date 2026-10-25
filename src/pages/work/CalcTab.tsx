import { useState } from 'react'
import { ErrorBox, Loading, Money, formatDateTime } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import {
  fetchBalances, fetchMissingCarryforward, fetchSteps, planCalculation, saveCalculation,
  type ItemRow, type Period, type Run, type StepRow,
} from '../../lib/workflow'

const MOVEMENT_LABELS: Record<string, string> = { new: '新規', continuing: '継続', disposed: '除却' }

const pct = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—')

// 計算シートの値：月数・年数・日数は金額ではないので小数をそのまま出す
const isCount = (label: string) => /月数|年）|日数/.test(label)

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
            <div className="card-title">明細ごとの計算シート（行を押すと計算過程を表示）</div>
            <div className="table-wrap">
              <table className="compact">
                <thead>
                  <tr><th>番号</th><th>名称</th><th>区分</th><th className="num">日本基準 期末</th><th className="num">IFRS 期末</th><th className="num">差額</th></tr>
                </thead>
                <tbody>
                  {details.data.balances.map((b) => (
                    <FragmentRow key={b.item_key} open={openItem === b.item_key} onToggle={() => setOpenItem(openItem === b.item_key ? null : b.item_key)}
                      cells={[
                        b.item_key, String(b.extra.name ?? ''), MOVEMENT_LABELS[b.movement_type] ?? b.movement_type,
                        <Money value={b.jgaap_amount} />, <Money value={b.ifrs_amount} />, <Money value={b.difference} />,
                      ]}
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

function FragmentRow({ cells, detail, open, onToggle }: { cells: React.ReactNode[]; detail: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`clickable${open ? ' selected' : ''}`} onClick={onToggle}>
        {cells.map((c, i) => <td key={i} className={i >= 3 ? 'num' : ''}>{i === 0 ? <>{open ? '▾' : '▸'} {c}</> : c}</td>)}
      </tr>
      {open && <tr className="detail-row"><td colSpan={cells.length}>{detail}</td></tr>}
    </>
  )
}
