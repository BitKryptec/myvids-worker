FROM node:20-alpine

WORKDIR /app

# ffmpeg/ffprobe for job processing
RUN apk add --no-cache ffmpeg

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["npm", "start"]

