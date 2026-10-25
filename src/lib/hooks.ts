import { useCallback, useEffect, useState } from 'react'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [...deps, tick])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, reload }
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
