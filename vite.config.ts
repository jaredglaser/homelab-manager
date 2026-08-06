import { defineConfig, createLogger, loadEnv } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { nitro } from 'nitro/vite'
import tailwindcss from '@tailwindcss/vite'
import { encodeFunctionId } from './src/lib/server-fn-id'

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

export default defineConfig(({ mode }) => {
  // Not process.env: the app reads these through import.meta.env, and Vite never
  // copies .env values into process.env, so the two sides would disagree.
  const env = loadEnv(mode, process.cwd(), '')

  // Demo and Playwright targets only; a production build keeps TanStack's opaque
  // ids so RPC URLs do not decode back to a source path and export name.
  const isMockBuild = env.VITE_DEMO_MODE === 'true' || env.VITE_ENABLE_MSW === 'true'

  return {
    customLogger,
    base: env.VITE_BASE_PATH || '/',
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
        ...(isMockBuild
          ? {
              serverFns: {
                generateFunctionId: ({ filename, functionName }: { filename: string; functionName: string }) =>
                  encodeFunctionId(filename, functionName),
              },
            }
          : {}),
      }),
      viteReact(),
    ],
    ssr: {
      external: ['undici'],
    },
    optimizeDeps: {
      exclude: ['@tanstack/start-server-core'],
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
        external: ['undici'],
        onwarn(warning, warn) {
          // Suppress "use client" directive warnings from MUI and other libraries
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) {
            return
          }
          warn(warning)
        },
      },
    },
  }
})
