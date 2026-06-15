import { defineConfig, createLogger } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { nitro } from 'nitro/vite'
import tailwindcss from '@tailwindcss/vite'
import { encodeFunctionId } from './src/lib/mock/handlers/function-id'

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

function buildAliases(): Record<string, string> {
  // Demo and e2e modes no longer swap server-function modules at build time;
  // MSW intercepts the real RPC/SSE network calls instead (see src/lib/mock).
  return {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  }
}

export default defineConfig({
  customLogger,
  base: process.env.VITE_BASE_PATH || '/',
  resolve: {
    alias: buildAliases(),
  },
  plugins: [
    isDev && devtools(),
    nitro({ serverDir: 'server', features: { websocket: true } }),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
      },
      importProtection: {
        behavior: 'error',
      },
      serverFns: {
        // Mirror the dev compiler's base64url(JSON{file,export}) id format in
        // production builds so the MSW dispatcher decodes server-function calls
        // the same way in the dev app target and the built demo deploy.
        generateFunctionId: ({ filename, functionName }) =>
          encodeFunctionId(filename, functionName),
      },
    }),
    viteReact(),
  ],
  ssr: {
    external: ['dockerode', 'ssh2', 'docker-modem', 'ssh2-streams', 'undici'],
  },
  optimizeDeps: {
    exclude: ['dockerode', 'ssh2', 'cpu-features', 'docker-modem', 'ssh2-streams', '@tanstack/start-server-core'],
    // Pre-bundle MSW so demo/e2e mode does not trigger a mid-session dep
    // re-optimization (which invalidates in-flight module hashes and 404s
    // already-loaded dynamic imports). MSW is lazy-loaded, so without this Vite
    // only discovers it after the first navigation.
    include: ['msw', 'msw/browser'],
  },
  preview: {
    host: true,
  },
  server: {
    // Allow host.docker.internal so the Playwright MCP browser (in Docker) can reach the dev server
    allowedHosts: ['host.docker.internal'],
    watch: {
      ignored: ['**/public/icons/**'],
    },
    warmup: {
      clientFiles: ['./src/routes/index.tsx', './src/routes/__root.tsx'],
    },
  },
  build: {
    rolldownOptions: {
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
