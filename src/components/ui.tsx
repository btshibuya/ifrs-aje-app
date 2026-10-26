import type { ReactNode } from 'react'
import { QUARTERS, QUARTER_LABELS, QUARTER_SHORT, parseSlot, type Slot } from '../lib/hooks'
import { APPLICABILITY_LABELS, STATUS_LABELS } from '../lib/issues'

// 読み込み中：画面の骨組み（灰色の帯）を出し、表示が出たときのずれを小さくする。文字は読み上げ用に残す
export function Loading() {
  return (
    <div className="skeleton" aria-busy="true">
      <span className="sr-only">読み込み中…</span>
      <div className="sk sk-title" />
      <div className="sk-row"><div className="sk sk-card" /><div className="sk sk-card" /><div className="sk sk-card" /></div>
      <div className="sk sk-line" /><div className="sk sk-line" /><div className="sk sk-line short" />
    </div>
  )
}

// よくあるエラーを、担当者にわかる言葉と次にすることに言い換える（元の文面は「詳しい情報」に残す）
const FRIENDLY: [RegExp, string][] = [
  [/Failed to fetch|NetworkError|Load failed/i, 'サーバーに接続できませんでした。通信状況を確認して、ページを再読み込みしてください。'],
  [/duplicate key/i, '同じものがすでに登録されています。画面を再読み込みして、最新の内容を確認してください。'],
  [/foreign key/i, 'ほかのデータから参照されているため、この操作はできません。'],
  [/JWT|permission denied|row-level security/i, 'この操作をする権限がありません。親会社の担当者に連絡してください。'],
  [/timeout|timed out/i, '時間内に処理が終わりませんでした。少し待ってから、もう一度お試しください。'],
]

export function ErrorBox({ message }: { message: string }) {
  const friendly = FRIENDLY.find(([re]) => re.test(message))?.[1]
  return (
    <div className="alert alert-error" role="alert">
      {friendly ?? message}
      {friendly && <details className="small"><summary>詳しい情報</summary>{message}</details>}
    </div>
  )
}

export function Money({ value, signed = false }: { value: number | null | undefined; signed?: boolean }) {
  if (value === null || value === undefined) return <span className="muted">—</span>
  const n = Math.round(Number(value))
  const text = n.toLocaleString('ja-JP')
  return <span className={`num${n < 0 ? ' neg' : ''}`}>{signed && n > 0 ? `+${text}` : text}</span>
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge status-${status}`}>{STATUS_LABELS[status] ?? status}</span>
}

export function ApplicabilityBadge({ value }: { value: string | null }) {
  if (!value) return <span className="badge app-none">未設定</span>
  return <span className={`badge app-${value}`}>{APPLICABILITY_LABELS[value] ?? value}</span>
}

// 対象の時点：前期・当期のそれぞれに、第1〜第3四半期と期末を並べる（時系列の順）
export function SlotToggle({ slot, onChange, years }: { slot: Slot; onChange: (s: Slot) => void; years?: { prior: string; current: string } }) {
  const { fy, q } = parseSlot(slot)
  return (
    <div className="period-picker" role="group" aria-label="対象の時点">
      {(['prior', 'current'] as const).map((y) => (
        <div key={y} className={`pp-year${fy === y ? ' on' : ''}`}>
          <span className="pp-year-label">{y === 'prior' ? '前期' : '当期'}<small>{years?.[y] ?? ''}{years ? '等' : ''}</small></span>
          <div className="segmented pp-quarters">
            {QUARTERS.map((x) => (
              <button key={x} className={fy === y && q === x ? 'on' : ''} aria-pressed={fy === y && q === x}
                title={`${years?.[y] ?? (y === 'prior' ? '前期' : '当期')} ${QUARTER_LABELS[x]}`} onClick={() => onChange(`${y}:${x}`)}>
                {QUARTER_SHORT[x]}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { key: T; label: ReactNode }[]; active: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key} className={active === t.key ? 'on' : ''} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      <div className="page-header-tools">{children}</div>
    </div>
  )
}

export const formatDateTime = (s: string | null) =>
  s ? new Date(s).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
