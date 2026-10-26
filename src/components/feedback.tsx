// 操作の確認（ダイアログ）と、終わったことの知らせ（トースト）
// ブラウザ標準の confirm / prompt は、スマホでサイトのURLが出る・結果の説明が書けない・理由の入力を検証できないため使わない

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

interface ConfirmOptions {
  title: string
  body?: ReactNode
  confirmLabel: string
  danger?: boolean
  // 理由などの入力を求めるとき（空では確定できない）
  input?: { label: string; placeholder?: string; defaultValue?: string; rows?: number }
}

interface Toast { id: number; message: string; tone: 'ok' | 'info' | 'error' }

interface FeedbackApi {
  confirm: (o: ConfirmOptions) => Promise<string | null> // 押されたら入力値（入力なしは ''）、やめたら null
  toast: (message: string, tone?: Toast['tone']) => void
}

const Ctx = createContext<FeedbackApi | null>(null)

export function useFeedback() {
  const v = useContext(Ctx)
  if (!v) throw new Error('FeedbackProvider の中で使ってください')
  return v
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: string | null) => void }) | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)

  const confirm = useCallback((o: ConfirmOptions) => new Promise<string | null>((resolve) => setDialog({ ...o, resolve })), [])
  const toast = useCallback((message: string, tone: Toast['tone'] = 'ok') => {
    const id = ++seq.current
    setToasts((t) => [...t, { id, message, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  return (
    <Ctx.Provider value={{ confirm, toast }}>
      {children}
      {dialog && <ConfirmDialog {...dialog} onDone={(v) => { dialog.resolve(v); setDialog(null) }} />}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span aria-hidden>{t.tone === 'ok' ? '✓' : t.tone === 'error' ? '!' : 'i'}</span>{t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

function ConfirmDialog({ title, body, confirmLabel, danger, input, onDone }: ConfirmOptions & { onDone: (v: string | null) => void }) {
  const [text, setText] = useState(input?.defaultValue ?? '')
  const [touched, setTouched] = useState(false)
  const first = useRef<HTMLTextAreaElement | HTMLButtonElement | null>(null)
  const opener = useRef<Element | null>(document.activeElement)

  // 開いたら入力欄（なければ「やめる」）にフォーカス。閉じたら元の場所に戻す。Escでやめる
  useEffect(() => {
    first.current?.focus()
    const back = opener.current
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(null) }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (back instanceof HTMLElement) back.focus()
    }
  }, [onDone])

  const invalid = !!input && text.trim() === ''
  const ok = () => {
    setTouched(true)
    if (!invalid) onDone(input ? text.trim() : '')
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null) }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">{title}</h2>
        {body && <div className="modal-body">{body}</div>}
        {input && (
          <label className="modal-input">
            <span className="small"><b>{input.label}</b><span className="req">必須</span></span>
            <textarea ref={(el) => { first.current = el }} rows={input.rows ?? 3} value={text} placeholder={input.placeholder} onChange={(e) => setText(e.target.value)} />
            {touched && invalid && <span className="small text-error">入力してください</span>}
          </label>
        )}
        <div className="modal-actions">
          <button className="btn" ref={(el) => { if (!input) first.current = el }} onClick={() => onDone(null)}>やめる</button>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={ok}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
