# Harness Console image — wizard API + bundled SPA (:8791).
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY profiles ./profiles
RUN bun install --frozen-lockfile
RUN bun run build:console

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HARNESS_CONSOLE_HOST=0.0.0.0
ENV HARNESS_CONSOLE_PORT=8791
ENV HARNESS_PRODUCT_STATE_DIR=/data/product-state
ENV HARNESS_PROFILES_DIR=/app/profiles
ENV HARNESS_ESO_ROOT=/app
ENV HARNESS_AGENT_MOUNT=/agent-repos
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/profiles ./profiles
EXPOSE 8791
CMD ["bun", "packages/harness-console-server/src/server.mjs"]
