FROM node:20-slim

# glibc по умолчанию заводит до 8×CPU арен malloc — память, которую Node уже
# честно освободил (free()), оседает закэшированной в этих аренах и не
# возвращается ОС, из-за чего RSS растёт и не падает без всякой утечки в JS.
# Одна арена = сразу отдаёт освобождённое обратно системе. Действует на весь
# контейнер (все процессы, включая дочерние).
ENV MALLOC_ARENA_MAX=1

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Только headless-only сборка Chromium — легче полной, для наших целей достаточно.
RUN npx playwright install --with-deps chromium-headless-shell

# xray-core — опционально поднимает локальный SOCKS5 через VLESS-подписку
# (см. src/proxy-bootstrap.js). Сам ключ подписки сюда не попадает — он только
# в переменной окружения PROXY_SUBSCRIPTION_URL на самом Render.
# tini — остаётся установленным (не purge'ится ниже, в отличие от curl/unzip):
# без init-процесса на PID1 контейнер не разгребает зомби-процессы и, что
# важнее здесь, если OOM-killer решит убить конкретно процесс Chromium (самый
# крупный потребитель на пике), без tini под PID1 это иногда валит весь
# контейнер целиком вместе с ним.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates tini \
  && curl -sL "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip" -o /tmp/xray.zip \
  && mkdir -p /app/xray \
  && unzip -o /tmp/xray.zip -d /app/xray \
  && chmod +x /app/xray/xray \
  && rm /tmp/xray.zip \
  && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY src ./src

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "--expose-gc", "src/start.js"]
