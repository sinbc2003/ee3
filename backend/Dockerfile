FROM node:20-slim

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --omit=dev

COPY backend/src ./src

RUN mkdir -p public
COPY app-config.js ./public/app-config.js
COPY index.html ./public/index.html
COPY admin.html ./public/admin.html
COPY chat.html ./public/chat.html
COPY modal.html ./public/modal.html
COPY chatgpt.png ./public/chatgpt.png

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "src/server.js"]

