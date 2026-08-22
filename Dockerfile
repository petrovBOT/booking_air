FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

# Только headless-only сборка Chromium — легче полной, для наших целей достаточно.
RUN npx playwright install --with-deps chromium-headless-shell

COPY src ./src

CMD ["node", "src/index.js"]
