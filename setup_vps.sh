#!/bin/bash
echo "[*] Preparando el VPS para Kingbot..."

# 1. Actualizar repositorios e instalar dependencias base
sudo apt update -y && sudo apt upgrade -y
sudo apt install -y curl git wget build-essential ffmpeg python3 python3-pip xz-utils libglib2.0-0 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2

# 2. Instalar Node.js 20 (LTS) si no está instalado
if ! command -v node >/dev/null 2>&1; then
    echo "[*] Instalando Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

# 3. Instalar yt-dlp actualizado
echo "[*] Instalando yt-dlp..."
sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# 4. Instalar PM2 para mantener el bot activo 24/7 profesionalmente
if ! command -v pm2 >/dev/null 2>&1; then
    echo "[*] Instalando PM2..."
    sudo npm install -g pm2
fi

# 5. Instalar dependencias del bot permitiendo descargar Chromium
echo "[*] Instalando dependencias de Node.js (incluyendo Chromium interno)..."
rm -rf node_modules
npm install

echo "=========================================================="
echo "✅ PREPARACIÓN DEL VPS COMPLETADA"
echo "Para arrancar el bot en el VPS permanentemente, ejecuta:"
echo "pm2 start index.js --name kingbot"
echo "pm2 save"
echo "pm2 startup"
echo "=========================================================="

