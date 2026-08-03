FROM node:22-alpine

# Instala Ghostscript (mais leve que ImageMagick)
RUN apk add --no-cache ghostscript

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

EXPOSE 8080

CMD ["node", "dist/index.js"]
