ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null || \
       ! command -v openssl >/dev/null || ! test -s /etc/ssl/certs/ca-certificates.crt; then \
      apt-get -o Acquire::Retries=4 update && \
      apt-get -o Acquire::Retries=4 install -y --no-install-recommends ca-certificates ffmpeg openssl && \
      rm -rf /var/lib/apt/lists/*; \
    fi

FROM base AS build
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=social-publisher-npm,target=/root/.npm,sharing=locked npm ci --no-audit --no-fund
COPY . .
RUN npm run build && rm -rf .next/cache && npm prune --omit=dev --no-audit --no-fund

FROM base
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json /app/tsconfig.json /app/prisma.config.ts ./
COPY --from=build --chown=node:node /app/next.config.ts ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/src ./src
USER node
EXPOSE 3000
CMD ["npm", "start"]
