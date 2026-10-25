import { createClient } from '@supabase/supabase-js'

// 公開用のキー（ブラウザに置く前提のもの）。環境変数があればそちらを使う
const url = import.meta.env.VITE_SUPABASE_URL ?? 'https://aqhldysgwypgpwikzayv.supabase.co'
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_GHR86a1-YUma4U7tCVhBTQ_0ifPicct'

export const supabase = createClient(url, key, { auth: { persistSession: false } })

// エラーなら例外にして、呼び出し側は try/catch でまとめて扱う
export function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message)
  return res.data
}
