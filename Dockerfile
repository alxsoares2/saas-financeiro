FROM node:22-slim

# Instala Poppler (pdftoppm) - leve e open source
RUN apt-get update && apt-get install -y poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

EXPOSE 8080

CMD ["node", "dist/index.js"]
