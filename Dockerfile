# Node 24 because the database is node:sqlite, which is only stable from 24.
# On Node 22 the same import needs --experimental-sqlite and behaves differently.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js index.html ./
# web/settings.jsx imports ../shared/brand.cjs. A build context that leaves a
# top-level directory out fails here and nowhere else: vite in a checkout has
# the whole repository, so this is invisible until the image is built.
COPY shared ./shared
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
# server/theme.js requires it too, so it has to be in the runtime image and not
# only in the build one. Copying it into the build stage alone produces an image
# that builds green and then crash-loops on the first boot.
COPY shared ./shared
COPY server ./server
# The staff guide, served at /manual.pdf. Without it the menu item in the app
# opens a 404 on the machine while working perfectly in a checkout --
# tests/dockerfile-copies.test.js is what turns that into a red test instead.
COPY docs/manual ./docs/manual
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
