FROM node:22-alpine

# Instala Poppler (pdftoppm) - leve e open source
RUN apk add --no-cache poppler-utils

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

EXPOSE 8080

CMD ["node", "dist/index.js"]
