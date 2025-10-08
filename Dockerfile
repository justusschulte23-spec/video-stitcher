FROM node:18

WORKDIR /app

COPY package*.json ./
RUN npm install

# FFmpeg installieren
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
