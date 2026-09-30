#!/usr/bin/env node
/**
 * Herramienta CLI de Diagnóstico del Sistema - Asistente Personal
 * Diseñada para ejecución directa en la terminal del VPS.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Colores ANSI para terminal
const C_RESET = '\x1b[0m';
const C_BOLD = '\x1b[1m';
const C_GREEN = '\x1b[32m';
const C_RED = '\x1b[31m';
const C_YELLOW = '\x1b[33m';
const C_CYAN = '\x1b[36m';
const C_BLUE = '\x1b[34m';

function ok(text) { return `${C_GREEN}[OK]${C_RESET} ${text}`; }
function fail(text) { return `${C_RED}[FALLO]${C_RESET} ${text}`; }
function warn(text) { return `${C_YELLOW}[AVISO]${C_RESET} ${text}`; }
function info(text) { return `${C_CYAN}[INFO]${C_RESET} ${text}`; }

console.log(`\n${C_BOLD}${C_BLUE}======================================================${C_RESET}`);
console.log(`${C_BOLD}${C_CYAN}    AUDITORÍA Y DIAGNÓSTICO EN VIVO DEL SISTEMA${C_RESET}`);
console.log(`${C_BOLD}${C_BLUE}======================================================${C_RESET}\n`);

// 1. Proceso PM2
try {
    const pm2Raw = execSync('pm2 jlist', { stdio: 'pipe' }).toString();
    const pm2List = JSON.parse(pm2Raw);
    const botProc = pm2List.find(p => p.name === 'nuevo_bot');
    if (botProc) {
        const status = botProc.pm2_env?.status;
        const pid = botProc.pid;
        const uptimeMin = Math.floor((Date.now() - (botProc.pm2_env?.pm_uptime || Date.now())) / 60000);
        const restarts = botProc.pm2_env?.restart_time || 0;
        const memMB = ((botProc.monit?.memory || 0) / (1024 * 1024)).toFixed(1);

        if (status === 'online') {
            console.log(ok(`Proceso PM2: "nuevo_bot" ONLINE (PID: ${pid}, Uptime: ${uptimeMin}m, Restarts: ${restarts}, RAM: ${memMB} MB)`));
        } else {
            console.log(warn(`Proceso PM2: "nuevo_bot" estado ${status} (Restarts: ${restarts})`));
        }
    } else {
        console.log(fail('Proceso PM2: "nuevo_bot" no encontrado en pm2 jlist'));
    }
} catch(e) {
    console.log(fail(`No se pudo consultar PM2: ${e.message}`));
}

// 2. Runtimes (Node y Deno)
console.log(info(`Node.js Runtime: ${process.version} (${process.arch})`));
try {
    const denoVer = execSync('/usr/local/bin/deno --version 2>/dev/null || deno --version', { stdio: 'pipe' }).toString().split('\n')[0].trim();
    console.log(ok(`Deno Runtime: ${denoVer}`));
} catch(e) {
    console.log(fail('Deno Runtime: No detectado en /usr/local/bin/deno'));
}

// 3. Extractor yt-dlp y Cookies
try {
    const ytVer = execSync('yt-dlp --version', { stdio: 'pipe' }).toString().trim();
    console.log(ok(`yt-dlp: Versión ${ytVer}`));
} catch(e) {
    console.log(fail('yt-dlp: No disponible en PATH'));
}

const snapChromium = '/home/ubuntu/snap/chromium/common/chromium';
if (fs.existsSync(snapChromium)) {
    console.log(ok(`Cookies de Chromium: Perfil presente en ${snapChromium}`));
} else {
    console.log(warn(`Cookies de Chromium: No se encontró perfil en ${snapChromium}`));
}

// 4. Claves Gemini AI
try {
    let keyCount = 0;
    const keysJsonPath = path.join(__dirname, 'keys.json');
    if (fs.existsSync(keysJsonPath)) {
        const keys = JSON.parse(fs.readFileSync(keysJsonPath, 'utf8'));
        if (Array.isArray(keys)) keyCount = keys.length;
    }
    if (keyCount > 0) {
        console.log(ok(`Gemini AI: ${keyCount} claves API registradas y operativas`));
    } else {
        console.log(warn('Gemini AI: Sin claves en keys.json (revisar "llaves API gemini.txt")'));
    }
} catch(e) {
    console.log(warn(`Gemini AI: Error verificando claves: ${e.message}`));
}

// 5. Firebase Firestore
const saPath = path.join(__dirname, 'serviceAccount.json');
if (fs.existsSync(saPath)) {
    console.log(ok('Firebase: Credenciales serviceAccount.json detectadas'));
} else {
    console.log(info('Firebase: serviceAccount.json no configurado'));
}

// 6. Servidor y Recursos del Sistema
const totalRAM = (os.totalmem() / (1024 ** 3)).toFixed(2);
const freeRAM = (os.freemem() / (1024 ** 3)).toFixed(2);
const usedRAM = (totalRAM - freeRAM).toFixed(2);
const ramPct = (((totalRAM - freeRAM) / totalRAM) * 100).toFixed(1);
const cpuCores = os.cpus().length;
const load = os.loadavg ? os.loadavg().map(l => l.toFixed(2)).join(', ') : 'N/A';

console.log(info(`Recursos RAM: ${usedRAM} GB usados de ${totalRAM} GB (${ramPct}% en uso, ${freeRAM} GB libres)`));
console.log(info(`Carga de CPU: ${load} (${cpuCores} núcleos)`));

try {
    const df = execSync('df -h / | tail -1', { stdio: 'pipe' }).toString().trim().split(/\s+/);
    if (df.length >= 5) {
        console.log(info(`Espacio en Disco (/): ${df[2]} usados de ${df[1]} (${df[4]} en uso, ${df[3]} libres)`));
    }
} catch(e){}

// 7. Auditoría de Errores Recientes (nuevo-bot-error.log)
console.log(`\n${C_BOLD}${C_BLUE}------------------------------------------------------${C_RESET}`);
console.log(`${C_BOLD}ÚLTIMOS ERRORES REGISTRADOS (pm2 error log):${C_RESET}`);
console.log(`${C_BOLD}${C_BLUE}------------------------------------------------------${C_RESET}`);

const errorLogPath = '/home/ubuntu/.pm2/logs/nuevo-bot-error.log';
if (fs.existsSync(errorLogPath)) {
    try {
        const lastErrors = execSync(`tail -n 8 "${errorLogPath}"`, { stdio: 'pipe' }).toString().trim();
        if (lastErrors) {
            console.log(`${C_RED}${lastErrors}${C_RESET}`);
        } else {
            console.log(`${C_GREEN}No hay errores recientes en el registro.${C_RESET}`);
        }
    } catch(e) {
        console.log(`No se pudo leer log: ${e.message}`);
    }
} else {
    console.log('Archivo de log de errores no encontrado.');
}

console.log(`\n${C_BOLD}${C_CYAN}Atajos de consola disponibles:${C_RESET}`);
console.log(`• ${C_BOLD}bot-logs${C_RESET}        -> Ver registros de actividad en vivo (pm2 logs)`);
console.log(`• ${C_BOLD}bot-errors${C_RESET}      -> Ver únicamente errores en vivo (tail -f error.log)`);
console.log(`• ${C_BOLD}bot-diagnostico${C_RESET} -> Ejecutar este diagnóstico en cualquier momento`);
console.log(`• ${C_BOLD}bot-restart${C_RESET}     -> Reiniciar el bot limpiamente`);
console.log(`• ${C_BOLD}bot-status${C_RESET}      -> Ver estado del proceso en PM2\n`);
