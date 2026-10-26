// テストデータ（全13論点）を入れ直す。画面の「マスタ → テストデータ → テストデータを入れる」と同じ処理
// 前に入れたテストデータだけを入れ替え、画面で入力したものは残す
// 実行：npx vitest run --config scripts/vitest.seed.config.ts
import { it } from 'vitest'
import { insertTestData } from '../src/lib/testData'

it('テストデータを入れる', async () => {
  await insertTestData((message, ratio) => console.log(`${Math.round(ratio * 100)}% ${message}`))
})
