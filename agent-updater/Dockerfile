# Must match .bun-version; scripts/__tests__/bun-version.test.ts fails CI on drift.
ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-slim AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY tsconfig.json ./

FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "--eval", "process.exit(0)"]
CMD ["bun", "src/index.ts"]
