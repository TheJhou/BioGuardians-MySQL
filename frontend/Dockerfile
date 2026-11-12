# --- Build stage ---
FROM node:22-alpine AS build

WORKDIR /app

# Copy the whole build context (respects .dockerignore).
COPY . .

# Bake Vite env vars into the bundle at build time.
ARG VITE_API_URL=/api
ARG VITE_MAPTILER_API_KEY
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_MAPTILER_API_KEY=${VITE_MAPTILER_API_KEY}

# Install dependencies without running lifecycle scripts.
RUN npm install --ignore-scripts

# Build the production bundle.
RUN npx vite build

# --- Runtime stage ---
FROM nginx:alpine

# Copy built static assets.
COPY --from=build /app/dist /usr/share/nginx/html

# nginx config that proxies /api to the backend container.
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
