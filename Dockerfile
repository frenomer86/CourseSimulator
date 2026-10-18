# CS Virtual Lab: one image that serves the web app and its API.
# Build:  docker compose build     Run: docker compose up -d   (see README, "Deploying to a VPS")

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/lab-runtime/package.json packages/lab-runtime/
COPY packages/engine-digital-logic/package.json packages/engine-digital-logic/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    WEB_DIST=/app/apps/web/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
EXPOSE 8787
USER node
CMD ["node", "apps/api/dist/server.js"]
