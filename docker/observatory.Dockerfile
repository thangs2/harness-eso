# Harness Observatory image — API + bundled SPA (see documents/04.operations/02.docker-deploy.md).
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY profiles ./profiles
RUN bun install --frozen-lockfile
RUN bun run build:observatory

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HARNESS_SERVER_HOST=0.0.0.0
COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/profiles ./profiles
EXPOSE 8792
CMD ["bun", "packages/harness-observe-server/src/server.mjs", "--root", "/data/repo", "--port", "8792"]
