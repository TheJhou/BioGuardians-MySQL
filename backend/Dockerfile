# --- Build stage ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Runtime stage ---
FROM node:22-alpine AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3001
# --import ensures OTel instrumentation loads BEFORE other modules,
# so auto-instrumentation can patch Express, mysql2, http, etc.
CMD ["node", "--import", "./dist/telemetry/instrumentation.js", "dist/index.js"]
