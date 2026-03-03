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
const isDemoMode = process.env.VITE_DEMO_MODE === 'true'

function buildAliases(): Record<string, string> {
  const aliases: Record<string, string> = {}
  // Demo aliases must be registered before the generic '@' prefix so Vite matches them first
  if (isDemoMode) {
    aliases['@/data/docker.functions'] = fileURLToPath(new URL('./src/lib/mock/functions/docker.functions.ts', import.meta.url))
    aliases['@/data/zfs.functions'] = fileURLToPath(new URL('./src/lib/mock/functions/zfs.functions.ts', import.meta.url))
    aliases['@/data/proxmox.functions'] = fileURLToPath(new URL('./src/lib/mock/functions/proxmox.functions.ts', import.meta.url))
    aliases['@/data/settings.functions'] = fileURLToPath(new URL('./src/lib/mock/functions/settings.functions.ts', import.meta.url))
  }
  aliases['@'] = fileURLToPath(new URL('./src', import.meta.url))
  return aliases
}

export default defineConfig({
  customLogger,
  base: process.env.VITE_BASE_PATH || '/',
  resolve: {
    alias: buildAliases(),
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
    external: ['dockerode', 'ssh2', 'docker-modem', 'ssh2-streams', 'undici'],
  },
  optimizeDeps: {
    exclude: ['dockerode', 'ssh2', 'cpu-features', 'docker-modem', 'ssh2-streams'],
  },
  preview: {
    host: true,
  },
  server: {
    // Allow host.docker.internal so the Playwright MCP browser (in Docker) can reach the dev server
    allowedHosts: ['host.docker.internal'],
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
      external: ['dockerode', 'ssh2', 'docker-modem', 'ssh2-streams', 'undici'],
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
