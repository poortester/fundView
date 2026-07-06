import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = env.API_PORT ?? process.env.API_PORT ?? 4001

  return {
    plugins: [tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 4000,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${apiPort}`,
      },
    },
  }
})
