import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { productionAnalyticsHtml } from './tools/build/productionAnalytics.ts'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => ({
  plugins: [react(), productionAnalyticsHtml({ command, mode, env: loadEnv(mode, process.cwd(), '') })],
}))
