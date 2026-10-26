// 再計算で仕訳を上書きするときの影響：科目ごとの上書き前・上書き後・差額（連結精算表の当期仕訳の列が、この差だけ変わる）
import { useState } from 'react'
import { amt } from '../../lib/consolidation'

export interface ImpactRow { code: string; name: string; statement: string; before: number; after: number }

export default function OverwriteImpact({ rows, consolidated }: { rows: ImpactRow[]; consolidated: boolean }) {
  const [all, setAll] = useState(false)
  const changed = rows.filter((r) => Math.round(r.before) !== Math.round(r.after))
  const shown = all ? rows : changed
  const profit = (k: 'before' | 'after') => Math.round(-rows.filter((r) => r.statement === 'PL').reduce((s, r) => s + r[k], 0)) || 0
  const d = profit('after') - profit('before')
  return (
    <div className="overwrite">
      {changed.length === 0 ? (
        <p className="ok-text" style={{ margin: '0 0 6px' }}>✓ 仕訳の金額は変わりません（同じ結果で上書きします）。</p>
      ) : (
        <p style={{ margin: '0 0 6px' }}>
          <b>{changed.length}科目</b>の金額が変わります。当期利益への影響は <b>{profit('before').toLocaleString('ja-JP')}</b> → <b>{profit('after').toLocaleString('ja-JP')}</b>
          （<b className={d < 0 ? 'text-error' : 'ok-text'}>{d > 0 ? '+' : ''}{Math.round(d).toLocaleString('ja-JP')}</b>）です。
        </p>
      )}
      <label className="check-inline small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> 変わらない科目も表示</label>
      {shown.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 280, marginTop: 6 }}>
          <table className="compact">
            <thead><tr><th>科目</th><th className="num">上書き前</th><th className="num">上書き後</th><th className="num">差額</th></tr></thead>
            <tbody>
              {shown.map((r) => {
                const diff = r.after - r.before
                return (
                  <tr key={r.code} className={Math.round(diff) !== 0 ? 'ws-row-changed' : ''}>
                    <td>{r.name}<span className="ws-code">{r.code}</span></td>
                    <td className="num muted">{amt(r.before, false)}</td>
                    <td className="num"><b>{amt(r.after, false)}</b></td>
                    <td className={`num${diff < 0 ? ' text-error' : ''}`}>{Math.round(diff) === 0 ? '' : `${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff)).toLocaleString('ja-JP')}`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        金額は借方そのまま、貸方は△です。{consolidated ? '連結精算表で集計済みのため、上書きすると精算表の「上書き前後を表示」で、この差を確かめられます。' : '連結精算表の当期仕訳の列が、この差だけ変わります。'}
      </p>
    </div>
  )
}
