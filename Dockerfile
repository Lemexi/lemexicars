# Базовый образ с Node 20
FROM node:20-bullseye

# Устанавливаем системный Chromium и шрифты
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
WORKDIR /app

# Устанавливаем зависимости
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Копируем исходники
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]