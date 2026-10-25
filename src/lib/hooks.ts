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
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  const data = state.key === key ? state.data : null
  return { data, error, loading: loading || state.key !== key, reload }
}

// 一覧画面で「前期／当期」を切り替える。選択はブラウザに覚えておく
export type Slot = 'prior' | 'current'

export function useSlot(): [Slot, (s: Slot) => void] {
  const [slot, setSlot] = useState<Slot>(() => {
    try {
      return localStorage.getItem('slot') === 'prior' ? 'prior' : 'current'
    } catch {
      return 'current'
    }
  })
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
