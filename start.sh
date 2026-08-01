pkill -f chromium 2>/dev/null
pkill -f chrome 2>/dev/null
rm -rf .wwebjs_auth/session/Default/Singleton* 2>/dev/null

if [ ! -d ".git" ]; then
    git init
fi

git remote remove origin 2>/dev/null
git remote add origin https://github.com/geovannypachecoxp-sys/kingbot-whatsapp.git
git fetch origin
git reset --hard origin/main

if [ ! -d "node_modules/@juzi" ] || [ ! -d "node_modules/debug" ]; then
    echo "[*] Instalando dependencias necesarias en Termux (modo Android)..."
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true PUPPETEER_SKIP_DOWNLOAD=true npm install --ignore-scripts
fi

node index.js