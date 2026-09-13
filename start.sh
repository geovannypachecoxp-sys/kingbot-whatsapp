#!/bin/bash

# 1. Activar wake-lock para evitar que Android duerma el proceso al apagar la pantalla
if command -v termux-wake-lock >/dev/null 2>&1; then
    echo "[*] Activando wake-lock de Termux para mantener el bot activo en segundo plano..."
    termux-wake-lock
fi

echo "[*] Comprobando actualizaciones automáticas..."
git pull origin main

limpiar_procesos_y_cache() {
    pkill -9 -f chromium 2>/dev/null
    pkill -9 -f chrome 2>/dev/null
    rm -rf .wwebjs_auth/session/Default/Singleton* 2>/dev/null
    rm -rf .wwebjs_auth/session/Default/Lock* 2>/dev/null
    rm -rf .wwebjs_auth/session/Default/Service\ Worker/ 2>/dev/null
    rm -rf .wwebjs_auth/session/Default/Cache/ 2>/dev/null
    rm -rf .wwebjs_auth/session/Default/Code\ Cache/ 2>/dev/null
    rm -rf .wwebjs_auth/session/Default/GPUCache/ 2>/dev/null
}

limpiar_procesos_y_cache

if [ ! -d "node_modules/@juzi" ] || [ ! -d "node_modules/debug" ]; then
    echo "[*] Instalando dependencias necesarias en Termux (modo Android)..."
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true PUPPETEER_SKIP_DOWNLOAD=true npm install --ignore-scripts
fi

# 2. Bucle permanente (Watchdog 24/7): Si Node o Chromium caen, se reinicia de inmediato
echo "[*] Kingbot Watchdog 24/7 iniciado. Presiona Ctrl + C para detenerlo."
while true; do
    echo "[*] Lanzando Kingbot..."
    node index.js
    EXIT_CODE=$?

    # Si el usuario detuvo el bot voluntariamente con Ctrl+C (130) o exit normal (0)
    if [ $EXIT_CODE -eq 130 ] || [ $EXIT_CODE -eq 0 ]; then
        echo "[*] Kingbot detenido por el usuario. Saliendo..."
        break
    fi

    echo "[!] Kingbot se detuvo (Código: $EXIT_CODE). Limpiando bloqueos y reiniciando en 3 segundos..."
    limpiar_procesos_y_cache
    sleep 3
done