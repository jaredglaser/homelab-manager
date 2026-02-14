import { defineConfig, createLogger } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'url'
import { nitro } from 'nitro/vite'
import tailwindcss from '@tailwindcss/vite'

const logger = createLogger()
const customLogger = {
  ...logger,
  warn(msg: string, options?: any) {
    // Suppress "use client" directive warnings from MUI and other libraries
    if (msg.includes('Module level directives cause errors when bundled') && msg.includes('"use client"')) {
      return
    }
    logger.warn(msg, options)
  },
}

const isDev = process.env.NODE_ENV !== 'production'

export default defineConfig({
  customLogger,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    isDev && devtools(),
    nitro(),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
      },
    }),
    viteReact(),
  ],
  ssr: {
    external: ['dockerode', 'ssh2', 'docker-modem', 'ssh2-streams'],
  },
  preview: {
    host: true,
  },
  server: {
    watch: {
      usePolling: true,
      // 2600+ dashboard icon SVGs cause slow startup through WSL file mount
      ignored: ['**/public/icons/**'],
    },
    warmup: {
      clientFiles: ['./src/routes/index.tsx', './src/routes/__root.tsx'],
    },
  },
  build: {
    rollupOptions: {
      external: ['dockerode', 'ssh2', 'docker-modem', 'ssh2-streams'],
      onwarn(warning, warn) {
        // Suppress "use client" directive warnings from MUI and other libraries
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) {
          return
        }
        warn(warning)
      },
    },
  },
})
