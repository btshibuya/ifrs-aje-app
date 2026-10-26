import { useCallback, useEffect, useState } from 'react'

// 非同期の読み込み。対象（deps）が変わったら、前の対象の結果は返さない（前の会社・期の数字を一瞬でも出さない）
// 同じ対象の読み直し（reload）では、前の結果を出したまま新しい結果に入れ替える（画面がちらつかない）
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const key = JSON.stringify(deps)
  const [state, setState] = useState<{ key: string; data: T | null }>({ key, data: null })
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fn()
      .then((d) => alive && (setState({ key, data: d }), setError(null)))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [key, tick]) // 対象は key（deps を文字列にしたもの）で見る

  const reload = useCallback(() => setTick((t) => t + 1), [])
  const data = state.key === key ? state.data : null
  return { data, error, loading: loading || state.key !== key, reload }
}

// 一覧画面で、対象の時点（前期・当期 × 第1〜第3四半期・期末）を切り替える。選択はブラウザに覚えておく
export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'FY'
export type Slot = `${'prior' | 'current'}:${Quarter}`
export const QUARTERS: Quarter[] = ['Q1', 'Q2', 'Q3', 'FY']
export const QUARTER_LABELS: Record<Quarter, string> = { Q1: '第1四半期', Q2: '第2四半期', Q3: '第3四半期', FY: '期末（本決算）' }
export const QUARTER_SHORT: Record<Quarter, string> = { Q1: '1Q', Q2: '2Q', Q3: '3Q', FY: '期末' }

export const parseSlot = (s: Slot) => {
  const [fy, q] = s.split(':') as ['prior' | 'current', Quarter]
  return { fy, q }
}

function readSlot(): Slot {
  try {
    const v = localStorage.getItem('slot') ?? ''
    // 以前の保存形式（prior / current）は、期末として読む
    if (v === 'prior' || v === 'current') return `${v}:FY`
    if (/^(prior|current):(Q1|Q2|Q3|FY)$/.test(v)) return v as Slot
  } catch {
    // 読めなくても既定で動く
  }
  return 'current:FY'
}

export function useSlot(): [Slot, (s: Slot) => void] {
  const [slot, setSlot] = useState<Slot>(readSlot)
  const update = (s: Slot) => {
    setSlot(s)
    try {
      localStorage.setItem('slot', s)
    } catch {
      // 保存できなくても動作に支障はない
    }
  }
  return [slot, update]
}
