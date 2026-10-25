// グラフの部品（ライブラリを使わず、HTML と SVG で描く）
// 色は index.css の --viz-* を使う。数値・ラベルの文字色は系列色にせず、通常の文字色にする

import { useState, type ReactNode } from 'react'

// ---------------------------------------------------------------------------
// ツールチップ：マウスを乗せる・タップすると、近くに内容を出す
// ---------------------------------------------------------------------------

interface Tip { x: number; y: number; content: ReactNode }

export function useTooltip() {
  const [tip, setTip] = useState<Tip | null>(null)
  const bind = (content: ReactNode) => ({
    onMouseEnter: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
    onMouseMove: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
    onMouseLeave: () => setTip(null),
    // onClick は持たない（行の選択など、呼び出し側のクリック処理を上書きしないため。スマホのタップでも mouseenter が起きる）
  })
  const node = tip ? (
    <div
      className="viz-tooltip"
      role="tooltip"
      style={{ left: Math.min(tip.x + 12, window.innerWidth - 240), top: tip.y + 14 }}
    >
      {tip.content}
    </div>
  ) : null
  return { bind, node, hide: () => setTip(null) }
}

// ---------------------------------------------------------------------------
// 凡例：色の四角＋ラベル（＋件数）
// ---------------------------------------------------------------------------

export interface LegendItem { key: string; label: string; color: string; value?: ReactNode }

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="viz-legend">
      {items.map((i) => (
        <li key={i.key}>
          <span className="viz-swatch" style={{ background: i.color }} />
          {i.label}
          {i.value !== undefined && <b className="viz-legend-value">{i.value}</b>}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// 100%積み上げの横棒（構成比）。区切りは2pxのすき間、両端は角丸
// ---------------------------------------------------------------------------

export interface Segment { key: string; label: string; value: number; color: string }

export function StackedBar({ segments, height = 14, tooltip, unit = '件', ariaLabel }: {
  segments: Segment[]
  height?: number
  tooltip?: ReturnType<typeof useTooltip>
  unit?: string
  ariaLabel?: string
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const shown = segments.filter((s) => s.value > 0)
  const label = ariaLabel ?? shown.map((s) => `${s.label} ${s.value}${unit}`).join('、')
  return (
    <div className="viz-stack" style={{ height }} role="img" aria-label={label}>
      {total === 0 ? (
        <div className="viz-stack-empty" />
      ) : (
        shown.map((s) => (
          <div
            key={s.key}
            className="viz-stack-seg"
            style={{ flexGrow: s.value, background: s.color }}
            {...(tooltip ? tooltip.bind(<><b>{s.label}</b> {s.value}{unit}（{Math.round((s.value / total) * 100)}%）</>) : {})}
          />
        ))
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 金額の目盛り
// ---------------------------------------------------------------------------

// 0 を含み、きりのよい目盛りにした範囲
export function niceDomain(values: number[]): { min: number; max: number; ticks: number[] } {
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const span = hi - lo || 1
  const raw = span / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const min = Math.floor(lo / step) * step
  const max = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v))
  return { min, max, ticks }
}

// 目盛りの表記：百万円単位などに丸める
export function shortYen(v: number): string {
  const a = Math.abs(v)
  if (a >= 100_000_000) return `${(v / 100_000_000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}億`
  if (a >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}百万`
  if (a >= 1_000) return `${(v / 1_000).toLocaleString('ja-JP', { maximumFractionDigits: 0 })}千`
  return v.toLocaleString('ja-JP')
}

export const yenText = (v: number, signed = false) => {
  const n = Math.round(v)
  return `${signed && n > 0 ? '+' : ''}${n.toLocaleString('ja-JP')}`
}

// ---------------------------------------------------------------------------
// 正負の横棒（0を中心に、プラスは右・マイナスは左）
// ---------------------------------------------------------------------------

export interface DivergingRow { key: string; label: ReactNode; sub?: ReactNode; value: number; tip?: ReactNode }

export function DivergingBars({ rows, selected, onSelect, tooltip }: {
  rows: DivergingRow[]
  selected?: string | null
  onSelect?: (key: string) => void
  tooltip?: ReturnType<typeof useTooltip>
}) {
  const { min, max, ticks } = niceDomain(rows.map((r) => r.value))
  const pos = (v: number) => ((v - min) / (max - min)) * 100
  const zero = pos(0)
  return (
    <div className="viz-div" role="list">
      <div className="viz-div-row viz-div-axis" aria-hidden>
        <div />
        <div className="viz-div-track">
          {ticks.map((t) => (
            <span key={t} className="viz-tick" style={{ left: `${pos(t)}%` }}>{shortYen(t)}</span>
          ))}
        </div>
        <div />
      </div>
      {rows.map((r) => {
        const left = Math.min(pos(r.value), zero)
        const width = Math.abs(pos(r.value) - zero)
        const sign = r.value >= 0 ? 'pos' : 'neg'
        return (
          <div
            key={r.key}
            role="listitem"
            className={`viz-div-row${onSelect ? ' clickable' : ''}${selected === r.key ? ' selected' : ''}`}
            onClick={() => onSelect?.(r.key)}
            {...(tooltip ? tooltip.bind(r.tip ?? <><b>{r.label}</b> {yenText(r.value, true)}円</>) : {})}
          >
            <div className="viz-div-label">{r.label}{r.sub && <div className="small muted">{r.sub}</div>}</div>
            <div className="viz-div-track">
              {ticks.map((t) => <span key={t} className={`viz-grid${t === 0 ? ' zero' : ''}`} style={{ left: `${pos(t)}%` }} />)}
              <span className={`viz-div-bar ${sign}`} style={{ left: `${left}%`, width: `max(${width}%, 2px)` }} />
            </div>
            <div className={`viz-div-value num${r.value < 0 ? ' neg' : ''}`}>{yenText(r.value, true)}</div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ウォーターフォール（横向き）：増減を積み上げ、小計・合計は灰色の棒
// ---------------------------------------------------------------------------

export interface WaterfallStep { key: string; label: ReactNode; value: number; kind: 'delta' | 'total' }

export function Waterfall({ steps, tooltip }: { steps: WaterfallStep[]; tooltip?: ReturnType<typeof useTooltip> }) {
  // 各段の始点と終点。合計の段はその値から次の増減を始める（期首残高→増減→期末残高の橋渡しにも使う）
  let run = 0
  const spans = steps.map((s) => {
    if (s.kind === 'total') {
      run = s.value
      return { ...s, from: 0, to: s.value }
    }
    const from = run
    run += s.value
    return { ...s, from, to: run }
  })
  const { min, max, ticks } = niceDomain(spans.flatMap((s) => [s.from, s.to]))
  const pos = (v: number) => ((v - min) / (max - min)) * 100
  return (
    <div className="viz-div viz-wf">
      <div className="viz-div-row viz-div-axis" aria-hidden>
        <div />
        <div className="viz-div-track">
          {ticks.map((t) => <span key={t} className="viz-tick" style={{ left: `${pos(t)}%` }}>{shortYen(t)}</span>)}
        </div>
        <div />
      </div>
      {spans.map((s) => {
        const left = pos(Math.min(s.from, s.to))
        const width = Math.abs(pos(s.to) - pos(s.from))
        const cls = s.kind === 'total' ? 'total' : s.value >= 0 ? 'pos' : 'neg'
        return (
          <div key={s.key} className={`viz-div-row${s.kind === 'total' ? ' is-total' : ''}`}
            {...(tooltip ? tooltip.bind(<><b>{s.label}</b> {yenText(s.value, true)}円</>) : {})}>
            <div className="viz-div-label">{s.label}</div>
            <div className="viz-div-track">
              {ticks.map((t) => <span key={t} className={`viz-grid${t === 0 ? ' zero' : ''}`} style={{ left: `${pos(t)}%` }} />)}
              <span className={`viz-div-bar ${cls}`} style={{ left: `${left}%`, width: `max(${width}%, 2px)` }} />
            </div>
            <div className={`viz-div-value num${s.value < 0 ? ' neg' : ''}`}>{yenText(s.value, true)}</div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 表の中の小さな正負の棒（行どうしの大きさを比べる）
// ---------------------------------------------------------------------------

// mixed：プラスとマイナスが混ざるときは0を中央に置く。片方だけなら左端を0にして幅を使い切る
export function InlineBar({ value, maxAbs, mixed }: { value: number; maxAbs: number; mixed: boolean }) {
  const w = maxAbs > 0 ? (Math.abs(value) / maxAbs) * (mixed ? 50 : 100) : 0
  const zero = mixed ? 50 : 0
  return (
    <span className="viz-inline" aria-hidden>
      <span className="viz-inline-zero" style={{ left: `${zero}%` }} />
      {Math.round(value) !== 0 && (
        <span className={`viz-inline-bar ${value >= 0 ? 'pos' : 'neg'}`}
          style={!mixed || value >= 0 ? { left: `${zero}%`, width: `max(${w}%, 2px)` } : { right: '50%', width: `max(${w}%, 2px)` }} />
      )}
    </span>
  )
}
