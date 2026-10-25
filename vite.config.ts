import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 相対パスで出力し、GitHub Pages のサブパス（/ifrs-aje-app/）でも動くようにする
  base: './',
})
