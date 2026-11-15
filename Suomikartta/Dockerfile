# Hosted copy of the website (Railway). Node 24 runs server.ts directly (type stripping).
FROM node:24-slim
WORKDIR /app
# Install with bun from bun.lock (plain npm install hits a vite/esbuild peer conflict).
COPY package.json bun.lock ./
RUN npm install -g bun@1 --no-audit --no-fund && bun install --frozen-lockfile
COPY . .
RUN npm run build
ENV NODE_ENV=production
CMD ["node", "server.ts"]
