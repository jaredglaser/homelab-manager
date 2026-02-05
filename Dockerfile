# Dockerfile for homelab-manager
# Used for both web server and worker by overriding CMD in docker-compose

FROM oven/bun:1

WORKDIR /app

# Copy dependency files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Expose port for web server (not used by worker)
EXPOSE 3000

# Default command (overridden in docker-compose)
CMD ["bun", "run", "dev"]
