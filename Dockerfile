FROM node:20
ARG BUILD_ID=definitive
ENV BUILD_ID=${BUILD_ID}
WORKDIR /app
RUN apt-get update && apt-get install -y     libcairo2-dev     libjpeg-dev     libpango1.0-dev     libgif-dev     build-essential     g++   && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 8000
CMD ["npm","start"]
