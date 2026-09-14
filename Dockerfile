# Node 24 because the database is node:sqlite, which is only stable from 24.
# On Node 22 the same import needs --experimental-sqlite and behaves differently.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js index.html ./
COPY web ./web
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
# The container is the whole network boundary here: Caddy or Fly's proxy is the
# only thing that reaches it, so it has to listen on every interface, not on
# 127.0.0.1 as it does on a laptop.
ENV HOST=0.0.0.0 PORT=3000
# Both of these belong on a volume. The paths are repeated in every deployment
# recipe in docs/deploy.md; change them in one place and change them there too.
ENV DATABASE_PATH=/data/gym.sqlite SLIP_STORAGE_PATH=/data/slips
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
COPY deploy/entrypoint.sh ./deploy/entrypoint.sh
RUN chmod +x deploy/entrypoint.sh && mkdir -p /data && chown -R node:node /data /app

# Nothing here needs root, and a slip upload lands on disk as this user.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["./deploy/entrypoint.sh"]
CMD ["node", "server/start.js"]
