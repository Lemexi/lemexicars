# Базовый образ с Node 20 (Debian bullseye)
FROM node:20-bullseye

# Устанавливаем системный Chromium и шрифты
# Делаем symlink на chromium-browser (на всякий случай)
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    ca-certificates \
    --no-install-recommends && \
    ln -sf /usr/bin/chromium /usr/bin/chromium-browser || true && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Пусть сервер берёт этот путь как дефолтный
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Ставим зависимости
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Копируем исходники
COPY . .

EXPOSE 8080
CMD ["node", "server.js"]