FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Только headless-only сборка Chromium — легче полной, для наших целей достаточно.
RUN npx playwright install --with-deps chromium-headless-shell

# xray-core — опционально поднимает локальный SOCKS5 через VLESS-подписку
# (см. src/proxy-bootstrap.js). Сам ключ подписки сюда не попадает — он только
# в переменной окружения PROXY_SUBSCRIPTION_URL на самом Render.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates \
  && curl -sL "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip" -o /tmp/xray.zip \
  && mkdir -p /app/xray \
  && unzip -o /tmp/xray.zip -d /app/xray \
  && chmod +x /app/xray/xray \
  && rm /tmp/xray.zip \
  && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY src ./src

EXPOSE 3000

CMD ["node", "--expose-gc", "src/start.js"]
