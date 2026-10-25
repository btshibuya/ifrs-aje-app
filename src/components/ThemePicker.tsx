// 配色の切り替え（Word を基本に、Office アプリを参考にした色）。選んだ配色はブラウザに覚える

import { useEffect, useRef, useState } from 'react'

export const THEMES = [
  { key: 'word', label: 'Word（標準）', header: '#11346f', primary: '#185abd' },
  { key: 'outlook', label: 'Outlook', header: '#0b4a85', primary: '#0f6cbd' },
  { key: 'excel', label: 'Excel', header: '#0a4f2a', primary: '#107c41' },
  { key: 'powerpoint', label: 'PowerPoint', header: '#6e2614', primary: '#b7472a' },
  { key: 'publisher', label: 'Publisher', header: '#044a42', primary: '#077568' },
  { key: 'onenote', label: 'OneNote', header: '#4a1069', primary: '#7719aa' },
] as const

export type ThemeKey = (typeof THEMES)[number]['key']

export function applyTheme(key: string) {
  if (key === 'word') document.documentElement.removeAttribute('data-color')
  else document.documentElement.setAttribute('data-color', key)
}

function readTheme(): ThemeKey {
  try {
    const v = localStorage.getItem('colorTheme')
    return (THEMES.find((t) => t.key === v)?.key ?? 'word') as ThemeKey
  } catch {
    return 'word'
  }
}

export default function ThemePicker() {
  const [theme, setTheme] = useState<ThemeKey>(readTheme)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem('colorTheme', theme)
    } catch {
      // 保存できなくても、この画面の間は切り替わる
    }
  }, [theme])

  // 外側を押す・Escキーで閉じる
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = THEMES.find((t) => t.key === theme)!
  return (
    <div className="theme-picker" ref={root}>
      <button className="theme-button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="配色を変える">
        <span className="theme-chip" aria-hidden><span style={{ background: current.header }} /><span style={{ background: current.primary }} /></span>
        <span className="theme-label">配色：{current.label.replace('（標準）', '')}</span>
      </button>
      {open && (
        <div className="theme-menu" role="radiogroup" aria-label="配色">
          <div className="theme-menu-title">配色（このブラウザに保存されます）</div>
          {THEMES.map((t) => (
            <button key={t.key} role="radio" aria-checked={t.key === theme} className="theme-option" onClick={() => { setTheme(t.key); setOpen(false) }}>
              <span className="theme-chip" aria-hidden><span style={{ background: t.header }} /><span style={{ background: t.primary }} /></span>
              {t.label}
              {t.key === theme && <span className="theme-check" aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
