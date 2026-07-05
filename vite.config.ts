import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 4000,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.API_PORT ?? 4001}`,
    },
  },
})
