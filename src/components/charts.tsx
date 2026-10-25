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
    onClick: (e: React.MouseEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
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
