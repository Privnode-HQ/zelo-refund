# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json ./package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/admin/package.json ./apps/admin/package.json

RUN npm install

FROM deps AS builder
WORKDIR /app

COPY . .

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL

ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
  VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
  VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run -w @zelo/admin build
RUN npm run -w @zelo/api build

FROM node:20-alpine AS api
ENV NODE_ENV=production
WORKDIR /app/apps/api

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/apps/api/package.json ./package.json
COPY --from=builder /app/apps/api/dist ./dist

EXPOSE 3001
CMD ["node", "dist/index.js"]

FROM nginx:1.25-alpine AS admin

COPY docker/nginx.admin.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/admin/dist /usr/share/nginx/html

EXPOSE 80
