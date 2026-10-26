// 作業画面の時点の切り替え：年度ごとに 1Q・2Q・3Q・期末 を並べ、この論点の状況を色の点で示す
import { Link } from 'react-router-dom'
import { STATUS_LABELS } from '../../lib/issues'
import type { TimelinePoint } from '../../lib/workflow'

const SHORT: Record<string, string> = { Q1: '1Q', Q2: '2Q', Q3: '3Q', FY: '期末' }

export default function PeriodTimeline({ timeline, currentId, issueCode }: { timeline: TimelinePoint[]; currentId: string; issueCode: string }) {
  // 年度（開始日が同じ時点）ごとにまとめる
  const years = new Map<string, TimelinePoint[]>()
  for (const p of timeline) years.set(p.start_date, [...(years.get(p.start_date) ?? []), p])
  return (
    <nav className="ptl" aria-label="時点の切り替え">
      {[...years.values()].map((ps) => {
        const fy = ps.find((p) => p.period_type === 'FY') ?? ps[ps.length - 1]
        return (
          <div key={fy.start_date} className="ptl-year">
            <span className="ptl-year-label">{fy.label}</span>
            <ol>
              {ps.map((p) => (
                <li key={p.id}>
                  <Link to={`/work/${p.id}/${issueCode}`} className={`ptl-point${p.id === currentId ? ' on' : ''}`}
                    aria-current={p.id === currentId ? 'page' : undefined} title={`${p.label}（${p.end_date.replaceAll('-', '/')}）：${STATUS_LABELS[p.status] ?? p.status}`}>
                    <span className="ptl-dot" style={{ background: `var(--viz-st-${p.status})` }} aria-hidden />
                    <span>{SHORT[p.period_type] ?? p.label}</span>
                    <span className="sr-only">{STATUS_LABELS[p.status]}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        )
      })}
    </nav>
  )
}
