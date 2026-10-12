# ========================================================
# BravoGen MCP Server - Production Dockerfile
# ========================================================
FROM oven/bun:1.2-alpine AS builder

WORKDIR /build
COPY package.json tsconfig.json* ./
COPY src/ ./src/
RUN bun build src/index.ts --target=node --outfile=dist/index.js

# Runtime image: lightweight Node 22
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY bin/ ./bin/
COPY data/ ./data/
COPY docs/ ./docs/
COPY --from=builder /build/dist/ ./dist/

# Create volume mount points for user config
RUN mkdir -p /app/config && chmod +x /app/bin/bravogen-mcp.js

# By default, runs the stdio MCP server
ENTRYPOINT ["node", "/app/bin/bravogen-mcp.js"]
