FROM node:20-alpine AS builder

WORKDIR /app
ENV PRISMA_ENGINES_CACHE_DIR=/app/prisma-engines
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build?schema=public
RUN apk add --no-cache openssl \
  && mkdir -p /app/prisma-engines

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npx prisma generate

RUN npm run build

FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache openssl postgresql-client
ENV PORT=3000
ENV UPLOAD_DIR=/app/uploads
ENV NODE_ENV=production
ENV PRISMA_ENGINES_CACHE_DIR=/app/prisma-engines

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma-engines ./prisma-engines
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
RUN mkdir -p /app/uploads /app/backups /app/.seed-data \
  && chown -R node:node /app/uploads /app/backups /app/.seed-data
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh
EXPOSE 3000

USER node

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
