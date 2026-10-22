# Harness Observatory image — API + pre-bundled SPA (see documents/04.operations/02.docker-deploy.md).
FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# DSH session logs are zstd-compressed (`session.v4.jsonl.zstd`); the ingest reads them with the CLI
# when the runtime's zlib has no zstd codec.
RUN apt-get update && apt-get install -y --no-install-recommends zstd && rm -rf /var/lib/apt/lists/*
ENV HARNESS_SERVER_HOST=0.0.0.0
COPY package.json bun.lock ./
COPY packages ./packages
COPY profiles ./profiles
RUN bun install --production --frozen-lockfile
EXPOSE 8792
CMD ["bun", "packages/harness-observe-server/src/server.mjs", "--root", "/data/repo", "--port", "8792"]
