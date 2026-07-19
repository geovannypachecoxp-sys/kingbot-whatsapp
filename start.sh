pkill -f chromium
pkill -f chrome
rm -rf .wwebjs_auth/session/Default/Singleton*

if [ ! -d ".git" ]; then
    git init
fi

git remote remove origin 2>/dev/null
git remote add origin https://github.com/geovannypachecoxp-sys/kingbot-whatsapp.git
git fetch origin
git reset --hard origin/main

if [ ! -d "node_modules/@juzi" ] || [ ! -d "node_modules/debug" ]; then
    echo "[*] Instalando librerías faltantes en Termux (modo Android)..."
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true PUPPETEER_SKIP_DOWNLOAD=true npm install --ignore-scripts debug @juzi/whatsapp-web.js --save
fi

node index.js