#!/bin/bash
pkill -9 -f chromium 2>/dev/null
pkill -9 -f chrome 2>/dev/null
pkill -9 -f node 2>/dev/null
rm -rf .wwebjs_auth/session/Default/Singleton* 2>/dev/null
rm -rf .wwebjs_auth/session/Default/Lock* 2>/dev/null
rm -rf .wwebjs_auth/session/Default/Service\ Worker/ 2>/dev/null
rm -rf .wwebjs_auth/session/Default/Cache/ 2>/dev/null
rm -rf .wwebjs_auth/session/Default/Code\ Cache/ 2>/dev/null
rm -rf .wwebjs_auth/session/Default/GPUCache/ 2>/dev/null
rm -rf .wwebjs_cache/ 2>/dev/null

if [ ! -d "node_modules/@juzi" ] || [ ! -d "node_modules/debug" ]; then
    echo "[*] Instalando dependencias necesarias en Termux (modo Android)..."
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true PUPPETEER_SKIP_DOWNLOAD=true npm install --ignore-scripts
fi

node index.js