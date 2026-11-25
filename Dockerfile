ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=social-publisher-npm,target=/root/.npm,sharing=locked npm ci --no-audit --no-fund

FROM dependencies
RUN if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null || \
       ! command -v openssl >/dev/null || ! test -s /etc/ssl/certs/ca-certificates.crt; then \
      apt-get -o Acquire::Retries=4 update && \
      apt-get -o Acquire::Retries=4 install -y --no-install-recommends ca-certificates ffmpeg openssl && \
      rm -rf /var/lib/apt/lists/*; \
    fi
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
