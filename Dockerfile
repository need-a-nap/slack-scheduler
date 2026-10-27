FROM node:20-alpine

WORKDIR /app

# 의존성 먼저 (캐시 활용)
COPY package*.json ./
RUN npm ci --omit=dev

# 앱 소스
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
