import { useState } from 'react'
import { ErrorBox, formatDateTime } from '../../components/ui'
import type { IssueConfig } from '../../lib/issues'
import { setChecked, type ItemRow } from '../../lib/workflow'

export default function ItemsTab({ periodId, cfg, items, locked, onDone }: { periodId: string; cfg: IssueConfig; items: ItemRow[]; locked: boolean; onDone: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkedCount = items.filter((i) => i.review_status === 'checked').length
  // 合計で入力した明細は、項目名を「〜の合計」にし、人数・件数の列を足す
  const agg = items.some((i) => i.data.input_mode === 'aggregate')
  const label = (key: string, base: string) => (agg ? cfg.manual.aggregate.labels[key] ?? base : base)
  const manual = items.some((i) => i.data.input_mode)

  const apply = async (ids: string[], checked: boolean) => {
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await setChecked(periodId, cfg.code, ids, checked)
      setSelected(new Set())
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (items.length === 0) return <div className="alert alert-info">明細がありません。「取込」タブでファイルを取り込んでください。</div>

  const toggle = (id: string) => {
    const s = new Set(selected)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setSelected(s)
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <div>
          チェック済 <b>{checkedCount}</b> ／ {items.length}件
          {agg && <span className="badge cat" style={{ marginLeft: 8 }}>合計で入力</span>}
          {checkedCount === items.length ? <span className="badge status-checked" style={{ marginLeft: 8 }}>すべて確認済み</span> : <span className="small muted">　すべての明細を確認すると計算できます</span>}
        </div>
        {!locked && (
          <div className="actions">
            <button className="btn" disabled={busy || selected.size === 0} onClick={() => apply([...selected], true)}>選んだ明細をチェック</button>
            <button className="btn" disabled={busy || selected.size === 0} onClick={() => apply([...selected], false)}>チェックを外す</button>
            <button className="btn btn-primary" disabled={busy || checkedCount === items.length} onClick={() => apply(items.filter((i) => i.review_status !== 'checked').map((i) => i.id), true)}>
              すべてチェック
            </button>
          </div>
        )}
      </div>
      {error && <ErrorBox message={error} />}
      <div className="table-wrap" style={{ maxHeight: 560 }}>
        <table className="compact">
          <thead>
            <tr>
              <th>{!locked && <input type="checkbox" aria-label="すべて選ぶ" checked={selected.size === items.length} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} />}</th>
              <th>状態</th>
              <th>{manual ? '入力の行' : '元ファイルの行'}</th>
              {cfg.fields.map((f) => <th key={f.key}>{label(f.key, f.label)}</th>)}
              {agg && <th className="num">{cfg.manual.aggregate.countLabel}</th>}
              <th>確認日時</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className={selected.has(i.id) ? 'row-selected' : ''}>
                <td>{!locked && <input type="checkbox" aria-label={`${i.item_key}を選ぶ`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />}</td>
                <td>{i.review_status === 'checked' ? <span className="badge status-checked">確認済</span> : <span className="badge status-not_started">未確認</span>}</td>
                <td className="num">{i.source_row_no}</td>
                {cfg.fields.map((f) => {
                  const v = i.data[f.key]
                  return (
                    <td key={f.key} className={f.type === 'number' ? 'num' : ''}>
                      {v === null || v === undefined ? '' : f.type === 'number' ? Number(v).toLocaleString('ja-JP') : String(v)}
                    </td>
                  )
                })}
                {agg && <td className="num">{i.data.count === null || i.data.count === undefined ? '' : Number(i.data.count).toLocaleString('ja-JP')}</td>}
                <td className="small muted">{formatDateTime(i.checked_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
