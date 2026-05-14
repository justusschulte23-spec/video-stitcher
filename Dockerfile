FROM node:18

WORKDIR /app

COPY package*.json ./
RUN npm install

# FFmpeg + Python3 + wget
RUN apt-get update && apt-get install -y ffmpeg wget python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Python deps for /composite endpoint
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

# Montserrat Bold font für Untertitel
RUN wget -q "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Bold.ttf" \
    -O /app/fonts/Montserrat-Bold.ttf

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
