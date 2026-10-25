import type { ReactNode } from 'react'
import type { Slot } from '../lib/hooks'
import { APPLICABILITY_LABELS, STATUS_LABELS } from '../lib/issues'

export function Loading() {
  return <div className="muted pad">読み込み中…</div>
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="alert alert-error">エラー：{message}</div>
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

export function SlotToggle({ slot, onChange }: { slot: Slot; onChange: (s: Slot) => void }) {
  return (
    <div className="segmented" role="group" aria-label="対象期">
      <button className={slot === 'prior' ? 'on' : ''} onClick={() => onChange('prior')}>前期（2026年3月期等）</button>
      <button className={slot === 'current' ? 'on' : ''} onClick={() => onChange('current')}>当期（2027年3月期等）</button>
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
