# Образ с Node + уже установленным Chrome
FROM ghcr.io/puppeteer/puppeteer:21.11.0

WORKDIR /app

# Устанавливаем зависимости
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Копируем исходники
COPY . .

# В этом образе Chrome доступен по этим путям
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

EXPOSE 8080
CMD ["node", "server.js"]