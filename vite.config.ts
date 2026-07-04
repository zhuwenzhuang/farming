import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const basePath = process.env.FARMING_BASE_PATH || env.FARMING_BASE_PATH || '/'
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version?: string }

  return {
    base: normalizedBase,
    plugins: [react()],
    define: {
      __FARMING_PACKAGE_VERSION__: JSON.stringify(packageJson.version || ''),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': 'http://127.0.0.1:3000',
        '/farming/api': 'http://127.0.0.1:3000',
        '/ws': {
          target: 'ws://127.0.0.1:3000',
          ws: true,
        },
        '/farming/ws': {
          target: 'ws://127.0.0.1:3000',
          ws: true,
        },
        '/vendor': 'http://127.0.0.1:3000',
        '/farming/vendor': 'http://127.0.0.1:3000',
      },
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 7500,
    },
  }
})
