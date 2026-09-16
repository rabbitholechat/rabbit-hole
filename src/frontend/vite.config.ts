import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
const backend = fileURLToPath(new URL('../backend', import.meta.url))
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, backend, '')
  return {
    plugins: [react(), tailwind()],
    server: { port: Number(env.FRONTEND_PORT || 5173), strictPort: true, proxy: { '/api': `http://127.0.0.1:${env.BACKEND_PORT || 8000}` } },
    // No env is copied to define/import.meta.env: server keys stay server-side.
  }
})
