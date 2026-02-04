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

export default defineConfig({
  customLogger,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  plugins: [
    devtools(),
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
