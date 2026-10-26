// テストデータを入れる・全て消す（マスタ画面のタブ）
import { useEffect, useState } from 'react'
import { useFeedback } from '../../components/feedback'
import { ErrorBox, Loading } from '../../components/ui'
import { useAsync } from '../../lib/hooks'
import { countData, deleteAllData, insertTestData, type Counts } from '../../lib/testData'

const LABELS: [keyof Counts, string][] = [
  ['package_entries', '収集パッケージの入力'],
  ['source_files', '元資料（取込・提出したファイル）'],
  ['detail_items', '明細'],
  ['calculation_runs', '計算（と仕訳）'],
  ['work_status', '作業の状況・確定'],
  ['consolidation_snapshots', '連結精算表の集計の記録'],
  ['policies', '会社ごとの方針の上書き（テスト用）'],
]

export default function TestDataPanel({ onChanged }: { onChanged: () => void }) {
  const fb = useFeedback()
  const counts = useAsync(countData, [])
  const [run, setRun] = useState<{ message: string; ratio: number; kind: 'insert' | 'delete' } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [withMine, setWithMine] = useState(false) // 画面で入力したものも消す

  // 実行中に画面を閉じないように知らせる
  useEffect(() => {
    if (!run) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [run])

  const c = counts.data
  const sum = (k: 'test' | 'other') => (c ? LABELS.reduce((s, [key]) => s + c[key][k], 0) : 0)

  const exec = async (kind: 'insert' | 'delete') => {
    setError(null)
    setRun({ message: '始めています', ratio: 0, kind })
    const started = Date.now()
    try {
      const progress = (message: string, ratio: number) => setRun({ message, ratio, kind })
      if (kind === 'insert') await insertTestData(progress)
      else await deleteAllData(progress, withMine ? 'all' : 'test')
      fb.toast(kind === 'insert' ? `テストデータを入れました（${Math.round((Date.now() - started) / 1000)}秒）` : withMine ? 'マスタ以外を全て消しました' : 'テストデータを全て消しました')
      setWithMine(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRun(null)
      counts.reload()
      onChanged()
    }
  }

  const onInsert = async () => {
    const ok = await fb.confirm({
      title: 'テストデータを入れますか？', confirmLabel: 'テストデータを入れる',
      body: (
        <ul>
          <li>全13論点について、全社（S01〜S10）の前期（1Q〜期末）と当期（1Q・2Q）のデータを入れます。</li>
          <li>前に入れたテストデータは入れ替えます。<b>画面で入力したものは残します</b>（同じ会社・基準日・様式の収集パッケージは、入力したほうを残します）。</li>
          <li>有給休暇・減価償却はアプリの計算そのもので作るため、2〜3分かかります。終わるまでこの画面を開いたままにしてください。</li>
        </ul>
      ),
    })
    if (ok !== null) await exec('insert')
  }
  const onDelete = async () => {
    const ok = await fb.confirm({
      title: withMine ? 'マスタ以外を全て消しますか？' : 'テストデータを全て消しますか？', confirmLabel: '消す', danger: true,
      body: (
        <ul>
          {withMine
            ? <li>テストデータ（{sum('test')}件）と、<b>画面で入力したもの（{sum('other')}件）を全て消します</b>。マスタは残ります。</li>
            : <li>テストデータ（{sum('test')}件）を全て消します。画面で入力したもの（{sum('other')}件）は残します。</li>}
          <li>テスト用に入れた方針の上書きも消し、元の方針に戻します。</li>
          <li>消すと元に戻せません（変更履歴には残ります）。「テストデータを入れる」で、また入れられます。</li>
        </ul>
      ),
    })
    if (ok !== null) await exec('delete')
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-title">テストデータ</div>
        <p style={{ margin: '0 0 6px' }}>全13論点を、会社・時点をまたいで一通り試せるデータです。</p>
        <ul className="small muted" style={{ margin: 0 }}>
          <li>収集パッケージ：全様式（当期2Qは、提出済・入力中・差し戻しの様式もあります）と、試算表の提出</li>
          <li>有給休暇・減価償却：取込 → 明細チェック → 計算 → 確定を、アプリの処理そのもので行います（S01 は手で試すため空けています）</li>
          <li>そのほかの論点：収集パッケージの入力から仕訳を簡易計算し、確定します（当期2Qの一部は下書き）</li>
          <li>のれん・株式報酬・借入手数料は、一部の会社で「適用」にする方針の上書きを入れます</li>
          <li>連結精算表：当期2Qを集計したあと、S03 の有給休暇を訂正しています（上書き前後を確かめられます）</li>
        </ul>
      </div>

      <div className="card">
        <div className="card-title">いまのデータの件数</div>
        {counts.loading && !c && <Loading />}
        {counts.error && <ErrorBox message={counts.error} />}
        {c && (
          <table className="compact" style={{ maxWidth: 640 }}>
            <thead><tr><th>種類</th><th className="num">テストデータ</th><th className="num">画面で入力したもの</th></tr></thead>
            <tbody>
              {LABELS.map(([k, label]) => (
                <tr key={k}><td>{label}</td><td className="num">{c[k].test.toLocaleString('ja-JP')}</td><td className="num">{k === 'policies' ? '—' : c[k].other.toLocaleString('ja-JP')}</td></tr>
              ))}
            </tbody>
            <tfoot><tr className="subtotal"><td>合計</td><td className="num">{sum('test').toLocaleString('ja-JP')}</td><td className="num">{sum('other').toLocaleString('ja-JP')}</td></tr></tfoot>
          </table>
        )}
      </div>

      {error && <ErrorBox message={error} />}
      {run && (
        <div className="card testdata-run" role="status" aria-live="polite">
          <div className="card-title">{run.kind === 'insert' ? 'テストデータを入れています' : '消しています'}<span className="small muted">{Math.round(run.ratio * 100)}%</span></div>
          <div className="testdata-bar"><span style={{ width: `${Math.max(2, run.ratio * 100)}%` }} /></div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>{run.message}。この画面を開いたままにしてください。</p>
        </div>
      )}
      <div className="actions">
        <button className="btn btn-primary" disabled={!!run || !c} onClick={() => void onInsert()}>テストデータを入れる</button>
        <button className="btn btn-danger-outline" disabled={!!run || !c || (withMine ? sum('test') + sum('other') : sum('test')) === 0} onClick={() => void onDelete()}>
          {withMine ? 'マスタ以外を全て消す' : 'テストデータを全て消す'}
        </button>
        <label className="check-inline small">
          <input type="checkbox" checked={withMine} disabled={!!run} onChange={(e) => setWithMine(e.target.checked)} /> 画面で入力したもの{c ? `（${sum('other')}件）` : ''}も消す
        </label>
      </div>
    </div>
  )
}
