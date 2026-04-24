FROM node:18

WORKDIR /app

COPY package*.json ./
RUN npm install

# FFmpeg + wget installieren
RUN apt-get update && apt-get install -y ffmpeg wget && rm -rf /var/lib/apt/lists/*

COPY . .

# Montserrat Bold font für Untertitel
RUN wget -q "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Bold.ttf" \
    -O /app/fonts/Montserrat-Bold.ttf

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
