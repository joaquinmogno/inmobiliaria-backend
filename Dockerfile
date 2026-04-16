FROM node:20-alpine AS builder

WORKDIR /app

ARG DATABASE_URL

COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

ENV DATABASE_URL=${DATABASE_URL}
RUN npx prisma generate

RUN npm run build

FROM node:20-alpine

WORKDIR /app
RUN apk update && apk add --no-cache openssl postgresql-client
ARG DATABASE_URL
ARG JWT_SECRET
ARG PORT=3000
ARG UPLOAD_DIR=/app/uploads
ENV DATABASE_URL=${DATABASE_URL}
ENV JWT_SECRET=${JWT_SECRET}
ENV PORT=${PORT}
ENV UPLOAD_DIR=${UPLOAD_DIR}
ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
RUN mkdir -p /app/uploads
COPY docker-entrypoint.sh /app/
RUN chmod +x /app/docker-entrypoint.sh
EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
