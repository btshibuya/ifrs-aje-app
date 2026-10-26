// デモ用の計算データを作るスクリプトを、アプリと同じ読み込み（import.meta.env など）で動かすための設定
// 実行：npx vitest run --config scripts/vitest.seed.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['scripts/seed-demo.seed.ts'], testTimeout: 600_000 },
})
