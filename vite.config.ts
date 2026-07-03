import { defineConfig } from 'vite'
import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

function autoStartBackend() {
  return {
    name: 'auto-start-backend',
    configureServer() {
      const port = 4001
      const host = '127.0.0.1'
      const client = net.connect({ port, host }, () => {
        console.log(`[AutoStart] Backend is already running on ${host}:${port}`)
        client.end()
      })

      client.on('error', () => {
        console.log(`[AutoStart] No process on ${host}:${port}, starting backend...`)
        const scriptPath = path.resolve(process.cwd(), 'server/index.mjs')
        const child = spawn('node', [scriptPath], {
          cwd: process.cwd(),
          stdio: 'inherit',
          detached: true,
          shell: true,
          env: { ...process.env, API_PORT: String(port) }
        })

        child.on('error', (spawnError) => {
          console.error('[AutoStart] Failed to spawn backend process:', spawnError)
        })

        child.unref()
      })
    }
  }
}

export default defineConfig({
  plugins: [autoStartBackend()],
  server: {
    host: '127.0.0.1',
    port: 4000,
    proxy: {
      '/api': 'http://127.0.0.1:4001',
    },
  },
})
