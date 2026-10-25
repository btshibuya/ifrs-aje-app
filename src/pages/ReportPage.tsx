// 検証レポート：会社×期×論点の証跡を1枚にまとめる（印刷・PDF保存向け）
// 開いた時点で、計算の再現と原本のハッシュ値の確認を自動で行い、その結果を載せる

import { Link, useParams } from 'react-router-dom'
import { ErrorBox, Loading, Money, StatusBadge, formatDateTime } from '../components/ui'
import { useAsync } from '../lib/hooks'
import { CARRY_METHOD_LABELS, STATUS_LABELS } from '../lib/issues'
import { must, supabase } from '../lib/supabase'
import { fetchRecordLogs, reproduceCalculation, verifySourceFile } from '../lib/verify'
import {
  fetchActiveRun, fetchEntries, fetchItems, fetchPeriod, fetchPolicy, fetchSourceFiles, fetchSteps, fetchWorkStatus,
} from '../lib/workflow'

const STATEMENT_ORDER = ['BS', 'PL', 'OCI']
const CLASS_ORDER = ['current_asset', 'noncurrent_asset', 'current_liability', 'noncurrent_liability', 'equity', 'operating', 'finance', 'income_tax']
const pct = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : '—')

export default function ReportPage() {
  const { periodId = '', issueCode = '' } = useParams()
  // 1) 内容（すぐ表示する）
  const { data, error, loading } = useAsync(async () => {
    const [period, policy, ws, items, run, files, issue, wsRow] = await Promise.all([
      fetchPeriod(periodId), fetchPolicy(periodId, issueCode), fetchWorkStatus(periodId, issueCode), fetchItems(periodId, issueCode),
      fetchActiveRun(periodId, issueCode), fetchSourceFiles(periodId, issueCode),
      supabase.from('issues').select('no, name, standard_ref').eq('code', issueCode).single(),
      supabase.from('work_status').select('id').eq('period_id', periodId).eq('issue_code', issueCode).maybeSingle(),
    ])
    const usedIds = new Set(items.map((i) => i.source_file_id))
    const usedFiles = files.filter((f) => usedIds.has(f.id))
    const wsId = (must(wsRow) as { id: string } | null)?.id
    const [steps, entries, logs] = run
      ? await Promise.all([fetchSteps(run.id), fetchEntries(run.id), wsId ? fetchRecordLogs('work_status', wsId) : Promise.resolve([])])
      : [[], [], []]
    return { period, policy, ws, items, run, files: usedFiles, issue: must(issue) as { no: number; name: string; standard_ref: string }, steps, entries, logs }
  }, [periodId, issueCode])

  // 2) 自動の確認（計算の再現・原本のハッシュ値）。内容を出したあとで行い、終わったら結果を埋める
  const verify = useAsync(async () => {
    if (!data?.run) return null
    const [checks, fileChecks] = await Promise.all([
      reproduceCalculation(data.period, issueCode, data.items, data.run).catch((e: Error) => [{ label: '計算の再現', ok: false, detail: e.message }]),
      Promise.all(data.files.map((f) => verifySourceFile(f.storage_path, f.sha256).then((r) => ({ ok: r.ok, msg: r.ok ? '一致' : '不一致' })).catch((e: Error) => ({ ok: false, msg: e.message })))),
    ])
    return { checks, fileChecks }
  }, [data?.run?.id])

  if (loading && !data) return <Loading />
  if (error) return <ErrorBox message={error} />
  if (!data) return null
  const { period, policy, ws, run, issue, steps, entries, files, logs } = data
  const checks = verify.data?.checks ?? []
  const fileChecks = verify.data?.fileChecks ?? []
  const verifying = !verify.data && !verify.error
  const snap = (run?.assumptions_snapshot ?? {}) as Record<string, unknown>
  const allOk = checks.length > 0 && checks.every((c) => c.ok) && fileChecks.every((f) => f.ok)

  // 科目別（BS → PL）
  const totals = new Map<string, { name: string; statement: string; cls: string | null; net: number }>()
  for (const e of entries) for (const l of e.journal_lines) {
    const a = l.group_accounts
    const t = totals.get(l.group_account_code) ?? { name: a.name, statement: a.statement, cls: a.bs_class ?? a.pl_class, net: 0 }
    t.net += (l.side === 'debit' ? 1 : -1) * Number(l.amount)
    totals.set(l.group_account_code, t)
  }
  const plImpact = -[...totals.values()].filter((t) => t.statement === 'PL').reduce((s, t) => s + t.net, 0)
  const lockEvents = logs.filter((l) => (l.before_data?.status ?? null) !== (l.after_data?.status ?? null))

  return (
    <article className="report">
      <div className="report-tools no-print">
        <Link className="btn" to={`/work/${period.id}/${issueCode}`}>← 作業画面へ</Link>
        <button className="btn btn-primary" onClick={() => window.print()}>印刷・PDFで保存</button>
        <span className="small muted">印刷画面で「PDFに保存」を選ぶと、PDFにできます。</span>
      </div>

      <header className="report-head">
        <div className="small muted">IFRS 調整仕訳 検証レポート</div>
        <h1>{period.companies.code} {period.companies.name} ／ {period.label} ／ {issue.no}. {issue.name} <span className="small muted">{issue.standard_ref}</span></h1>
        <div className="small muted">作成 {formatDateTime(new Date().toISOString())}（このレポートを開いた時点で、計算の再現と原本の確認を自動で行いました）</div>
      </header>

      {!run ? <div className="alert alert-info">まだ計算していないため、レポートを作れません。</div> : (
        <>
          <section className={`report-summary ${verifying ? 'pending' : allOk ? 'ok' : 'ng'}`}>
            <div>
              <div className="small muted">検証の結果</div>
              <div className="report-verdict" aria-live="polite">{verifying ? '確認しています…' : allOk ? '✓ すべての確認が一致' : '! 一致しない項目あり'}</div>
            </div>
            <div><div className="small muted">状況</div><StatusBadge status={ws?.status ?? 'not_started'} />{ws?.locked_at && <div className="small">確定 {formatDateTime(ws.locked_at)}</div>}</div>
            <div><div className="small muted">当期純利益への影響</div><div className="report-big"><Money value={plImpact} signed /> <span className="small muted">円</span></div></div>
            <div><div className="small muted">計算日時</div><div>{formatDateTime(run.run_at)}</div><div className="small muted">{run.status === 'final' ? '確定した計算' : '下書きの計算'}</div></div>
          </section>

          <section className="report-section">
            <h2>1. 計算の検証（再現）</h2>
            <table className="compact">
              <tbody>
                {verifying && <tr><td colSpan={3} className="muted">もう一度計算して、保存された結果と比べています…</td></tr>}
                {verify.error && <tr><td colSpan={3}><ErrorBox message={verify.error} /></td></tr>}
                {checks.map((c) => <tr key={c.label}><td className={`report-mark${c.ok ? '' : ' ng'}`}>{c.ok ? '✓' : '!'}</td><td>{c.label}</td><td className="small">{c.detail}</td></tr>)}
              </tbody>
            </table>
          </section>

          <section className="report-section">
            <h2>2. 元資料（原本）</h2>
            <table className="compact">
              <thead><tr><th /><th>ファイル名</th><th>取込日時</th><th>SHA-256（取込時に記録）</th><th>原本の確認</th></tr></thead>
              <tbody>
                {files.map((f, i) => (
                  <tr key={f.id}>
                    <td className={`report-mark${verifying || fileChecks[i]?.ok ? '' : ' ng'}`}>{verifying ? '…' : fileChecks[i]?.ok ? '✓' : '!'}</td>
                    <td>{f.file_name}</td><td className="nowrap">{formatDateTime(f.uploaded_at)}</td>
                    <td className="mono small hash">{f.sha256}</td><td className="small">{verifying ? '確認しています…' : fileChecks[i]?.msg}</td>
                  </tr>
                ))}
                {files.length === 0 && <tr><td colSpan={5} className="muted">元資料が見つかりません</td></tr>}
              </tbody>
            </table>
            <p className="small muted">原本を保管場所から読み込み、ハッシュ値を計算し直して、取込時に記録した値と比べています。一致すれば、取り込んだあとに書き換えられていません。明細 {data.items.length}件。</p>
          </section>

          <section className="report-section">
            <h2>3. 方針と前提値（計算時点）</h2>
            <dl className="kv">
              <dt>方針</dt><dd>{policy.applicability === 'applied' ? '適用' : policy.applicability ?? '未設定'}{policy.is_company_override ? '（会社ごとの上書き）' : '（グループ共通）'}{policy.reason ? `：${policy.reason}` : ''}</dd>
              <dt>実効税率</dt><dd>{pct(snap.tax_rate)}</dd>
              {'prior_tax_rate' in snap && <><dt>期首の実効税率</dt><dd>{pct(snap.prior_tax_rate)}</dd></>}
              {'expected_usage_rate' in snap && <><dt>消化見込率</dt><dd>{pct(snap.expected_usage_rate)}</dd></>}
              {'social_insurance_rate' in snap && <><dt>法定福利費率</dt><dd>{pct(snap.social_insurance_rate)}</dd></>}
              <dt>前期の確定した計算</dt><dd>{snap.prior_run_id ? 'あり（前期末の残高から引き継ぎ）' : 'なし'}</dd>
            </dl>
          </section>

          <section className="report-section">
            <h2>4. 計算シートの集計</h2>
            <table className="compact">
              <thead><tr><th>項目</th><th>計算式・根拠</th><th className="num">値</th></tr></thead>
              <tbody>
                {steps.filter((s) => s.item_key === null).map((s) => (
                  <tr key={s.id}><td>{s.label}</td><td className="small">{s.formula}</td><td className="num"><Money value={s.value} /></td></tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="report-section">
            <h2>5. 科目別の合計（借方プラス、BS → PL）</h2>
            <table className="compact">
              <thead><tr><th>科目</th><th>区分</th><th className="num">金額</th></tr></thead>
              {STATEMENT_ORDER.map((st) => {
                const list = [...totals.entries()].filter(([, t]) => t.statement === st)
                  .sort(([ca, a], [cb, b]) => (CLASS_ORDER.indexOf(a.cls ?? '') - CLASS_ORDER.indexOf(b.cls ?? '')) || (Number(/_DT[AL]$/.test(ca)) - Number(/_DT[AL]$/.test(cb))) || ca.localeCompare(cb))
                if (list.length === 0) return null
                return (
                  <tbody key={st}>
                    {list.map(([code, t]) => <tr key={code}><td>{t.name} <span className="muted small">{code}</span></td><td>{st}</td><td className="num"><Money value={t.net} /></td></tr>)}
                    <tr className="subtotal"><td colSpan={2}>{st} 計</td><td className="num"><Money value={list.reduce((s, [, t]) => s + t.net, 0)} /></td></tr>
                  </tbody>
                )
              })}
            </table>
          </section>

          <section className="report-section">
            <h2>6. 仕訳</h2>
            <table className="compact">
              <thead><tr><th>No.</th><th>仕訳区分</th><th>方式</th><th>借方</th><th className="num">借方金額</th><th>貸方</th><th className="num">貸方金額</th></tr></thead>
              <tbody>
                {entries.flatMap((e) => e.journal_lines.map((l, i) => (
                  <tr key={`${e.id}-${l.line_no}`}>
                    <td>{i === 0 ? e.entry_no : ''}</td>
                    <td className="small">{i === 0 ? e.journal_categories.name : ''}</td>
                    <td className="small">{i === 0 ? CARRY_METHOD_LABELS[e.journal_categories.carry_method] : ''}</td>
                    <td>{l.side === 'debit' ? l.group_accounts.name : ''}</td><td className="num">{l.side === 'debit' && <Money value={l.amount} />}</td>
                    <td>{l.side === 'credit' ? l.group_accounts.name : ''}</td><td className="num">{l.side === 'credit' && <Money value={l.amount} />}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </section>

          <section className="report-section">
            <h2>7. 状況の記録（DBの変更履歴より）</h2>
            {lockEvents.length === 0 ? <p className="small muted">記録はありません。</p> : (
              <table className="compact">
                <tbody>
                  {lockEvents.map((l) => (
                    <tr key={l.id}>
                      <td className="nowrap">{formatDateTime(l.changed_at)}</td>
                      <td>{STATUS_LABELS[String(l.before_data?.status)] ?? '（なし）'} → {STATUS_LABELS[String(l.after_data?.status)] ?? '（削除）'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="small muted">誰が確定したかは、ログインを導入したあとに記録します（現在はログインなしのため日時のみ）。</p>
          </section>
        </>
      )}
    </article>
  )
}
