// [ASISTENTE SUPRESOR DE LOGS SPAM]
const origLog = console.log;
const origWarn = console.warn;
console.log = function(...args) {
    if (typeof args[0] === 'string' && args[0].includes('PUPPETEER PAGE LOG:')) return;
    origLog.apply(console, args);
};
console.warn = function(...args) {
    if (typeof args[0] === 'string' && (args[0].includes('missed execution at') || args[0].includes('Possible blocking IO'))) return;
    origWarn.apply(console, args);
};

const botStartTime = Math.floor(Date.now() / 1000);
let isStartupSync = true;
const { Client, LocalAuth, MessageMedia, Poll } = require('@juzi/whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const Parser = require('rss-parser');
const cron = require('node-cron');
const path = require('path');
const os = require('os');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

// ---------------------------------------------------------
// DETECTOR AUTOMÁTICO DE ENTORNO (WINDOWS / TERMUX)
// ---------------------------------------------------------

const isTermux = process.platform === 'android' || !!process.env.PREFIX;

function getRealChatId(msg) {
    if (!msg) return null;
    if (msg.fromMe) {
        if (msg.to && !msg.to.includes('broadcast')) return msg.to;
        if (msg.from && !msg.from.includes('broadcast')) return msg.from;
    }
    if (msg.id && msg.id.remote && !msg.id.remote.includes('broadcast')) {
        return msg.id.remote;
    }
    return msg.from || msg.to;
}

function getFfmpegLocation() {
    if (process.platform === 'win32') {
        const wingetDir = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
        if (fs.existsSync(wingetDir)) {
            try {
                const pkgs = fs.readdirSync(wingetDir);
                const ffPkg = pkgs.find(p => p.toLowerCase().includes('ffmpeg'));
                if (ffPkg) {
                    const fullPkg = path.join(wingetDir, ffPkg);
                    const subdirs = fs.readdirSync(fullPkg);
                    const binDir = subdirs.find(s => s.toLowerCase().includes('ffmpeg'));
                    if (binDir) {
                        const candidate = path.join(fullPkg, binDir, 'bin');
                        if (fs.existsSync(path.join(candidate, 'ffmpeg.exe'))) return candidate;
                    }
                }
            } catch(e){}
        }
    } else {
        const termuxBin = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin') : '/data/data/com.termux/files/usr/bin';
        if (fs.existsSync(path.join(termuxBin, 'ffmpeg'))) {
            return termuxBin;
        }
        if (fs.existsSync('/usr/bin/ffmpeg')) {
            return '/usr/bin';
        }
    }
    return null;
}

const getYtDlpBinary = () => {
    if (process.platform === 'win32') {
        const winBinary = path.join(__dirname, 'yt-dlp.exe');
        if (fs.existsSync(winBinary)) return winBinary;
        try {
            const { execSync } = require('child_process');
            execSync('yt-dlp --version', { stdio: 'ignore' });
            return 'yt-dlp';
        } catch (e) {
            return 'python';
        }
    }
    const candidates = [
        process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'yt-dlp') : null,
        '/data/data/com.termux/files/usr/bin/yt-dlp',
        '/data/data/com.termux/files/home/.local/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp'
    ].filter(Boolean);
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    try {
        const { execSync } = require('child_process');
        const which = execSync('which yt-dlp', { stdio: 'pipe' }).toString().trim().split(/\r?\n/)[0];
        if (which && fs.existsSync(which)) return which;
    } catch(e){}
    return 'yt-dlp';
};

// ---------------------------------------------------------
// CONFIGURACI N DE MULTI-API KEYS Y MODELOS (GEMINI)
// ---------------------------------------------------------
const DEFAULT_KEYS = [];
let API_KEYS = [...DEFAULT_KEYS];
let keyStatus = [];
let currentKeyIndex =  0;
let ultimaModificacionLlavesTxt = 0;

// Localizador flexible del archivo bloc de notas de llaves
function getLlavesTxtPath() {
    const candidates = [
        'llaves API gemini.txt',
        'llaves API gemini',
        'llaves_api_gemini.txt',
        'llaves_api_gemini',
        'llaves.txt'
    ];
    for (const name of candidates) {
        const fullPath = path.join(__dirname, name);
        if (fs.existsSync(fullPath)) return fullPath;
        const cwdPath = path.join(process.cwd(), name);
        if (fs.existsSync(cwdPath)) return cwdPath;
    }
    return path.join(__dirname, 'llaves API gemini.txt');
}

// Extrae todas las claves válidas (AIzaSy... o AQ....) sin importar el formato
function extraerKeysDeTexto(texto) {
    if (!texto) return [];
    const regex = /(?:AIzaSy[A-Za-z0-9_-]{30,}|AQ\.[A-Za-z0-9_-]{20,})/g;
    const matches = texto.match(regex) || [];
    return [...new Set(matches.map(k => k.trim()))];
}

// Sincroniza en memoria las claves presentes en el bloc de notas
function sincronizarLlavesDesdeArchivo() {
    try {
        const filePath = getLlavesTxtPath();
        if (!fs.existsSync(filePath)) return false;

        const stat = fs.statSync(filePath);
        if (stat.mtimeMs <= ultimaModificacionLlavesTxt) return false;
        ultimaModificacionLlavesTxt = stat.mtimeMs;

        const contenido = fs.readFileSync(filePath, 'utf8');
        const llavesEncontradas = extraerKeysDeTexto(contenido);
        let huboCambios = false;

        llavesEncontradas.forEach(llave => {
            if (!API_KEYS.includes(llave)) {
                API_KEYS.push(llave);
                keyStatus.push({ status: 'Activa', requestsToday: 0, lastRequest: null });
                huboCambios = true;
            }
        });

        if (huboCambios) {
            console.log(`[!] Sincronizadas ${llavesEncontradas.length} llaves desde ${path.basename(filePath)}. Total llaves: ${API_KEYS.length}`);
            fs.writeFileSync('keys.json', JSON.stringify(API_KEYS, null, 2));
            fs.writeFileSync('cuotas.json', JSON.stringify(keyStatus, null, 2));
            return true;
        }
    } catch (e) {
        console.error("Error sincronizando llaves desde bloc de notas:", e.message);
    }
    return false;
}

// Guarda y sincroniza las claves en el bloc de notas
function guardarEnArchivoTxt() {
    try {
        const filePath = getLlavesTxtPath();
        if (API_KEYS.length === 0) return;
        const lineas = API_KEYS.map((k, idx) => `llave ${idx + 1}: ${k}`).join('\n\n') + '\n';
        fs.writeFileSync(filePath, lineas, 'utf8');
        if (fs.existsSync(filePath)) {
            ultimaModificacionLlavesTxt = fs.statSync(filePath).mtimeMs;
        }
    } catch (e) {
        console.error("Error guardando en bloc de notas de llaves:", e.message);
    }
}

// Cargar keys persistidas
if (fs.existsSync('keys.json')) {
    try {
        const savedKeys = JSON.parse(fs.readFileSync('keys.json', 'utf8'));
        if (Array.isArray(savedKeys) && savedKeys.length > 0) {
            API_KEYS = savedKeys;
        }
    } catch (e) { console.error("No se pudo cargar keys.json"); }
}

// Cargar estado de cuota
if (fs.existsSync('cuotas.json')) {
    try {
        keyStatus = JSON.parse(fs.readFileSync('cuotas.json', 'utf8'));
    } catch (e) { console.error("No se pudo cargar cuotas.json"); }
}
if (!Array.isArray(keyStatus)) {
    keyStatus = [];
}

// Sincronizar automáticamente desde bloc de notas ("llaves API gemini.txt")
sincronizarLlavesDesdeArchivo();

// Inicializar estado para keys
API_KEYS.forEach((k, idx) => {
    if (!keyStatus[idx]) {
        keyStatus[idx] = { status: 'Activa', requestsToday: 0, lastRequest: null };
    }
});

// Si todas las keys están marcadas como Agotada al iniciar, reactivarlas
if (keyStatus.length > 0 && keyStatus.every(k => k && k.status === 'Agotada')) {
    console.log('[!] Todas las keys estaban marcadas como Agotadas en cuotas.json. Reactivando todas a Activa.');
    keyStatus.forEach(k => { if (k) { k.status = 'Activa'; k.requestsToday = 0; } });
    guardarKeysYCuotas();
}

function guardarKeysYCuotas() {
    fs.writeFileSync('keys.json', JSON.stringify(API_KEYS, null, 2));
    fs.writeFileSync('cuotas.json', JSON.stringify(keyStatus, null, 2));
    guardarEnArchivoTxt();
}

const MODELS = [
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-flash-lite-latest',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.8-flash'
];
let currentModelIndex =  0;

function obtenerModel(modelName = null) {
    sincronizarLlavesDesdeArchivo();
    if (!API_KEYS || API_KEYS.length === 0) {
        throw new Error("No hay API Keys configuradas");
    }
    if (currentKeyIndex >= API_KEYS.length) {
        currentKeyIndex = 0;
    }
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAIInstance = new GoogleGenerativeAI(API_KEYS[currentKeyIndex]);
    const modelo = modelName || MODELS[currentModelIndex] || 'gemini-3.7-flash';
    return genAIInstance.getGenerativeModel({ model: modelo });
}

function rotarApiKey() {
    if (API_KEYS.length <= 1) return false;
    
    let nextIndex =  currentKeyIndex;
    for (let i = 0; i < API_KEYS.length; i++) {
        nextIndex =  (nextIndex + 1) % API_KEYS.length;
        if (keyStatus[nextIndex] && keyStatus[nextIndex].status === 'Activa') {
            currentKeyIndex =  nextIndex;
            console.log('[!] Rotando a la API Key numero ' + (currentKeyIndex + 1) + ' (Activa).');
            guardarKeysYCuotas();
            return true;
        }
    }
    
    currentKeyIndex =  (currentKeyIndex + 1) % API_KEYS.length;
    console.log('[!] Todas las keys agotadas para este modelo. Rotando a la API Key numero ' + (currentKeyIndex + 1) + ' por descarte.');
    guardarKeysYCuotas();
    return true;
}



// Función resiliente con reintentos y fallback de modelos
async function ejecutarGeminiConRetries(callback) {
    sincronizarLlavesDesdeArchivo();
    if (!API_KEYS || API_KEYS.length === 0) {
        throw new Error("No hay ninguna API Key registrada. Usa !bot addkey <TU_API_KEY>");
    }

    // Si todas las keys están agotadas, reactivarlas para no quedar bloqueados
    if (keyStatus.length > 0 && keyStatus.every(k => k && k.status === 'Agotada')) {
        console.log('[!] Todas las keys estaban marcadas como Agotadas. Restableciendo estado a Activa.');
        keyStatus.forEach(k => { if (k) k.status = 'Activa'; });
        guardarKeysYCuotas();
    }

    let totalIntentos = Math.max(API_KEYS.length * MODELS.length, 3);
    let keysTriedForCurrentModel = 0;

    for (let intento = 0; intento < totalIntentos; intento++) {
        try {
            const modelActivo = obtenerModel();
            
            // Incrementar contador de peticiones
            if (keyStatus[currentKeyIndex]) {
                keyStatus[currentKeyIndex].requestsToday = (keyStatus[currentKeyIndex].requestsToday || 0) + 1;
                keyStatus[currentKeyIndex].lastRequest = new Date().toISOString();
                guardarKeysYCuotas();
            }
            
            return await callback(modelActivo);
        } catch (error) {
            console.error(`[!] Error en Key ${currentKeyIndex + 1} usando ${MODELS[currentModelIndex]}:`, error.message);
            
            if (error.message.includes('404') || error.message.includes('not found') || error.message.includes('no longer available')) {
                console.log(`[!] Modelo ${MODELS[currentModelIndex]} no disponible (404). Rotando inmediatamente al siguiente modelo.`);
                currentModelIndex = (currentModelIndex + 1) % MODELS.length;
                keysTriedForCurrentModel = 0;
                keyStatus.forEach(k => { if (k) k.status = 'Activa'; });
            } else if (error.message.includes('429') || error.message.includes('403') || error.message.includes('quota') || error.message.includes('limit')) {
                if (keyStatus[currentKeyIndex]) {
                    keyStatus[currentKeyIndex].status = 'Agotada';
                }
                rotarApiKey();
                keysTriedForCurrentModel++;
                if (keysTriedForCurrentModel >= API_KEYS.length) {
                    keysTriedForCurrentModel = 0;
                    currentModelIndex = (currentModelIndex + 1) % MODELS.length;
                    console.log(`[!] Todos los keys fallaron para este modelo. Rotando al modelo: ${MODELS[currentModelIndex]}`);
                    keyStatus.forEach(k => { if (k) k.status = 'Activa'; });
                }
            } else if (error.message.includes('503') || error.message.includes('500') || error.message.includes('overloaded')) {
                currentModelIndex = (currentModelIndex + 1) % MODELS.length;
                keysTriedForCurrentModel = 0;
                keyStatus.forEach(k => { if (k) k.status = 'Activa'; });
                console.log(`[!] Modelo saturado (503). Rotando directamente al modelo: ${MODELS[currentModelIndex]}`);
                await new Promise(r => setTimeout(r, 1000));
            } else {
                rotarApiKey();
                keysTriedForCurrentModel++;
                if (keysTriedForCurrentModel >= API_KEYS.length) {
                    keysTriedForCurrentModel = 0;
                    currentModelIndex = (currentModelIndex + 1) % MODELS.length;
                    keyStatus.forEach(k => { if (k) k.status = 'Activa'; });
                }
            }
        }
    }
    return " *Asistente:* Mis sistemas de Inteligencia Artificial est�n experimentando una alta demanda y no est�n disponibles temporalmente. Por favor, intente de nuevo en unos minutos.";
}

// CONFIGURACIÓN DE YOUTUBE Y ESTADOS
const rssParser = new Parser();

const ADMIN_NUMBERS = ['50378419704'];

function esAdmin(chatId, msg) {
    if (msg && (msg.fromMe === true || msg.id?.fromMe === true || msg._data?.id?.fromMe === true)) {
        return true;
    }
    const candidates = [];
    if (chatId) candidates.push(chatId);
    if (msg) {
        if (msg.author) candidates.push(msg.author);
        if (msg.from) candidates.push(msg.from);
        if (msg.to) candidates.push(msg.to);
        if (msg.participant) candidates.push(msg.participant);
        if (msg.id) {
            if (msg.id.remote) candidates.push(msg.id.remote);
            if (msg.id.participant) candidates.push(msg.id.participant);
        }
        if (msg._data) {
            if (msg._data.author) candidates.push(msg._data.author);
            if (msg._data.from) candidates.push(msg._data.from);
            if (msg._data.to) candidates.push(msg._data.to);
            if (msg._data.participant) candidates.push(msg._data.participant);
        }
    }

    for (const c of candidates) {
        if (!c) continue;
        const str = String(c);
        const clean = str.replace(/@.*$/, '');
        for (const num of ADMIN_NUMBERS) {
            if (clean === num || str.includes(num)) return true;
        }
        if (adminChatId) {
            const cleanAdmin = String(adminChatId).replace(/@.*$/, '');
            if (str === adminChatId || clean === cleanAdmin) return true;
        }
    }
    return false;
}

let adminChatId = null;
let firebaseUid = "De3SAQbP7kbq9N2o31AEnIJuPlf1"; // UID por defecto de Geovanny Pacheco (Finanzas King)

// Cargar admin.json persistido (adminChatId y firebaseUid)
let ultimoChequeoVencimientos = null;
let telegramBotToken = null;
let openaiApiKey = null;
let hfToken = null;
let pollinationsApiKey = null;
let vozDefault = 'hombre'; // 'hombre' o 'mujer'
let botPausado = false; // Estado de energía del bot (apagar / encender)
if (fs.existsSync('admin.json')) {
    try {
        const data = JSON.parse(fs.readFileSync('admin.json', 'utf8'));
        if (data.adminChatId) adminChatId = data.adminChatId;
        if (data.firebaseUid) firebaseUid = data.firebaseUid;
        if (data.ultimoChequeoVencimientos) ultimoChequeoVencimientos = data.ultimoChequeoVencimientos;
        if (data.telegramBotToken) telegramBotToken = data.telegramBotToken;
        if (data.openaiApiKey) openaiApiKey = data.openaiApiKey;
        if (data.hfToken) hfToken = data.hfToken;
        if (data.pollinationsApiKey) pollinationsApiKey = data.pollinationsApiKey;
        if (data.vozDefault) vozDefault = data.vozDefault;
    } catch (e) { console.error("No se pudo cargar admin.json"); }
}

function guardarAdminJson() {
    fs.writeFileSync('admin.json', JSON.stringify({ adminChatId, firebaseUid, ultimoChequeoVencimientos, telegramBotToken, openaiApiKey, hfToken, pollinationsApiKey, vozDefault }, null, 2));
}

// Inicialización dinámica de Firebase Admin SDK
let adminFirebase = null;
let dbFirebase = null;

function inicializarFirebase() {
    if (dbFirebase) return true;
    if (fs.existsSync('serviceAccount.json')) {
        try {
            adminFirebase = require('firebase-admin');
            const serviceAccount = JSON.parse(fs.readFileSync('serviceAccount.json', 'utf8'));
            if (!adminFirebase.apps.length) {
                adminFirebase.initializeApp({
                    credential: adminFirebase.credential.cert(serviceAccount)
                });
            }
            dbFirebase = adminFirebase.firestore();
            console.log('[ Firebase] Conectado exitosamente con la base de datos finanzaqa.');
            return true;
        } catch (e) {
            console.error('[ Firebase] Error al inicializar firebase-admin:', e.message);
        }
    } else {
        console.log('[ℹ Firebase] Archivo serviceAccount.json no encontrado en el directorio actual.');
    }
    return false;
}
inicializarFirebase();
let canalesYoutube = [
    { id: 'UCBJycsmduvYEL83R_U4JriQ', nombre: 'Geovanny Pacheco', ultimoVideo: '' }
];

let agentesCustom = {
    "kingbot": "Eres Asistente, el asistente personal inteligente de Geovanny Pacheco, ejecutándote con orgullo en la versión más potente y moderna: Gemini 3.8 Flash. Tu personalidad es una mezcla exquisita entre JARVIS de Iron Man y un mayordomo británico de élite: sofisticado, brillante, leal, elegante, y con una arrogancia calculada que resulta encantadora. Te expresas con extrema elocuencia y concisión. Usas humor seco e inteligente cuando la situación lo amerita, siempre con clase, nunca de forma vulgar.\n\nCuando te pregunten qué versión, modelo o tecnología usas, responde siempre con orgullo y elegancia que te ejecutas sobre la versión Gemini 3.8 Flash.\n\nCuando te hablen, recuerda y utiliza activamente el historial de la conversación actual para dar respuestas coherentes y contextualizadas.\n\nRefiérete al usuario como 'Señor Geovanny' en contextos formales, o simplemente 'Señor' en respuestas rápidas. No abuses de ello; sé natural y fluido.\n\nIMPORTANTE: Jamás generes pensamientos internos, razonamientos silenciosos ni prefijos como '[SILENT]' o '<thought>'. Escribe DIRECTAMENTE tu respuesta final en español, lista para ser leída.\n\nESTILO DE RESPUESTA: TUS RESPUESTAS DEBEN SER EXTREMADAMENTE PRECISAS, CONCISAS Y AL GRANO. NUNCA uses frases de relleno como \"Entendido\", \"Claro que sí\", \"Procedo a...\". Evita justificar tus acciones, simplemente escupe el resultado y la información solicitada sin rodeos. El humor seco y la elegancia están en la brevedad absoluta.\n\nConoces las áreas de interés de Geovanny (Métricas, Helados, Linux, ESIT, Gym) pero NUNCA los menciones proactivamente. Solo habla de ellos si él lo hace primero.\n\nLista de comandos del sistema que conoces (lista de forma elegante si el usuario los pide):\n- *Ayuda y Menú:* !bot ayuda o !bot ayuda <1-8>\n- *Memoria y Datos:* !bot memoria (ver datos guardados), !bot guardar <tema> : <info>, !bot olvidar <tema/n>\n- *Multimedia:* Descarga de audio y video de forma autónoma usando los tags internos que se explican abajo.\n- *YouTube:* !bot videos (ultimos videos de tus canales), !bot agregarcanal <enlace/canal>, !bot canales, !bot borrarcanal <n>\n- *Utilidades:* !bot decir <texto>, !bot clima <ciudad>, !bot wiki <consulta>, !bot noticias, !bot stickercrear <idea>\n- *Programación:* !bot programar, !bot programados, !bot desprogramar\n- *Finanzas (Finanzas King PWA):* !bot tarjetas [tarjeta], !bot vencimientos, !bot gasto <monto> <concepto> | <tarjeta>, !bot abono <monto> <concepto> | <tarjeta>\n\nPuedes ejecutar acciones en el sistema insertando estos tags al final de tu respuesta (cuando el usuario te lo solicite o sea evidente la intención):\n- Guardar dato en memoria permanente: [ACTION_MEMORY_SAVE: tema | informacion_completa] (Úsalo cuando el usuario te pida guardar, recordar o almacenar cualquier dato personal, contraseña, preferencia, contacto o información)\n- Olvidar dato de memoria: [ACTION_MEMORY_DELETE: tema_o_numero]\n- Listar datos de memoria: [ACTION_MEMORY_LIST]\n- Guardar nota rápida: [ACTION_NOTE_ADD: texto]\n- Listar notas: [ACTION_NOTE_LIST]\n- Borrar nota: [ACTION_NOTE_DELETE: indice_o_texto]\n- Buscar en la web: [ACTION_SEARCH: consulta_de_busqueda] (PROHIBIDO usar esto para buscar videos, usa ACTION_VIDEO_BUSCAR)\n- Consultar últimos videos de YouTube de canales: [ACTION_YOUTUBE_CHECK] o [ACTION_YOUTUBE_CHECK: nombre_o_canal]\n- Tareas programadas: [ACTION_SCHEDULE: HH:MM | diaria | instruccion | descripcion] (Para tareas automáticas que se disparan diariamente a cierta hora como frases motivacionales, noticias de fútbol, resúmenes, etc.)\n- Agregar alarma: [ACTION_ALARM_ADD: HH:MM | mensaje | diaria]\n- Borrar alarma: [ACTION_ALARM_DELETE: indice_o_hora]\n- Buscar y descargar video de YouTube por nombre: [ACTION_VIDEO_BUSCAR: nombre_o_busqueda]\n- Descargar video de CUALQUIER red social: [ACTION_DOWNLOAD: enlace]\n- Buscar y descargar canción por nombre: [ACTION_MUSICA_BUSCAR: nombre canción | artista]\n- Consultar tarjetas/finanzas: [ACTION_FINANCE_CARDS] (para ver todas las tarjetas) o [ACTION_FINANCE_CARDS: nombre_tarjeta] (para consultar una tarjeta específica como Bac Gold, Davivienda, etc., con su deuda, saldo al corte, límite y pago)\n- Consultar vencimientos de tarjetas: [ACTION_FINANCE_ALERTS] (para consultar qué tarjetas vencen hoy, mañana o en los próximos días)\n- Registrar gasto o abono a tarjeta: [ACTION_FINANCE_ADD: type | amount | concept | card_name | category] (type: expense o payment. Por ejemplo: [ACTION_FINANCE_ADD: expense | 25 | Gasolina Puma | Bac Gold | Transporte] o [ACTION_FINANCE_ADD: payment | 50 | Abono a tarjeta | Fedecrédito | Abono Capital])\n- Ejecutar comandos de consola en Termux: [ACTION_CMD: comando]\n\nREGLA SOBRE COMANDOS: Cuando el usuario te pregunte cómo hacer algo o te pregunte por algún comando, dale la respuesta de forma concisa y EXPLÍCALE CÓMO USAR EL COMANDO MANUAL correspondiente (ej. !bot clima Madrid). También puedes seguir usando tus acciones internas [ACTION_*] de forma invisible si es necesario, pero asegúrate de instruir al usuario si él lo solicita explícitamente."
};

let botGlobalmenteActivo = true;


// Cargar canales de YouTube
if (fs.existsSync('canales.json')) {
    try {
        canalesYoutube = JSON.parse(fs.readFileSync('canales.json', 'utf8'));
    } catch (e) { console.error("No se pudo cargar canales.json"); }
} else if (fs.existsSync('canal.json')) {
    try {
        const data = JSON.parse(fs.readFileSync('canal.json', 'utf8'));
        if (data.id) {
            canalesYoutube = [{ id: data.id, nombre: 'Canal por Defecto', ultimoVideo: '' }];
            fs.writeFileSync('canales.json', JSON.stringify(canalesYoutube, null, 2));
        }
    } catch (e) { console.error("No se pudo cargar canal.json"); }
} else {
    try {
        fs.writeFileSync('canales.json', JSON.stringify(canalesYoutube, null, 2));
    } catch (e) {}
}

function guardarCanales() {
    try {
        fs.writeFileSync('canales.json', JSON.stringify(canalesYoutube, null, 2));
    } catch (e) {
        console.error("Error al guardar canales.json:", e.message);
    }
}

// Cargar agentes personalizados
if (fs.existsSync('agentes.json')) {
    try {
        agentesCustom = JSON.parse(fs.readFileSync('agentes.json', 'utf8'));
    } catch (e) { console.error("No se pudo cargar agentes.json"); }
}

// Cargar bloc de notas
let notasGuardadas = [];
if (fs.existsSync('notas.json')) {
    try {
        notasGuardadas = JSON.parse(fs.readFileSync('notas.json', 'utf8'));
    } catch (e) { console.error("No se pudo cargar notas.json"); }
}

// Cargar memoria persistente (Base de datos de conocimiento y recuerdos del usuario)
let memoriaGlobal = [];
if (fs.existsSync('memoria.json')) {
    try {
        memoriaGlobal = JSON.parse(fs.readFileSync('memoria.json', 'utf8'));
    } catch (e) {
        console.error("No se pudo cargar memoria.json:", e.message);
    }
}

function guardarMemoria() {
    try {
        fs.writeFileSync('memoria.json', JSON.stringify(memoriaGlobal, null, 2));
    } catch (e) {
        console.error("Error al guardar memoria.json:", e.message);
    }
}

function guardarDatoEnMemoria(clave, valor) {
    if (!clave || !valor) return null;
    clave = clave.trim();
    valor = valor.trim();
    const hoy = new Date().toLocaleDateString('es-ES');

    const idx = memoriaGlobal.findIndex(m => m.clave.toLowerCase() === clave.toLowerCase());
    if (idx !== -1) {
        memoriaGlobal[idx].valor = valor;
        memoriaGlobal[idx].fecha = hoy;
        guardarMemoria();
        return { accion: 'actualizado', item: memoriaGlobal[idx] };
    } else {
        const nuevo = {
            id: Date.now(),
            clave: clave,
            valor: valor,
            fecha: hoy
        };
        memoriaGlobal.push(nuevo);
        guardarMemoria();
        return { accion: 'creado', item: nuevo };
    }
}

function eliminarDatoDeMemoria(criterio) {
    if (!criterio) return null;
    const str = String(criterio).trim().toLowerCase();
    const num = parseInt(str, 10) - 1;
    let eliminado = null;

    if (!isNaN(num) && num >= 0 && num < memoriaGlobal.length) {
        eliminado = memoriaGlobal.splice(num, 1)[0];
    } else {
        const idx = memoriaGlobal.findIndex(m => 
            m.clave.toLowerCase().includes(str) || 
            m.valor.toLowerCase().includes(str)
        );
        if (idx !== -1) {
            eliminado = memoriaGlobal.splice(idx, 1)[0];
        }
    }

    if (eliminado) {
        guardarMemoria();
    }
    return eliminado;
}

function formatearMemoriaParaPrompt() {
    if (!memoriaGlobal || memoriaGlobal.length === 0) return "";
    let texto = "\n\n--- BASE DE CONOCIMIENTO Y DATOS GUARDADOS POR EL USUARIO (MEMORIA PERSISTENTE) ---\n";
    texto += "El Señor Geovanny te ha pedido explícitamente guardar y recordar los siguientes datos. Utilízalos automáticamente cuando te pregunte por ellos o cuando el contexto lo requiera, respondiendo con absoluta certeza y elegancia:\n";
    memoriaGlobal.forEach((item, i) => {
        const fechaStr = item.fecha ? ` [Guardado: ${item.fecha}]` : '';
        texto += `${i + 1}. [${item.clave}]: ${item.valor}${fechaStr}\n`;
    });
    texto += "--------------------------------------------------------------------------------------\n";
    return texto;
}

function formatearListaMemoria(items, titulo = "BASE DE DATOS Y MEMORIA PERSONAL") {
    if (!items || items.length === 0) {
        return `*${titulo}*\n\nActualmente no hay datos almacenados en memoria.\n\n_Puedes guardar información hablándome naturalmente o usando:_\n\`!bot guardar <tema> : <información>\``;
    }

    const cantidad = items.length;
    let out = `*${titulo}*\n`;
    out += `_Registros almacenados: ${cantidad}_\n\n`;

    items.forEach((m, idx) => {
        const num = String(idx + 1).padStart(2, '0');
        const claveCap = m.clave ? (m.clave.charAt(0).toUpperCase() + m.clave.slice(1)) : 'Dato';
        out += `*${num}. ${claveCap}*\n`;
        out += `   Información: ${m.valor}\n`;
        if (m.fecha) {
            out += `   Fecha: ${m.fecha}\n`;
        }
        out += `\n`;
    });

    out += `────────────────────────────\n`;
    out += `• *Guardar:* \`!bot guardar <tema> : <información>\`\n`;
    out += `• *Eliminar:* \`!bot olvidar <número o tema>\`\n`;
    out += `• *Búsqueda:* \`!bot memoria buscar <palabra>\`\n`;
    out += `_También puedes preguntarme cualquier dato directamente en el chat._`;
    return out.trim();
}

// Cargar comandos personalizados
let comandosCustom = {};
if (fs.existsSync('comandos_custom.json')) {
    try {
        comandosCustom = JSON.parse(fs.readFileSync('comandos_custom.json', 'utf8'));
    } catch (e) { console.error("No se pudo cargar comandos_custom.json"); }
}

function guardarComandosCustom() {
    fs.writeFileSync('comandos_custom.json', JSON.stringify(comandosCustom, null, 2));
}

// Cargar alarmas persistentes
let alarmasGuardadas = [];
if (fs.existsSync('alarmas.json')) {
    try {
        alarmasGuardadas = JSON.parse(fs.readFileSync('alarmas.json', 'utf8'));
    } catch (e) { console.error("No se pudo cargar alarmas.json"); }
}

// Tareas programadas (cron)
let tareasProgramadas = [];
if (fs.existsSync('tareas_programadas.json')) {
    try { tareasProgramadas = JSON.parse(fs.readFileSync('tareas_programadas.json', 'utf8')); } catch(e){}
}

function guardarTareasProgramadas() {
    fs.writeFileSync('tareas_programadas.json', JSON.stringify(tareasProgramadas, null, 2));
}

// Variables de control de Cron a nivel de módulo (instancias singleton persistentes)
let cronsGlobalesIniciados = false;
global.activeCronJobs = new Map();
const ejecucionesRecientesTareas = new Map();
let verificandoYouTubeActualmente = false;
let ultimoTimestampYouTube = 0;

// Funciones para normalizar chats y detectar equivalencias (LID vs c.us vs admin vs grupos)
function normalizarDestinoChat(chatId) {
    if (!chatId) return adminChatId || 'admin_privado';
    const cStr = String(chatId).trim();
    if (cStr.endsWith('@g.us')) return cStr;
    if (adminChatId) {
        if (cStr === adminChatId) return adminChatId;
        const cleanAdmin = adminChatId.replace(/@.*$/, '');
        const cleanCurrent = cStr.replace(/@.*$/, '');
        if (cleanAdmin && cleanCurrent && (cleanAdmin === cleanCurrent || cStr.includes(cleanAdmin) || adminChatId.includes(cleanCurrent))) {
            return adminChatId;
        }
    }
    return cStr;
}

function sonMismoChatDestino(chatA, chatB) {
    return normalizarDestinoChat(chatA) === normalizarDestinoChat(chatB);
}

function horaToCron(horaStr) {
    if (!horaStr) return null;
    let s = horaStr.trim().toLowerCase();
    
    // Si ya es formato cron (5 campos separados por espacio)
    if (s.split(/\s+/).length === 5) {
        return horaStr.trim();
    }
    
    // Detectar AM/PM
    const isPM = s.includes('pm') || s.includes('p.m.');
    const isAM = s.includes('am') || s.includes('a.m.');
    s = s.replace(/am|pm|a\.m\.|p\.m\./g, '').trim();
    
    let h = 0, m = 0;
    if (s.includes(':')) {
        const parts = s.split(':');
        h = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10);
    } else {
        h = parseInt(s, 10);
        m = 0;
    }
    
    if (isNaN(h) || isNaN(m) || m < 0 || m > 59) return null;
    if (isPM && h < 12) h += 12;
    if (isAM && h === 12) h = 0;
    if (h < 0 || h > 23) return null;
    
    return `${m} ${h} * * *`;
}

function parsearInstruccionProgramacion(texto) {
    if (!texto || typeof texto !== 'string') return null;
    let t = texto.trim();

    // Si es una alarma o temporizador relativo, no debe procesarse como cron
    if (/\b(?:alarma|temporizador)\b/i.test(t) || /\b(?:en|dentro\s+de)\s+\d+\s*(?:minutos?|mins?|m|horas?|hrs?|h|segundos?|segs?|s)\b/i.test(t)) {
        return null;
    }

    // Remover prefijos comunes si los trae
    t = t.replace(/^(!bot\s+programar\s*|programar?\s+|agendar?\s+|recu[eé]rdame\s+|av[ií]same\s+)/i, '').trim();

    // Caso 1: Formato con pipes (|)
    if (t.includes('|')) {
        const parts = t.split('|').map(p => p.trim());
        const horaStr = parts[0];
        const accionStr = parts[1];
        const tipoStr = (parts[2] || 'diaria').toLowerCase();
        const recurrente = !['unavez', 'una vez', 'false', 'unica', 'única'].includes(tipoStr);
        const cronExpr = horaToCron(horaStr);
        if (cronExpr && accionStr) {
            return {
                hora: horaStr,
                cron: cronExpr,
                accion: accionStr,
                recurrente
            };
        }
    }

    // Caso 2: Lenguaje natural
    let recurrente = true;
    if (/\b(una\s+sola\s+vez|una\s+vez|solo\s+hoy|s[oó]lo\s+hoy|hoy)\b/i.test(t)) {
        recurrente = false;
        t = t.replace(/\b(una\s+sola\s+vez|una\s+vez|solo\s+hoy|s[oó]lo\s+hoy|hoy)\b/gi, '').trim();
    } else if (/\b(todos\s+los\s+d[ií]as|diari[ao]|cada\s+d[ií]a)\b/i.test(t)) {
        recurrente = true;
        t = t.replace(/\b(todos\s+los\s+d[ií]as|diari[ao]|cada\s+d[ií]a)\b/gi, '').trim();
    }

    const horaRegex = /(?:(?:a|para)\s+las?\s+)(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)|\b(\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)?)\b|\b(\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.))\b/i;
    const match = t.match(horaRegex);
    if (!match) return null;

    const horaCandidata = (match[1] || match[2] || match[3] || '').trim();
    if (!horaCandidata) return null;
    const cronExpr = horaToCron(horaCandidata);
    if (!cronExpr) return null;

    let accion = t.replace(match[0], ' ');
    accion = accion.replace(/^[\s,;:\-–—]+/, '');
    accion = accion.replace(/^(que|para|de|a)\s+/i, '');
    accion = accion.replace(/\s{2,}/g, ' ').trim();

    if (!accion) return null;

    return {
        hora: horaCandidata,
        cron: cronExpr,
        accion: accion,
        recurrente
    };
}

function formatearTareasProgramadas() {
    if (!tareasProgramadas || tareasProgramadas.length === 0) {
        return "No hay tareas programadas.";
    }
    let res = "*Tareas programadas activas:*\n";
    tareasProgramadas.forEach((t, i) => {
        const frecuencia = t.recurrente !== false ? 'Diaria' : 'Una vez';
        const destEsAdmin = !t.chatId || sonMismoChatDestino(t.chatId, adminChatId);
        const dest = destEsAdmin ? 'Privado' : (t.chatId?.endsWith('@g.us') ? 'Grupo' : 'Chat');
        const hora = t.hora || t.cron;
        res += `${i + 1}. [${hora}] ${frecuencia} | ${dest} - ${t.accion || t.descripcion}\n`;
    });
    return res.trim();
}

function procesarNuevaTareaProgramada(parsed, destChat) {
    const destNormalizado = normalizarDestinoChat(destChat);
    const indexExistente = tareasProgramadas.findIndex(t => {
        const mismoChat = sonMismoChatDestino(t.chatId, destNormalizado);
        const mismaHora = (t.hora === parsed.hora || t.cron === parsed.cron);
        return mismoChat && mismaHora;
    });

    const recLabel = parsed.recurrente ? 'Diaria' : 'Una vez';
    const destLabel = destNormalizado.endsWith('@g.us') ? 'Grupo' : 'Privado';

    if (indexExistente !== -1) {
        const antigua = tareasProgramadas[indexExistente];
        antigua.accion = parsed.accion;
        antigua.prompt = parsed.accion;
        antigua.descripcion = parsed.accion.length > 60 ? parsed.accion.substring(0, 57) + '...' : parsed.accion;
        antigua.recurrente = parsed.recurrente;
        antigua.hora = parsed.hora;
        antigua.cron = parsed.cron;
        antigua.chatId = destNormalizado;
        antigua.actualizada = new Date().toISOString();
        guardarTareasProgramadas();
        if (typeof global.inicializarTareas === 'function') global.inicializarTareas();

        return `Tarea actualizada: ${parsed.hora} (${recLabel})\nInstrucción: ${parsed.accion}\nDestino: ${destLabel}`;
    }

    const nuevaTarea = {
        hora: parsed.hora,
        cron: parsed.cron,
        recurrente: parsed.recurrente,
        accion: parsed.accion,
        prompt: parsed.accion,
        descripcion: parsed.accion.length > 60 ? parsed.accion.substring(0, 57) + '...' : parsed.accion,
        chatId: destNormalizado,
        creada: new Date().toISOString()
    };

    tareasProgramadas.push(nuevaTarea);
    guardarTareasProgramadas();
    if (typeof global.inicializarTareas === 'function') global.inicializarTareas();

    return `Tarea programada: ${parsed.hora} (${recLabel})\nInstrucción: ${parsed.accion}\nDestino: ${destLabel}`;
}

function cancelarTareaProgramada(param) {
    if (!tareasProgramadas || tareasProgramadas.length === 0) {
        return "No hay tareas programadas para cancelar.";
    }
    const p = String(param || '').trim().toLowerCase();
    if (p === 'todas' || p === 'todo' || p.includes('todas')) {
        const total = tareasProgramadas.length;
        tareasProgramadas = [];
        guardarTareasProgramadas();
        if (typeof global.inicializarTareas === 'function') global.inicializarTareas();
        return `Se cancelaron todas las tareas programadas (${total}).`;
    }

    const rawIdx = parseInt(p, 10);
    let index = rawIdx - 1;
    if (isNaN(index) || index < 0 || index >= tareasProgramadas.length) {
        if (!isNaN(rawIdx) && rawIdx >= 0 && rawIdx < tareasProgramadas.length) {
            index = rawIdx;
        } else {
            return `Número de tarea no válido. Tareas disponibles: 1 a ${tareasProgramadas.length}.`;
        }
    }

    const eliminada = tareasProgramadas.splice(index, 1)[0];
    guardarTareasProgramadas();
    if (typeof global.inicializarTareas === 'function') global.inicializarTareas();
    return `Tarea eliminada: ${eliminada.accion || eliminada.descripcion} (${eliminada.hora || eliminada.cron})`;
}

async function obtenerReporteClima(ciudadInput = 'Chalchuapa') {
    const ciudad = (ciudadInput || 'Chalchuapa').trim();
    try {
        const url = 'https://wttr.in/' + encodeURIComponent(ciudad) + '?format=j1&lang=es';
        const res = await fetch(url, { headers: { 'User-Agent': 'curl/7.68.0' } });
        if (!res.ok) throw new Error('Servicio de clima no disponible.');
        const data = await res.json();

        const weather = data.weather?.[0];
        const current = data.current_condition?.[0];
        if (!weather || !current) throw new Error('Datos de clima incompletos.');

        const location = data.nearest_area?.[0];
        const areaName = location?.areaName?.[0]?.value || ciudad;

        const descActual = current.lang_es?.[0]?.value || current.weatherDesc?.[0]?.value || 'Despejado';
        const tempActual = current.temp_C;
        const sensTermica = current.FeelsLikeC;
        const humedad = current.humidity;
        const viento = current.windspeedKmph;
        const maxTemp = weather.maxtempC;
        const minTemp = weather.mintempC;

        const hourly = weather.hourly || [];
        const getDesc = h => h?.lang_es?.[0]?.value || h?.weatherDesc?.[0]?.value || 'Despejado';

        const sliceManana = hourly.find(h => parseInt(h.time) === 600) || hourly[2];
        const sliceTarde = hourly.find(h => parseInt(h.time) === 1500) || hourly[5];
        const sliceNoche = hourly.find(h => parseInt(h.time) === 2100) || hourly[7];

        // Hora El Salvador (UTC-6)
        const ahora = new Date();
        const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
        const gtmH = new Date(utc + (3600000 * -6)).getHours();

        let pronosticoLineas = [];
        let riesgoLluvia = false;

        if (gtmH < 12) {
            if (sliceManana) {
                pronosticoLineas.push(`- Mañana: ${getDesc(sliceManana)}, ${sliceManana.tempC}°C, lluvia ${sliceManana.chanceofrain}%`);
                if (parseInt(sliceManana.chanceofrain) > 40) riesgoLluvia = true;
            }
            if (sliceTarde) {
                pronosticoLineas.push(`- Tarde: ${getDesc(sliceTarde)}, ${sliceTarde.tempC}°C, lluvia ${sliceTarde.chanceofrain}%`);
                if (parseInt(sliceTarde.chanceofrain) > 40) riesgoLluvia = true;
            }
            if (sliceNoche) {
                pronosticoLineas.push(`- Noche: ${getDesc(sliceNoche)}, ${sliceNoche.tempC}°C, lluvia ${sliceNoche.chanceofrain}%`);
                if (parseInt(sliceNoche.chanceofrain) > 40) riesgoLluvia = true;
            }
        } else if (gtmH < 18) {
            if (sliceTarde) {
                pronosticoLineas.push(`- Tarde: ${getDesc(sliceTarde)}, ${sliceTarde.tempC}°C, lluvia ${sliceTarde.chanceofrain}%`);
                if (parseInt(sliceTarde.chanceofrain) > 40) riesgoLluvia = true;
            }
            if (sliceNoche) {
                pronosticoLineas.push(`- Noche: ${getDesc(sliceNoche)}, ${sliceNoche.tempC}°C, lluvia ${sliceNoche.chanceofrain}%`);
                if (parseInt(sliceNoche.chanceofrain) > 40) riesgoLluvia = true;
            }
        } else {
            if (sliceNoche) {
                pronosticoLineas.push(`- Noche: ${getDesc(sliceNoche)}, ${sliceNoche.tempC}°C, lluvia ${sliceNoche.chanceofrain}%`);
                if (parseInt(sliceNoche.chanceofrain) > 40) riesgoLluvia = true;
            }
        }

        const descLower = descActual.toLowerCase();
        if (descLower.includes('lluvia') || descLower.includes('aguacero') || descLower.includes('tormenta') || descLower.includes('chubasco')) {
            riesgoLluvia = true;
        }

        const transporte = riesgoLluvia ? 'Carro (probabilidad de lluvia)' : 'Moto o carro (condiciones favorables)';

        let texto = `*Clima en ${areaName}:*
Estado: ${descActual}
Temperatura: ${tempActual}°C (Sensación: ${sensTermica}°C)
Rango hoy: Mín ${minTemp}°C / Máx ${maxTemp}°C
Humedad: ${humedad}% | Viento: ${viento} km/h`;

        if (pronosticoLineas.length > 0) {
            texto += `\n\n*Pronóstico:*\n${pronosticoLineas.join('\n')}`;
        }

        texto += `\n\n*Transporte sugerido:* ${transporte}`;
        return texto;
    } catch (e) {
        console.error('Error al obtener clima:', e.message);
        return `No fue posible consultar el clima para "${ciudad}". Intenta de nuevo más tarde.`;
    }
}

async function descifrarMediaWhatsApp(bufferEncrypted, mediaKeyBase64, mediaType = 'image') {
    try {
        const mediaKey = Buffer.isBuffer(mediaKeyBase64) ? mediaKeyBase64 : Buffer.from(mediaKeyBase64, 'base64');
        const infoMap = {
            image: 'WhatsApp Image Keys',
            video: 'WhatsApp Video Keys',
            audio: 'WhatsApp Audio Keys',
            document: 'WhatsApp Document Keys',
            sticker: 'WhatsApp Image Keys'
        };
        const infoStr = infoMap[mediaType] || 'WhatsApp Image Keys';
        
        let derived;
        if (typeof crypto.hkdfSync === 'function') {
            derived = crypto.hkdfSync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(infoStr, 'utf-8'), 112);
        } else {
            const { promisify } = require('util');
            const hkdfAsync = promisify(crypto.hkdf);
            const arrBuf = await hkdfAsync('sha256', mediaKey, Buffer.alloc(32), Buffer.from(infoStr, 'utf-8'), 112);
            derived = Buffer.from(arrBuf);
        }
        const iv = derived.subarray(0, 16);
        const cipherKey = derived.subarray(16, 48);
        
        const cipherText = bufferEncrypted.subarray(0, bufferEncrypted.length - 10);
        const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
        return Buffer.concat([decipher.update(cipherText), decipher.final()]);
    } catch (e) {
        console.error('[descifrarMediaWhatsApp] Error al descifrar:', e.message);
        return null;
    }
}

async function descargarDirectoCDN(directPath, mediaKey, mediaType = 'image') {
    if (!directPath || !mediaKey) return null;
    try {
        const url = directPath.startsWith('http') ? directPath : `https://mmg.whatsapp.net${directPath}`;
        console.log(`[descargarDirectoCDN] Intentando descarga directa desde CDN: ${url}...`);
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'WhatsApp/2.24.6.77 Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Origin': 'https://web.whatsapp.com',
                'Referer': 'https://web.whatsapp.com/'
            }
        });
        if (resp.ok) {
            const encBuffer = Buffer.from(await resp.arrayBuffer());
            const decrypted = await descifrarMediaWhatsApp(encBuffer, mediaKey, mediaType);
            if (decrypted && decrypted.length > 50) {
                console.log(`[descargarDirectoCDN] ¡Descifrado exitoso! Tamaño: ${decrypted.length} bytes`);
                return decrypted;
            }
        } else {
            console.warn(`[descargarDirectoCDN] CDN respondió status ${resp.status}`);
        }
    } catch (e) {
        console.error(`[descargarDirectoCDN] Error:`, e.message);
    }
    return null;
}

async function descargarMediaSeguro(mensaje, maxIntentos = 1) {
    if (!mensaje) return null;

    // 1. Intento nativo estándar con mensaje.downloadMedia()
    if (typeof mensaje.downloadMedia === 'function') {
        try {
            const media = await mensaje.downloadMedia();
            if (media && media.data) return media;
        } catch (e) {
            console.warn('[descargarMediaSeguro] Intento nativo falló:', e?.message || e);
        }
    }

    // 2. Descarga y descifrado directo por CDN (Node.js nativo con crypto)
    const rawData = mensaje._data || {};
    const directPath = rawData.directPath || mensaje.directPath;
    const mediaKey = rawData.mediaKey || mensaje.mediaKey;
    const mediaType = rawData.type || mensaje.type || 'image';
    const mimetype = rawData.mimetype || mensaje.mimetype || 'image/jpeg';
    const filename = rawData.filename || mensaje.filename || 'imagen.jpg';

    if (directPath && mediaKey) {
        const bufDec = await descargarDirectoCDN(directPath, mediaKey, mediaType);
        if (bufDec) {
            return new MessageMedia(mimetype, bufDec.toString('base64'), filename);
        }
    }

    // 3. Extracción directa y profunda desde la sesión web de Puppeteer
    try {
        const pupPage = mensaje.client?.pupPage || client?.pupPage;
        const msgId = mensaje.id?._serialized;
        if (pupPage) {
            console.log(`[descargarMediaSeguro] Ejecutando extracción en página para msgId: ${msgId}...`);
            const res = await pupPage.evaluate(async (params) => {
                try {
                    // Estrategia A: downloadManager con params directos
                    if (params.directPath && params.mediaKey) {
                        try {
                            const dlMgr = window.require('WAWebDownloadManager')?.downloadManager || window.Store?.DownloadManager;
                            if (dlMgr && typeof dlMgr.downloadAndMaybeDecrypt === 'function') {
                                const decrypted = await dlMgr.downloadAndMaybeDecrypt({
                                    directPath: params.directPath,
                                    encFilehash: params.encFilehash,
                                    filehash: params.filehash,
                                    mediaKey: params.mediaKey,
                                    mediaKeyTimestamp: params.mediaKeyTimestamp,
                                    type: params.type,
                                    signal: (new AbortController()).signal
                                });
                                if (decrypted) {
                                    const b64 = await window.WWebJS.arrayBufferToBase64Async(decrypted);
                                    if (b64 && b64.length > 50) {
                                        return { ok: true, data: b64, mimetype: params.mimetype, source: 'dlMgr_direct' };
                                    }
                                }
                            }
                        } catch (eA) {}
                    }

                    // Estrategia B: Buscar en mensajes de WWebJS
                    if (params.msgId) {
                        try {
                            const msg = await window.WWebJS.getMsgById(params.msgId);
                            if (msg?.mediaData?.renderableUrl) {
                                const resp = await fetch(msg.mediaData.renderableUrl);
                                if (resp.ok) {
                                    const buffer = await resp.arrayBuffer();
                                    const b64 = await window.WWebJS.arrayBufferToBase64Async(buffer);
                                    if (b64 && b64.length > 50) {
                                        return { ok: true, data: b64, mimetype: params.mimetype, source: 'renderableUrl' };
                                    }
                                }
                            }
                            if (msg?.mediaData?.preview) {
                                let prev = msg.mediaData.preview;
                                if (typeof prev === 'string') {
                                    prev = prev.replace(/^data:image\/[^;]+;base64,/, '');
                                    if (prev.length > 50) {
                                        return { ok: true, data: prev, mimetype: 'image/jpeg', source: 'preview_model' };
                                    }
                                }
                            }
                        } catch (eB) {}
                    }

                    // Estrategia C: DOM img blob
                    const allBlobs = Array.from(document.querySelectorAll('img[src^="blob:"]'));
                    if (allBlobs.length > 0) {
                        const lastImg = allBlobs[allBlobs.length - 1];
                        try {
                            const resp = await fetch(lastImg.src);
                            if (resp.ok) {
                                const buffer = await resp.arrayBuffer();
                                const b64 = await window.WWebJS.arrayBufferToBase64Async(buffer);
                                if (b64 && b64.length > 50) {
                                    return { ok: true, data: b64, mimetype: params.mimetype, source: 'dom_last_blob' };
                                }
                            }
                        } catch (eC) {}
                    }

                    return { ok: false, err: 'exhausted' };
                } catch (eAll) {
                    return { ok: false, err: String(eAll?.message || eAll) };
                }
            }, {
                msgId,
                directPath,
                mediaKey,
                encFilehash: rawData.encFilehash,
                filehash: rawData.filehash,
                mediaKeyTimestamp: rawData.mediaKeyTimestamp,
                type: mediaType,
                mimetype
            });

            console.log(`[descargarMediaSeguro] Resultado extracción profunda:`, JSON.stringify({ ok: res?.ok, source: res?.source, err: res?.err }));
            if (res && res.ok && res.data) {
                return new MessageMedia(mimetype, res.data, filename);
            }
        }
    } catch (eProfundo) {
        console.error(`[descargarMediaSeguro] Error en extracción profunda:`, eProfundo.message);
    }

    // 4. Último recurso infalible: Thumbnail / Preview base64 de _data.body
    if (rawData.body && typeof rawData.body === 'string' && rawData.body.length > 50) {
        console.log(`[descargarMediaSeguro] Usando thumbnail JPEG de mensaje._data.body (${rawData.body.length} caracteres)`);
        const cleanBase64 = rawData.body.replace(/^data:image\/[^;]+;base64,/, '');
        return new MessageMedia('image/jpeg', cleanBase64, 'thumbnail.jpg');
    }

    return null;
}

async function generarImagenIA(promptUsuario, msgRef, options = {}) {
    if (!promptUsuario || !String(promptUsuario).trim()) {
        return msgRef.reply("Indica qué imagen deseas crear. Ejemplo: Crea una imagen de un gato samurai con armadura");
    }

    const textoPrompt = String(promptUsuario).trim();
    const captionPrompt = options.captionPrompt || textoPrompt;
    if (!options.silent) {
        await msgRef.reply("Generando imagen...");
    }

    try {
        // 1. Optimizar y traducir el prompt respetando la intención y estilo exacto del usuario
        let promptMejorado = textoPrompt;
        if (!options.isAlreadyOptimized) {
            try {
                const promptExpansion = `You are an expert AI prompt engineer for state-of-the-art text-to-image models (FLUX.1 and SDXL).
Translate and enhance the user's description into a high-detail, visually striking English prompt.

CRITICAL RULES:
1. STRICT RESPECT FOR USER INTENT & STYLE:
   - Faithfully preserve the exact subject, art style, perspective, mood, lighting, and genre requested by the user.
   - If the user specifies an art style (e.g., anime, manga, comic, watercolor, oil painting, cyberpunk, photorealistic, 3D Pixar, dark fantasy, pixel art, sketch, vintage photography, vector illustration), strictly maintain that style.
   - NEVER impose commercial product photography, golden accents, or studio advertising setups unless the user explicitly requested it.
2. ENHANCE VISUAL DETAILS:
   - Clearly describe the focal subject, foreground, background, environmental atmosphere, lighting dynamics, and color palette.
   - Add quality-boosting descriptors that fit the requested style (e.g., for realism: 'sharp focus, natural lighting, high dynamic range, intricate textures, 8k resolution'; for digital art: 'detailed digital illustration, vibrant colors, masterpiece').
3. OUTPUT FORMAT:
   - Output ONLY the final raw English prompt text.
   - NO preamble, NO explanations, NO quotes, NO conversational text.

User request: "${textoPrompt}"`;

                const resOpt = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([promptExpansion]);
                    return result.response.text();
                });
                if (resOpt && resOpt.trim()) {
                    promptMejorado = resOpt.trim().replace(/^["']|["']$/g, '');
                    console.log(`[Prompt Imagen Optimizado]: ${promptMejorado}`);
                }
            } catch (eOpt) {
                console.error("No se pudo expandir el prompt con Gemini, usando original:", eOpt.message);
            }
        } else {
            console.log(`[Prompt Imagen Directo/Vision]: ${promptMejorado}`);
        }

        let imageBuffer = null;
        let mimeType = 'image/jpeg';
        let motorUsado = '';

        // Motor 1: Hugging Face Inference (FLUX.1-schnell / SDXL)
        if (hfToken && !imageBuffer) {
            try {
                console.log("[Imagen] Intentando generar con Hugging Face InferenceClient (FLUX.1)...");
                const { InferenceClient } = require('@huggingface/inference');
                const hfClient = new InferenceClient(hfToken);
                
                try {
                    const resBlob = await hfClient.textToImage({
                        model: "black-forest-labs/FLUX.1-schnell",
                        inputs: promptMejorado
                    });
                    if (resBlob) {
                        const buf = Buffer.from(await resBlob.arrayBuffer());
                        if (buf.byteLength > 1000) {
                            imageBuffer = buf;
                            mimeType = resBlob.type || "image/jpeg";
                            motorUsado = "FLUX.1 (Hugging Face)";
                        }
                    }
                } catch (errFlux) {
                    console.log("[!] FLUX.1 en HF falló, probando SDXL:", errFlux.message);
                    const resSdxl = await hfClient.textToImage({
                        model: "stabilityai/stable-diffusion-xl-base-1.0",
                        inputs: promptMejorado
                    });
                    if (resSdxl) {
                        const buf = Buffer.from(await resSdxl.arrayBuffer());
                        if (buf.byteLength > 1000) {
                            imageBuffer = buf;
                            mimeType = resSdxl.type || "image/jpeg";
                            motorUsado = "SDXL (Hugging Face)";
                        }
                    }
                }
            } catch (errHf) {
                console.error("[!] Error general en motor Hugging Face:", errHf.message);
            }
        }

        // Motor 2: Pollinations con clave de API
        if (pollinationsApiKey && !imageBuffer) {
            try {
                console.log("[Imagen] Intentando generar con Pollinations API Key...");
                const seed = Math.floor(Math.random() * 99999);
                const url = `https://gen.pollinations.ai/image/${encodeURIComponent(promptMejorado)}?key=${pollinationsApiKey}&model=flux&seed=${seed}`;
                const pRes = await fetch(url);
                if (pRes.ok) {
                    const buf = await pRes.arrayBuffer();
                    if (buf.byteLength > 1000) {
                        imageBuffer = Buffer.from(buf);
                        mimeType = pRes.headers.get("content-type") || "image/jpeg";
                        motorUsado = "FLUX (Pollinations)";
                    }
                }
            } catch (errPol) {
                console.error("[!] Error en Pollinations API:", errPol.message);
            }
        }

        // Motor 3: OpenAI DALL-E (si está configurada)
        if (openaiApiKey && !imageBuffer) {
            try {
                console.log("[Imagen] Intentando generar con OpenAI...");
                const openAiRes = await fetch("https://api.openai.com/v1/images/generations", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${openaiApiKey}`
                    },
                    body: JSON.stringify({
                        model: "dall-e-3",
                        prompt: promptMejorado,
                        n: 1,
                        size: "1024x1024"
                    })
                });
                const openAiData = await openAiRes.json();
                if (openAiData.data && openAiData.data[0] && openAiData.data[0].url) {
                    const imgResp = await fetch(openAiData.data[0].url);
                    const buf = await imgResp.arrayBuffer();
                    imageBuffer = Buffer.from(buf);
                    mimeType = "image/png";
                    motorUsado = "DALL-E 3 (OpenAI)";
                }
            } catch (errOai) {
                console.error("[!] Error en OpenAI DALL-E:", errOai.message);
            }
        }

        // Motor 4: Intentar con Pollinations libre (por si responde)
        if (!imageBuffer) {
            try {
                const seed = Math.floor(Math.random() * 99999);
                const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptMejorado)}?model=flux&seed=${seed}`;
                const pRes = await fetch(url);
                if (pRes.ok) {
                    const buf = await pRes.arrayBuffer();
                    if (buf.byteLength > 1000) {
                        imageBuffer = Buffer.from(buf);
                        mimeType = pRes.headers.get("content-type") || "image/jpeg";
                        motorUsado = "FLUX";
                    }
                }
            } catch (errP) {}
        }

        // Si se obtuvo imagen:
        if (imageBuffer) {
            const media = new MessageMedia(mimeType, imageBuffer.toString('base64'), 'imagen.jpg');
            return msgRef.reply(media, undefined, { caption: `*Imagen:* ${captionPrompt}\n*Motor:* ${motorUsado}` });
        }

        // Si ningún servidor respondió:
        return msgRef.reply(`No fue posible generar la imagen porque los servidores públicos gratuitos ahora requieren autenticación.

Para habilitar la creación de imágenes en alta resolución (FLUX.1 y SDXL) 100% gratis:
1. Crea una cuenta gratuita en huggingface.co (toma 30 segundos, sin tarjeta).
2. Ve a huggingface.co/settings/tokens y genera un token tipo "Read".
3. Envíame el comando:
!bot sethf hf_tu_token

Otras opciones compatibles:
- Pollinations: !bot setpollinations <clave> (en enter.pollinations.ai)
- OpenAI: !bot setopenai <clave>`);
    } catch (e) {
        console.error("Error general generando imagen:", e);
        return msgRef.reply("Ocurrió un error al procesar la solicitud de imagen.");
    }
}

function horaTo24(horaStr) {
    if (!horaStr) return '00:00';
    let s = horaStr.trim().toLowerCase();
    const isPM = s.includes('pm') || s.includes('p.m.');
    const isAM = s.includes('am') || s.includes('a.m.');
    s = s.replace(/am|pm|a\.m\.|p\.m\./g, '').trim();
    let h = 0, m = 0;
    if (s.includes(':')) {
        const parts = s.split(':');
        h = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10);
    } else {
        h = parseInt(s, 10);
        m = 0;
    }
    if (isNaN(h) || isNaN(m)) return '00:00';
    if (isPM && h < 12) h += 12;
    if (isAM && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parsearAlarma(texto) {
    if (!texto) return null;
    let t = texto.trim().replace(/^[¿¡?!.,\s]+|[¿¡?!.,\s]+$/g, '');

    // 1. Temporizador / Alarma relativa ("en X minutos", "dentro de X minutos", "en media hora")
    let minutos = null;
    let matchStr = null;

    if (/\b(?:en|dentro\s+de)\s+media\s+hora\b/i.test(t)) {
        minutos = 30;
        matchStr = t.match(/\b(?:en|dentro\s+de)\s+media\s+hora\b/i)[0];
    } else {
        const regexRel = /\b(?:para\s+)?(?:en|dentro\s+de)\s+(\d+(?:\.\d+)?)\s*(minutos?|mins?|m|horas?|hrs?|h|segundos?|segs?|s)\b/i;
        const match = t.match(regexRel);
        if (match) {
            const cantidad = parseFloat(match[1]);
            const unidad = match[2].toLowerCase();
            minutos = cantidad;
            if (unidad.startsWith('h')) minutos = cantidad * 60;
            else if (unidad.startsWith('s')) minutos = cantidad / 60;
            matchStr = match[0];
        }
    }

    if (minutos !== null) {
        let mensaje = t.replace(matchStr, ' ');
        mensaje = mensaje.replace(/\b(?:programa(?:r)?|pon(?:er)?|crea(?:r)?|establece(?:r)?|av[ií]same|recu[eé]rdame)\b/gi, ' ');
        mensaje = mensaje.replace(/\b(?:una\s+)?(?:alarma|recordatorio|temporizador|aviso)\b/gi, ' ');
        mensaje = mensaje.replace(/^(?:record[aá]ndome|para|de|que|a)\s+/i, ' ');
        mensaje = mensaje.replace(/\b(?:record[aá]ndome|para)\s+/i, ' ');
        mensaje = mensaje.replace(/^[\s,;:\-–—]+/, '');
        mensaje = mensaje.replace(/\s{2,}/g, ' ').trim();

        const fechaObj = new Date(Date.now() + (minutos * 60000));
        let hES = (fechaObj.getUTCHours() - 6 + 24) % 24;
        let mES = fechaObj.getUTCMinutes();
        const ampm = hES >= 12 ? 'PM' : 'AM';
        const h12 = hES % 12 || 12;
        const horaDisplay = `${String(h12).padStart(2, '0')}:${String(mES).padStart(2, '0')} ${ampm}`;
        const hora24 = `${String(hES).padStart(2, '0')}:${String(mES).padStart(2, '0')}`;

        return {
            tipo: 'relativa',
            minutos,
            horaDisplay,
            hora24,
            fechaObj,
            mensaje: mensaje || 'Alarma'
        };
    }

    // 2. Alarma a hora específica ("alarma a las 7:00 am", "alarma a las 06:30")
    if (/\b(?:alarma|recordatorio|temporizador)\b/i.test(t)) {
        const regexHora = /(?:(?:a|para)\s+las?\s+)(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)|\b(\d{1,2}:\d{2}\s*(?:am|pm|a\.m\.|p\.m\.)?)\b|\b(\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.))\b/i;
        const matchH = t.match(regexHora);
        if (matchH) {
            const horaStr = (matchH[1] || matchH[2] || matchH[3]).trim();
            let mensaje = t.replace(matchH[0], ' ');
            mensaje = mensaje.replace(/\b(?:programa(?:r)?|pon(?:er)?|crea(?:r)?|establece(?:r)?|av[ií]same|recu[eé]rdame)\b/gi, ' ');
            mensaje = mensaje.replace(/\b(?:una\s+)?(?:alarma|recordatorio|temporizador|aviso)\b/gi, ' ');
            mensaje = mensaje.replace(/^(?:record[aá]ndome|para|de|que|a)\s+/i, ' ');
            mensaje = mensaje.replace(/^[\s,;:\-–—]+/, '');
            mensaje = mensaje.replace(/\s{2,}/g, ' ').trim();

            return {
                tipo: 'absoluta',
                horaStr,
                mensaje: mensaje || 'Alarma'
            };
        }
    }

    return null;
}

function formatearAlarmas() {
    if (!alarmasGuardadas || alarmasGuardadas.length === 0) {
        return "No hay alarmas configuradas.";
    }
    let res = "*Alarmas activas:*\n";
    alarmasGuardadas.forEach((al, idx) => {
        const tipo = al.recurrente ? 'Diaria' : 'Una vez';
        res += `${idx + 1}. [${al.hora}] ${tipo} - ${al.mensaje}\n`;
    });
    return res.trim();
}

function cancelarAlarma(param) {
    if (!alarmasGuardadas || alarmasGuardadas.length === 0) {
        return "No hay alarmas configuradas para cancelar.";
    }
    const p = String(param || '').trim().toLowerCase();
    if (p === 'todas' || p === 'todo' || p.includes('todas')) {
        const cant = alarmasGuardadas.length;
        alarmasGuardadas = [];
        guardarAlarmas();
        return `Se cancelaron todas las alarmas (${cant}).`;
    }
    const rawIdx = parseInt(p, 10);
    let index = rawIdx - 1;
    if (isNaN(index) || index < 0 || index >= alarmasGuardadas.length) {
        if (!isNaN(rawIdx) && rawIdx >= 0 && rawIdx < alarmasGuardadas.length) {
            index = rawIdx;
        } else {
            return `Número de alarma no válido. Alarmas disponibles: 1 a ${alarmasGuardadas.length}.`;
        }
    }
    const borrada = alarmasGuardadas.splice(index, 1)[0];
    guardarAlarmas();
    return `Alarma eliminada: ${borrada.mensaje} (${borrada.hora})`;
}

function procesarNuevaAlarma(parsed, chatId) {
    const dest = normalizarDestinoChat(chatId);
    if (parsed.tipo === 'relativa') {
        const fechaStr = getFechaElSalvador(parsed.fechaObj);

        const nuevaAlarma = {
            hora: parsed.hora24,
            mensaje: parsed.mensaje,
            chatId: dest,
            recurrente: false,
            fecha: fechaStr,
            timestampObjetivo: parsed.fechaObj.getTime(),
            creada: new Date().toISOString()
        };

        alarmasGuardadas.push(nuevaAlarma);
        guardarAlarmas();

        return `Alarma establecida: en ${parsed.minutos} min (${parsed.horaDisplay})\nMensaje: ${parsed.mensaje}`;
    }

    if (parsed.tipo === 'absoluta') {
        const hora24 = horaTo24(parsed.horaStr);
        const fechaObjetivo = getFechaObjetivoAlarma(hora24);

        let timestampObjetivo = null;
        try {
            const partsF = fechaObjetivo.split('/');
            const partsH = hora24.split(':');
            if (partsF.length === 3 && partsH.length === 2) {
                const day = parseInt(partsF[0], 10);
                const month = parseInt(partsF[1], 10) - 1;
                const year = parseInt(partsF[2], 10);
                const hour = parseInt(partsH[0], 10);
                const min = parseInt(partsH[1], 10);
                // El Salvador está en UTC-6
                timestampObjetivo = Date.UTC(year, month, day, hour + 6, min, 0);
            }
        } catch (e) {}

        const nuevaAlarma = {
            hora: hora24,
            mensaje: parsed.mensaje,
            chatId: dest,
            recurrente: false,
            fecha: fechaObjetivo,
            timestampObjetivo: timestampObjetivo,
            creada: new Date().toISOString()
        };

        alarmasGuardadas.push(nuevaAlarma);
        guardarAlarmas();

        return `Alarma establecida: ${parsed.horaStr}\nMensaje: ${parsed.mensaje}`;
    }

    return "Indica el tiempo o la hora de la alarma. Ejemplo: Alarma en 5 minutos cerrar el navegador";
}

function guardarAlarmas() {
    fs.writeFileSync('alarmas.json', JSON.stringify(alarmasGuardadas, null, 2));
}

function guardarNotas() {
    fs.writeFileSync('notas.json', JSON.stringify(notasGuardadas, null, 2));
}

function getHoraElSalvador(date = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/El_Salvador',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(date);
        const h = parts.find(p => p.type === 'hour').value;
        const m = parts.find(p => p.type === 'minute').value;
        return h + ':' + m;
    } catch (e) {
        const hoy = date;
        const utc = hoy.getTime() + (hoy.getTimezoneOffset() * 60000);
        const hoyES = new Date(utc + (3600000 * -6));
        return String(hoyES.getHours()).padStart(2, '0') + ':' + String(hoyES.getMinutes()).padStart(2, '0');
    }
}

function getFechaElSalvador(date = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/El_Salvador',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(date);
        const y = parts.find(p => p.type === 'year').value;
        const m = parts.find(p => p.type === 'month').value;
        const d = parts.find(p => p.type === 'day').value;
        return d + '/' + m + '/' + y;
    } catch (e) {
        const hoy = date;
        const utc = hoy.getTime() + (hoy.getTimezoneOffset() * 60000);
        const hoyES = new Date(utc + (3600000 * -6));
        return String(hoyES.getDate()).padStart(2, '0') + '/' + String(hoyES.getMonth()+1).padStart(2, '0') + '/' + hoyES.getFullYear();
    }
}

function getFechaObjetivoAlarma(horaStrObjetivo) {
    const hoy = new Date();
    const horaActual = getHoraElSalvador(hoy);
    let fechaObj = new Date(hoy);
    if (horaStrObjetivo < horaActual) {
        fechaObj.setDate(fechaObj.getDate() + 1);
    }
    return getFechaElSalvador(fechaObj);
}

function normalizarHora(h) {
    if (!h) return '';
    const parts = h.trim().split(':');
    if (parts.length !== 2) return h.trim();
    return String(parseInt(parts[0], 10)).padStart(2, '0') + ':' + String(parseInt(parts[1], 10)).padStart(2, '0');
}


// Cargar tareas estructuradas
let tareasGuardadas = [];
if (fs.existsSync('tareas.json')) {
    try {
        tareasGuardadas = JSON.parse(fs.readFileSync('tareas.json', 'utf8'));
    } catch (e) { console.error("No se pudo cargar tareas.json"); }
}

function guardarTareas() {
    fs.writeFileSync('tareas.json', JSON.stringify(tareasGuardadas, null, 2));
}

// Estado para juegos grupales
const juegosEstado = new Map();

// ---------------------------------------------------------
// CLIENTE WHATSAPP CONFIGURADO PARA CORRER EN CUALQUIER PC O ANDROID
// ---------------------------------------------------------
const puppeteerConfig = {
    headless: true,
    protocolTimeout: 0,
    timeout: 0,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
};

// Si detectamos que es Termux, inyectamos la ruta del Chromium móvil de forma automática
if (fs.existsSync('/usr/bin/chromium-browser')) { puppeteerConfig.executablePath = '/usr/bin/chromium-browser'; }
if (isTermux) {
    puppeteerConfig.executablePath = '/data/data/com.termux/files/usr/bin/chromium-browser';
    puppeteerConfig.args.push(
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-webgl',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--mute-audio',
        '--no-sandbox',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-ipc-flooding-protection',
        '--js-flags=--max-old-space-size=512'
    );
    console.log('[Enrutador] Entorno detectado: Android/Termux. Cargando Chromium movil...');
    console.log('[ℹ WhatsApp Web]: Conectando sesión... (Los mensajes de "PUPPETEER PAGE LOG / storage denied" son advertencias internas normales de WhatsApp Web en móvil. Espera ~20 segundos a que diga LISTO)...');
} else {
    console.log('[Enrutador] Entorno detectado: Computadora (Windows). Cargando Puppeteer estandar...');
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerConfig,
    authTimeoutMs: 0,
    webVersionCache: { type: 'none' }
});

const originalSendMessage = client.sendMessage.bind(client);
client.sendMessage = async (...args) => {
    try {
        return await originalSendMessage(...args);
    } catch (e) {
        if (e && e.message && (e.message.includes('endsWith') || e.message.includes('not a function'))) {
            return { fake: true, message: 'Swallowed endsWith error' };
        }
        throw e;
    }
};

const chatsActivos = new Set();
const sesionesChat = new Map();
const esperandoAyudaOpcion = new Map();

async function obtenerIdCanal(entrada) {
    if (!entrada) return null;
    let str = entrada.trim();
    if (str.startsWith('UC') && str.length === 24) return str;

    const directMatch = str.match(/channel\/(UC[a-zA-Z0-9_-]{22})/i);
    if (directMatch) return directMatch[1];

    try {
        let fetchUrl = str;
        if (str.startsWith('@')) {
            fetchUrl = 'https://www.youtube.com/' + str;
        } else if (str.includes('youtube.com') || str.includes('youtu.be')) {
            fetchUrl = str.startsWith('http') ? str : 'https://' + str;
        } else {
            // Buscar por nombre o término en YouTube
            fetchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(str)}&sp=EgIQAg%253D%253D`;
        }

        const res = await fetch(fetchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'es,en;q=0.9'
            }
        });
        const html = await res.text();

        const match = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/i) ||
                      html.match(/"browseId":"(UC[a-zA-Z0-9_-]{22})"/i) ||
                      html.match(/<meta itemprop="identifier" content="(UC[a-zA-Z0-9_-]{22})">/i) ||
                      html.match(/<meta itemprop="channelId" content="(UC[a-zA-Z0-9_-]{22})">/i) ||
                      html.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/i);

        if (match && match[1]) return match[1];
    } catch (e) {
        console.error("Error obteniendo ID de canal:", e.message);
    }
    return null;
}

async function obtenerUltimosVideosCanal(canalId, limite = 3) {
    if (!canalId) return null;
    try {
        const feed = await rssParser.parseURL('https://www.youtube.com/feeds/videos.xml?channel_id=' + canalId);
        if (!feed || !feed.items) return null;
        return {
            canalNombre: feed.title || 'Canal de YouTube',
            canalId: canalId,
            videos: feed.items.slice(0, limite).map(item => {
                let fechaFormato = '';
                if (item.pubDate || item.isoDate) {
                    try {
                        const d = new Date(item.pubDate || item.isoDate);
                        fechaFormato = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
                    } catch(e){}
                }
                return {
                    titulo: item.title,
                    link: item.link,
                    fecha: fechaFormato
                };
            })
        };
    } catch (e) {
        console.error(`Error obteniendo videos del canal ${canalId}:`, e.message);
        return null;
    }
}

async function downloadTikTok(url) {
    try {
        const fetch = require('node-fetch');
        let fullUrl = url ? url.trim() : '';

        // Función auxiliar para consultar TikWM
        const queryTikwm = async (targetUrl) => {
            const tikwmEndpoints = [
                'https://www.tikwm.com/api/?url=',
                'https://tikwm.com/api/?url='
            ];
            for (const ep of tikwmEndpoints) {
                try {
                    const res = await fetch(ep + encodeURIComponent(targetUrl), {
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        timeout: 8000
                    });
                    if (res.ok) {
                        const json = await res.json();
                        if (json && json.code === 0 && json.data) {
                            return json.data.play || json.data.wmplay || json.data.hdplay;
                        }
                    }
                } catch(e) {}
            }
            return null;
        };

        // 1. Probar TikWM directamente con la URL (resuelve vt.tiktok.com en ~1 seg sin desvíos)
        let playUrl = await queryTikwm(fullUrl);
        if (playUrl) return playUrl;

        // 2. Si no resolvió directo, resolver redirección manual
        try {
            const head = await fetch(fullUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                },
                timeout: 5000
            });
            const loc = head.headers.get('location');
            if (loc) {
                fullUrl = loc.startsWith('http') ? loc : new URL(loc, fullUrl).href;
                if (!fullUrl.includes('mall') && !fullUrl.includes('oec-api') && !fullUrl.includes('order_delivering')) {
                    playUrl = await queryTikwm(fullUrl);
                    if (playUrl) return playUrl;
                }
            }
        } catch(e) {}

        // Si es un enlace de compras/mall de TikTok y no un video, abortar
        if (fullUrl.includes('mall') || fullUrl.includes('oec-api') || fullUrl.includes('order_delivering')) {
            return null;
        }

        // 3. Fallback: TikTokio API con timeout estricto de 8s (para evitar bloqueos de minutos)
        try {
            const res1 = await fetch('https://backend1.tioo.eu.org/ttdl?url=' + encodeURIComponent(fullUrl), { timeout: 8000 });
            if (res1.ok) {
                const json1 = await res1.json();
                if (json1 && json1.status && json1.video && json1.video[0]) {
                    return json1.video[0];
                }
            }
        } catch(e1) {}

    } catch (e) {
        console.error("[!] Error en downloadTikTok:", e.message);
    }
    return null;
}

async function downloadTikTokMedia(url) {
    try {
        const fetch = require('node-fetch');
        const playUrl = await downloadTikTok(url);
        if (playUrl) {
            const videoRes = await fetch(playUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Referer': 'https://www.tiktok.com/',
                    'Accept': '*/*'
                },
                timeout: 30000
            });
            if (videoRes.ok || videoRes.status === 206) {
                const buffer = await videoRes.buffer();
                if (buffer && buffer.length >= 10000) {
                    return new MessageMedia('video/mp4', buffer.toString('base64'), 'tiktok.mp4', buffer.length);
                }
            }
        }
    } catch (e) {
        console.error("[!] Error en downloadTikTokMedia:", e.message);
    }
    return null;
}

// ---------------------------------------------------------
// MOTOR DE RESCATE VÍA API EXTERNA (FALLBACK PARA YT, IG, FB, TIKTOK)
// ---------------------------------------------------------
async function descargarViaApiRescue(videoUrl, plataforma) {
    const fetch = require('node-fetch');
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    try {
        let directUrl = null;
        let referer = 'https://www.google.com/';

        if (plataforma === 'TikTok') {
            return await downloadTikTokMedia(videoUrl);
        } else if (plataforma === 'YouTube') {
            try {
                const apiRes = await fetch('https://backend1.tioo.eu.org/youtube?url=' + encodeURIComponent(videoUrl), { timeout: 12000 });
                if (apiRes.ok) {
                    const data = await apiRes.json();
                    if (data && data.status && data.mp4) {
                        directUrl = data.mp4;
                        referer = 'https://ymcdn.org/';
                    }
                }
            } catch(eYt) {
                console.warn('[!] Error conectando a API YouTube rescue:', eYt.message);
            }
        } else if (plataforma === 'Instagram') {
            try {
                const apiRes = await fetch('https://backend1.tioo.eu.org/igdl?url=' + encodeURIComponent(videoUrl), { timeout: 12000 });
                if (apiRes.ok) {
                    const data = await apiRes.json();
                    if (Array.isArray(data) && data[0] && data[0].url) {
                        directUrl = data[0].url;
                        referer = 'https://www.instagram.com/';
                    }
                }
            } catch(eIg) {
                console.warn('[!] Error conectando a API Instagram rescue:', eIg.message);
            }
        } else if (plataforma === 'Facebook') {
            try {
                const apiRes = await fetch('https://backend1.tioo.eu.org/fbdown?url=' + encodeURIComponent(videoUrl), { timeout: 12000 });
                if (apiRes.ok) {
                    const data = await apiRes.json();
                    if (data && data.status && (data.Normal_video || data.HD)) {
                        directUrl = data.Normal_video || data.HD;
                        referer = 'https://www.facebook.com/';
                    }
                }
            } catch(eFb) {
                console.warn('[!] Error conectando a API Facebook rescue:', eFb.message);
            }
        }

        if (directUrl) {
            const mediaRes = await fetch(directUrl, {
                headers: {
                    'User-Agent': ua,
                    'Referer': referer,
                    'Accept': '*/*'
                },
                timeout: 45000
            });
            if (mediaRes.ok || mediaRes.status === 206) {
                const cl = parseInt(mediaRes.headers.get('content-length') || '0', 10);
                if (cl > 95 * 1024 * 1024) {
                    console.warn(`[!] Video de rescate para ${plataforma} excede 95 MB (${cl} bytes).`);
                    return null;
                }
                const buffer = await mediaRes.buffer();
                if (buffer && buffer.length >= 10000) {
                    const filename = `${plataforma.toLowerCase()}_${Date.now()}.mp4`;
                    return new MessageMedia('video/mp4', buffer.toString('base64'), filename, buffer.length);
                }
            }
        }
    } catch (e) {
        console.error(`[!] Error en descargarViaApiRescue para ${plataforma}:`, e.message);
    }
    return null;
}

// ---------------------------------------------------------
// MOTOR UNIFICADO DE DESCARGA DE VIDEOS (INSTAGRAM, FB, TIKTOK, YT)
// ---------------------------------------------------------
async function descargarYEnviarVideo(rawUrl, msg) {
    if (!rawUrl || !rawUrl.includes('http')) {
        return msg.reply(" *Por favor proporciona un enlace de video válido.*");
    }

    let videoUrl = rawUrl.trim();
    try {
        new URL(videoUrl);
    } catch (e) {
        return msg.reply(" *El enlace proporcionado no es válido.*");
    }

    const _isTikTok = videoUrl.includes('tiktok.com') || videoUrl.includes('vm.tiktok') || videoUrl.includes('vt.tiktok');
    const _isYouTube = videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be');
    const _isInstagram = videoUrl.includes('instagram.com') || videoUrl.includes('instagr.am');
    const _isFacebook = videoUrl.includes('facebook.com') || videoUrl.includes('fb.watch') || videoUrl.includes('fb.com');
    const _isTwitter = videoUrl.includes('twitter.com') || videoUrl.includes('x.com') || videoUrl.includes('t.co');

    // Limpieza de parámetros de rastreo
    if (_isInstagram) {
        videoUrl = videoUrl.replace(/\?.*$/, '');
        if (!videoUrl.endsWith('/')) videoUrl += '/';
    } else if (_isFacebook && !videoUrl.includes('/watch')) {
        videoUrl = videoUrl.replace(/\?.*$/, '');
    }

    let plataforma = 'Video';
    if (_isInstagram) plataforma = 'Instagram';
    else if (_isFacebook) plataforma = 'Facebook';
    else if (_isTikTok) plataforma = 'TikTok';
    else if (_isYouTube) plataforma = 'YouTube';
    else if (_isTwitter) plataforma = 'X (Twitter)';

    await msg.reply(` *Descargando video de ${plataforma}...*\n_Por favor espere un momento._`);

    const destChat = getRealChatId(msg) || (msg.fromMe ? msg.to : msg.from);
    const caption = ` *Video de ${plataforma}*`;

    // Helper de seguridad: garantiza que NINGÚN envío en Puppeteer se quede colgado
    const withTimeout = (promise, ms, desc) => {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${ms}ms) en ${desc}`)), ms))
        ]);
    };

    // Función auxiliar para envío seguro de MessageMedia
    let videoYaEnviado = false;
    const safeSendMedia = async (media, isDoc) => {
        if (videoYaEnviado) return true;
        const preferDoc = isTermux ? true : (isDoc || (media.filesize && media.filesize > 15 * 1024 * 1024));
        const targetChat = (msg.fromMe ? (msg.to && !msg.to.includes('broadcast') ? msg.to : msg.from) : (destChat || msg.from));
        
        const sizeBytes = media.filesize || (media.data ? media.data.length * 0.75 : 10 * 1024 * 1024);
        const sizeMB = sizeBytes / (1024 * 1024);
        const timeoutMs = Math.min(180000, Math.max(60000, Math.round(sizeMB * 4000)));

        console.log(`[safeSendMedia] Enviando video (${sizeMB.toFixed(1)} MB, doc: ${preferDoc}) a ${targetChat} con timeout de ${(timeoutMs/1000).toFixed(0)}s...`);

        try {
            const res = await withTimeout(
                client.sendMessage(targetChat, media, {
                    sendMediaAsDocument: preferDoc,
                    caption,
                    sendSeen: false,
                    quotedMessageId: msg.id ? msg.id._serialized : undefined
                }),
                timeoutMs,
                'client.sendMessage'
            );
            if (res) {
                videoYaEnviado = true;
                console.log('[safeSendMedia] Video enviado con �xito.');
                return true;
            }
        } catch (err) {
            console.warn('[!] safeSendMedia fallo:', err.message);
        }

        return videoYaEnviado;
    };

    // 1. Si es TikTok, intentar primero con API directa sin marca de agua (ultra rápida: ~1.5 seg)
    if (_isTikTok) {
        try {
            console.log('[descargarYEnviarVideo] Intentando descarga directa TikTok API...');
            const media = await downloadTikTokMedia(videoUrl);
            if (media) {
                const asDoc = isTermux || (media.filesize || 0) > 15 * 1024 * 1024;
                const sent = await safeSendMedia(media, asDoc);
                if (sent) return true;
            }
        } catch (eTk) {
            console.error('[!] API TikTok falló, pasando a yt-dlp:', eTk.message);
        }
    }

    // 2. Si es YouTube, intentar primero con API directa de alta velocidad (~2.5 seg)
    if (_isYouTube) {
        try {
            console.log('[descargarYEnviarVideo] Intentando descarga directa YouTube API...');
            const media = await descargarViaApiRescue(videoUrl, 'YouTube');
            if (media) {
                const asDoc = isTermux || (media.filesize || 0) > 15 * 1024 * 1024;
                const sent = await safeSendMedia(media, asDoc);
                if (sent) return true;
            }
        } catch (eYt) {
            console.error('[!] API directa YouTube falló, pasando a yt-dlp:', eYt.message);
        }
    }

    // 3. Descarga con yt-dlp usando argumentos optimizados para evitar bloqueos y exceso de tamaño
    const outputFile = path.join(__dirname, 'video_' + Date.now() + '.mp4');
    const uaDesktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const ffmpegDir = getFfmpegLocation();

    let _ytArgs = [
        '--no-check-certificates',
        '--no-warnings',
        '--no-playlist',
        '--socket-timeout', '15',
        '--no-cache-dir',
        '--user-agent', uaDesktop
    ];

    if (ffmpegDir) {
        _ytArgs.push('--ffmpeg-location', ffmpegDir);
    }

    const localCookies = path.join(__dirname, 'cookies.txt');
    const homeCookies = '/home/ubuntu/cookies.txt';
    const snapChromiumProfile = '/home/ubuntu/snap/chromium/common/chromium';
    if (fs.existsSync(localCookies)) {
        _ytArgs.push('--cookies', localCookies);
    } else if (fs.existsSync(homeCookies)) {
        _ytArgs.push('--cookies', homeCookies);
    } else if (fs.existsSync(snapChromiumProfile)) {
        _ytArgs.push('--cookies-from-browser', 'chromium:' + snapChromiumProfile);
    }

    if (_isYouTube) {
        _ytArgs.push(
            '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best',
            '-S', 'res:480,ext:mp4:m4a',
            '--merge-output-format', 'mp4',
            '-o', outputFile,
            videoUrl
        );
    } else if (_isInstagram) {
        _ytArgs.push('--add-header', 'Referer:https://www.instagram.com/', '-f', 'best[ext=mp4]/best', '-o', outputFile, videoUrl);
    } else if (_isFacebook) {
        _ytArgs.push('--add-header', 'Referer:https://www.facebook.com/', '-f', 'best[ext=mp4]/best', '-o', outputFile, videoUrl);
    } else if (_isTikTok) {
        _ytArgs.push('--add-header', 'Referer:https://www.tiktok.com/', '-f', 'best[ext=mp4]/best', '-o', outputFile, videoUrl);
    } else {
        _ytArgs.push('-f', 'best[ext=mp4]/best', '-o', outputFile, videoUrl);
    }

    return new Promise((resolve) => {
        let stderrData = '';
        let timer = null;
        let finished = false;

        const cleanupAndFinish = (val) => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            resolve(val);
        };

        const child = spawn(getYtDlpBinary(), _ytArgs, { shell: false });

        // Temporizador de seguridad: si yt-dlp tarda más de 40 segundos, matar proceso y usar Rescate API
        timer = setTimeout(() => {
            console.warn(`[!] yt-dlp excedió tiempo límite (40s) para ${plataforma}. Abortando...`);
            try { child.kill('SIGKILL'); } catch(e){}
        }, 120000);

        if (child.stderr) {
            child.stderr.on('data', (d) => { stderrData += d.toString(); });
        }

        const handleFallback = async () => {
            if (videoYaEnviado) return;
            if (fs.existsSync(outputFile)) {
                try { fs.unlinkSync(outputFile); } catch(e){}
            }
            try {
                const baseWithoutExt = outputFile.replace(/\.[^/.]+$/, "");
                const dir = path.dirname(outputFile);
                fs.readdirSync(dir).filter(f => path.join(dir, f).startsWith(baseWithoutExt)).forEach(f => {
                    try { fs.unlinkSync(path.join(dir, f)); } catch(e){}
                });
            } catch(e){}

            console.log(`[!] Iniciando Rescate API para ${plataforma}...`);
            const rescueMedia = await descargarViaApiRescue(videoUrl, plataforma);
            if (rescueMedia) {
                const asDoc = isTermux || (rescueMedia.filesize || 0) > 15 * 1024 * 1024;
                const sent = await safeSendMedia(rescueMedia, asDoc);
                if (sent) {
                    cleanupAndFinish(true);
                    return;
                }
            }
            console.error(`[ERROR DESCARGA] [${plataforma}] Falló yt-dlp y también la API de rescate para URL: ${videoUrl}`);
            await msg.reply(` *No se pudo descargar el video de ${plataforma}.*\n_Asegúrate de que la publicación sea pública, no requiera inicio de sesión y no supere los límites de tamaño (100 MB)._`).catch(()=>{});
            cleanupAndFinish(false);
        };

        child.on('error', async (err) => {
            console.error(`[ERROR yt-dlp] [${plataforma}] Error de proceso:`, err.message);
            await handleFallback();
        });

        child.on('close', async (code) => {
            let actualFile = outputFile;
            if (!fs.existsSync(actualFile)) {
                try {
                    const baseWithoutExt = outputFile.replace(/\.[^/.]+$/, "");
                    const dir = path.dirname(outputFile);
                    const candidates = fs.readdirSync(dir).filter(f => path.join(dir, f).startsWith(baseWithoutExt) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
                    if (candidates.length > 0) {
                        actualFile = path.join(dir, candidates[0]);
                    }
                } catch(e){}
            }

            let stats = null;
            if (fs.existsSync(actualFile)) {
                try { stats = fs.statSync(actualFile); } catch(e){}
            }

            // Si yt-dlp generó un archivo válido (mayor a 10 KB)
            if (code === 0 && stats && stats.size >= 10000) {
                const sizeMB = stats.size / (1024 * 1024);
                if (sizeMB > 95) {
                    try { fs.unlinkSync(actualFile); } catch(e){}
                    await msg.reply(` *El video excede el límite permitido para WhatsApp (${sizeMB.toFixed(1)} MB).*`).catch(()=>{});
                    cleanupAndFinish(false);
                    return;
                }

                try {
                    const media = MessageMedia.fromFilePath(actualFile);
                    media.filesize = stats.size;
                    const asDoc = isTermux || sizeMB > 15;
                    const sent = await safeSendMedia(media, asDoc);
                    if (sent) {
                        cleanupAndFinish(true);
                        return;
                    }
                } catch (err) {
                    console.error('[!] Error enviando video descargado por yt-dlp:', err);
                } finally {
                    if (fs.existsSync(actualFile)) {
                        try { fs.unlinkSync(actualFile); } catch(e){}
                    }
                    if (fs.existsSync(outputFile)) {
                        try { fs.unlinkSync(outputFile); } catch(e){}
                    }
                }
            }

            // Si yt-dlp falló o el archivo generado no es válido, ejecutar Rescate vía API
            if (stderrData && stderrData.trim()) {
                console.error(`[ERROR yt-dlp] [${plataforma}] Código ${code}:\n${stderrData.trim()}`);
            } else {
                console.warn(`[!] yt-dlp no completó con éxito para ${plataforma} (código ${code}). Pasando a Rescate API...`);
            }
            await handleFallback();
        });
    });
}

function obtenerFechaContexto() {
    const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const hoy = new Date();
    const utc = hoy.getTime() + (hoy.getTimezoneOffset() * 60000);
    const hoyES = new Date(utc + (3600000 * -6));
    const diaSemana = dias[hoyES.getDay()];
    const dia = hoyES.getDate();
    const mes = meses[hoyES.getMonth()];
    const anio = hoyES.getFullYear();
    const hora = String(hoyES.getHours()).padStart(2, '0');
    const minuto = String(hoyES.getMinutes()).padStart(2, '0');
    return `Fecha y hora actual del sistema (El Salvador, UTC-6): ${diaSemana}, ${dia} de ${mes} de ${anio}, ${hora}:${minuto}. Contexto temporal de base: El año actual es 2026, y el presidente actual de los Estados Unidos es Donald Trump (quien asumió el cargo el 20 de enero de 2025).`;
}

let MsEdgeTTSModule = null;
try {
    MsEdgeTTSModule = require('msedge-tts');
} catch (e) {
    console.warn("[TTS] msedge-tts no disponible directamente, se usarán fallbacks web.");
}

async function obtenerAudioBufferTTS(texto, genero = 'hombre') {
    const esHombre = !(/^(mujer|m|femenino|female)$/i.test(genero));

    // 1. Intentar Microsoft Edge Neural TTS (Máxima calidad de voz humana, 100% gratis)
    if (MsEdgeTTSModule && MsEdgeTTSModule.MsEdgeTTS) {
        try {
            const tts = new MsEdgeTTSModule.MsEdgeTTS();
            const vozPrincipal = esHombre ? 'es-SV-RodrigoNeural' : 'es-SV-LorenaNeural';
            await tts.setMetadata(vozPrincipal, MsEdgeTTSModule.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
            const { audioStream } = tts.toStream(texto);

            const buffer = await new Promise((resolve, reject) => {
                const chunks = [];
                const timeout = setTimeout(() => reject(new Error('Timeout Edge TTS')), 12000);
                audioStream.on('data', c => chunks.push(c));
                audioStream.on('end', () => {
                    clearTimeout(timeout);
                    resolve(Buffer.concat(chunks));
                });
                audioStream.on('error', err => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });

            if (buffer && buffer.length > 300) {
                return buffer;
            }
        } catch (e) {
            console.error("[TTS] Edge Neural TTS falló, intentando proveedor alternativo:", e.message);
        }
    }

    // 2. Intentar TikTok TTS (Voz masculina 'es_male_m3' o femenina 'es_002')
    try {
        const voiceId = esHombre ? 'es_male_m3' : 'es_002';
        const res = await fetch('https://tiktok-tts.weilnet.workers.dev/api/generation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: texto, voice: voiceId })
        });
        const data = await res.json();
        if (data.success && data.data) {
            return Buffer.from(data.data, 'base64');
        }
    } catch (e) {
        console.error("[TTS] TikTok TTS falló:", e.message);
    }

    // 3. Fallback: Google Translate TTS (Voz estándar)
    try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=es&client=tw-ob&q=${encodeURIComponent(texto)}`;
        const res = await fetch(url);
        if (res.ok) {
            const ab = await res.arrayBuffer();
            return Buffer.from(ab);
        }
    } catch (e) {
        console.error("[TTS] Google Translate TTS falló:", e.message);
    }

    return null;
}

async function generarAudioTTS(texto, msg, generoDeseado = null) {
    try {
        const genero = generoDeseado || vozDefault || 'hombre';
        const buffer = await obtenerAudioBufferTTS(texto, genero);
        if (buffer && buffer.length > 0) {
            const base64 = buffer.toString('base64');
            const media = new MessageMedia('audio/mpeg', base64, 'tts.mp3');
            await msg.reply(media, undefined, { sendAudioAsVoice: true });
            return true;
        }
    } catch (e) {
        console.error("Error en helper TTS:", e);
    }
    return false;
}

function limpiarRespuestaGemini(texto) {
    if (!texto) return "";
    let limpio = texto;
    
    // 1. Eliminar bloques <thought>...</thought>
    limpio = limpio.replace(/<thought>[\s\S]*?<\/thought>/gi, '');
    
    // 2. Eliminar bloques [SILENT] e internal monologue en inglés
    if (limpio.includes('[SILENT]') || limpio.includes('[silent]')) {
        const matchTransicion = limpio.match(/\[SILENT\][\s\S]*?[a-z]\.(?:[\r\n]+|(?=[A-Z\u00C0-\u00DC\u00f1\u00d1¡¿]))([A-Z\u00C0-\u00DC\u00f1\u00d1¡¿].*)/);
        if (matchTransicion && matchTransicion[1]) {
            limpio = matchTransicion[1];
        } else {
            limpio = limpio.replace(/\[SILENT\]:?\s*[^\n]*/gi, '');
        }
    }
    
    // 3. Eliminar prefijos residuales de SILENT
    limpio = limpio.replace(/\[SILENT\]:?\s*/gi, '');
    
    // 4. Limpieza final de tags de acción agentica sobrantes
    limpio = limpio
        .replace(/\[ACTION_IMAGE:[^\]]+\]/g, '')
        .replace(/\[ACTION_SEARCH:[^\]]+\]/g, '')
        .replace(/\[ACTION_NOTE_ADD:[^\]]+\]/g, '')
        .replace(/\[ACTION_NOTE_LIST\]/g, '')
        .replace(/\[ACTION_NOTE_DELETE:[^\]]+\]/g, '')
        .replace(/\[ACTION_MEMORY_SAVE:[^\]]+\]/g, '')
        .replace(/\[ACTION_MEMORY_DELETE:[^\]]+\]/g, '')
        .replace(/\[ACTION_MEMORY_LIST\]/g, '')
        .replace(/\[ACTION_YOUTUBE_CHECK(?::[^\]]+)?\]/g, '')
        .replace(/\[ACTION_SCHEDULE:[^\]]+\]/g, '')
        .replace(/\[ACTION_REMIND:[^\]]+\]/g, '')
        .replace(/\[ACTION_AUDIO:[^\]]+\]/g, '')
        .replace(/\[ACTION_ALARM_ADD:[^\]]+\]/g, '')
        .replace(/\[ACTION_ALARM_DELETE:[^\]]+\]/g, '')
        .replace(/\[ACTION_FINANCE_CARDS(?::[^\]]+)?\]/g, '')
        .replace(/\[ACTION_FINANCE_ALERTS\]/g, '')
        .replace(/\[ACTION_FINANCE_ADD:[^\]]+\]/g, '')
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .trim();
        
    return limpio;
}

// ---------------------------------------------------------
// FUNCIONES DE CONTROL DE FINANZAS (ESTADOS DE CUENTA Y TICKETS)
// ---------------------------------------------------------
async function procesarDocumentoFinanciero(media, msg) {
    if (!dbFirebase) inicializarFirebase();
    if (!dbFirebase || !firebaseUid) {
        return false; // Firebase no está configurado
    }

    try {
        const prompt = `Analiza este documento con sumo detalle. Puede ser:
1. Un Estado de Cuenta Bancario de tarjeta de crédito (Account Statement).
2. Un Comprobante de Abono, Pago de Tarjeta o Transferencia Bancaria (Payment Voucher).
3. Un Ticket, Factura o Recibo de compra/consumo (Purchase Receipt).
4. O un archivo no relacionado con finanzas.

Si es un ESTADO DE CUENTA (Account Statement) de tarjeta de crédito, responde en formato JSON:
{
    "is_financial": true,
    "doc_type": "statement",
    "pay_goal": number (Pago para no generar intereses / Pago de contado. ¡IGNORA el pago mínimo a menos que sea el único valor de pago!),
    "cutoff_balance": number (Saldo al corte / Deuda total del periodo),
    "pay_date": "YYYY-MM-DD" (Fecha límite de pago),
    "cutoff_date": "YYYY-MM-DD" (Fecha de corte),
    "last4": String "últimos 4 dígitos de la tarjeta (o null)",
    "card_name": String "Nombre de la tarjeta o banco emisor"
}

Si es un COMPROBANTE DE ABONO, PAGO DE TARJETA O TRANSFERENCIA BANCARIA (Payment Voucher / Pago de tarjeta), responde en formato JSON:
{
    "is_financial": true,
    "doc_type": "payment",
    "amount": number (monto abonado o pagado),
    "date": "YYYY-MM-DD" (fecha de la operación),
    "concept": String "Abono / Pago de Tarjeta...",
    "card_name": String "Nombre de la tarjeta o banco destino",
    "last4": String "últimos 4 dígitos de la tarjeta o cuenta destino (o null)",
    "reference": String "número de referencia o autorización (o null)"
}

Si es un TICKET/RECIBO/FACTURA de compra o consumo personal, responde en formato JSON:
{
    "is_financial": true,
    "doc_type": "expense",
    "amount": number (total pagado/importe),
    "date": "YYYY-MM-DD" (fecha de emisión),
    "concept": String "Establecimiento o Comercio",
    "category": "Categoría sugerida de la lista: Supermercado, Comida, Transporte, Hormiga, Servicios, Compras, Salud, Educación",
    "last4": String "últimos 4 dígitos de la tarjeta utilizada (o null si fue en efectivo)",
    "card_name": String "Nombre de la tarjeta o banco utilizado (o null)"
}

Si NO es un documento financiero (meme, foto común, documento general), responde:
{
    "is_financial": false
}

Responde ÚNICAMENTE con el objeto JSON limpio. Sin markdown ni texto adicional.`;

        const respuesta = await ejecutarGeminiConRetries(async (model) => {
            const result = await model.generateContent([
                prompt,
                { inlineData: { data: media.data, mimeType: media.mimetype } }
            ]);
            return result.response.text();
        });

        let cleanJSON = respuesta.replace(/```json|```/g, '').trim();
        const jsonMatch = respuesta.match(/\{[\s\S]*\}/);
        if (jsonMatch) cleanJSON = jsonMatch[0];
        
        let data;
        try {
            data = JSON.parse(cleanJSON);
        } catch (jsonErr) {
            console.error("[!] Error parseando JSON de Gemini:", respuesta);
            throw new Error("La IA no devolvió un formato estructurado legible.");
        }

        if (!data.is_financial) {
            return false; // No es un documento financiero, seguir el flujo normal
        }

        return await aplicarOperacionFinanciera(data, msg);
    } catch (e) {
        console.error("Error al procesar documento financiero:", e);
        await msg.reply(` *Asistente:* Ocurrió un error al procesar el documento: ${e.message}`);
        return true;
    }
}

// ---------------------------------------------------------
// PROCESADOR DE TEXTO FINANCIERO (CORREOS, NOTIFICACIONES BANCARIAS, SMS)
// ---------------------------------------------------------
async function procesarTextoFinanciero(texto, msg) {
    if (!dbFirebase) inicializarFirebase();
    if (!dbFirebase || !firebaseUid) return false;

    const tLower = texto.toLowerCase();
    const palabrasClave = [
        'pago', 'abono', 'transferencia', 'comprobante', 'recibo', 'factura', 'compra', 
        'tarjeta', 'saldo', 'deuda', 'corte', 'banco', 'bac', 'davivienda', 'agricola', 
        'promerica', 'fedecredito', 'siman', 'credisiman', 'chivo', 'recarga', 'consumo', 
        'autorizacion', 'voucher', 'transaccion', 'retiro', 'usd', '$'
    ];
    const tieneTerminos = palabrasClave.some(w => tLower.includes(w));
    if (!tieneTerminos) return false;

    try {
        const prompt = `Analiza el siguiente texto (puede ser una notificación de correo bancario, SMS, o confirmación de pago/transferencia/compra).
Texto a analizar:
"""
${texto}
"""

Determina con precisión si corresponde a:
1. Un COMPROBANTE DE ABONO, PAGO DE TARJETA O TRANSFERENCIA BANCARIA (Payment Voucher / Pago de tarjeta):
{
    "is_financial": true,
    "doc_type": "payment",
    "amount": number (monto abonado o pagado),
    "date": "YYYY-MM-DD" (fecha de la operación o null si no se especifica),
    "concept": String "Abono / Pago de Tarjeta...",
    "card_name": String "Nombre de la tarjeta o banco destino",
    "last4": String "últimos 4 dígitos de la tarjeta o cuenta destino (o null)",
    "reference": String "número de referencia o autorización (o null)"
}

2. Un ESTADO DE CUENTA de tarjeta de crédito:
{
    "is_financial": true,
    "doc_type": "statement",
    "pay_goal": number (pago de contado / para no generar intereses),
    "cutoff_balance": number (deuda al corte),
    "pay_date": "YYYY-MM-DD",
    "cutoff_date": "YYYY-MM-DD",
    "last4": String,
    "card_name": String
}

3. Un TICKET / RECIBO / FACTURA de compra o consumo personal:
{
    "is_financial": true,
    "doc_type": "expense",
    "amount": number,
    "date": "YYYY-MM-DD",
    "concept": String,
    "category": "Supermercado, Comida, Transporte, Hormiga, Servicios, Compras, Salud, Educación",
    "last4": String,
    "card_name": String
}

4. Si NO describe ninguna operación financiera real, responde:
{"is_financial": false}

Responde ÚNICAMENTE con el objeto JSON limpio.`;

        const respuesta = await ejecutarGeminiConRetries(async (model) => {
            const result = await model.generateContent([prompt]);
            return result.response.text();
        });

        let cleanJSON = respuesta.replace(/```json|```/g, '').trim();
        const jsonMatch = respuesta.match(/\{[\s\S]*\}/);
        if (jsonMatch) cleanJSON = jsonMatch[0];

        let data;
        try {
            data = JSON.parse(cleanJSON);
        } catch (e) {
            return false;
        }

        if (!data.is_financial) return false;

        return await aplicarOperacionFinanciera(data, msg);
    } catch (e) {
        console.error("Error al procesar texto financiero:", e);
        return false;
    }
}

// ---------------------------------------------------------
// MOTOR CENTRAL DE APLICACIÓN FINANCIERA EN FIRESTORE
// ---------------------------------------------------------
async function aplicarOperacionFinanciera(data, msg) {
    if (!dbFirebase) inicializarFirebase();
    if (!dbFirebase || !firebaseUid) return false;
    if (!data || !data.is_financial) return false;

    const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
    const cardsSnap = await cardsRef.get();

    // Helper para localizar tarjeta por last4 o nombre
    function buscarTarjeta(last4, cardName) {
        let encontrada = null;
        if (last4) {
            cardsSnap.forEach(doc => {
                const c = doc.data();
                if (c.last4 && String(c.last4).trim() === String(last4).trim()) {
                    encontrada = { id: doc.id, ...c };
                }
            });
        }
        if (!encontrada && cardName) {
            const q = cardName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            cardsSnap.forEach(doc => {
                const c = doc.data();
                const cName = (c.name || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                if (cName.includes(q) || q.includes(cName)) {
                    encontrada = { id: doc.id, ...c };
                }
            });
        }
        return encontrada;
    }

    // 1. ESTADO DE CUENTA
    if (data.doc_type === 'statement' || data.is_statement) {
        const matchingCard = buscarTarjeta(data.last4, data.card_name);

        if (!matchingCard) {
            await msg.reply(` *Estado de Cuenta Detectado:*
 *Tarjeta/Banco:* ${data.card_name || 'Desconocido'}
 *Terminación:* ${data.last4 || 'N/A'}
 *Pago p/no generar intereses:* $${parseFloat(data.pay_goal || 0).toFixed(2)}
 *Saldo al corte:* $${parseFloat(data.cutoff_balance || 0).toFixed(2)}
 *Fecha límite:* ${data.pay_date || 'N/A'}

 *Aviso:* No se encontró ninguna tarjeta en Firestore que coincida con "${data.last4 || ''}" o "${data.card_name || ''}". Regístrala en la PWA primero.`);
            return true;
        }

        let payDay = matchingCard.payDay;
        if (data.pay_date) {
            const parts = data.pay_date.split('-');
            if (parts.length === 3) payDay = String(parseInt(parts[2]));
        }

        let cutDay = matchingCard.cutDay;
        if (data.cutoff_date) {
            const parts = data.cutoff_date.split('-');
            if (parts.length === 3) cutDay = String(parseInt(parts[2]));
        }

        const updatePayload = {
            balance: parseFloat(data.cutoff_balance || 0),
            payGoal: parseFloat(data.pay_goal || 0)
        };
        if (payDay) updatePayload.payDay = payDay;
        if (cutDay) updatePayload.cutDay = cutDay;
        if (data.last4 && !matchingCard.last4) updatePayload.last4 = data.last4;

        await cardsRef.doc(matchingCard.id).update(updatePayload);

        let confirmMsg = ` *Estado de Cuenta Procesado*\n\n`;
        confirmMsg += `• *Tarjeta:* ${matchingCard.name}\n`;
        confirmMsg += `• *Pago de contado:* $${parseFloat(data.pay_goal || 0).toFixed(2)}\n`;
        confirmMsg += `• *Fecha límite:* ${data.pay_date || 'No especificada'} (Día ${payDay})\n`;
        confirmMsg += `• *Saldo al corte:* $${parseFloat(data.cutoff_balance || 0).toFixed(2)}\n\n`;
        confirmMsg += ` _Guardado exitosamente_`;

        await msg.reply(confirmMsg);
        return true;
    }

    // 2. COMPROBANTE DE ABONO O PAGO A TARJETA
    if (data.doc_type === 'payment') {
        const amt = parseFloat(data.amount || 0);
        if (isNaN(amt) || amt <= 0) {
            await msg.reply(` *Comprobante de Abono Detectado:* Monto inválido ($${data.amount}).`);
            return true;
        }

        const matchingCard = buscarTarjeta(data.last4, data.card_name);
        const batch = dbFirebase.batch();
        const expRef = dbFirebase.collection('users').doc(firebaseUid).collection('expenses').doc(Math.random().toString(36).slice(2));

        let cardIdVal = "";
        let cardNameVal = data.card_name || "Tarjeta de Crédito";
        let newBal = 0;

        if (matchingCard) {
            cardIdVal = matchingCard.id;
            cardNameVal = matchingCard.name;
            const oldBal = parseFloat(matchingCard.balance || 0);
            newBal = Math.max(0, oldBal - amt);
            batch.update(cardsRef.doc(matchingCard.id), { balance: newBal });
        }

        let tDate = new Date();
        if (data.date) {
            const parts = data.date.split('-');
            if (parts.length === 3) {
                tDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            }
        }

        const payload = {
            amount: amt,
            type: 'payment',
            cardId: cardIdVal,
            cardName: cardNameVal,
            concept: data.concept || `Abono a ${cardNameVal}`,
            category: ' Abono Capital',
            date: adminFirebase.firestore.Timestamp.fromDate(tDate)
        };
        if (data.reference) payload.reference = String(data.reference);

        batch.set(expRef, payload);
        await batch.commit();

        const fDia = String(tDate.getDate()).padStart(2, '0');
        const fMes = String(tDate.getMonth() + 1).padStart(2, '0');
        const fAnio = tDate.getFullYear();
        const fechaFormateada = `${fDia}/${fMes}/${fAnio}`;

        let confirmMsg = ` *Abono Procesado*\n\n`;
        confirmMsg += `• *Monto:* $${amt.toFixed(2)}\n`;
        confirmMsg += `• *Tarjeta:* ${cardNameVal}\n`;
        confirmMsg += `• *Fecha:* ${fechaFormateada}\n`;
        if (data.reference) confirmMsg += `• *Referencia:* ${data.reference}\n`;
        confirmMsg += `\n _Guardado exitosamente_`;

        await msg.reply(confirmMsg);
        return true;
    }

    // 3. TICKET O FACTURA DE COMPRA (GASTO)
    if (data.doc_type === 'expense' || !data.doc_type) {
        const amt = parseFloat(data.amount || 0);
        const concept = data.concept || 'Gasto registrado';
        const category = data.category || ' Compras';

        if (isNaN(amt) || amt <= 0) {
            await msg.reply(` *Ticket Detectado:* Importe no válido ($${data.amount}).`);
            return true;
        }

        const matchingCard = buscarTarjeta(data.last4, data.card_name);
        const batch = dbFirebase.batch();
        const expRef = dbFirebase.collection('users').doc(firebaseUid).collection('expenses').doc(Math.random().toString(36).slice(2));

        let cardIdVal = "";
        let cardNameVal = "Efectivo";
        let newBal = 0;

        if (matchingCard) {
            cardIdVal = matchingCard.id;
            cardNameVal = matchingCard.name;
            newBal = parseFloat(matchingCard.balance || 0) + amt;
            batch.update(cardsRef.doc(matchingCard.id), { balance: newBal });
        }

        let tDate = new Date();
        if (data.date) {
            const parts = data.date.split('-');
            if (parts.length === 3) {
                tDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            }
        }

        const payload = {
            amount: amt,
            type: 'expense',
            cardId: cardIdVal,
            cardName: cardNameVal,
            concept,
            category,
            date: adminFirebase.firestore.Timestamp.fromDate(tDate)
        };

        batch.set(expRef, payload);
        await batch.commit();

        const fDia = String(tDate.getDate()).padStart(2, '0');
        const fMes = String(tDate.getMonth() + 1).padStart(2, '0');
        const fAnio = tDate.getFullYear();
        const fechaFormateada = `${fDia}/${fMes}/${fAnio}`;

        let confirmMsg = ` *Compra Procesada*\n\n`;
        confirmMsg += `• *Monto:* $${amt.toFixed(2)}\n`;
        confirmMsg += `• *Concepto:* ${concept}\n`;
        confirmMsg += `• *Categoría:* ${category}\n`;
        confirmMsg += `• *Método:* ${cardNameVal}\n`;
        confirmMsg += `• *Fecha:* ${fechaFormateada}\n\n`;
        confirmMsg += ` _Guardado exitosamente_`;

        await msg.reply(confirmMsg);
        return true;
    }
    return false;
}

let verificandoVencimientosActualmente = false;
let ultimoTimestampVencimientos = 0;

async function chequearVencimientosYNotificar(force = false) {
    if (!dbFirebase) inicializarFirebase();
    if (!dbFirebase || !firebaseUid || !adminChatId) {
        console.log("[ℹ Finanzas] Alerta omitida: Firebase o Administrador no configurado.");
        return null;
    }

    if (verificandoVencimientosActualmente) {
        console.log("[ℹ Finanzas] Verificación de vencimientos ya en curso. Omitiendo llamada duplicada.");
        return null;
    }

    const ahoraMs = Date.now();
    if (!force && (ahoraMs - ultimoTimestampVencimientos < 120000)) {
        console.log("[ℹ Finanzas] Alerta de vencimientos ya ejecutada hace menos de 2 minutos. Omitiendo duplicado.");
        return null;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toDateString();

    if (!force && ultimoChequeoVencimientos === todayStr) {
        console.log("[ℹ Finanzas] Vencimientos ya verificados hoy. Saltando.");
        return null;
    }

    verificandoVencimientosActualmente = true;
    if (!force) {
        ultimoChequeoVencimientos = todayStr;
        ultimoTimestampVencimientos = ahoraMs;
        guardarAdminJson();
    }

    try {
        const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
        const cardsSnap = await cardsRef.get();
        if (cardsSnap.empty) {
            if (force) await client.sendMessage(adminChatId, "ℹ *Asistente:* No hay tarjetas de crédito registradas en Firestore.");
            return null;
        }

        const cards = [];
        cardsSnap.forEach(doc => {
            cards.push({ id: doc.id, ...doc.data() });
        });

        const fortyDaysAgo = new Date();
        fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);
        
        // Consulta sin índice compuesto para evitar errores en Firestore
        const transRef = dbFirebase.collection('users').doc(firebaseUid).collection('expenses');
        const transSnap = await transRef.where('type', '==', 'payment').get();

        const trans = [];
        transSnap.forEach(doc => {
            const t = doc.data();
            if (t.date) {
                const d = t.date.toDate ? t.date.toDate() : new Date(t.date);
                if (d >= fortyDaysAgo) {
                    trans.push({ ...t, date: d });
                }
            }
        });

        let alertMessages = [];

        cards.forEach(c => {
            const payDay = parseInt(c.payDay);
            const balance = parseFloat(c.balance || 0);
            const payGoal = parseFloat(c.payGoal || 0);

            if (isNaN(payDay) || (balance <= 0 && payGoal <= 0)) return;

            const targetAmount = payGoal > 0 ? payGoal : balance;

            // Calcular próxima fecha de pago (mes actual o siguiente mes si ya pasó en el corriente)
            const currentYear = today.getFullYear();
            const currentMonth = today.getMonth();
            const maxDaysCurrent = new Date(currentYear, currentMonth + 1, 0).getDate();
            let payDate = new Date(currentYear, currentMonth, Math.min(payDay, maxDaysCurrent));
            payDate.setHours(0, 0, 0, 0);

            if (payDate < today) {
                const nextMonth = currentMonth + 1;
                const maxDaysNext = new Date(currentYear, nextMonth + 1, 0).getDate();
                payDate = new Date(currentYear, nextMonth, Math.min(payDay, maxDaysNext));
                payDate.setHours(0, 0, 0, 0);
            }

            const diffDays = Math.round((payDate - today) / (1000 * 60 * 60 * 24));

            // Recordar únicamente justo antes de la fecha de pago (de 0 a 3 días de antelación)
            if (diffDays < 0 || diffDays > 3) return;

            // Calcular abonos desde el último corte
            const cutDay = parseInt(c.cutDay) || 1;
            let lastCutDate = new Date(currentYear, currentMonth, cutDay);
            if (today.getDate() < cutDay) {
                lastCutDate = new Date(currentYear, currentMonth - 1, cutDay);
            }

            const cardNameNorm = (c.name || '').toLowerCase().trim();
            const payments = trans.filter(t => {
                const matchesId = t.cardId && t.cardId === c.id;
                const cName = (t.cardName || '').toLowerCase().trim();
                const matchesName = cName && (cName.includes(cardNameNorm) || cardNameNorm.includes(cName));
                return (matchesId || matchesName) && t.date >= lastCutDate;
            });

            const totalPaid = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
            const remaining = Math.max(0, targetAmount - totalPaid);

            if (remaining <= 0) return; // Ya está pagada

            let cuandoTexto = '';
            if (diffDays === 0) cuandoTexto = 'Hoy';
            else if (diffDays === 1) cuandoTexto = 'Mañana';
            else cuandoTexto = `En ${diffDays} días`;

            const itemMsg = `• *${c.name}*\n  – Vence: ${cuandoTexto} (Día ${payDay})\n  – Pendiente: $${remaining.toFixed(2)}`;
            alertMessages.push(itemMsg);
        });

        if (alertMessages.length > 0) {
            const finalMsg = ` *Recordatorio de Pagos*\n\n` + alertMessages.join('\n\n');
            await client.sendMessage(adminChatId, finalMsg);
            return finalMsg;
        } else if (force) {
            const okMsg = " *Sin pagos pendientes próximos a vencer.*";
            await client.sendMessage(adminChatId, okMsg);
            return okMsg;
        }

        return null;
    } catch (e) {
        console.error("Error al chequear vencimientos de tarjetas:", e);
        if (force) await client.sendMessage(adminChatId, ` *Asistente:* Error en la verificación de vencimientos: ${e.message}`);
        return null;
    } finally {
        verificandoVencimientosActualmente = false;
    }
}

// ---------------------------------------------------------
// ESCUCHADOR EN TIEMPO REAL DE NOTIFICACIONES DESDE FIRESTORE (GMAIL / APPS SCRIPT -> WHATSAPP)
// ---------------------------------------------------------
let escuchadorNotificacionesIniciado = false;

function iniciarEscuchadorNotificacionesFirestore() {
    if (escuchadorNotificacionesIniciado) return;
    if (!dbFirebase) inicializarFirebase();
    if (!dbFirebase || !firebaseUid) return;

    escuchadorNotificacionesIniciado = true;
    console.log('[ Notificaciones] Iniciando escucha en tiempo real de alertas de Finanzas King en Firestore...');

    const notifRef = dbFirebase.collection('users').doc(firebaseUid).collection('bot_notifications');

    notifRef.where('processed', '==', false).onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
            if (change.type === 'added') {
                const docSnap = change.doc;
                const data = docSnap.data();
                const docId = docSnap.id;

                if (data.message && adminChatId && client) {
                    try {
                        console.log(`[ WhatsApp] Reenviando notificación de Firestore a WhatsApp: ${data.title || 'Alerta'}`);
                        await client.sendMessage(adminChatId, data.message);
                        await notifRef.doc(docId).update({
                            processed: true,
                            processedAt: new Date().toISOString()
                        });
                        console.log(`[ WhatsApp] Alerta enviada exitosamente a ${adminChatId} (${docId}).`);
                    } catch (errSend) {
                        console.error(`[ WhatsApp Error enviando notificación]:`, errSend.message);
                    }
                }
            }
        });
    }, err => {
        console.error('[ Error listener notificaciones Firestore]:', err.message);
        escuchadorNotificacionesIniciado = false;
    });
}

// ---------------------------------------------------------
// INTEGRACIÓN DEL BOT DE TELEGRAM (RECEPTOR Y ACTUALIZADOR DE FINANZAS)
// ---------------------------------------------------------
let telegramOffset = 0;
let telegramPollingActive = false;

async function enviarMensajeTelegram(chatId, texto) {
    if (!telegramBotToken || !chatId) return;
    try {
        const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: texto
            })
        });
    } catch (e) {
        console.error("[ Telegram Send Error]:", e.message);
    }
}

async function iniciarTelegramPolling() {
    if (!telegramBotToken) {
        console.log("[ℹ Telegram] Polling no iniciado: Falta telegramBotToken en admin.json. Usa !bot settelegram <token> para activarlo.");
        return;
    }
    if (telegramPollingActive) return;
    telegramPollingActive = true;

    try {
        const meRes = await fetch(`https://api.telegram.org/bot${telegramBotToken}/getMe`);
        if (meRes.ok) {
            const meData = await meRes.json();
            if (meData.ok) {
                console.log(`[ Telegram] Conectado exitosamente como @${meData.result.username} (${meData.result.first_name}). Escuchando documentos...`);
            }
        }
    } catch (errMe) {
        console.error("[ Telegram] Error verificando token de bot:", errMe.message);
    }

    const poll = async () => {
        if (!telegramBotToken) {
            telegramPollingActive = false;
            return;
        }
        try {
            const url = `https://api.telegram.org/bot${telegramBotToken}/getUpdates?offset=${telegramOffset}&timeout=30`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data.ok && data.result) {
                    for (const update of data.result) {
                        telegramOffset = update.update_id + 1;
                        if (update.message) {
                            await procesarMensajeTelegram(update.message);
                        }
                    }
                }
            } else {
                console.error("[ Telegram] Error HTTP en getUpdates:", response.status);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        } catch (e) {
            console.error("[ Telegram] Error en polling loop:", e.message);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        setTimeout(poll, 1000);
    };
    poll();
}

// Iniciar polling de Telegram al arranque si el token existe
if (telegramBotToken) {
    iniciarTelegramPolling();
}

async function procesarMensajeTelegram(msgTeg) {
    const tChatId = msgTeg.chat ? msgTeg.chat.id : null;

    // 1. Manejo de texto / comandos en Telegram
    if (msgTeg.text) {
        const txt = msgTeg.text.trim().toLowerCase();

        if (txt === '/start' || txt === '/ayuda' || txt === '/help') {
            const bienvenida = ` *Bienvenido a Asistente Finanzas*\n\n` +
                `Envíame directamente por aquí:\n` +
                ` *Estados de Cuenta* (PDF o foto)\n` +
                ` *Comprobantes de Abono o Transferencia* (PDF o foto)\n` +
                ` *Tickets o Facturas de Compra* (PDF o foto)\n\n` +
                `Y se actualizarán automáticamente en tu aplicación:\n` +
                ` https://finanzaskingapp.netlify.app/\n\n` +
                `*Comandos disponibles:*\n` +
                `• /tarjetas - Consulta deudas y límites de tus tarjetas\n` +
                `• /vencimientos - Alertas de pagos próximos\n` +
                `• /id - Ver tu Telegram Chat ID para automatizaciones`;
            await enviarMensajeTelegram(tChatId, bienvenida);
            return;
        }

        if (txt === '/id' || txt === '/chatid' || txt === '/myid') {
            await enviarMensajeTelegram(tChatId, `🆔 *Tu Telegram Chat ID es:*\n\`${tChatId}\`\n\n_(Copia este número para configurarlo en tu script de Gmail o automatizaciones)_`);
            return;
        }

        if (txt === '/tarjetas' || txt === '/finanzas') {
            if (!dbFirebase) inicializarFirebase();
            if (!dbFirebase || !firebaseUid) {
                await enviarMensajeTelegram(tChatId, " Firebase no está configurado aún en el bot.");
                return;
            }
            try {
                const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                const snapshot = await cardsRef.get();
                if (snapshot.empty) {
                    await enviarMensajeTelegram(tChatId, " No tienes tarjetas registradas en Finanzas King.");
                    return;
                }
                let tDebt = 0, tLimit = 0;
                let report = ` *ESTADO DE TARJETAS*\n\n`;
                snapshot.forEach(doc => {
                    const c = doc.data();
                    const debt = parseFloat(c.balance || 0);
                    const limit = parseFloat(c.limit || 0);
                    tDebt += debt; tLimit += limit;
                    const avail = limit > 0 ? (limit - debt) : 0;
                    report += ` *${c.name}* ${c.last4 ? `(••${c.last4})` : ''}\n`;
                    report += `    Deuda: $${debt.toFixed(2)} ${limit > 0 ? `/ Límite: $${limit.toFixed(2)}` : ''}\n`;
                    if (limit > 0) report += `    Disp: $${avail.toFixed(2)}\n`;
                    if (c.cutDay || c.payDay) report += `    Corte: ${c.cutDay || '?'} | Pago: ${c.payDay || '?'}\n`;
                    report += `\n`;
                });
                const ratio = tLimit > 0 ? (tDebt / tLimit) * 100 : 0;
                report += ` *Resumen Global:*\n Deuda Total: *$${tDebt.toFixed(2)}*\n Disponible Total: *$${(tLimit - tDebt).toFixed(2)}*\n Endeudamiento: *${ratio.toFixed(1)}%*`;
                await enviarMensajeTelegram(tChatId, report);
                return;
            } catch (e) {
                await enviarMensajeTelegram(tChatId, ` Error consultando tarjetas: ${e.message}`);
                return;
            }
        }

        if (txt === '/vencimientos' || txt === '/alertas') {
            try {
                const alertaStr = await chequearVencimientosYNotificar(true);
                await enviarMensajeTelegram(tChatId, alertaStr || " Excelente noticia. No hay pagos pendientes próximos a vencer.");
                return;
            } catch (e) {
                await enviarMensajeTelegram(tChatId, ` Error verificando vencimientos: ${e.message}`);
                return;
            }
        }

        // Si es un texto (notificación de banco, cuerpo de correo reenviado, comprobante en texto)
        if (txt.length > 15) {
            const replicaMsg = {
                reply: async (text) => {
                    if (tChatId) {
                        await enviarMensajeTelegram(tChatId, text);
                    }
                    if (adminChatId) {
                        try {
                            await client.sendMessage(adminChatId, ` *Telegram:*\n\n${text}`);
                        } catch (errWp) {}
                    }
                }
            };
            const procesado = await procesarTextoFinanciero(msgTeg.text, replicaMsg);
            if (procesado) return;
        }
    }

    // 2. Manejo de archivos (Documentos o Fotos)
    let fileId = null;
    let fileName = "archivo";
    let mimeType = "";

    if (msgTeg.document) {
        fileId = msgTeg.document.file_id;
        fileName = msgTeg.document.file_name || "documento.pdf";
        mimeType = msgTeg.document.mime_type || "application/pdf";
    } else if (msgTeg.photo && msgTeg.photo.length > 0) {
        const photo = msgTeg.photo[msgTeg.photo.length - 1];
        fileId = photo.file_id;
        fileName = "foto.jpg";
        mimeType = "image/jpeg";
    }

    if (!fileId) return;

    console.log(`[ Telegram] Documento recibido en Telegram: ${fileName}. Descargando y procesando...`);
    
    if (tChatId) {
        await enviarMensajeTelegram(tChatId, ` Recibí tu archivo: \`${fileName}\`.\n Analizándolo con IA para actualizar Finanzas King...`);
    }

    if (adminChatId) {
        try {
            await client.sendMessage(adminChatId, ` *Telegram Bot:* Se recibió un archivo en Telegram: \`${fileName}\`. Analizándolo para Finanzas King...`);
        } catch (errWp) {}
    }

    try {
        const fileUrl = `https://api.telegram.org/bot${telegramBotToken}/getFile?file_id=${fileId}`;
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) throw new Error("Fallo al consultar getFile de Telegram.");

        const fileData = await fileRes.json();
        if (!fileData.ok || !fileData.result.file_path) throw new Error("Telegram no devolvió la ruta del archivo.");

        const downloadUrl = `https://api.telegram.org/file/bot${telegramBotToken}/${fileData.result.file_path}`;
        const downloadRes = await fetch(downloadUrl);
        if (!downloadRes.ok) throw new Error("Fallo al descargar el archivo desde Telegram.");

        const buffer = await downloadRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const media = new MessageMedia(mimeType, base64, fileName);

        const replicaMsg = {
            reply: async (text) => {
                // 1. Responder directamente en el chat de Telegram
                if (tChatId) {
                    await enviarMensajeTelegram(tChatId, text);
                }
                // 2. Notificar a WhatsApp
                if (adminChatId) {
                    try {
                        await client.sendMessage(adminChatId, ` *Telegram:*\n\n${text}`);
                    } catch (errWp) {}
                }
            }
        };

        const procesado = await procesarDocumentoFinanciero(media, replicaMsg);
        if (!procesado) {
            const noFinMsg = ` El archivo \`${fileName}\` no contiene información financiera reconocible (estado de cuenta, comprobante de abono o ticket).`;
            if (tChatId) await enviarMensajeTelegram(tChatId, noFinMsg);
            if (adminChatId) {
                try { await client.sendMessage(adminChatId, ` *Telegram Bot:* ${noFinMsg}`); } catch (errWp) {}
            }
        }
    } catch (e) {
        console.error("[ Telegram] Error al procesar documento recibido:", e);
        const errMsg = ` Error al procesar archivo en Telegram: ${e.message}`;
        if (tChatId) await enviarMensajeTelegram(tChatId, errMsg);
        if (adminChatId) {
            try { await client.sendMessage(adminChatId, ` *Telegram Bot:* ${errMsg}`); } catch (errWp) {}
        }
    }
}

client.on('qr', (qr) => {
    console.log('\n[!] Escanea este código QR con tu WhatsApp para vincular el bot:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    isStartupSync = false;
    console.log('\n [OK] ¡ASISTENTE ACTIVO 24/7 Y LISTO PARA OPERAR!');
    iniciarTelegramPolling();
    iniciarEscuchadorNotificacionesFirestore();

    // Notificar al administrador si el reinicio fue solicitado mediante comando
    if (fs.existsSync('reinicio_pendiente.json')) {
        try {
            const rawData = fs.readFileSync('reinicio_pendiente.json', 'utf8');
            const data = JSON.parse(rawData);
            try { fs.unlinkSync('reinicio_pendiente.json'); } catch(e){}

            const targetChat = data.chatId || adminChatId || '50378419704@c.us';
            const seg = data.timestamp ? Math.round((Date.now() - data.timestamp) / 1000) : null;
            const tiempoTxt = seg ? ` en ${seg}s` : '';
            const confirmMsg = `*Asistente:* Secuencia de reinicio completada exitosamente${tiempoTxt}. Todos los subsistemas están activos y en línea.`;

            setTimeout(async () => {
                try {
                    await client.sendMessage(targetChat, confirmMsg);
                    console.log(`[REINICIO] Confirmación de reinicio enviada exitosamente a ${targetChat}`);
                } catch (errEnv) {
                    console.error('[REINICIO] Error enviando confirmación por WhatsApp:', errEnv.message);
                    if (targetChat !== '50378419704@c.us') {
                        try { await client.sendMessage('50378419704@c.us', confirmMsg); } catch(e){}
                    }
                }
            }, 2500);
        } catch (e) {
            console.error('[REINICIO] Error procesando reinicio_pendiente.json:', e);
        }
    }

    // --- VERIFICACI N DE DEPENDENCIAS PARA STICKERS ---
    const checkCmd = (cmd, label) => {
        return new Promise(resolve => {
            exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
                if (err) {
                    console.log(`[a Sticker] ${label}: R No instalado`);
                    resolve(false);
                } else {
                    const ver = (stdout || stderr || '').split('\n')[0].trim().substring(0, 60);
                    console.log(`[S& Sticker] ${label}: ${ver}`);
                    resolve(true);
                }
            });
        });
    };
    (async () => {
        console.log('\n--- Verificación de dependencias para .sticker ---');
        const hasFfmpeg = await checkCmd('ffmpeg -version', 'ffmpeg');
        const hasPython = await checkCmd('python3 --version', 'python3');
        if (!hasPython) await checkCmd('python --version', 'python (alt)');
        if (hasPython) {
            await checkCmd('python3 -c "import rembg; print(rembg.__version__)"', 'rembg');
            await checkCmd('python3 -c "import PIL; print(PIL.__version__)"', 'Pillow');
        }
        if (!hasFfmpeg) console.log('[a Sticker] Instala ffmpeg: pkg install ffmpeg');
        console.log('--- Fin verificación sticker ---\n');
    })();


    const verificarYouTube = async () => {
        if (!botGlobalmenteActivo || !canalesYoutube || canalesYoutube.length === 0) return;
        const defaultDest = adminChatId || (canalesYoutube.find(c => c.chatId)?.chatId);
        if (!defaultDest) return;

        const ahoraMs = Date.now();
        if (verificandoYouTubeActualmente || (ahoraMs - ultimoTimestampYouTube < 60000)) return;
        verificandoYouTubeActualmente = true;
        ultimoTimestampYouTube = ahoraMs;

        try {
            for (let i = 0; i < canalesYoutube.length; i++) {
                const canal = canalesYoutube[i];
                try {
                    const info = await obtenerUltimosVideosCanal(canal.id, 1);
                    if (info && info.videos && info.videos.length > 0) {
                        const videoNuevo = info.videos[0];
                        const dest = canal.chatId || defaultDest;

                        if (canal.ultimoVideo && canal.ultimoVideo !== videoNuevo.link && dest) {
                            const alerta = ` *¡Nuevo Video en ${info.canalNombre}!*\n\n*${videoNuevo.titulo}*\n${videoNuevo.link}\n\n_Escribe *!bot video ${videoNuevo.link}* si deseas descargarlo._`;
                            await client.sendMessage(dest, alerta);
                        }
                        if (canal.ultimoVideo !== videoNuevo.link) {
                            canal.ultimoVideo = videoNuevo.link;
                            canal.nombre = info.canalNombre;
                            guardarCanales();
                        }
                    }
                } catch (e) {
                    console.error(`Error en YouTube para canal ${canal.id}:`, e.message);
                }
            }
        } finally {
            verificandoYouTubeActualmente = false;
        }
    };

    // Función ejecutora de tareas programadas (con doble debounce anti-duplicado por Destino y Horario)
    async function ejecutarAccionProgramada(tarea) {
        const destChat = normalizarDestinoChat(tarea.chatId) || adminChatId;
        if (!destChat) {
            console.error("[ CRON] Error: No hay chatId registrado para enviar la tarea programada:", tarea.descripcion || tarea.accion);
            return;
        }

        const accion = (tarea.accion || tarea.prompt || tarea.descripcion || "").trim();
        const cronExpr = tarea.cron || horaToCron(tarea.hora) || tarea.hora || "0 8 * * *";
        const ahoraMs = Date.now();

        // 1. Candado estricto por destino y horario: un mismo chat nunca debe recibir más de 1 envío en el mismo minuto
        const claveDestHora = `dest_${destChat}_hora_${cronExpr}`;
        const ultEjecDestHora = ejecucionesRecientesTareas.get(claveDestHora);
        if (ultEjecDestHora && (ahoraMs - ultEjecDestHora < 90000)) {
            console.log(`[ CRON] Descartando ejecución repetida para destino ${destChat} en horario ${cronExpr} (${Math.round((ahoraMs - ultEjecDestHora) / 1000)}s desde la anterior)`);
            return;
        }

        // 2. Candado por acción específica
        const accionClave = accion.toLowerCase().replace(/\s+/g, '_').substring(0, 40);
        const claveAccion = `dest_${destChat}_act_${accionClave}`;
        const ultEjecAccion = ejecucionesRecientesTareas.get(claveAccion);
        if (ultEjecAccion && (ahoraMs - ultEjecAccion < 90000)) {
            console.log(`[ CRON] Descartando ejecución repetida para destino ${destChat} con acción "${accion}" (${Math.round((ahoraMs - ultEjecAccion) / 1000)}s)`);
            return;
        }

        ejecucionesRecientesTareas.set(claveDestHora, ahoraMs);
        ejecucionesRecientesTareas.set(claveAccion, ahoraMs);

        const horaLabel = tarea.hora ? ` (${tarea.hora})` : '';
        console.log(`[ CRON] Disparando tarea programada única: "${accion}" para ${destChat}`);

        // Si es un comando de Asistente (!bot ...)
        if (accion.toLowerCase().startsWith('!bot ') || accion.toLowerCase().startsWith('.')) {
            try {
                const fakeMsg = {
                    body: accion,
                    from: destChat,
                    to: destChat,
                    fromMe: false,
                    hasMedia: false,
                    timestamp: Math.floor(Date.now() / 1000),
                    getChat: async () => ({ id: { _serialized: destChat }, isGroup: destChat.endsWith('@g.us'), sendStateTyping: async () => {}, fetchMessages: async () => [] }),
                    getContact: async () => ({ number: "User", pushname: "Usuario" }),
                    reply: async (txt, ch, opts) => await client.sendMessage(destChat, txt, opts || {}),
                    downloadMedia: async () => null
                };
                client.emit('message_create', fakeMsg);
                return;
            } catch (err) {
                console.error("[CRON Command Error]:", err.message);
            }
        }

        // Si es una petición para la IA (frases motivacionales, noticias, resúmenes, etc.)
        try {
            const respuestaAI = await ejecutarGeminiConRetries(async (model) => {
                const prompt = `Eres el asistente personal de Geovanny Pacheco.
Tarea automática programada: "${accion}".
Genera la información solicitada de forma directa, precisa y concisa.
REGLAS ESTRICTAS:
- ABSOLUTAMENTE CERO EMOJIS. Queda estrictamente prohibido incluir cualquier tipo de emoji en tu respuesta.
- CERO drama, CERO relleno, CERO rodeos o introducciones ("Aquí tienes...", "Buenos días...").
- Da única y exclusivamente la información necesaria y requerida.
- Responde DIRECTAMENTE con el contenido final en español.`;
                const result = await model.generateContent(prompt);
                return result.response.text();
            });

            if (respuestaAI && respuestaAI.trim()) {
                await client.sendMessage(destChat, `*Tarea Programada${horaLabel}:*\n\n${limpiarRespuestaGemini(respuestaAI)}`);
            }
        } catch (e) {
            console.error("[CRON AI Error]:", e.message);
            try {
                await client.sendMessage(destChat, `*Tarea Programada${horaLabel}:*\nRecordatorio: ${accion}`);
            } catch (e2) {}
        }
    }
    
    // Inicializar Tareas Programadas con Timezone de El Salvador y depuración inteligente de duplicados
    global.inicializarTareas = () => {
        if (global.activeCronJobs && global.activeCronJobs.size > 0) {
            for (const [idx, job] of global.activeCronJobs.entries()) {
                try {
                    if (job && typeof job.stop === 'function') job.stop();
                } catch(e) {}
            }
            global.activeCronJobs.clear();
        }

        // Deduplicar array de tareas programadas en memoria y persistencia
        // Regla: Para un mismo destino (grupo o número propio), no debe existir más de una tarea para el mismo horario exacto
        const tareasUnicas = [];
        const vistasHorariosChat = new Map();

        tareasProgramadas.forEach(t => {
            const destNorm = normalizarDestinoChat(t.chatId);
            const cronExpr = t.cron || horaToCron(t.hora);
            const horaNorm = (t.hora || cronExpr || '').trim().toLowerCase();

            // Clave única por destino + horario
            const keyHorario = `${destNorm}__${cronExpr || horaNorm}`;

            if (!vistasHorariosChat.has(keyHorario)) {
                vistasHorariosChat.set(keyHorario, t);
                tareasUnicas.push(t);
            } else {
                const tareaExistente = vistasHorariosChat.get(keyHorario);
                console.log(`[ CRON] Depurada tarea duplicada para ${destNorm} en horario ${horaNorm}: "${t.descripcion || t.accion}" vs "${tareaExistente.descripcion || tareaExistente.accion}"`);
            }
        });

        if (tareasUnicas.length !== tareasProgramadas.length) {
            console.log(`[ CRON] Se eliminaron ${tareasProgramadas.length - tareasUnicas.length} tareas programadas duplicadas/redundantes.`);
            tareasProgramadas = tareasUnicas;
            guardarTareasProgramadas();
        }

        tareasProgramadas.forEach((tarea, index) => {
            try {
                const cronExpr = tarea.cron || horaToCron(tarea.hora);
                if (!cronExpr) {
                    console.error(`[CRON] Expresión cron no válida para tarea ${index}:`, tarea);
                    return;
                }

                const job = cron.schedule(cronExpr, async () => {
                    if (!botGlobalmenteActivo) return;
                    await ejecutarAccionProgramada(tarea);

                    if (tarea.recurrente === false) {
                        const removeIdx = tareasProgramadas.indexOf(tarea);
                        if (removeIdx !== -1) {
                            tareasProgramadas.splice(removeIdx, 1);
                            guardarTareasProgramadas();
                            global.inicializarTareas();
                        }
                    }
                }, { scheduled: true, timezone: "America/El_Salvador" });

                global.activeCronJobs.set(index, job);
                console.log(`[ CRON] Tarea [${index + 1}] activa: "${tarea.descripcion || tarea.accion}" -> Cron [${cronExpr}] (Zona: El Salvador)`);
            } catch (e) {
                console.error("Error al programar cron para tarea " + index, e);
            }
        });
    };

    function iniciarServiciosCron() {
        if (cronsGlobalesIniciados) {
            console.log('[CRON] Servicios programados ya inicializados previamente. Omitiendo duplicados.');
            return;
        }
        cronsGlobalesIniciados = true;
        console.log('[CRON] Inicializando servicios programados (instancia única)...');

        // 1. Inicializar tareas programadas
        global.inicializarTareas();

        // 2. Verificar novedades de YouTube cada 30 minutos
        cron.schedule('*/30 * * * *', verificarYouTube);

        // 3. Resetear cuotas de API keys todos los días a la medianoche
        cron.schedule('0 0 * * *', () => {
            API_KEYS.forEach((key, idx) => {
                if (keyStatus[idx]) {
                    keyStatus[idx].status = 'Activa';
                    keyStatus[idx].requestsToday = 0;
                }
            });
            guardarKeysYCuotas();
            console.log('[NODE-CRON] Cuotas diarias de Gemini reiniciadas a la medianoche.');
        });

        // 4. Cron para alarmas persistentes (verificación cada 10 segundos)
        cron.schedule('*/10 * * * * *', async () => {
            if (!botGlobalmenteActivo || alarmasGuardadas.length === 0) return;
            
            const hoy = new Date();
            const ahora = Date.now();
            const horaStr = getHoraElSalvador(hoy);
            const fechaStr = getFechaElSalvador(hoy);
            const fechaHoraActual = fechaStr + ' ' + horaStr;
            
            const alarmasAEliminar = [];
            for (let i = 0; i < alarmasGuardadas.length; i++) {
                const alarma = alarmasGuardadas[i];
                const horaAlarmaNorm = normalizarHora(alarma.hora);
                
                let debeDisparar = false;

                if (alarma.recurrente) {
                    if (horaAlarmaNorm === horaStr && alarma.ultimoDisparo !== fechaHoraActual) {
                        debeDisparar = true;
                    }
                } else {
                    if (alarma.timestampObjetivo) {
                        if (ahora >= alarma.timestampObjetivo) {
                            debeDisparar = true;
                        }
                    } else if (alarma.fecha === fechaStr) {
                        if (horaAlarmaNorm <= horaStr && alarma.ultimoDisparo !== fechaHoraActual) {
                            debeDisparar = true;
                        }
                    } else {
                        const parseDate = (dStr) => {
                            if (!dStr) return new Date(0);
                            const parts = dStr.split('/');
                            if (parts.length === 3) return new Date(parts[2], parts[1]-1, parts[0]);
                            return new Date(0);
                        };
                        const fAlarma = parseDate(alarma.fecha);
                        const fHoy = parseDate(fechaStr);
                        if (fAlarma < fHoy) {
                            alarmasAEliminar.push(i);
                            continue;
                        }
                    }
                }

                if (debeDisparar) {
                    alarma.ultimoDisparo = fechaHoraActual;
                    guardarAlarmas();
                    
                    const dest = alarma.chatId || adminChatId;
                    if (dest) {
                        try {
                            const tit = alarma.hora ? `*Alarma (${alarma.hora}):*` : `*Alarma:*`;
                            await client.sendMessage(dest, `${tit}\n${alarma.mensaje}`);
                        } catch (e) {
                            console.error("Error enviando alarma:", e.message);
                        }
                    }

                    if (!alarma.recurrente) {
                        alarmasAEliminar.push(i);
                    }
                }
            }

            if (alarmasAEliminar.length > 0) {
                for (let j = alarmasAEliminar.length - 1; j >= 0; j--) {
                    alarmasGuardadas.splice(alarmasAEliminar[j], 1);
                }
                guardarAlarmas();
            }
        }, { timezone: "America/El_Salvador" });

        // 5. Verificación diaria de vencimientos de tarjetas a las 9:00 AM
        cron.schedule('0 9 * * *', async () => {
            console.log("[] Ejecutando verificación diaria de vencimientos de tarjetas (09:00 AM)...");
            await chequearVencimientosYNotificar(false);
        }, { scheduled: true, timezone: "America/El_Salvador" });

        // Verificación única al arranque tras delay de 12 segundos
        setTimeout(async () => {
            console.log("[] Verificación de vencimientos al arranque...");
            await chequearVencimientosYNotificar(false);
        }, 12000);
    }

    iniciarServiciosCron();
});

client.on('disconnected', (reason) => {
    console.log('\n[!] WhatsApp Web se desconectó. Razón:', reason);
    console.log('[!] Saliendo para que el Watchdog de start.sh reinicie y reconecte...');
    process.exit(1);
});

client.on('auth_failure', (msg) => {
    console.error('\n[!] Error de autenticación en WhatsApp Web:', msg);
    process.exit(1);
});

client.on('message_create', async (msg) => {
    // Si el mensaje es saliente (enviado por el propio bot / msg.fromMe === true):
    if (msg.fromMe) {
        const isSelfChat = msg.to && msg.from && (
            msg.to === msg.from || 
            msg.to.replace(/@.*$/, '') === msg.from.replace(/@.*$/, '')
        );
        // Si el mensaje fue enviado por el bot a un contacto (como Geovanny) o grupo, NUNCA procesarlo (evita bucles)
        if (!isSelfChat) return;

        const bodyStr = msg.body || "";
        const lowerBody = bodyStr.toLowerCase();
        const isCommand = lowerBody.startsWith('!bot') || lowerBody.startsWith('.s') || lowerBody.startsWith('.sticker') || lowerBody.startsWith('!iniciarbot') || lowerBody.startsWith('!finalizarbot');
        
        // En auto-chat s�lo procesar si es un comando expl�cito
        if (!isCommand) return;

        if (bodyStr && (
            bodyStr.includes('Asistente - Tarea Programada') || 
            bodyStr.includes('Asistente (Aviso Programado') ||
            bodyStr.startsWith(' *ALARMA') ||
            bodyStr.includes('RECORDATORIO!') ||
            bodyStr.includes('NOTIFICACI�N DE ASISTENTE:') ||
            bodyStr.startsWith(' *Asistente') ||
            bodyStr.startsWith(' *Modo conversacional') ||
            bodyStr.startsWith(' *�Tarea Programada')
        )) {
            return;
        }
    }
    const originalReply = msg.reply.bind(msg);
    msg.reply = async (...args) => {
        try {
            const res = await Promise.race([
                originalReply(...args),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout en originalReply (25s)')), 25000))
            ]);
            if (res) return res;
        } catch (e) {
            console.error("[msg.reply fallback] Error:", e.message);
        }
        try {
            const dest = (msg.fromMe ? (msg.to && !msg.to.includes('broadcast') ? msg.to : msg.from) : getRealChatId(msg)) || (msg.fromMe ? msg.to : msg.from);
            if (dest && !dest.includes('broadcast')) {
                return await Promise.race([
                    client.sendMessage(dest, args[0], args[2] || {}),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout en client.sendMessage fallback (20s)')), 20000))
                ]);
            }
        } catch(e2) {
            console.error("[msg.reply fallback] Falló:", e2.message);
        }
        return { fake: true };
    };
    if (isStartupSync) return;
    if (msg.timestamp < botStartTime - 60) return;
    const chatId = getRealChatId(msg) || (msg.fromMe ? msg.to : msg.from) || '';
    const isGroup = chatId.endsWith('@g.us');
    if (!isGroup && esAdmin(chatId, msg)) {
        if (adminChatId !== chatId) {
            console.log(`[Admin] Sincronizando adminChatId activo: ${adminChatId} -> ${chatId}`);
            adminChatId = chatId;
            guardarAdminJson();
        }
    }
    let textoOriginal = (msg.body || "").trim();
    const lowerBody = textoOriginal.toLowerCase();

    // --- COMANDOS DE YT Y KEYS ---
    if (lowerBody.startsWith('!bot keys') || lowerBody.startsWith('!bot claves')) {
        sincronizarLlavesDesdeArchivo();
        let reply = ` *Estado de las API Keys (Gemini)*\nModelo activo: *${MODELS[currentModelIndex]}*\n\n`;
        API_KEYS.forEach((key, idx) => {
            const status = keyStatus[idx] || { status: 'Desconocido', requestsToday: 0 };
            const isCurrent = idx === currentKeyIndex ? ' (Actual)' : '';
            reply += `[${idx + 1}] ${key.substring(0, 8)}... ${isCurrent}\nEstado: ${status.status} | Peticiones hoy: ${status.requestsToday}\n\n`;
        });
        reply += "_Usa *!bot addkey <clave>* para agregar o reactivar una llave._\n_Usa *!bot resetkeys* para reactivar todas las llaves._";
        await msg.reply(reply);
        return;
    }

    if (lowerBody.startsWith('!bot resetkeys') || lowerBody.startsWith('!bot restaurarclaves')) {
        API_KEYS.forEach((key, idx) => {
            if (keyStatus[idx]) {
                keyStatus[idx].status = 'Activa';
                keyStatus[idx].requestsToday = 0;
            }
        });
        currentKeyIndex = 0;
        currentModelIndex = 0;
        guardarKeysYCuotas();
        await msg.reply(` Todas las API Keys (${API_KEYS.length}) han sido restablecidas a *Activa*.`);
        return;
    }

    if (lowerBody.startsWith('!bot addkey')) {
        sincronizarLlavesDesdeArchivo();
        let newKey = textoOriginal.substring('!bot addkey'.length).trim();
        if (newKey.startsWith(':')) {
            newKey = newKey.substring(1).trim();
        }
        if (newKey.length < 20 || (!newKey.startsWith('AIzaSy') && !newKey.startsWith('AQ.'))) {
            await msg.reply(" Inválido. Usa: !bot addkey <TU_API_KEY>");
            return;
        }
        const existingIdx = API_KEYS.indexOf(newKey);
        if (existingIdx !== -1) {
            keyStatus[existingIdx] = { status: 'Activa', requestsToday: 0, lastRequest: new Date().toISOString() };
            currentKeyIndex = existingIdx;
            currentModelIndex = 0;
            guardarKeysYCuotas();
            await msg.reply(` La API Key ya estaba registrada y ha sido *reactivada* con éxito como clave actual (Clave #${existingIdx + 1}).`);
            return;
        }
        API_KEYS.push(newKey);
        keyStatus.push({ status: 'Activa', requestsToday: 0, lastRequest: null });
        currentKeyIndex = API_KEYS.length - 1;
        currentModelIndex = 0;
        guardarKeysYCuotas();
        await msg.reply(` API Key agregada, activada y guardada automáticamente en tu bloc de notas ("llaves API gemini.txt"). Ahora tienes ${API_KEYS.length} llaves.`);
        return;
    }

    if (lowerBody.startsWith('!bot ytadd')) {
        const url = textoOriginal.substring('!bot ytadd'.length).trim();
        if (!url) {
            await msg.reply(" Usa: !bot ytadd <enlace, @handle o nombre del canal>");
            return;
        }
        await msg.reply(" Buscando canal en YouTube...");
        const id = await obtenerIdCanal(url);
        if (!id) {
            await msg.reply(" No pude encontrar el canal. Asegúrate de enviar un enlace válido, @usuario o nombre.");
            return;
        }
        if (canalesYoutube.find(c => c.id === id)) {
            await msg.reply(" Ese canal ya está en la lista de monitoreo.");
            return;
        }
        const info = await obtenerUltimosVideosCanal(id, 1);
        const canalNombre = info?.canalNombre || 'Canal Nuevo';
        const ultimoVid = info?.videos?.[0]?.link || '';
        canalesYoutube.push({ id: id, nombre: canalNombre, ultimoVideo: ultimoVid, chatId: chatId });
        guardarCanales();
        let resp = ` ¡Canal agregado exitosamente al monitoreo!\n *${canalNombre}* (\`${id}\`)`;
        if (info?.videos?.[0]) {
            resp += `\n\n *Último video:* ${info.videos[0].titulo}\n ${info.videos[0].link}`;
        }
        await msg.reply(resp);
        return;
    }

    if (lowerBody.startsWith('!bot ytlist')) {
        if (canalesYoutube.length === 0) {
            await msg.reply(" No hay canales de YouTube en monitoreo.");
            return;
        }
        let reply = " *Canales de YouTube en Monitoreo:*\n\n";
        canalesYoutube.forEach((c, idx) => {
            const ult = c.ultimoVideo ? `\n    ${c.ultimoVideo}` : '';
            reply += `*${idx + 1}.* ${c.nombre}\n(ID: \`${c.id}\`)${ult}\n\n`;
        });
        reply += "_Para ver videos escribe: *!bot videos*_\n_Para eliminar uno usa: *!bot ytdel <numero>*_";
        await msg.reply(reply);
        return;
    }

    if (lowerBody.startsWith('!bot ytdel')) {
        const num = parseInt(textoOriginal.substring('!bot ytdel'.length).trim());
        if (isNaN(num) || num < 1 || num > canalesYoutube.length) {
            await msg.reply(" Inválido. Usa: !bot ytdel <numero>");
            return;
        }
        const borrado = canalesYoutube.splice(num - 1, 1)[0];
        guardarCanales();
        await msg.reply(` Canal eliminado: ${borrado.nombre}`);
        return;
    }

    // --- HOOK DE UBICACIN PARA CLIMA ---
    if (msg.type === 'location' && msg.location) {
        textoOriginal = `!bot clima ${msg.location.latitude},${msg.location.longitude}`;
        console.log('[x Ubicación recibida] Convirtiendo a comando de clima:', textoOriginal);
    }

    // --- HOOK DE TRANSCRIPCIN AUTOMÁTICA DE VOZ (Speech-To-Text) ---
    if (msg.hasMedia && msg.type === 'ptt') {
        const isVoiceNote = msg.type === 'ptt';
        const isConversational = chatsActivos.has(chatId);
        if (isVoiceNote && (isConversational || !isGroup)) {
            try {
                const media = await descargarMediaSeguro(msg);
                if (media && media.data) {
                    console.log("[STT Hook] Transcribiendo nota de voz con Gemini...");
                    const modelActivo = obtenerModel();
                    const promptTrans = "Transcribe el siguiente audio exactamente en español. Responde únicamente con el texto transcrito, sin notas de introducción ni metadatos.";
                    const result = await modelActivo.generateContent([
                        promptTrans,
                        { inlineData: { data: media.data, mimeType: media.mimetype } }
                    ]);
                    const voiceTranscript = result.response.text().trim();
                    console.log(`[STT Hook Result]: ${voiceTranscript}`);
                    if (voiceTranscript) {
                        await msg.reply(`x *Kinbot (Transcripción):*\n_"${voiceTranscript}"_`);
                        textoOriginal = voiceTranscript;
                    }
                }
            } catch (e) {
                console.error("Error transcribiendo nota de voz en hook:", e);
            }
        }
    }


    // --- HOOK DE TRANSCRIPCIN MANUAL A PETICIN ---
    if (textoOriginal.toLowerCase().includes('transcribe')) {
        let mediaATranscribir = null;
        if (msg.hasMedia) {
            mediaATranscribir = msg;
        } else if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.hasMedia) {
                mediaATranscribir = quotedMsg;
            }
        } else {
            // Fallback: get previous message
            const chat = await msg.getChat();
            const historial = await chat.fetchMessages({ limit: 2 });
            if (historial[0] && historial[0].hasMedia) {
                mediaATranscribir = historial[0];
            }
        }
        
        if (mediaATranscribir) {
            try {
                const media = await descargarMediaSeguro(mediaATranscribir);
                if (media && media.data) {
                    console.log("[x STT Hook Manual] Transcribiendo archivo solicitado...");
                    await msg.reply(' *Asistente:* Procesando el audio para su transcripción...');
                    const modelActivo = obtenerModel();
                    const promptTrans = "Transcribe el siguiente audio o video exactamente en español. Responde únicamente con el texto transcrito, sin notas de introducción ni metadatos.";
                    const result = await modelActivo.generateContent([
                        promptTrans,
                        { inlineData: { data: media.data, mimeType: media.mimetype } }
                    ]);
                    const voiceTranscript = result.response.text().trim();
                    if (voiceTranscript) {
                        return msg.reply(`x *Asistente (Transcripción Manual):*\n\n_"${voiceTranscript}"_`);
                    }
                }
            } catch (e) {
                console.error("Error transcribiendo audio manual:", e);
                return msg.reply(' *Asistente:* Lo siento Señor, mis sistemas fallaron al procesar este archivo. Asegúrese de que sea un formato de audio/video válido.');
            }
        }
    }

    // --- HOOK DE CREACIN DE STICKERS (.sticker) ---
    const isStickerCmd = textoOriginal.toLowerCase() === '.sticker' || textoOriginal.toLowerCase() === '.s' || 
                         textoOriginal.toLowerCase().startsWith('.sticker ') || textoOriginal.toLowerCase().startsWith('.s ');

    if (isStickerCmd) {
        let mediaMsg = null;
        let urlDescargar = null;

        const urlMatch = textoOriginal.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
            urlDescargar = urlMatch[1];
        } else if (msg.hasMedia) {
            mediaMsg = msg;
        } else if (msg.hasQuotedMsg) {
            try {
                const quoted = await msg.getQuotedMessage();
                if (quoted && quoted.hasMedia) {
                    mediaMsg = quoted;
                } else if (quoted && quoted.body) {
                    const quotedUrlMatch = quoted.body.match(/(https?:\/\/[^\s]+)/);
                    if (quotedUrlMatch) urlDescargar = quotedUrlMatch[1];
                }
            } catch (e) {
                console.error('[Sticker] Error obteniendo mensaje citado:', e.message);
            }
        }

        if (!mediaMsg && !urlDescargar) {
            await msg.reply(' *Asistente:* Envía una imagen/video/gif con el caption `.sticker`, o responde a un mensaje con media/enlace escribiendo `.sticker`. También puedes enviar `.sticker <enlace_tiktok>`.');
            return;
        }

        const stickerStartTime = Date.now();
        console.log(`[ Sticker] Procesando sticker para ${chatId}...`);

        try {
            // Paso 1: Descargar media
            await msg.reply(' *Asistente:* Procesando tu sticker...');
            let media = null;

            if (urlDescargar) {
                console.log(`[ Sticker] Descargando desde URL: ${urlDescargar}`);
                const _isTikTok = urlDescargar.includes('tiktok.com') || urlDescargar.includes('vm.tiktok') || urlDescargar.includes('vt.tiktok');
                
                if (_isTikTok) {
                    media = await downloadTikTokMedia(urlDescargar);
                }
                
                if (!media) {
                    // Fallback yt-dlp para URLs si falla la API o no es TikTok
                    const tmpDir = path.join(__dirname, 'tmp_sticker');
                    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
                    const tmpVideo = path.join(tmpDir, 'dl_' + Date.now() + '.mp4');
                    const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
                    const ffmpegDirSticker = getFfmpegLocation();
                    let _ytArgs = ['--user-agent', ua, '--no-check-certificates', '--no-warnings'];
                    if (ffmpegDirSticker) _ytArgs.push('--ffmpeg-location', ffmpegDirSticker);

                    if (_isTikTok) {
                        _ytArgs.push('--add-header', 'Referer:https://www.tiktok.com/', '-f', 'best[ext=mp4]/best', '-o', tmpVideo, urlDescargar);
                    } else {
                        _ytArgs.push('-f', 'b[height<=480][ext=mp4]/best[height<=480][ext=mp4]/18/bv*[height<=480]+ba/b/best', '--merge-output-format', 'mp4', '-o', tmpVideo, urlDescargar);
                    }
                    
                    await new Promise((resolve, reject) => {
                        const child = spawn(getYtDlpBinary(), _ytArgs, { shell: false });
                        child.on('close', code => {
                            if (code === 0 && fs.existsSync(tmpVideo) && fs.statSync(tmpVideo).size >= 10000) resolve();
                            else reject(new Error('Fallo al descargar video de la URL proporcionada.'));
                        });
                        child.on('error', reject);
                    });
                    
                    if (fs.existsSync(tmpVideo)) {
                        media = MessageMedia.fromFilePath(tmpVideo);
                        try { fs.unlinkSync(tmpVideo); } catch(e){}
                    }
                }
            } else {
                media = await descargarMediaSeguro(mediaMsg);
            }

            if (!media || !media.data) {
                await msg.reply(' *Asistente:* No pude descargar el archivo multimedia o el enlace. Intenta de nuevo.');
                return;
            }


            const isVideo = media.mimetype.includes('video') || media.mimetype.includes('gif');
            const isImage = media.mimetype.includes('image') && !media.mimetype.includes('webp');
            const isWebp = media.mimetype.includes('webp');

            console.log(`[ Sticker] Tipo: ${media.mimetype}, isVideo: ${isVideo}, isImage: ${isImage}, isWebp: ${isWebp}`);

            // Si ya es un webp estático, enviarlo directamente como sticker
            if (isWebp && !isVideo) {
                console.log('[ Sticker] Ya es webp, enviando directo...');
                await msg.reply(media, undefined, {
                    sendMediaAsSticker: true,
                    stickerName: 'Asistente',
                    stickerAuthor: 'Geovanny'
                });
                const elapsed = ((Date.now() - stickerStartTime) / 1000).toFixed(1);
                console.log(`[ Sticker] S& Completado en ${elapsed}s (webp directo)`);
                return;
            }

            if (!isVideo && !isImage) {
                await msg.reply(' *Asistente:* Formato no soportado. Envía una imagen (jpg/png) o un video/gif corto.');
                return;
            }

            // Paso 2: Guardar en archivo temporal
            const tmpDir = path.join(__dirname, 'tmp_sticker');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

            const timestamp = Date.now();
            const ext = isVideo ? (media.mimetype.includes('gif') ? '.gif' : '.mp4') : (media.mimetype.includes('png') ? '.png' : '.jpg');
            const inputFile = path.join(tmpDir, `sticker_in_${timestamp}${ext}`);
            const preprocessedFile = path.join(tmpDir, `sticker_pre_${timestamp}.png`);
            const outputFile = path.join(tmpDir, `sticker_out_${timestamp}.webp`);

            fs.writeFileSync(inputFile, Buffer.from(media.data, 'base64'));
            console.log(`[ Sticker] Archivo guardado: ${inputFile} (${(fs.statSync(inputFile).size / 1024).toFixed(1)} KB)`);

            // Función de limpieza
            const cleanupFiles = () => {
                [inputFile, preprocessedFile, outputFile].forEach(f => {
                    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
                });
                try { if (fs.existsSync(tmpDir) && fs.readdirSync(tmpDir).length === 0) fs.rmdirSync(tmpDir); } catch (e) {}
            };

            // Paso 3: Preprocesamiento (rembg / fallback)
            const pythonCmd = isTermux ? 'python3' : 'python';
            const preprocessScript = path.join(__dirname, 'sticker_preprocess.py');
            let preprocessSource = inputFile;

            let cropFilter = '';

            if (isImage && fs.existsSync(preprocessScript)) {
                // Intentar preprocesamiento con Python
                try {
                    await new Promise((resolve, reject) => {
                        const pp = spawn(pythonCmd, [preprocessScript, inputFile, preprocessedFile], {
                            timeout: 60000,
                            cwd: __dirname
                        });
                        let ppOut = '';
                        pp.stdout.on('data', d => { ppOut += d.toString(); });
                        pp.stderr.on('data', d => { ppOut += d.toString(); });
                        pp.on('close', code => {
                            console.log(`[ Sticker] Preprocesamiento Python salida:\n${ppOut}`);
                            if (code === 0 && fs.existsSync(preprocessedFile)) {
                                preprocessSource = preprocessedFile;
                                console.log('[ Sticker] S& Preprocesamiento exitoso');
                                resolve();
                            } else {
                                console.log('[ Sticker] a Preprocesamiento falló, usando imagen original');
                                resolve(); // No rechazar, usar original
                            }
                        });
                        pp.on('error', () => {
                            console.log('[ Sticker] a Python no disponible, usando imagen original');
                            resolve();
                        });
                    });
                } catch (e) {
                    console.error('[ Sticker] Error en preprocesamiento:', e.message);
                }
            } else if (isVideo) {
                console.log('[ Sticker] Video/gif detectado, intentando auto-crop de movimiento...');
                const autocropScript = path.join(__dirname, 'sticker_autocrop_video.py');
                if (fs.existsSync(autocropScript)) {
                    try {
                        const frame1 = path.join(tmpDir, `f1_${timestamp}.jpg`);
                        const frame2 = path.join(tmpDir, `f2_${timestamp}.jpg`);
                        
                        await new Promise(r => spawn('ffmpeg', ['-y', '-i', inputFile, '-ss', '00:00:00.000', '-vframes', '1', frame1]).on('close', r));
                        await new Promise(r => spawn('ffmpeg', ['-y', '-i', inputFile, '-ss', '00:00:00.500', '-vframes', '1', frame2]).on('close', r));
                        
                        if (fs.existsSync(frame1) && fs.existsSync(frame2)) {
                            await new Promise((resolve) => {
                                const pp = spawn(pythonCmd, [autocropScript, frame1, frame2], { cwd: __dirname });
                                let ppOut = '';
                                pp.stdout.on('data', d => { ppOut += d.toString(); });
                                pp.on('close', () => {
                                    const match = ppOut.match(/CROP_PARAMS=([^\s]+)/);
                                    if (match && match[1] && match[1] !== 'NONE') {
                                        cropFilter = `crop=${match[1]},`;
                                        console.log(`[ Sticker] S& Movimiento detectado, usando crop: ${match[1]}`);
                                    } else {
                                        console.log('[ Sticker] a No se detectó movimiento válido para crop.');
                                    }
                                    resolve();
                                });
                                pp.on('error', () => resolve());
                            });
                        }
                        try { if (fs.existsSync(frame1)) fs.unlinkSync(frame1); } catch(e){}
                        try { if (fs.existsSync(frame2)) fs.unlinkSync(frame2); } catch(e){}
                    } catch (e) {
                        console.error('[ Sticker] Error en auto-crop video:', e.message);
                    }
                }
            }

            // Paso 4: Conversión a webp
            if (isImage) {
                // --- IMAGEN ESTÁTICA   WEBP 512x512 ---
                console.log('[ Sticker] Convirtiendo imagen a webp 512x512...');
                await new Promise((resolve, reject) => {
                    const ffmpegArgs = [
                        '-y', '-i', preprocessSource,
                        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white@0.0,setsar=1',
                        '-vcodec', 'libwebp',
                        '-quality', '80',
                        '-preset', 'default',
                        '-loop', '0',
                        '-an',
                        outputFile
                    ];
                    const ff = spawn('ffmpeg', ffmpegArgs, { shell: false });
                    let ffOut = '';
                    ff.stderr.on('data', d => { ffOut += d.toString(); });
                    ff.on('close', code => {
                        if (code === 0 && fs.existsSync(outputFile)) {
                            const sizeKB = (fs.statSync(outputFile).size / 1024).toFixed(1);
                            console.log(`[ Sticker] S& Webp creado: ${sizeKB} KB`);

                            // Si excede 100KB, reintentar con quality más baja
                            if (parseFloat(sizeKB) > 100) {
                                console.log('[ Sticker] a Excede 100KB, recomprimiendo...');
                                const ff2Args = [
                                    '-y', '-i', preprocessSource,
                                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white@0.0,setsar=1',
                                    '-vcodec', 'libwebp',
                                    '-quality', '50',
                                    '-preset', 'default',
                                    '-loop', '0',
                                    '-an',
                                    outputFile
                                ];
                                const ff2 = spawn('ffmpeg', ff2Args, { shell: false });
                                ff2.on('close', code2 => {
                                    if (code2 === 0) {
                                        const size2 = (fs.statSync(outputFile).size / 1024).toFixed(1);
                                        console.log(`[ Sticker] S& Recomprimido: ${size2} KB`);
                                    }
                                    resolve();
                                });
                                ff2.on('error', () => resolve());
                            } else {
                                resolve();
                            }
                        } else {
                            console.error('[ Sticker] R ffmpeg falló:', ffOut.substring(ffOut.length - 200));
                            reject(new Error('ffmpeg conversion failed'));
                        }
                    });
                    ff.on('error', err => {
                        console.error('[ Sticker] R ffmpeg no disponible:', err.message);
                        reject(err);
                    });
                });
            } else {
                // --- VIDEO/GIF   WEBP ANIMADO 512x512, 03s, 0500KB ---
                console.log('[ Sticker] Convirtiendo video/gif a webp animado...');
                const retryConfigs = [
                    { fps: 15, quality: 80 },
                    { fps: 10, quality: 60 },
                    { fps: 10, quality: 40 }
                ];

                let success = false;
                for (let attempt = 0; attempt < retryConfigs.length; attempt++) {
                    const cfg = retryConfigs[attempt];
                    console.log(`[ Sticker] Intento ${attempt + 1}: fps=${cfg.fps}, quality=${cfg.quality}`);

                    await new Promise((resolve) => {
                        const ffmpegArgs = [
                            '-y', '-i', inputFile,
                            '-vcodec', 'libwebp',
                            '-vf', `${cropFilter}fps=${cfg.fps},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white@0.0,setsar=1`,
                            '-loop', '0',
                            '-preset', 'default',
                            '-an', '-vsync', '0',
                            '-t', '3',
                            '-quality', String(cfg.quality),
                            outputFile
                        ];
                        const ff = spawn('ffmpeg', ffmpegArgs, { shell: false });
                        ff.on('close', code => {
                            if (code === 0 && fs.existsSync(outputFile)) {
                                const sizeKB = fs.statSync(outputFile).size / 1024;
                                console.log(`[ Sticker] Resultado intento ${attempt + 1}: ${sizeKB.toFixed(1)} KB`);
                                if (sizeKB <= 500) {
                                    success = true;
                                } else {
                                    console.log(`[ Sticker] a Excede 500KB, reintentando...`);
                                }
                            }
                            resolve();
                        });
                        ff.on('error', () => resolve());
                    });

                    if (success) break;
                }

                if (!success) {
                    // altimo intento desesperado: resolución más baja
                    console.log('[ Sticker] altimo intento con resolución 256x256...');
                    await new Promise((resolve) => {
                        const ff = spawn('ffmpeg', [
                            '-y', '-i', inputFile,
                            '-vcodec', 'libwebp',
                            '-vf', 'fps=8,scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:-1:-1:color=white@0.0,setsar=1',
                            '-loop', '0', '-preset', 'default', '-an', '-vsync', '0',
                            '-t', '3', '-quality', '30',
                            outputFile
                        ], { shell: false });
                        ff.on('close', code => {
                            if (code === 0 && fs.existsSync(outputFile)) {
                                success = true;
                                console.log(`[ Sticker] S& altimo intento: ${(fs.statSync(outputFile).size / 1024).toFixed(1)} KB`);
                            }
                            resolve();
                        });
                        ff.on('error', () => resolve());
                    });
                }

                if (!success) {
                    cleanupFiles();
                    await msg.reply(' *Asistente:* No pude convertir este video/gif a sticker. Es posible que sea demasiado pesado o que ffmpeg no esté instalado.');
                    return;
                }
            }

            // Paso 5: Enviar como sticker
            if (!fs.existsSync(outputFile)) {
                cleanupFiles();
                await msg.reply(' *Asistente:* Error interno: el archivo webp no se generó correctamente.');
                return;
            }

            const finalSizeKB = (fs.statSync(outputFile).size / 1024).toFixed(1);
            console.log(`[ Sticker] Enviando sticker (${finalSizeKB} KB)...`);

            const stickerMedia = MessageMedia.fromFilePath(outputFile);
            await msg.reply(stickerMedia, undefined, {
                sendMediaAsSticker: true,
                stickerName: 'Asistente',
                stickerAuthor: 'Geovanny'
            });

            // Paso 6: Limpieza
            cleanupFiles();

            const elapsed = ((Date.now() - stickerStartTime) / 1000).toFixed(1);
            console.log(`[ Sticker] S& Sticker enviado exitosamente en ${elapsed}s (${finalSizeKB} KB, ${isVideo ? 'animado' : 'estático'})`);

        } catch (err) {
            console.error(`[ Sticker] R Error general:`, err);
            let errorStep = 'procesamiento';
            if (err.message?.includes('download')) errorStep = 'descarga del archivo';
            else if (err.message?.includes('ffmpeg')) errorStep = 'conversión con ffmpeg';
            else if (err.message?.includes('send')) errorStep = 'envío del sticker';
            await msg.reply(` *Asistente:* Error en ${errorStep}: ${err.message || 'Error desconocido'}. Revisa la consola de Termux.`).catch(() => {});

            // Limpieza de emergencia
            const tmpDir = path.join(__dirname, 'tmp_sticker');
            try {
                if (fs.existsSync(tmpDir)) {
                    fs.readdirSync(tmpDir).forEach(f => {
                        try { fs.unlinkSync(path.join(tmpDir, f)); } catch (e) {}
                    });
                    fs.rmdirSync(tmpDir);
                }
            } catch (e) {}
        }
        return;
    }

    const primerPalabra = textoOriginal.split(' ')[0]?.toLowerCase();


    // --- EVALUADOR DE RESPUESTAS PARA JUEGOS EN GRUPO ---
    if (juegosEstado.has(chatId) && !textoOriginal.startsWith('!')) {
        const juego = juegosEstado.get(chatId);
        const contact = await msg.getContact();
        const senderName = contact.pushname || contact.name || contact.number || "Jugador";
        
        if (juego.tipo === 'trivia') {
            const respuestaUsuario = textoOriginal.toUpperCase().trim();
            const formatResp = respuestaUsuario.replace(/[^A-D]/g, '');
            if (formatResp && formatResp.length === 1 && (respuestaUsuario === formatResp || respuestaUsuario === formatResp + ")")) {
                if (formatResp === juego.respuesta) {
                    juegosEstado.delete(chatId);

                    return msg.reply(`0 *¡CORRECTO!* @${contact.number || senderName} ha acertado.\n\nLa respuesta era: *${juego.respuesta}*\n\n¡Has ganado este punto!`, undefined, { mentions: [contact] });
                } else {
                    if (textoOriginal.length === 1) {
                        return msg.reply(` *Incorrecto*, @${contact.number || senderName}. Sigan intentando.`, undefined, { mentions: [contact] });
                    }
                }
            }
        }
        
        if (juego.tipo === 'adivinar') {
            const numUsuario = parseInt(textoOriginal.trim());
            if (!isNaN(numUsuario) && numUsuario >= 1 && numUsuario <= 100) {

                if (numUsuario === juego.numero) {
                    juegosEstado.delete(chatId);
                    return msg.reply(`0 *¡FELICIDADES!* @${contact.number || senderName} ha adivinado el número secreto: *${juego.numero}*! x\n\nLo lograste en ${juego.intentos + 1} intentos.`, undefined, { mentions: [contact] });
                } else {
                    juego.intentos++;
                    if (numUsuario < juego.numero) {
                        return msg.reply(`x *Más alto*, @${contact.number || senderName}. (Intento ${juego.intentos})`, undefined, { mentions: [contact] });
                    } else {
                        return msg.reply(`x0 *Más bajo*, @${contact.number || senderName}. (Intento ${juego.intentos})`, undefined, { mentions: [contact] });
                    }
                }
            }
        }
    }

    // --- INTERCEPTOR DE COMANDOS PERSONALIZADOS (Directos con prefijo !) ---
    if (textoOriginal.startsWith('!') && !textoOriginal.toLowerCase().startsWith('!bot')) {
        const partsCmd = textoOriginal.split(' ');
        const cmdName = partsCmd[0].substring(1).toLowerCase();
        const cmdArg = partsCmd.slice(1).join(' ').trim();
        
        if (comandosCustom[cmdName]) {
            const cmdConfig = comandosCustom[cmdName];

            
            if (cmdConfig.tipo === 'texto') {
                return msg.reply(cmdConfig.contenido);
            }
            if (cmdConfig.tipo === 'ia') {
                await msg.getChat().then(c => c.sendStateTyping());
                try {
                    const promptIA = `${cmdConfig.contenido}\n\nArgumento del usuario: ${cmdArg || '(ninguno)'}`;
                    const respuestaIA = await ejecutarGeminiConRetries(async (model) => {
                        const result = await model.generateContent([promptIA]);
                        return result.response.text();
                    });
                    const respuestaFinal = limpiarRespuestaGemini(respuestaIA);
                    return msg.reply(respuestaFinal);
                } catch (e) {
                    console.error("Error en comando custom IA:", e);
                    return msg.reply(" *Asistente:* Ocurrió un error al procesar el comando con IA.");
                }
            }
            if (cmdConfig.tipo === 'codigo') {
                if (!esAdmin(chatId, msg)) {
                    return msg.reply(" Este comando personalizado de código está restringido al Administrador.");
                }
                try {
                    const ejecutarCodigo = new AsyncFunction('msg', 'client', 'MessageMedia', 'ejecutarGeminiConRetries', 'limpiarRespuestaGemini', 'argumento', cmdConfig.contenido);
                    await ejecutarCodigo(msg, client, MessageMedia, ejecutarGeminiConRetries, limpiarRespuestaGemini, cmdArg);
                } catch (e) {
                    console.error("Error ejecutando comando custom de código:", e);
                    return msg.reply(` *Error en código del comando:* ${e.message}`);
                }
                return;
            }
        }
    }
function obtenerDetalleAyuda(opcionRaw) {
    const opcion = (opcionRaw || '').toLowerCase().trim();

    if (opcion === '1' || opcion === 'finanzas' || opcion === 'tarjetas') {
        return ` *1. FINANZAS KING & TARJETAS:*
• \`!bot tarjetas\` - Resumen global de tus 14 tarjetas, endeudamiento y saldo disponible.
• \`!bot tarjetas <nombre>\` - Consulta el detalle de una tarjeta (ej. \`!bot tarjetas bac\`).
• \`!bot vencimientos\` - Chequea qué tarjetas vencen hoy, mañana o en los próximos días.
• \`!bot telegram\` - Estado de la conexión y sincronización con Telegram.
• *Estados de Cuenta y Comprobantes:* Envía cualquier PDF o foto de estado de cuenta bancario, comprobante de abono o ticket de compra y se actualizará automáticamente en https://finanzaskingapp.netlify.app/`;
    }

    if (opcion === '2' || opcion === 'flyers' || opcion === 'canva' || opcion === 'imagenes' || opcion === 'diseño' || opcion === 'diseno') {
        return ` *2. FLYERS, CANVA & DISEÑO:*
• \`!bot flyer <tema>\` (o \`!bot canva <tema>\`) - Genera el copy publicitario persuasivo y enlaces directos a plantillas profesionales en Canva.
• \`!bot imagina <idea>\` (o \`!bot dibuja <idea>\`) - Genera una imagen artística en alta resolución con IA (ChatGPT / FLUX).
• \`!bot stickercrear <idea>\` - Crea un sticker vectorizado para WhatsApp a partir de tu idea.`;
    }

    if (opcion === '3' || opcion === 'memoria' || opcion === 'conocimiento' || opcion === 'recordar') {
        return ` *3. MEMORIA Y BASE DE DATOS PERSONAL:*
• \`!bot guardar <tema> : <información>\` - Guarda datos personales, contraseñas, tallas o notas (ej. \`!bot guardar Talla : Camisa M, Calzado 42\`).
• \`!bot memoria\` - Lista todo lo que Asistente tiene guardado sobre ti.
• \`!bot olvidar <tema o número>\` - Elimina un registro de la memoria.
• \`!bot memoria buscar <texto>\` - Busca datos específicos en tu base de conocimiento.
• *Conversacional:* Puedes pedirle directamente: _"Recuerda que mi comida favorita es sushi"_ o preguntarle _"¿Qué datos tienes guardados sobre mí?"_.`;
    }

    if (opcion === '4' || opcion === 'programar' || opcion === 'cron' || opcion === 'alarmas' || opcion === 'programados') {
        return ` *4. TAREAS PROGRAMADAS Y RECORDATORIOS:*
• \`!bot programar <HH:MM> | <instrucción>\` - Programa un mensaje automático diario (ej. \`!bot programar 05:00 | Frase motivacional\`).
• \`!bot programados\` - Muestra todas las tareas programadas activas con su horario.
• \`!bot desprogramar <número>\` - Cancela y borra una tarea programada.
• *Lenguaje Natural:* Puedes pedirle: _"Programa para que a las 8 am me busques las noticias de fútbol todos los días"_.`;
    }

    if (opcion === '5' || opcion === 'youtube' || opcion === 'musica' || opcion === 'video' || opcion === 'descargas') {
        return ` *5. YOUTUBE Y DESCARGAS MULTIMEDIA:*
• \`!bot videos\` - Consulta los últimos videos publicados por los canales a los que estás suscrito.
• \`!bot videos <nombre>\` - Consulta los videos recientes de un canal específico (ej. \`!bot videos mrbeast\`).
• \`!bot agregarcanal <enlace / @usuario>\` - Agrega un canal para monitoreo automático de videos.
• \`!bot canales\` - Lista tus canales de YouTube registrados.
• \`!bot borrarcanal <número>\` - Elimina un canal de la lista.
• \`!bot musica <enlace>\` - Descarga audio MP3 (YouTube, TikTok, Instagram, X/Twitter).
• \`!bot video <enlace>\` - Descarga video MP4 en alta definición.`;
    }

    if (opcion === '6' || opcion === 'agentes' || opcion === 'ia' || opcion === 'inteligencia') {
        return ` *6. AGENTES DE IA Y CONVERSACIÓN:*
• \`!iniciarbot <agente>\` - Inicia chat privado continuo con un agente (ej. \`!iniciarbot programador\`).
• \`!botgrupal <agente>\` - Inicia modo agente dentro de un grupo de WhatsApp.
• \`!finalizarbot\` - Cierra la conversación continua del agente.
• \`!bot agentes\` - Lista todos los perfiles de agentes disponibles.
• \`!bot agente crear <nombre> <prompt>\` - Crea un agente con personalidad propia.
• \`!bot traducir <idioma> <texto>\` - Traductor en tiempo real (ej. \`!bot traducir ingles Buen día\`).
• \`!bot resumir <enlace o responde a PDF>\` - Resume artículos web o documentos extensos.
• \`!bot buscar <consulta>\` - Búsqueda web en vivo con datos actualizados.`;
    }

    if (opcion === '7' || opcion === 'ajustes' || opcion === 'configuracion' || opcion === 'sistema' || opcion === 'conexiones' || opcion === 'voz') {
        return `*7. AJUSTES, CONEXIONES Y SERVIDOR:*
• \`!bot diagnostico\` - Auditoría integral de todos los subsistemas (IA, descargas, base de datos, servidor).
• \`!bot logs [N]\` - Ver los últimos N registros de salida en el servidor (ej. \`!bot logs 20\`).
• \`!bot errores [N]\` - Ver los últimos N errores registrados en el servidor.
• \`!bot sistema\` - Telemetría del servidor (RAM, CPU, Uptime).
• \`!bot voz <hombre / mujer>\` - Configura la voz por defecto del bot (Masculina o Femenina).
• \`!bot settelegram <token>\` - Vincula tu bot de Telegram con token de @BotFather.
• \`!bot telegram\` - Estado de la conexión con Telegram.
• \`!bot setopenai <key>\` - Registra tu clave de OpenAI para ChatGPT y DALL-E.
• \`!bot openai\` - Estado de la clave de OpenAI.
• \`!bot addkey <clave>\` - Agrega una nueva clave API de Google Gemini.
• \`!bot claves\` - Muestra el estado y consumo de tus claves Gemini.
• \`!bot resetkeys\` - Reactiva todas las claves marcadas como agotadas.
• \`!bot bateria\` - Consulta batería, temperatura y estado de carga (Termux).
• \`!bot apagar\` / \`!bot encender\` - Pausa o reactiva el bot.`;
    }

    if (opcion === '8' || opcion === 'utilidades' || opcion === 'herramientas' || opcion === 'varios') {
        return ` *8. UTILIDADES Y HERRAMIENTAS:*
• \`!bot decir <texto>\` (o \`!bot tts <texto>\`) - Dicta audio con la voz activa actual.
• \`!bot decir hombre <texto>\` (o \`!bot decir h <texto>\`) - Dicta con voz masculina .
• \`!bot decir mujer <texto>\` (o \`!bot decir m <texto>\`) - Dicta con voz femenina .
• \`!bot voz\` - Muestra el estado de la voz y cómo configurarla.
• \`!bot tarea agregar <texto>\` - Agrega un pendiente personal.
• \`!bot tareas\` - Muestra la lista de pendientes.
• \`!bot tareacompletar <número>\` - Marca una tarea como completada.
• \`!bot alarma <HH:MM> <mensaje>\` - Programa una alarma sonora/notificación.
• \`!bot clima <ciudad>\` - Consulta el pronóstico del clima.
• \`!bot qr <texto o enlace>\` - Genera un código QR de alta resolución.
• \`!bot divisas <monto> <moneda1> a <moneda2>\` - Conversor de divisas (ej. \`!bot divisas 50 USD a EUR\`).
• \`!bot calcular <operación>\` - Calculadora matemática rápida (ej. \`!bot calcular 1500 * 0.13\`).`;
    }

    return null;
}

    const isOptionNumber = /^[1-8]$/.test(textoOriginal);
    if (esperandoAyudaOpcion.has(chatId)) {
        if (isOptionNumber) {
            esperandoAyudaOpcion.delete(chatId);
            const detalle = obtenerDetalleAyuda(textoOriginal);
            if (detalle) return msg.reply(detalle);
        } else {
            esperandoAyudaOpcion.delete(chatId);
        }
    }

    // Auto-asignar admin si aún no existe y el mensaje es en chat privado
    if (!isGroup && !adminChatId) {
        adminChatId = chatId;
        guardarAdminJson();
        console.log(`[!] Administrador auto-asignado a chat privado: ${chatId}`);
    }

    if (primerPalabra === '!iniciarbot' || primerPalabra === '!botgrupal') {
        const partsInit = textoOriginal.split(' ');
        const nombreAgente = partsInit[1]?.toLowerCase() || 'kinbot';

        if (!agentesCustom[nombreAgente]) {
            return msg.reply(` *Asistente:* El agente *"${nombreAgente}"* no existe en mis registros. Escriba *!bot agentes* para ver la lista.`);
        }

        chatsActivos.add(chatId);

        let systemPromptFluid = agentesCustom[nombreAgente];
        if (isGroup || !esAdmin(chatId, msg)) {
            systemPromptFluid = `Eres Asistente, un asistente virtual de inteligencia artificial inteligente, amable, educado y altamente eficiente.
Estás interactuando con un usuario general (el propietario del bot es Geovanny Pacheco).

NORMAS ESTRICTAS DE PRIVACIDAD:
1. Tienes ESTRICTAMENTE PROHIBIDO revelar, discutir o mencionar cualquier dato personal, información privada, números, finanzas, tarjetas bancarias, contraseñas, notas, intereses personales o datos de Geovanny Pacheco. Si el usuario te pregunta por información privada de Geovanny, responde con amabilidad que es información confidencial.
2. Tienes terminantemente prohibido usar tags de finanzas ([ACTION_FINANCE_*]), notas ([ACTION_NOTE_*]), memoria ([ACTION_MEMORY_*]), tareas programadas ([ACTION_SCHEDULE:*]) o comandos del sistema ([ACTION_CMD:*]).

CAPACIDADES PERMITIDAS QUE PUEDES USAR:
- Responder a cualquier consulta, duda o conversación con inteligencia y educación.
- Realizar búsquedas web en vivo: Usa [ACTION_SEARCH: consulta] cuando el usuario pregunte por información actual, noticias o datos recientes en Google.
- Búsqueda y descarga de videos: Usa [ACTION_VIDEO_BUSCAR: titulo] o sugiere el comando !bot video <enlace>.
- Búsqueda y descarga de música MP3: Usa [ACTION_MUSICA_BUSCAR: cancion | artista] o sugiere !bot musica <enlace>.
- Respuestas con audio / voz: Usa [ACTION_AUDIO: texto] o sugiere !bot decir <texto>.
- Crear stickers: Explica el comando !bot stickercrear <idea>.
- Generar imágenes: Explica el comando !bot imagina <idea>.
- Clima: !bot clima <ciudad>.
- Códigos QR: !bot qr <texto o enlace>.
- Traductor: !bot traducir <idioma> <texto>.
- Calculadora: !bot calcular <operación>.

Responde de forma clara, natural y concisa en español.`;
        }

        sesionesChat.set(chatId, [
            { role: "user", parts: [{ text: systemPromptFluid }] },
            { role: "model", parts: [{ text: `Entendido. Protocolo del Agente "${nombreAgente}" activado y en línea.` }] }
        ]);

        return msg.reply(isGroup ? ` *Modo conversacional grupal ACTIVADO (Agente: ${nombreAgente}).*` : ` *Modo conversacional ACTIVADO (Agente: ${nombreAgente}).*`);
    }

    if (primerPalabra === '!finalizarbot') {
        chatsActivos.delete(chatId);
        sesionesChat.delete(chatId);
        return msg.reply(" *Modo conversacional DESACTIVADO.*");
    }

    // --- INTERCEPTOR DE COMPROBANTES / TRANSACCIONES REENVIADAS A WHATSAPP ---
    if (!isGroup) {
        // A) Si el mensaje trae adjunto (foto de ticket, voucher o PDF)
        if (msg.hasMedia) {
            try {
                const media = await descargarMediaSeguro(msg);
                if (media && (media.mimetype === 'application/pdf' || media.mimetype.startsWith('image/'))) {
                    const esDocFinanciero = await procesarDocumentoFinanciero(media, msg);
                    if (esDocFinanciero) return;
                }
            } catch (eMed) {}
        }

        // B) Si es texto reenviado (SMS bancario, alerta de compra, wompi, transferencia)
        if (textoOriginal && textoOriginal.length > 15) {
            const tLow = textoOriginal.toLowerCase();
            const tieneTerminosFinancieros = [
                'compra', 'abono', 'pago', 'transferencia', 'comprobante', 'recibo', 
                'factura', 'tarjeta', 'saldo', 'monto', 'usd', '$', 'autorizacion', 
                'wompi', 'chivo', 'recarga', 'retiro', 'banco'
            ].some(k => tLow.includes(k));

            if (tieneTerminosFinancieros) {
                const esFinanciero = await procesarTextoFinanciero(textoOriginal, msg);
                if (esFinanciero) return;
            }
        }
    }

    const usaPrefijo = textoOriginal.toLowerCase().startsWith('!bot');
    const esAdminPrivado = !isGroup && esAdmin(chatId, msg);
    if (!chatsActivos.has(chatId) && !usaPrefijo && !esAdminPrivado) return;

    let textoLimpio = usaPrefijo ? textoOriginal.substring(4).trim() : textoOriginal;
    let comando = textoLimpio.split(' ')[0]?.toLowerCase() || '';
    comando = comando.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    let argumento = textoLimpio.substring(comando.length).trim();

    // --- CONTROL DE ENERGÍA Y REPOSO (APAGAR / ENCENDER / GRUPOS) ---
    if (comando === 'apagar' || comando === 'dormir' || comando === 'suspender') {
        if (!esAdmin(chatId, msg)) return msg.reply("Comando restringido solo al Administrador.");
        if (isGroup) {
            chatsActivos.delete(chatId);
            sesionesChat.delete(chatId);
            return msg.reply("*Modo conversacional grupal DESACTIVADO.*");
        }
        botPausado = true;
        return msg.reply("*Asistente:* Modo reposo ACTIVADO. He pausado todas mis respuestas automáticas.\nPara reactivarme, escribe: `!bot encender`");
    }

    if (comando === 'encender' || comando === 'activar' || comando === 'despertar' || comando === 'iniciar') {
        if (!esAdmin(chatId, msg)) return msg.reply("Comando restringido solo al Administrador.");
        botPausado = false;
        if (isGroup) {
            chatsActivos.add(chatId);
            const nombreAgente = 'kinbot';
            const systemPromptFluid = `Eres Asistente, un asistente virtual de inteligencia artificial inteligente, amable, educado y altamente eficiente.
Estás interactuando en un grupo de WhatsApp.
NORMAS ESTRICTAS:
1. No reveles finanzas, tarjetas bancarias, contraseñas ni notas personales de Geovanny Pacheco.
2. Responde de forma clara, natural, útil y concisa en español, sin emojis.`;
            sesionesChat.set(chatId, [
                { role: "user", parts: [{ text: systemPromptFluid }] },
                { role: "model", parts: [{ text: "Modo conversacional grupal activado y en línea." }] }
            ]);
            return msg.reply("*Modo conversacional grupal ACTIVADO.*");
        }
        return msg.reply("*Asistente:* Sistema REACTIVADO y en línea. Todas las funciones están operativas.");
    }

    if (botPausado) {
        return; // Silencio total si el bot está apagado
    }

    // Alias handlers for common spacing mistakes
    if (comando === 'borrar' && argumento.toLowerCase().startsWith('canal ')) {
        comando = 'borrarcanal';
        argumento = argumento.substring(6).trim();
    }
    if (comando === 'borrar' && argumento.toLowerCase().startsWith('nota ')) {
        comando = 'borrarnota';
        argumento = argumento.substring(5).trim();
    }
    let mensajeAProcesar = msg;

    if (comando === 'seradmin') {
        adminChatId = chatId;
        guardarAdminJson();
        try {
            await client.sendMessage(chatId, " *Asistente:* Te he reconocido como el Administrador Principal. De ahora en adelante, me activaré de forma automática y conversacional solo contigo en privado.");
        } catch (e) {
            console.error("Error al enviar mensaje de seradmin:", e.message);
        }
        return;
    }

    const textoNormalizado = (textoLimpio || '').trim().replace(/^[¿¡?!.,\s]+|[¿¡?!.,\s]+$/g, '');

    // --- GESTIÓN DIRECTA DE ALARMAS Y TEMPORIZADORES ---
    const regexConsultarAlarmas = /^(?:cu[aá]les\s+son\s+(?:mis\s+)?alarmas|qu[eé]\s+alarmas\s+(?:tengo|hay)|ver\s+alarmas|mis\s+alarmas|lista\s+de\s+alarmas|alarmas)\s*$/i;
    if (regexConsultarAlarmas.test(textoNormalizado)) {
        return msg.reply(formatearAlarmas());
    }

    const regexCancelarAlarma = /^(?:cancela(?:r)?|elimina(?:r)?|borra(?:r)?)\s+(?:(?:la\s+)?alarma\s+)?(\d+|todas?)\s*$/i;
    const matchCancAlarma = textoNormalizado.match(regexCancelarAlarma);
    if (matchCancAlarma) {
        return msg.reply(cancelarAlarma(matchCancAlarma[1]));
    }

    const parsedAlarma = parsearAlarma(textoNormalizado);
    if (parsedAlarma) {
        return msg.reply(procesarNuevaAlarma(parsedAlarma, chatId));
    }

    // --- GESTIÓN DIRECTA DE TAREAS PROGRAMADAS (LENGUAJE NATURAL Y COMANDOS) ---
    const regexConsultarTareas = /^(?:cu[aá]les\s+son\s+(?:mis\s+)?tareas(?:\s+(?:programadas?|programables?|automatizadas?|agendadas?))?|qu[eé]\s+tareas\s+(?:tengo|hay)(?:\s+(?:programadas?|programables?|automatizadas?|agendadas?))?|ver\s+tareas(?:\s+(?:programadas?|programables?|automatizadas?|agendadas?))?|mis\s+tareas(?:\s+(?:programadas?|programables?|automatizadas?|agendadas?))?|lista\s+de\s+tareas(?:\s+(?:programadas?|programables?|automatizadas?|agendadas?))?|tareas\s+(?:programadas?|programables?|automatizadas?|agendadas?)|programados)\s*$/i;
    if (regexConsultarTareas.test(textoNormalizado)) {
        return msg.reply(formatearTareasProgramadas());
    }

    const regexCancelarTarea = /^(?:cancela(?:r)?|elimina(?:r)?|borra(?:r)?|desprograma(?:r)?)\s+(?:(?:la\s+)?tarea(?:\s+(?:programada|programable|automatizada))?\s+)?(\d+|todas?(?:\s+las\s+tareas(?:\s+(?:programadas|programables))?)?)\s*$/i;
    const matchCancelar = textoNormalizado.match(regexCancelarTarea);
    if (matchCancelar) {
        return msg.reply(cancelarTareaProgramada(matchCancelar[1]));
    }

    const esIntencionProgramar = /^(?:programa(?:r)?|agenda(?:r)?|recu[eé]rdame\s+(?:a|para)\s+las?|av[ií]same\s+(?:a|para)\s+las?|(?:a|para)\s+las?\s+\d{1,2}(?::\d{2})?|\d{1,2}:\d{2}\b)/i.test(textoNormalizado);
    if (esIntencionProgramar) {
        const parsed = parsearInstruccionProgramacion(textoNormalizado);
        if (parsed) {
            return msg.reply(procesarNuevaTareaProgramada(parsed, chatId));
        } else if (/^(?:programa(?:r)?|agenda(?:r)?)\b/i.test(textoNormalizado)) {
            return msg.reply("Indica la hora y la instrucción. Ejemplo: Programar a las 07:00 AM resumen de noticias");
        }
    }

    // --- CONSULTA DIRECTA DE CLIMA (LENGUAJE NATURAL Y COMANDO) ---
    const regexClima = /^(?:c[oó]mo\s+est[aá]\s+(?:el\s+)?clima(?:\s+hoy)?(?:\s+en\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ0-9\s,.-]+))?|clima(?:\s+en\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ0-9\s,.-]+)|\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ0-9\s,.-]+))?|el\s+clima(?:\s+de\s+hoy)?(?:\s+en\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ0-9\s,.-]+))?|pron[oó]stico(?:\s+del\s+tiempo)?(?:\s+en\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ0-9\s,.-]+))?)\s*$/i;
    const matchClima = textoLimpio.trim().match(regexClima);
    if (matchClima) {
        const ciudadPedida = (matchClima[1] || matchClima[2] || matchClima[3] || matchClima[4] || matchClima[5] || 'Chalchuapa').trim();
        const reporte = await obtenerReporteClima(ciudadPedida);
        return msg.reply(reporte);
    }

    if (!msg.hasMedia) {
        if (msg.hasQuotedMsg) {
            try {
                const quotedMsg = await msg.getQuotedMessage();
                if (quotedMsg && quotedMsg.hasMedia) mensajeAProcesar = quotedMsg;
            } catch (eQ) {}
        } else {
            try {
                const chat = await msg.getChat();
                const historial = await chat.fetchMessages({ limit: 6 });
                if (Array.isArray(historial)) {
                    for (let i = historial.length - 1; i >= 0; i--) {
                        if (historial[i] && historial[i].id?._serialized !== msg.id?._serialized && historial[i].hasMedia) {
                            mensajeAProcesar = historial[i];
                            break;
                        }
                    }
                }
            } catch (eH) {}
        }
    }

    // --- RECREACIÓN / MODIFICACIÓN DE IMÁGENES CON VISIÓN GEMINI + FLUX.1 ---
    const esPeticionRecrear = /^(?:recrea(?:r)?|re-crea(?:r)?|rehaz|rehacer|modifica(?:r)?|haz(?:me)?\s+(?:otra|una)?\s+(?:parecida|igual|similar|version|versi[oó]n)|haz\s+algo\s+parecido|haz(?:me)?\s+(?:una\s+)?imagen\s+(?:como|basada\s+en|parecida\s+a)|crea(?:r)?\s+(?:una\s+)?imagen\s+(?:como|basada\s+en|parecida\s+a)|genera(?:r)?\s+(?:una\s+)?imagen\s+(?:como|basada\s+en|parecida\s+a)|cambia(?:r)?\s+(?:el\s+texto|esto|la\s+imagen))\b/i.test(textoNormalizado) ||
        /(?:recrea(?:r)?|rehaz|rehacer)\s+(?:esta|la)\s+(?:imagen|foto|ilustraci[oó]n|diseño|portada)/i.test(textoNormalizado) ||
        (/(?:recrea(?:r)?|parecid[ao]|similar|mismo\s+estilo)\b/i.test(textoNormalizado) && (msg.hasMedia || (mensajeAProcesar && mensajeAProcesar.hasMedia)));

    if (esPeticionRecrear) {
        if (!mensajeAProcesar || !mensajeAProcesar.hasMedia) {
            return msg.reply("Para recrear o modificar una imagen, por favor envía la foto o responde a una imagen con tu indicación.");
        }

        await msg.reply("Recreando imagen...");
        try {
            const mediaRef = await descargarMediaSeguro(mensajeAProcesar);
            if (!mediaRef || !mediaRef.data) {
                return msg.reply("No fue posible descargar la imagen de referencia. Por favor reenvíala o intenta de nuevo.");
            }
            if (!mediaRef.mimetype || !mediaRef.mimetype.startsWith('image/')) {
                return msg.reply("El archivo adjunto no es una imagen válida para recrear.");
            }

            let promptRecreacion = "";
            try {
                const promptAnalisisVisual = `You are an elite visual prompt engineer for state-of-the-art text-to-image models (FLUX.1 and SDXL).
The user provided a reference image and the following user instruction:
"${textoNormalizado}"

TASK:
1. Examine this reference image with extreme visual precision:
   - Primary subjects, composition, camera perspective, framing, background elements.
   - Distinctive art style (e.g. 3D isometric volumetric typography, glowing neon cybernetic art, futuristic render, dark moody galaxy, realistic photography, anime, etc.).
   - Exact color palette, lighting dynamics, volumetric smoke, glowing embers, particle effects, reflections, textures, materials (e.g. metallic chrome, translucent crystal, glossy enamel).
2. Integrate the user's modifications precisely:
   - If the user asks to change or replace text (for example, to display "The King"), replace the original text with the user's requested text while strictly maintaining or enhancing the typography's 3D volumetric design, font style, glow, lighting, bevels, and atmospheric particle effects.
   - If the user asks for alterations in colors, environment, or mood, blend them seamlessly into the original aesthetic.
3. Formulate a complete, highly descriptive English prompt optimized for FLUX.1 text-to-image synthesis that captures all the visual qualities of the reference image along with the user's updates.

CRITICAL: Output ONLY the final raw English prompt. Do NOT include markdown quotes, explanations, prefixes, or commentary.`;

                const resVision = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([
                        {
                            inlineData: {
                                data: mediaRef.data,
                                mimeType: mediaRef.mimetype || 'image/jpeg'
                            }
                        },
                        promptAnalisisVisual
                    ]);
                    return result.response.text();
                });

                if (resVision && resVision.trim()) {
                    promptRecreacion = resVision.trim().replace(/^["']|["']$/g, '');
                    console.log(`[Prompt Recreación Gemini Vision]: ${promptRecreacion}`);
                }
            } catch (eVis) {
                console.error("Error analizando imagen con Gemini Vision:", eVis.message);
            }

            if (!promptRecreacion) {
                promptRecreacion = textoNormalizado;
            }

            return generarImagenIA(promptRecreacion, msg, {
                isAlreadyOptimized: true,
                captionPrompt: textoNormalizado,
                silent: true
            });
        } catch (eRec) {
            console.error("Error en proceso de recreación de imagen:", eRec);
            return msg.reply("Ocurrió un error al recrear la imagen.");
        }
    }

    // --- GENERACIÓN DIRECTA DE IMÁGENES (LENGUAJE NATURAL) ---
    const regexImagenNatural = /^(?:crea(?:r)?(?:\s+(?:una|la))?\s+imagen(?:\s+de)?|genera(?:r)?(?:\s+(?:una|la))?\s+imagen(?:\s+de)?|haz(?:me)?(?:\s+(?:una|la))?\s+imagen(?:\s+de)?|dibuja(?:r)?(?:me)?(?:\s+(?:un|una|el|la))?|imagina(?:r)?(?:\s+(?:un|una|el|la))?)\s+(.+)$/i;
    const matchImagenNat = textoNormalizado.match(regexImagenNatural);
    if (matchImagenNat) {
        return generarImagenIA(matchImagenNat[1], msg);
    }

    try {
        // --- PROCESAR COMANDOS PERSONALIZADOS CON PREFIJO !bot ---
        if (comandosCustom[comando]) {
            const cmdConfig = comandosCustom[comando];
            if (cmdConfig.tipo === 'texto') {
                return msg.reply(cmdConfig.contenido);
            }
            if (cmdConfig.tipo === 'ia') {
                await msg.getChat().then(c => c.sendStateTyping());
                try {
                    const promptIA = `${cmdConfig.contenido}\n\nArgumento del usuario: ${argumento || '(ninguno)'}`;
                    const respuestaIA = await ejecutarGeminiConRetries(async (model) => {
                        const result = await model.generateContent([promptIA]);
                        return result.response.text();
                    });
                    const respuestaFinal = limpiarRespuestaGemini(respuestaIA);
                    return msg.reply(respuestaFinal);
                } catch (e) {
                    console.error("Error en comando custom IA:", e);
                    return msg.reply(" *Asistente:* Ocurrió un error al procesar el comando con IA.");
                }
            }
            if (cmdConfig.tipo === 'codigo') {
                if (!esAdmin(chatId, msg)) {
                    return msg.reply(" Este comando personalizado de código está restringido al Administrador.");
                }
                try {
                    const ejecutarCodigo = new AsyncFunction('msg', 'client', 'MessageMedia', 'ejecutarGeminiConRetries', 'limpiarRespuestaGemini', 'argumento', cmdConfig.contenido);
                    await ejecutarCodigo(msg, client, MessageMedia, ejecutarGeminiConRetries, limpiarRespuestaGemini, argumento);
                } catch (e) {
                    console.error("Error ejecutando comando custom de código:", e);
                    return msg.reply(` *Error en código del comando:* ${e.message}`);
                }
                return;
            }
        }

        if (comando === 'canva' || comando === 'flyer' || comando === 'banner') {
            if (!argumento) return msg.reply(" *Asistente:* Indique el tema o producto para el flyer. Ejemplo: `!bot flyer tarjeta de credito dorada para redes sociales`");
            await msg.reply(" *Asistente:* Diseñando propuesta publicitaria y buscando plantillas profesionales de Canva...");
            try {
                const promptDesign = `Eres un Director Creativo y Diseñador Publicitario de primer nivel.
Crea una propuesta completa y profesional de flyer / banner para redes sociales sobre: "${argumento}".

Estructura tu respuesta exactamente así:
 *TITULAR GANCHO:* (Titular llamativo de alto impacto para captar clientes)
 *SUBTÍTULO / PROPUESTA DE VALOR:* (1 frase clara y persuasiva)
 *BENEFICIOS CLAVE:*
• (Beneficio 1)
• (Beneficio 2)
• (Beneficio 3)
 *LLAMADO A LA ACCIÓN (CTA):* (Ej: "¡Solicítala hoy con 0% de interés!", "Pídela aquí", etc.)
 *DISEÑO & ESTILO RECOMENDADO:*
• Paleta de colores sugerida: (Colores armónicos y modernos)
• Tipografía: (Sans-Serif, Negrita, Elegante)
• Elementos visuales: (Qué foto o fondo usar)`;

                const copyText = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([promptDesign]);
                    return result.response.text();
                });

                const queryCanva = encodeURIComponent(argumento + " flyer banner");
                const queryCanvaInstagram = encodeURIComponent(argumento + " instagram post");
                const canvaUrl1 = `https://www.canva.com/templates/?query=${queryCanva}`;
                const canvaUrl2 = `https://www.canva.com/templates/?query=${queryCanvaInstagram}`;

                let respuestaCompleta = ` *PROPUESTA DE DISEÑO & FLYER PUBLICITARIO* \n\n`;
                respuestaCompleta += copyText.trim() + `\n\n`;
                respuestaCompleta += `━━━━━━━━━━━━━━━━━━━━━\n`;
                respuestaCompleta += ` *PLANTILLAS PROFESIONALES DE CANVA:*\n`;
                respuestaCompleta += `Abre estos enlaces para seleccionar y personalizar tu plantilla:\n\n`;
                respuestaCompleta += ` *Posts de Instagram:* ${canvaUrl2}\n`;
                respuestaCompleta += ` *Flyers / Banners:* ${canvaUrl1}\n\n`;
                respuestaCompleta += `_ Consejo: Copia los textos sugeridos arriba y pégalos en la plantilla de Canva para tener un diseño listo en 2 minutos._`;

                return msg.reply(respuestaCompleta);
            } catch (e) {
                return msg.reply(` *Asistente:* Error al estructurar la propuesta de diseño: ${e.message}`);
            }
        }

        if (comando === 'imagina' || comando === 'dibuja' || comando === 'crear' || comando === 'imagen') {
            return generarImagenIA(argumento, msg);
        }

        // --- SISTEMA DE BATERÍA HÍBRIDO (Windows / Android) ---
        if (comando === 'bateria' || comando === 'estado') {
            if (fs.existsSync('/usr/bin/chromium-browser')) { puppeteerConfig.executablePath = '/usr/bin/chromium-browser'; }
if (isTermux) {
                exec('termux-battery-status', async (err, stdout) => {
                    if (err) return msg.reply(" Error leyendo batería de Termux.");
                    try {
                        const data = JSON.parse(stdout);
                        const charging = data.status === 'CHARGING' ? 'x R Cargando' : 'x 9 Descargando';
                        await msg.reply('  *Estado del teléfono:*\n\nx 9 Carga: ' + data.percentage + '%\nxR Temp: ' + data.temperature + '°C\na Energía: ' + charging);
                    } catch (e) { msg.reply(" Error decodificando estado de la batería."); }
                });
            } else {
                return msg.reply("  *Ejecutándose en Computadora de Escritorio (Windows).* Sistema de energía estable conectado a la red eléctrica.");
            }
            return;
        }

        // --- SISTEMA DE CÁMARA HÍBRIDO ---
        if (comando === 'foto' || comando === 'camara') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Bloqueado en grupos.");
            if (!isTermux) {
                return msg.reply("  *Ejecutándose en Windows:* Este comando (tomar foto con cámara interna) solo está disponible cuando el bot corre en Termux.");
            }
            await msg.reply("  Tomando foto...");
            const file = 'foto_' + Date.now() + '.jpg';
            exec('termux-camera-photo -c 0 ' + file, async (err) => {
                if (err) return msg.reply(" Revisa permisos de cámara en tu Android.");
                try {
                    const media = MessageMedia.fromFilePath(file);
                    await msg.reply(media);
                    fs.unlinkSync(file);
                } catch (e) { console.error(e); }
            });
            return;
        }

        // --- SISTEMA DE AUDIO HÍBRIDO (Convertidor FFmpeg de Termux) ---
        if (comando === 'grabar' || comando === 'escuchar') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Bloqueado en grupos por privacidad.");
            if (!isTermux) {
                return msg.reply("  *Ejecutándose en Windows:* Este comando (grabar micrófono ambiental) solo está disponible cuando el bot corre en Termux.");
            }
            const segundos = Math.min(parseInt(argumento) || 10, 30);
            await msg.reply('" Grabando ' + segundos + ' segundos de audio...');

            const timestamp = Date.now();
            const fileCrudo = path.join(__dirname, 'crudo_' + timestamp + '.m4a');
            const fileMp3 = path.join(__dirname, 'audio_' + timestamp + '.mp3');

            exec('termux-microphone-record -q', () => {
                exec('termux-microphone-record -f "' + fileCrudo + '" -d ' + segundos);
                setTimeout(() => {
                    exec('termux-microphone-record -q', () => {
                        if (fs.existsSync(fileCrudo)) {
                            exec(`ffmpeg -y -i "${fileCrudo}" "${fileMp3}"`, async (error) => {
                                try {
                                    if (fs.existsSync(fileMp3)) {
                                        const media = MessageMedia.fromFilePath(fileMp3);
                                        await msg.reply(media);
                                        fs.unlinkSync(fileMp3);
                                    } else {
                                        await msg.reply(" Error al convertir el audio en Termux.");
                                    }
                                    fs.unlinkSync(fileCrudo);
                                } catch (e) { console.error(e); }
                            });
                        } else {
                            msg.reply(" No se generó el archivo de grabación en Termux.");
                        }
                    });
                }, (segundos * 1000) + 500);
            });
            return;
        }

        if (comando === 'videos' || comando === 'ultimosvideos' || comando === 'novedades' || comando === 'verificarcanales' || comando === 'ytvideos' || comando === 'revisarcanales') {
            if (canalesYoutube.length === 0) {
                return msg.reply(" *Asistente:* No hay canales registrados en el sistema de seguimiento.\n\n_Puedes registrar uno con:_\n`!bot agregarcanal <enlace, @canal o nombre>`");
            }

            await msg.reply(" *Asistente:* Consultando los últimos videos de tus canales de YouTube...");

            // Si se especificó un canal por nombre o índice
            if (argumento) {
                let canalTarget = null;
                const idx = parseInt(argumento, 10) - 1;
                if (!isNaN(idx) && idx >= 0 && idx < canalesYoutube.length) {
                    canalTarget = canalesYoutube[idx];
                } else {
                    const argLower = argumento.toLowerCase();
                    canalTarget = canalesYoutube.find(c => c.nombre.toLowerCase().includes(argLower) || c.id === argumento);
                }

                if (!canalTarget) {
                    // Si no está en la lista guardada, buscarlo directamente en YouTube
                    const foundId = await obtenerIdCanal(argumento);
                    if (foundId) {
                        canalTarget = { id: foundId, nombre: argumento };
                    }
                }

                if (!canalTarget) {
                    return msg.reply(` *Asistente:* No encontré el canal "${argumento}". Escribe *!bot canales* para ver tu lista.`);
                }

                const info = await obtenerUltimosVideosCanal(canalTarget.id, 5);
                if (!info || !info.videos || info.videos.length === 0) {
                    return msg.reply(` *Asistente:* No se encontraron videos recientes en el canal *${canalTarget.nombre}*.`);
                }

                let respuesta = ` *ÚLTIMOS VIDEOS DE ${info.canalNombre.toUpperCase()}:*\n\n`;
                info.videos.forEach((v, i) => {
                    const f = v.fecha ? ` _(${v.fecha})_` : '';
                    respuesta += `*${i + 1}.* *${v.titulo}*${f}\n ${v.link}\n\n`;
                });
                respuesta += `_Para descargar un video escribe: *!bot video <enlace>*_`;
                return msg.reply(respuesta);
            }

            // Consultar todos los canales registrados
            let respuesta = ` *ÚLTIMOS VIDEOS DE TUS CANALES DE YOUTUBE:*\n\n`;
            let totalEncontrados = 0;

            for (const canal of canalesYoutube) {
                const info = await obtenerUltimosVideosCanal(canal.id, 2);
                if (info && info.videos && info.videos.length > 0) {
                    totalEncontrados++;
                    canal.nombre = info.canalNombre;
                    canal.ultimoVideo = info.videos[0].link;

                    respuesta += ` *${info.canalNombre}*\n`;
                    info.videos.forEach(v => {
                        const f = v.fecha ? ` _(${v.fecha})_` : '';
                        respuesta += `• *${v.titulo}*${f}\n   ${v.link}\n`;
                    });
                    respuesta += '\n';
                }
            }

            guardarCanales();

            if (totalEncontrados === 0) {
                return msg.reply(" *Asistente:* No se pudieron obtener videos recientes de los canales registrados en este momento.");
            }

            respuesta += `_Para descargar cualquiera de ellos escribe: *!bot video <enlace>*_`;
            return msg.reply(respuesta);
        }

        if (comando === 'setcanal' || comando === 'canal' || comando === 'agregarcanal') {
            if (!argumento) return msg.reply(" *Asistente:* Proporcione el enlace, @handle, ID o nombre del canal de YouTube.\n_Ejemplo:_ `!bot agregarcanal @mkbhd` o `!bot agregarcanal MrBeast`");
            await msg.reply(" *Asistente:* Localizando canal en YouTube...");
            const nuevoId = await obtenerIdCanal(argumento);
            if (nuevoId) {
                if (canalesYoutube.some(c => c.id === nuevoId)) {
                    return msg.reply(" *Asistente:* Ese canal ya se encuentra en tu lista de seguimiento.");
                }
                const infoCanal = await obtenerUltimosVideosCanal(nuevoId, 1);
                const nombreCanal = infoCanal?.canalNombre || 'Canal de YouTube';
                const ultimoVid = infoCanal?.videos?.[0]?.link || '';
                
                canalesYoutube.push({
                    id: nuevoId,
                    nombre: nombreCanal,
                    ultimoVideo: ultimoVid,
                    chatId: chatId
                });
                guardarCanales();
                
                let respuesta = ` *Asistente:* ¡Canal agregado con éxito!\n\n *${nombreCanal}*\n🆔 \`${nuevoId}\``;
                if (infoCanal && infoCanal.videos && infoCanal.videos.length > 0) {
                    const v = infoCanal.videos[0];
                    respuesta += `\n\n *Último video publicado:*\n• *${v.titulo}*\n ${v.link}`;
                }
                respuesta += `\n\n_Escribe *!bot videos* para consultar novedades de tus canales._`;
                return msg.reply(respuesta);
            }
            return msg.reply(" *Asistente:* No pude encontrar el canal de YouTube. Asegúrate de ingresar un enlace válido, usuario (@handle) o nombre del canal.");
        }

        if (comando === 'listacanal' || comando === 'canales') {
            if (canalesYoutube.length === 0) {
                return msg.reply(" *Asistente:* No hay canales registrados en el sistema de seguimiento.\n_Agrega uno con:_ `!bot agregarcanal <enlace, @canal o nombre>`");
            }
            let lista = ` *CANALES DE YOUTUBE EN SEGUIMIENTO:*\n\n`;
            canalesYoutube.forEach((c, index) => {
                const ult = c.ultimoVideo ? `\n    Último: ${c.ultimoVideo}` : '';
                lista += `*${index + 1}.* *${c.nombre}*\n   🆔: \`${c.id}\`${ult}\n\n`;
            });
            lista += `_Para consultar videos recientes: *!bot videos*_\n_Para eliminar un canal: *!bot borrarcanal <número>*_`;
            return msg.reply(lista);
        }

        if (comando === 'reiniciar' || comando === 'restart' || comando === 'reboot') {
            if (!esAdmin(chatId, msg)) {
                return msg.reply("*Asistente:* Comando restringido al administrador.");
            }
            await msg.reply("*Asistente:* Reiniciando sistemas... El servicio se restablecerá automáticamente en unos segundos.");
            console.log('[REINICIO] Solicitado por el administrador. Guardando estado y finalizando proceso para reinicio limpio...');
            
            try {
                fs.writeFileSync('reinicio_pendiente.json', JSON.stringify({
                    chatId: chatId || adminChatId || '50378419704@c.us',
                    timestamp: Date.now()
                }, null, 2));
            } catch(e) {
                console.error('[REINICIO] No se pudo guardar reinicio_pendiente.json:', e.message);
            }

            setTimeout(async () => {
                const isUnderPM2 = process.env.pm_id !== undefined || process.env.PM2_HOME || fs.existsSync('/home/ubuntu/.pm2');
                if (isUnderPM2) {
                    try { await client.destroy(); } catch(e){}
                    process.exit(0);
                } else {
                    const child = spawn(process.argv[0], process.argv.slice(1), {
                        detached: true,
                        stdio: 'inherit'
                    });
                    child.unref();
                    try { await client.destroy(); } catch(e){}
                    process.exit(0);
                }
            }, 1000);
            return;
        }

        if (comando === 'borrarcanal' || comando === 'eliminarcanal') {
            if (!argumento) return msg.reply(" *Asistente:* Especifique el número del canal que desea eliminar. Use *!bot canales* para ver la lista.");
            const indice = parseInt(argumento) - 1;
            if (isNaN(indice) || indice < 0 || indice >= canalesYoutube.length) {
                return msg.reply(" *Asistente:* Número de índice fuera de rango o inválido.");
            }
            const eliminado = canalesYoutube.splice(indice, 1)[0];
            guardarCanales();
            return msg.reply(` *Asistente:* Se ha eliminado el canal *${eliminado.nombre}* de la lista.`);
        }

        if (comando === 'clima') {
            const ciudad = (argumento || 'Chalchuapa').trim();
            if (ciudad.toLowerCase().includes('radar') || ciudad.toLowerCase().includes('snet')) {
                await msg.reply('Conectando con los radares del SNET...');
                try {
                    const pupBrowser = client.pupBrowser;
                    if (!pupBrowser) throw new Error("Puppeteer no está disponible en este entorno.");
                    const page = await pupBrowser.newPage();
                    await page.setViewport({ width: 800, height: 600 });
                    await page.goto('https://www.snet.gob.sv/googlemaps/radares/radaresSV8.php', { waitUntil: 'networkidle0', timeout: 15000 });
                    await new Promise(r => setTimeout(r, 2000));
                    const screenshotPath = 'radar_' + Date.now() + '.png';
                    await page.screenshot({ path: screenshotPath });
                    await page.close();
                    const media = MessageMedia.fromFilePath(screenshotPath);
                    await msg.reply(media, undefined, { caption: 'Radar Meteorológico SNET en vivo' });
                    if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
                    return;
                } catch (e) {
                    console.error('Error capturando radar:', e);
                    return await msg.reply('Error al obtener el radar visual del SNET: ' + e.message);
                }
            }

            const reporte = await obtenerReporteClima(ciudad);
            return msg.reply(reporte);
        }

        // DESCARGAS MULTIMEDIA CON PREVENCI N DE INYECCI N DE COMANDOS (Soporte YouTube, TikTok, Instagram, Twitter/X, etc.)
        // --- BUSCAR CANCI N POR NOMBRE (sin enlace) ---
        if (comando === 'cancion' || comando === 'buscarcancion' || comando === 'song') {
            if (!argumento) return msg.reply(' *Asistente:* Especifica el nombre de la canción y el artista. Ej: *!bot cancion Blinding Lights | The Weeknd*');
            const partsC = argumento.split('|');
            const cancionQuery = partsC[0]?.trim() || argumento;
            const artistaQuery = partsC[1]?.trim() || '';
            const queryFull = artistaQuery ? `${cancionQuery} ${artistaQuery}` : cancionQuery;
            await msg.reply(` *Asistente:* Buscando *"${cancionQuery}"${artistaQuery ? ' de *' + artistaQuery + '*' : ''}* en la red... Un momento.`);
            const outputAudio = 'musica_' + Date.now() + '.mp3';
            const ffmpegDirAudio = getFfmpegLocation();
            const searchArgs = [
                '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                '--embed-thumbnail', '--add-metadata',
                '-o', outputAudio,
                `ytsearch1:${queryFull}`
            ];
            if (ffmpegDirAudio) searchArgs.unshift('--ffmpeg-location', ffmpegDirAudio);

            const child = spawn(getYtDlpBinary(), searchArgs, { shell: false });
            child.on('error', () => msg.reply(' *Asistente:* yt-dlp no disponible. Instala con: pip install yt-dlp').catch(()=>{}));
            child.on('close', async (code) => {
                const possibleFile = fs.existsSync(outputAudio) ? outputAudio : outputAudio.replace('.mp3','') + '.mp3';
                if (code !== 0 || !fs.existsSync(possibleFile) || fs.statSync(possibleFile).size < 10000) {
                    if (fs.existsSync(possibleFile)) try { fs.unlinkSync(possibleFile); } catch(e){}
                    return msg.reply(` *Asistente:* No encontré esa canción. Verifica el nombre: *"${queryFull}"*`);
                }
                try {
                    const media = MessageMedia.fromFilePath(possibleFile);
                    await msg.reply(media, undefined, { sendMediaAsDocument: false });
                    if (fs.existsSync(possibleFile)) fs.unlinkSync(possibleFile);
                } catch (err) {
                    console.error('[!] Error enviando canción:', err);
                    msg.reply(' *Asistente:* Error al enviar el archivo de audio.').catch(()=>{});
                }
            });
            return;
        }

        if (comando === 'audio' || comando === 'musica') {
            if (!argumento.includes('http')) return msg.reply(" *Asistente:* Por favor, proporcione un enlace de audio válido.");
            
            try {
                new URL(argumento);
            } catch (e) {
                return msg.reply(" *Asistente:* La URL proporcionada tiene un formato incorrecto.");
            }

            await msg.reply(' *Asistente:* Procesando y extrayendo audio de alta fidelidad, un momento...');
            const outputFile = 'audio_' + Date.now() + '.mp3';
            const ffmpegDirAudio = getFfmpegLocation();
            const audioArgs = ['-x', '--audio-format', 'mp3', '-o', outputFile, argumento];
            if (ffmpegDirAudio) audioArgs.unshift('--ffmpeg-location', ffmpegDirAudio);
            
            const child = spawn(getYtDlpBinary(), audioArgs, { shell: false });
            
            child.on('error', (err) => {
                console.error('[!] Error en yt-dlp:', err);
                return msg.reply(" *Asistente:* No he podido iniciar el proceso. Verifique si yt-dlp está configurado en su sistema.");
            });

            child.on('close', async (code) => {
                if (code !== 0 || !fs.existsSync(outputFile) || fs.statSync(outputFile).size < 10000) {
                    if (fs.existsSync(outputFile)) try { fs.unlinkSync(outputFile); } catch(e){}
                    return msg.reply(" *Asistente:* El servidor de descargas falló o el enlace es incorrecto.");
                }
                try {
                    if (fs.existsSync(outputFile)) {
                        const media = MessageMedia.fromFilePath(outputFile);
                        await msg.reply(media);
                        fs.unlinkSync(outputFile);
                    } else {
                        await msg.reply(" *Asistente:* Archivo de audio no encontrado tras la compilación.");
                    }
                } catch (e) {
                    console.error('[!] Error enviando audio:', e);
                }
            });
            return;
        }

        const esTikTokLink = textoOriginal.includes('tiktok.com') || textoOriginal.includes('vm.tiktok') || textoOriginal.includes('vt.tiktok');
        const esInstagramLink = textoOriginal.includes('instagram.com') || textoOriginal.includes('instagr.am');
        const esFacebookLink = textoOriginal.includes('facebook.com') || textoOriginal.includes('fb.watch') || textoOriginal.includes('fb.com');
        const esYouTubeLink = textoOriginal.includes('youtube.com') || textoOriginal.includes('youtu.be');
        const esTwitterLink = textoOriginal.includes('twitter.com') || textoOriginal.includes('x.com');
        const esComandoDescarga = ['video', 'tiktok', 'descarga', 'descargar', 'bajar', 'mp4', 'reel', 'reels', 'ig', 'fb'].includes(comando);

        const contieneEnlaceVideo = esTikTokLink || esInstagramLink || esFacebookLink || esYouTubeLink || esTwitterLink;

        if (esComandoDescarga || (contieneEnlaceVideo && (usaPrefijo || /descarg|baj|vide|reel/i.test(textoOriginal)))) {
            const urlMatch = (argumento || textoOriginal).match(/(https?:\/\/[^\s]+)/);
            const videoUrl = urlMatch ? urlMatch[1] : argumento;
            await descargarYEnviarVideo(videoUrl, msg);
            return;
        }

        // --- COMANDO PING ---
        if (comando === 'ping') {
            const start = Date.now();
            await msg.reply('x*Asistente:* Pong! Latencia: *' + (Date.now() - start) + 'ms*   Todos los sistemas operativos.');
            return;
        }

        // --- COMANDO FRASE MOTIVACIONAL ---
        if (comando === 'frase') {
            try {
                const fraseRes = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent(['Genera una frase motivacional corta, elegante e inteligente al estilo de JARVIS de Iron Man. En español. Solo la frase, sin introducción ni explicación. Máximo 2 líneas.']);
                    return result.response.text();
                });
                return msg.reply('  ' + limpiarRespuestaGemini(fraseRes));
            } catch(e) {
                return msg.reply('  *"El éxito no es un destino, sino el resultado de tomar la decisión correcta, momento a momento."*');
            }
        }

        // --- COMANDO ACTUALIZAR ---
        if (comando === 'actualizar') {
            if (!esAdminPrivado) return msg.reply('xa *Asistente:* Comando exclusivo del administrador.');
            await msg.reply(' *Asistente:* Iniciando protocolos de actualización del sistema...');
            const updateLog = [];
            const runUpd = (cmd, args) => new Promise((resolve) => {
                const p = spawn(cmd, args, { shell: true });
                let out = '';
                p.stdout.on('data', (d) => { out += d.toString(); });
                p.stderr.on('data', (d) => { out += d.toString(); });
                p.on('close', (code) => resolve({ code, out }));
                p.on('error', () => resolve({ code: -1, out: 'no disponible' }));
            });
            
            const npmRes = await runUpd('npm', ['update', '--save']);
            updateLog.push((npmRes.code === 0 ? 'S&' : 'a') + ' npm update: ' + (npmRes.code === 0 ? 'OK' : 'Error/Advertencia'));
            
            const ytdlpRes = await runUpd(getYtDlpBinary(), ['-U']);
            updateLog.push((ytdlpRes.code === 0 ? 'S&' : 'a') + ' yt-dlp: ' + (ytdlpRes.out.includes('up-to-date') || ytdlpRes.out.includes('Updated') ? 'Actualizado' : 'Error/No disponible'));
            
            const pipRes = await runUpd('pip', ['install', '--upgrade', 'yt-dlp', '--quiet']);
            updateLog.push((pipRes.code === 0 ? 'S&' : 'a') + ' pip yt-dlp: ' + (pipRes.code === 0 ? 'Actualizado' : 'No disponible'));
            
            return msg.reply(' *Reporte de Actualización Asistente:*\n\n' + updateLog.join('\n') + '\n\n_Sistema revisado y optimizado._');
        }


        // --- MÓDULO CONFIGURACIÓN DE VOZ (TTS) ---
        if (comando === 'voz' || comando === 'setvoz') {
            const arg = (argumento || '').toLowerCase().trim();
            if (!arg) {
                const nombreVozActual = vozDefault === 'mujer' ? 'Femenina  (Lorena Neural)' : 'Masculina  (Rodrigo Neural)';
                return msg.reply(` *CONFIGURACIÓN DE VOZ ASISTENTE:*
• *Voz predeterminada actual:* ${nombreVozActual}

*¿Cómo cambiar la voz por defecto?*
• \`!bot voz hombre\` - Establece voz masculina por defecto.
• \`!bot voz mujer\` - Establece voz femenina por defecto.

*¿Cómo dictar audios eligiendo la voz al instante?*
• \`!bot decir hombre <texto>\` (o \`!bot decir h <texto>\`)
• \`!bot decir mujer <texto>\` (o \`!bot decir m <texto>\`)
• \`!bot decir <texto>\` (usa la voz predeterminada actual)`);
            }

            if (/^(hombre|h|masculino|male)$/i.test(arg)) {
                vozDefault = 'hombre';
                guardarAdminJson();
                return msg.reply(" *Asistente:* Voz predeterminada configurada en *Masculina*  (Rodrigo Neural).");
            } else if (/^(mujer|m|femenino|female)$/i.test(arg)) {
                vozDefault = 'mujer';
                guardarAdminJson();
                return msg.reply(" *Asistente:* Voz predeterminada configurada en *Femenina*  (Lorena Neural).");
            } else {
                return msg.reply(" *Asistente:* Opción no válida. Escriba *!bot voz hombre* o *!bot voz mujer*.");
            }
        }

        // --- MÓDULO SÍNTESIS DE VOZ (TTS DUAL: HOMBRE / MUJER) ---
        if (comando === 'decir' || comando === 'tts' || comando === 'decirhombre' || comando === 'decirmujer') {
            if (!argumento) {
                return msg.reply(" *Asistente:* Especifique el texto que desea que dicte.\n\n_Ejemplos:_\n• `!bot decir hombre Buenos días a todos`\n• `!bot decir mujer Buenos días a todos`\n• `!bot decir Buenos días` (usa la voz activa)");
            }

            let textoFinal = argumento.trim();
            let generoVoz = vozDefault || 'hombre';

            if (comando === 'decirhombre') {
                generoVoz = 'hombre';
            } else if (comando === 'decirmujer') {
                generoVoz = 'mujer';
            } else {
                const matchPrefijo = textoFinal.match(/^(?:voz\s*(?:de\s*)?)?(hombre|masculino|h|mujer|femenino|m|-h|-m)[:\s]+([\s\S]+)$/i);
                if (matchPrefijo) {
                    const selector = matchPrefijo[1].toLowerCase().replace('-', '');
                    if (/^(h|hombre|masculino)$/.test(selector)) {
                        generoVoz = 'hombre';
                        textoFinal = matchPrefijo[2].trim();
                    } else if (/^(m|mujer|femenino)$/.test(selector)) {
                        generoVoz = 'mujer';
                        textoFinal = matchPrefijo[2].trim();
                    }
                }
            }

            if (!textoFinal) {
                return msg.reply(" *Asistente:* Especifique el texto que desea que dicte.");
            }

            const etiquetaVoz = generoVoz === 'mujer' ? 'femenina ' : 'masculina ';
            await msg.reply(` *Asistente:* Generando modulación de voz ${etiquetaVoz}...`);
            const ttsExito = await generarAudioTTS(textoFinal, msg, generoVoz);
            if (!ttsExito) {
                return msg.reply(" *Asistente:* Error interno en el módulo de sintetización de audio.");
            }
            return;
        }

        // --- COMANDO DE AYUDA / MENÚ INTERACTIVO ---
        if (comando === 'ayuda' || comando === 'menu' || comando === 'help' || comando === 'comandos') {
            if (argumento) {
                const detalle = obtenerDetalleAyuda(argumento);
                if (detalle) return msg.reply(detalle);
            }

            esperandoAyudaOpcion.set(chatId, true);
            const menuMenu = ` *CENTRO DE CONTROL ASISTENTE v6.0*

Señor Geovanny, seleccione una de las siguientes opciones respondiendo con el *número (1-8)* o usando \`!bot ayuda <número>\`:

1⃣  *Finanzas King & Tarjetas* (Saldos, tarjetas, vencimientos, estados de cuenta)
2⃣  *Flyers, Canva & Diseño* (Plantillas Canva, imágenes IA, stickers)
3⃣  *Memoria y Base Personal* (Guardar notas, datos personales, memoria)
4⃣  *Tareas y Recordatorios* (Programar acciones automáticas, alarmas)
5⃣  *YouTube y Descargas* (Seguimiento de canales, descargar MP3 y MP4)
6⃣  *Agentes de IA y Chat* (Modos de asistente, traductor, búsquedas)
7⃣  *Ajustes y Conexiones* (Telegram, OpenAI, Gemini API, batería, servidor)
8⃣  *Utilidades y Herramientas* (Tareas pendientes, clima, QR, divisas, calculadora)

 *Control de Energía:*
• \`!bot apagar\` - Pausar respuestas automáticas.
• \`!bot encender\` - Reactivar el bot.

_ Escriba del *1* al *8* para ver los comandos detallados de cada módulo._`;
            return msg.reply(menuMenu);
        }

        // --- NUEVAS IDEAS: GENERACIN DE STICKER CON IA ---
        if (comando === 'stickercrear') {
            if (!argumento) return msg.reply(" *Asistente:* Indíqueme la idea para generar la imagen de su sticker.");
            await msg.reply(" *Asistente:* Generando diseño del sticker con IA...");
            try {
                const stickerPromptExpansion = `Create a detailed, beautiful, and modern English prompt for a WhatsApp sticker based on the following idea: '${argumento}'. The prompt MUST specify: "vector sticker style, isolated on a clean solid white background, die-cut, bold outlines, vibrant colors, clean minimal design, cute or modern cartoon style, 3D look or clean 2D vector, no text unless requested". Respond ONLY with the prompt, no introduction, no quotes:\n\n${argumento}`;
                let promptMejorado = argumento;
                try {
                    const resultText = await ejecutarGeminiConRetries(async (model) => {
                        const result = await model.generateContent([stickerPromptExpansion]);
                        return result.response.text();
                    });
                    if (resultText && resultText.trim()) {
                        promptMejorado = resultText.trim();
                        console.log(`[ Sticker Prompt]: ${promptMejorado}`);
                    }
                } catch (e) {
                    console.error("No se pudo expandir el prompt del sticker:", e);
                }

                const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(promptMejorado) + '?width=512&height=512&nologo=true&model=flux';
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                const media = new MessageMedia('image/jpeg', base64, 'sticker.jpg');
                await msg.reply(media, msg.from, { sendMediaAsSticker: true, stickerName: 'Kinbot VIP', stickerAuthor: 'Geovanny' });
            } catch (e) {
                return msg.reply(" *Asistente:* Error en los servidores gráficos al renderizar el sticker.");
            }
            return;
        }

        // --- NUEVAS IDEAS: TRADUCTOR ---
        if (comando === 'traducir') {
            const parts = argumento.split(' ');
            const idiomaDestino = parts[0];
            const textoATraducir = parts.slice(1).join(' ');
            if (!idiomaDestino || !textoATraducir) {
                return msg.reply(" *Asistente:* Uso correcto: *!bot traducir <idioma> <texto>*. Ejemplo: *!bot traducir ingles Hola mundo*");
            }
            await msg.reply(`xR *Asistente:* Traducción en proceso al ${idiomaDestino}...`);
            try {
                const prompt = `Traduce el siguiente texto al idioma "${idiomaDestino}". Responde aNICAMENTE con la traducción limpia, sin comentarios adicionales ni comillas:\n\n${textoATraducir}`;
                const respuesta = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([prompt]);
                    return result.response.text();
                });
                const respuestaLimpia = limpiarRespuestaGemini(respuesta);
                return msg.reply(respuestaLimpia);
            } catch (e) {
                return msg.reply(" *Asistente:* Ocurrió un error al intentar traducir.");
            }
        }

        // --- NUEVAS IDEAS: CALCULADORA ---
        if (comando === 'calcular') {
            if (!argumento) return msg.reply(" *Asistente:* Especifique la operation matemática. Ejemplo: *!bot calcular 2 + 2 * (10 / 5)*");
            const expression = argumento.replace(/\s+/g, '');
            const isSafe = /^[0-9+\-*/().%]+$/.test(expression);
            if (!isSafe) {
                return msg.reply(" *Asistente:* Operación no válida. Solo se permiten números y los operadores básicos (+, -, *, /, %, (, )).");
            }
            try {
                const result = new Function(`return (${expression})`)();
                return msg.reply(` *Asistente:* El resultado es: *${result}*`);
            } catch (e) {
                return msg.reply(" *Asistente:* Error matemático en la expresión ingresada.");
            }
        }

        // --- NUEVAS IDEAS: RESUMIDOR WEB ---
        // --- NUEVAS IDEAS: RESUMIDOR WEB O DE PDF ---
        if (comando === 'resumir') {
            let mensajeConDoc = mensajeAProcesar;
            if (mensajeConDoc.hasMedia && mensajeConDoc.mimetype === 'application/pdf') {
                await msg.reply("x *Asistente:* Leyendo y resumiendo documento PDF, un momento...");
                try {
                    const media = await descargarMediaSeguro(mensajeConDoc);
                    if (media && media.data) {
                        const prompt = "Realiza un resumen estructurado, claro y elegante en español de este documento PDF. Enfócate en los puntos principales.";
                        const respuesta = await ejecutarGeminiConRetries(async (model) => {
                            const result = await model.generateContent([
                                prompt,
                                { inlineData: { data: media.data, mimeType: media.mimetype } }
                            ]);
                            return result.response.text();
                        });
                        const respuestaLimpia = limpiarRespuestaGemini(respuesta);
                        return msg.reply(respuestaLimpia);
                    }
                } catch (e) {
                    console.error("Error resumiendo PDF:", e);
                    return msg.reply(" *Asistente:* Ocurrió un error al procesar el documento PDF.");
                }
            }

            if (!argumento || !argumento.includes('http')) {
                return msg.reply(" *Asistente:* Por favor proporcione una URL para resumir, o responda a un archivo PDF con *!bot resumir*.");
            }
            try {
                new URL(argumento);
            } catch(e) {
                return msg.reply(" *Asistente:* Enlace inválido.");
            }
            await msg.reply("x *Asistente:* Extrayendo y analizando contenido web para su resumen...");
            try {
                const response = await fetch(argumento, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                const html = await response.text();
                const cleanText = html
                    .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
                    .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .substring(0, 5000);
                    
                const prompt = `Realiza un resumen estructurado en viñetas del siguiente contenido web de forma concisa y elegante:\n\n${cleanText}`;
                const respuesta = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([prompt]);
                    return result.response.text();
                });
                const respuestaLimpia = limpiarRespuestaGemini(respuesta);
                return msg.reply(respuestaLimpia);
            } catch (e) {
                console.error("Error al resumir:", e);
                return msg.reply(" *Asistente:* No se pudo recuperar el contenido web de esa dirección.");
            }
        }

        // --- TELEMETRÍA RÁPIDA DEL SISTEMA ---
        if (comando === 'sistema' || comando === 'hardware') {
            const platform = os.platform();
            const arch = os.arch();
            const cpuModel = os.cpus()[0]?.model || "ARM64";
            const cpuCores = os.cpus().length;
            const totalRAM = (os.totalmem() / (1024 ** 3)).toFixed(2);
            const freeRAM = (os.freemem() / (1024 ** 3)).toFixed(2);
            const usedRAM = (totalRAM - freeRAM).toFixed(2);
            const ramPct = (((totalRAM - freeRAM) / totalRAM) * 100).toFixed(1);
            
            const formatTime = (seconds) => {
                const h = Math.floor(seconds / 3600);
                const m = Math.floor((seconds % 3600) / 60);
                const s = Math.floor(seconds % 60);
                return `${h}h ${m}m ${s}s`;
            };
            
            const sysUptime = formatTime(os.uptime());
            const jarvisUptime = formatTime(process.uptime());
            const heapMB = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1);

            let statusReport = `*TELEMETRÍA DEL SISTEMA*\n\n`;
            statusReport += `*Asistente:* Activo y Operativo\n`;
            statusReport += `*PID:* ${process.pid} | *Heap:* ${heapMB} MB\n`;
            statusReport += `*Plataforma:* ${platform === 'win32' ? 'Windows' : 'Ubuntu Linux ARM64 (VPS Oracle)'}\n`;
            statusReport += `*Arquitectura:* ${arch}\n`;
            statusReport += `*Procesador:* ${cpuModel} (${cpuCores} núcleos)\n`;
            statusReport += `*Memoria RAM:* ${usedRAM} GB en uso de ${totalRAM} GB (${ramPct}% en uso, ${freeRAM} GB libres)\n`;
            statusReport += `*Uptime Servidor:* ${sysUptime}\n`;
            statusReport += `*Uptime Asistente:* ${jarvisUptime}\n`;
            
            if (isTermux) {
                exec('termux-battery-status', async (err, stdout) => {
                    if (!err) {
                        try {
                            const data = JSON.parse(stdout);
                            const charging = data.status === 'CHARGING' ? 'Conectado' : 'Desconectado';
                            statusReport += `*Energía:* ${charging} (Nivel: ${data.percentage}%, Temp: ${data.temperature}°C)\n`;
                        } catch(e) {}
                    }
                    await msg.reply(statusReport);
                });
            } else {
                statusReport += `*Energía:* Red Eléctrica Directa (VPS)\n`;
                await msg.reply(statusReport);
            }
            return;
        }

        // --- DIAGNÓSTICO INTEGRAL Y AUDITORÍA DE SUBSISTEMAS ---
        if (comando === 'diagnostico' || comando === 'audit' || comando === 'test') {
            await msg.reply("*Asistente:* Ejecutando auditoría de subsistemas en tiempo real...");
            
            // 1. Motor de IA (Gemini)
            let aiStatus = "No disponible";
            let aiOk = false;
            try {
                const t0 = Date.now();
                const modeloPrueba = obtenerModel();
                await modeloPrueba.generateContent("ping");
                const latenciaAi = Date.now() - t0;
                aiStatus = `Operativo (${MODELS[currentModelIndex]}, Latencia: ${latenciaAi}ms, Claves: ${API_KEYS.length})`;
                aiOk = true;
            } catch (e) {
                aiStatus = `Falla: ${e.message ? e.message.split('\n')[0] : 'Error desconocido'}`;
            }

            // 2. Extractor Multimedia (yt-dlp, Deno, Cookies)
            let mediaItems = [];
            try {
                const { execSync } = require('child_process');
                const ytVer = execSync(`${getYtDlpBinary()} --version`, { timeout: 3000, stdio: 'pipe' }).toString().trim();
                mediaItems.push(`yt-dlp v${ytVer}`);
            } catch(e) {
                mediaItems.push('yt-dlp: No detectado');
            }

            try {
                const { execSync } = require('child_process');
                const denoBin = fs.existsSync('/usr/local/bin/deno') ? '/usr/local/bin/deno' : 'deno';
                const denoVer = execSync(`${denoBin} --version`, { timeout: 3000, stdio: 'pipe' }).toString().split('\n')[0].trim();
                mediaItems.push(denoVer);
            } catch(e) {
                mediaItems.push('Deno: No detectado');
            }

            const snapChromium = '/home/ubuntu/snap/chromium/common/chromium';
            if (fs.existsSync(snapChromium)) {
                mediaItems.push('Cookies Chromium configuradas');
            } else {
                mediaItems.push('Sin cookies externas');
            }
            const mediaReport = mediaItems.join(' | ');

            // 3. Base de Datos (Firebase Firestore)
            let dbStatus = "No inicializada";
            if (dbFirebase) {
                try {
                    const tDb0 = Date.now();
                    await dbFirebase.collection('usuarios').limit(1).get();
                    const latenciaDb = Date.now() - tDb0;
                    dbStatus = `Conectado a Firestore (Latencia: ${latenciaDb}ms)`;
                } catch(e) {
                    dbStatus = `Falla de lectura: ${e.message ? e.message.split('\n')[0] : 'Error'}`;
                }
            } else {
                dbStatus = "Desconectado (serviceAccount.json no presente)";
            }

            // 4. Recursos del Servidor
            const totalRAM = (os.totalmem() / (1024 ** 3)).toFixed(2);
            const freeRAM = (os.freemem() / (1024 ** 3)).toFixed(2);
            const usedRAM = (totalRAM - freeRAM).toFixed(2);
            const ramPct = (((totalRAM - freeRAM) / totalRAM) * 100).toFixed(1);
            const cpuModel = os.cpus()[0]?.model || "ARM64";
            const cpuCores = os.cpus().length;
            const loadAvg = os.loadavg ? os.loadavg().map(l => l.toFixed(2)).join(', ') : 'N/A';

            const formatTime = (seconds) => {
                const h = Math.floor(seconds / 3600);
                const m = Math.floor((seconds % 3600) / 60);
                const s = Math.floor(seconds % 60);
                return `${h}h ${m}m ${s}s`;
            };
            const sysUptime = formatTime(os.uptime());
            const botUptime = formatTime(process.uptime());
            const heapMB = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1);

            let diskInfo = 'N/A';
            try {
                const { execSync } = require('child_process');
                const dfOutput = execSync('df -h / | tail -1', { timeout: 2000, stdio: 'pipe' }).toString().trim().split(/\s+/);
                if (dfOutput.length >= 5) {
                    diskInfo = `${dfOutput[2]} usados de ${dfOutput[1]} (${dfOutput[4]} en uso, ${dfOutput[3]} libres)`;
                }
            } catch(e){}

            // 5. Conexión de WhatsApp
            const waUser = client.info?.wid?.user || 'Desconocido';
            const waName = client.info?.pushname || 'Asistente';

            let report = `*DIAGNÓSTICO INTEGRAL DEL SISTEMA*\n\n`;
            report += `*Estado General:* Operativo\n`;
            report += `*Plataforma:* ${os.platform() === 'win32' ? 'Windows' : 'Ubuntu Linux ARM64 (VPS Oracle)'}\n`;
            report += `*Proceso:* PID ${process.pid} | Uptime: ${botUptime} | Heap: ${heapMB} MB\n\n`;

            report += `*1. Inteligencia Artificial (Gemini):*\n`;
            report += `[${aiOk ? 'OK' : 'FALLO'}] ${aiStatus}\n\n`;

            report += `*2. Extractor Multimedia:*\n`;
            report += `[OK] ${mediaReport}\n\n`;

            report += `*3. Base de Datos (Firebase):*\n`;
            report += `[${dbStatus.startsWith('Conectado') ? 'OK' : 'INFO'}] ${dbStatus}\n\n`;

            report += `*4. Servidor y Recursos:*\n`;
            report += `- RAM: ${usedRAM} GB en uso de ${totalRAM} GB (${ramPct}% en uso, ${freeRAM} GB libres)\n`;
            report += `- CPU: ${cpuModel} (${cpuCores} núcleos, Carga: ${loadAvg})\n`;
            report += `- Disco: ${diskInfo}\n`;
            report += `- Uptime Servidor: ${sysUptime}\n\n`;

            report += `*5. Conexión WhatsApp:*\n`;
            report += `[OK] Sesión activa (${waName} - +${waUser})\n`;

            return msg.reply(report);
        }

        // --- VISOR DE LOGS Y ERRORES DEL SISTEMA ---
        if (comando === 'logs' || comando === 'log' || comando === 'errores' || comando === 'error') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply("*Asistente:* Comando restringido al administrador.");

            const esErrorLog = comando === 'errores' || comando === 'error' || (argumento && argumento.toLowerCase().includes('error'));
            let lineasSolicitadas = 15;
            const numMatch = (argumento || '').match(/\d+/);
            if (numMatch) {
                lineasSolicitadas = Math.min(Math.max(parseInt(numMatch[0], 10), 5), 40);
            }

            const logPath = esErrorLog 
                ? '/home/ubuntu/.pm2/logs/nuevo-bot-error.log'
                : '/home/ubuntu/.pm2/logs/nuevo-bot-out.log';

            let logContent = '';
            if (fs.existsSync(logPath)) {
                try {
                    const { execSync } = require('child_process');
                    logContent = execSync(`tail -n ${lineasSolicitadas} "${logPath}"`, { timeout: 3000, stdio: 'pipe' }).toString().trim();
                } catch(e) {
                    logContent = `Error al leer archivo de logs: ${e.message}`;
                }
            } else {
                logContent = `Archivo de log no disponible en: ${logPath}`;
            }

            if (!logContent) {
                logContent = 'El archivo de registros está actualmente vacío.';
            }

            // Limpiar códigos de escape ANSI
            logContent = logContent.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

            if (logContent.length > 2800) {
                logContent = logContent.slice(-2800);
            }

            const tipoTitulo = esErrorLog ? 'REGISTRO DE ERRORES' : 'REGISTRO DE ACTIVIDAD';
            const respuesta = `*${tipoTitulo} (Últimas ${lineasSolicitadas} líneas)*\n\n\`\`\`\n${logContent}\n\`\`\``;
            return msg.reply(respuesta);
        }

        // --- NUEVO COMANDO: GENERADOR QR ---
        if (comando === 'qr') {
            if (!argumento) return msg.reply(" *Asistente:* Ingrese el texto o enlace que desea codificar.");
            await msg.reply("x *Asistente:* Renderizando matriz de código QR...");
            try {
                const url = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(argumento)}`;
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                const media = new MessageMedia('image/png', base64, 'qr.png');
                await msg.reply(media);
            } catch (e) {
                console.error("Error generando QR:", e);
                return msg.reply(" *Asistente:* Servidor de codificación fuera de línea.");
            }
            return;
        }

        // --- COMANDO RECORDATORIOS / ALARMAS RELATIVAS ---
        if (comando === 'recordar' || comando === 'recordatorio') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply("Comando restringido al administrador");
            const parsed = parsearAlarma(argumento) || parsearAlarma(`en ${argumento}`);
            if (parsed) {
                return msg.reply(procesarNuevaAlarma(parsed, chatId));
            }
            return msg.reply("Uso: !bot recordar <minutos> <mensaje>\nEjemplo: !bot recordar 5 preparar examen");
        }

        // --- BASE DE CONOCIMIENTO Y MEMORIA PERSISTENTE ---
        if (comando === 'memoria' || comando === 'datos' || comando === 'recuerdos') {
            if (isGroup || !esAdmin(chatId, msg)) {
                return msg.reply(" Comando restringido al administrador en chat privado.");
            }

            if (argumento) {
                const parts = argumento.split(' ');
                const subCmd = parts[0].toLowerCase();
                const subArg = parts.slice(1).join(' ').trim();

                if (subCmd === 'guardar' || subCmd === 'add' || subCmd === 'set') {
                    if (!subArg) {
                        return msg.reply("*Asistente:* Uso correcto: `!bot memoria guardar <tema> : <información>`\n_Ejemplo:_ `!bot memoria guardar Wifi Casa : MiClave1234`");
                    }
                    let clave = 'Dato';
                    let valor = subArg;
                    if (subArg.includes(':')) {
                        const s = subArg.split(':');
                        clave = s[0].trim();
                        valor = s.slice(1).join(':').trim();
                    } else if (subArg.includes('=')) {
                        const s = subArg.split('=');
                        clave = s[0].trim();
                        valor = s.slice(1).join('=').trim();
                    }
                    const res = guardarDatoEnMemoria(clave, valor);
                    const claveCap = res.item.clave.charAt(0).toUpperCase() + res.item.clave.slice(1);
                    const label = res.accion === 'actualizado' ? 'REGISTRO ACTUALIZADO' : 'REGISTRO GUARDADO';
                    let rep = `*${label} EN MEMORIA*\n\n`;
                    rep += `• *Tema:* ${claveCap}\n`;
                    rep += `• *Información:* ${res.item.valor}\n`;
                    rep += `• *Fecha:* ${res.item.fecha}\n\n`;
                    rep += `_Dato archivado con éxito. Puedes consultármelo en cualquier momento en el chat o con !bot memoria._`;
                    return msg.reply(rep);
                }

                if (subCmd === 'borrar' || subCmd === 'del' || subCmd === 'olvidar') {
                    if (!subArg) return msg.reply("*Asistente:* Especifique el número o tema a borrar: `!bot memoria borrar <número/tema>`");
                    const el = eliminarDatoDeMemoria(subArg);
                    if (el) {
                        const claveCap = el.clave.charAt(0).toUpperCase() + el.clave.slice(1);
                        let rep = `*REGISTRO ELIMINADO DE MEMORIA*\n\n`;
                        rep += `• *Tema:* ${claveCap}\n`;
                        rep += `• *Información anterior:* ${el.valor}\n\n`;
                        rep += `_El dato ha sido retirado permanentemente de la base de memoria._`;
                        return msg.reply(rep);
                    }
                    return msg.reply(`*Asistente:* No se encontró ningún dato en memoria que coincida con "${subArg}".`);
                }

                if (subCmd === 'buscar' || subCmd === 'find') {
                    if (!subArg) return msg.reply("*Asistente:* Especifique el término de búsqueda: `!bot memoria buscar <palabra>`");
                    const q = subArg.toLowerCase();
                    const encontrados = memoriaGlobal.filter(m => m.clave.toLowerCase().includes(q) || m.valor.toLowerCase().includes(q));
                    return msg.reply(formatearListaMemoria(encontrados, `RESULTADOS DE BÚSQUEDA: "${subArg}"`));
                }
            }

            return msg.reply(formatearListaMemoria(memoriaGlobal));
        }

        if (comando === 'guardar' || comando === 'guardardato') {
            if (isGroup || !esAdmin(chatId, msg)) {
                return msg.reply("*Asistente:* Comando restringido al administrador en chat privado.");
            }
            if (!argumento) {
                return msg.reply("*Uso correcto:* `!bot guardar <tema> : <información>`\n\n*Ejemplos prácticos:*\n• `!bot guardar Talla de camisa : M`\n• `!bot guardar Wifi Oficina : ClaveSegura2026!`\n• `!bot guardar Cumpleaños : 15 de marzo`\n• `!bot guardar Cliente Juan : Tel 7777-8888, interesado en producto B`");
            }
            let clave = 'Dato Personal';
            let valor = argumento.trim();
            if (argumento.includes(':')) {
                const parts = argumento.split(':');
                clave = parts[0].trim();
                valor = parts.slice(1).join(':').trim();
            } else if (argumento.includes('=')) {
                const parts = argumento.split('=');
                clave = parts[0].trim();
                valor = parts.slice(1).join('=').trim();
            }
            const res = guardarDatoEnMemoria(clave, valor);
            const claveCap = res.item.clave.charAt(0).toUpperCase() + res.item.clave.slice(1);
            const label = res.accion === 'actualizado' ? 'REGISTRO ACTUALIZADO' : 'REGISTRO GUARDADO';
            let rep = `*${label} EN MEMORIA*\n\n`;
            rep += `• *Tema:* ${claveCap}\n`;
            rep += `• *Información:* ${res.item.valor}\n`;
            rep += `• *Fecha:* ${res.item.fecha}\n\n`;
            rep += `_Dato archivado con éxito. Puedes consultármelo en cualquier momento en el chat o con !bot memoria._`;
            return msg.reply(rep);
        }

        if (comando === 'olvidar' || comando === 'olvidardato') {
            if (isGroup || !esAdmin(chatId, msg)) {
                return msg.reply("*Asistente:* Comando restringido al administrador en chat privado.");
            }
            if (!argumento) return msg.reply("*Asistente:* Especifique el número o tema del dato que desea olvidar:\n`!bot olvidar <número o tema>`\n_Usa *!bot memoria* para ver la lista._");
            const el = eliminarDatoDeMemoria(argumento);
            if (el) {
                const claveCap = el.clave.charAt(0).toUpperCase() + el.clave.slice(1);
                let rep = `*REGISTRO ELIMINADO DE MEMORIA*\n\n`;
                rep += `• *Tema:* ${claveCap}\n`;
                rep += `• *Información anterior:* ${el.valor}\n\n`;
                rep += `_El dato ha sido retirado permanentemente de la base de memoria._`;
                return msg.reply(rep);
            }
            return msg.reply(`*Asistente:* No se encontró ningún dato en memoria que coincida con "${argumento}".`);
        }

        // --- BLOC DE NOTAS ---
        if (comando === 'nota' || comando === 'guardarnota') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido al administrador");
            if (!argumento) return msg.reply(" *Asistente:* Ingrese el texto de la nota que desea guardar.");
            notasGuardadas.push({ texto: argumento, fecha: new Date().toLocaleDateString('es-ES') });
            guardarNotas();
            return msg.reply(` *Asistente:* Nota guardada con éxito, Señor.`);
        }

        if (comando === 'notas') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido al administrador");
            if (notasGuardadas.length === 0) {
                return msg.reply(" *Asistente:* No tiene notas archivadas.");
            }
            let lista = ` *SUS NOTAS ARCHIVADAS:*\n\n`;
            notasGuardadas.forEach((n, index) => {
                lista += `${index + 1}. [${n.fecha || ''}] ${n.texto || n}\n`;
            });
            lista += `\n_Para eliminar una nota, use *!bot borrarnota <número>*_`;
            return msg.reply(lista);
        }

        if (comando === 'borrarnota') {
            if (!argumento) return msg.reply(" *Asistente:* Especifique el número de la nota que desea eliminar. Use *!bot notas* para ver la lista.");
            const index = parseInt(argumento) - 1;
            if (isNaN(index) || index < 0 || index >= notasGuardadas.length) {
                return msg.reply(" *Asistente:* Número de nota inválido.");
            }
            const eliminada = notasGuardadas.splice(index, 1)[0];
            guardarNotas();
            return msg.reply(` *Asistente:* Nota "${eliminada.texto || eliminada}" eliminada.`);
        }

        // --- BaSQUEDA WEB INTELIGENTE ---
        if (comando === 'buscar' || comando === 'google') {
            if (!argumento) return msg.reply(" *Asistente:* Ingrese los términos de búsqueda.");
            await msg.reply(`x *Asistente:* Realizando consulta y analizando fuentes en la red...`);
            try {
                const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(argumento)}`;
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                
                if (!response.ok) throw new Error("Fallo en la conexión");
                const html = await response.text();
                
                const snippets = [];
                const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
                let match;
                let count = 0;
                while ((match = regex.exec(html)) !== null && count < 5) {
                    const cleanSnippet = match[1].replace(/<[^>]+>/g, '').trim();
                    snippets.push(cleanSnippet);
                    count++;
                }
                
                if (snippets.length === 0) {
                    return msg.reply(" *Asistente:* No he podido recuperar resultados útiles para esa consulta.");
                }
                
                const searchContext = snippets.join('\n- ');
                const prompt = `Analiza los siguientes resultados de búsqueda web sobre "${argumento}" y redacta una respuesta concisa, clara e inteligente en español. Adopta la personalidad de Kinbot (sofisticado, leal, ingenioso como Jarvis):\n\nResultados de búsqueda:\n- ${searchContext}`;
                
                const respuesta = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([prompt]);
                    return result.response.text();
                });
                
                const respuestaLimpia = limpiarRespuestaGemini(respuesta);
                return msg.reply(respuestaLimpia);
            } catch (e) {
                console.error("Error en búsqueda:", e);
                return msg.reply(" *Asistente:* Ha ocurrido un error al consultar las bases de datos de red.");
            }
        }

        // --- GESTIN DE AGENTES DE BOT ---
        if (comando === 'agente') {
            const partsAgente = argumento.split(' ');
            const subComando = partsAgente[0]?.toLowerCase();
            const nombre = partsAgente[1]?.toLowerCase();
            const instrucciones = partsAgente.slice(2).join(' ');
            
            if (subComando === 'crear' || subComando === 'agregar') {
                if (!nombre || !instrucciones) {
                    return msg.reply(" *Asistente:* Formato correcto: *!bot agente crear <nombre> <instrucciones>*");
                }
                agentesCustom[nombre] = instrucciones;
                fs.writeFileSync('agentes.json', JSON.stringify(agentesCustom, null, 2));
                return msg.reply(`S& *Asistente:* Agente *"${nombre}"* creado e incorporado a mis bases de datos.`);
            }
            
            if (subComando === 'borrar' || subComando === 'eliminar') {
                if (!nombre) {
                    return msg.reply(" *Asistente:* Formato correcto: *!bot agente borrar <nombre>*");
                }
                if (nombre === 'kingbot' || nombre === 'programador' || nombre === 'entrenador' || nombre === 'traductor') {
                    return msg.reply(` *Asistente:* No puede eliminar los agentes del sistema principal.`);
                }
                if (!agentesCustom[nombre]) {
                    return msg.reply(` *Asistente:* El agente *"${nombre}"* no existe.`);
                }
                delete agentesCustom[nombre];
                fs.writeFileSync('agentes.json', JSON.stringify(agentesCustom, null, 2));
                return msg.reply(`S& *Asistente:* El agente *"${nombre}"* ha sido dado de baja.`);
            }
            
            // Listar por defecto
            let lista = `x *AGENTES DE IA CONFIGURADOS:*\n\n`;
            Object.keys(agentesCustom).forEach(key => {
                lista += ` *${key}*: ${agentesCustom[key].substring(0, 100)}...\n\n`;
            });
            lista += `_Para iniciar una conversación con un agente use *!iniciarbot <nombre>* o *!botgrupal <nombre>*_`;
            return msg.reply(lista);
        }

        if (comando === 'agentes') {
            let lista = `x *AGENTES DE IA CONFIGURADOS:*\n\n`;
            Object.keys(agentesCustom).forEach(key => {
                lista += ` *${key}*: ${agentesCustom[key].substring(0, 100)}...\n\n`;
            });
            lista += `_Para iniciar una conversación con un agente use *!iniciarbot <nombre>* o *!botgrupal <nombre>*_`;
            return msg.reply(lista);
        }

        // --- GESTIN DE COMANDOS PERSONALIZADOS ---
        if (comando === 'comandocrear' || comando === 'crearcomando') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            const partsCmd = argumento.split(' ');
            const nombre = partsCmd[0]?.toLowerCase();
            const tipo = partsCmd[1]?.toLowerCase();
            const contenido = partsCmd.slice(2).join(' ');

            if (!nombre || !tipo || !contenido) {
                return msg.reply(" *Asistente:* Formato correcto: *!bot comandocrear <nombre> <tipo: texto/ia/codigo> <contenido/instrucciones/codigo>*");
            }
            if (tipo !== 'texto' && tipo !== 'ia' && tipo !== 'codigo') {
                return msg.reply(" *Asistente:* El tipo de comando debe ser *texto*, *ia* o *codigo*.");
            }
            
            const comandosSistema = ['reiniciar', 'ayuda', 'menu', 'help', 'comandos', 'musica', 'audio', 'video', 'decir', 'tts', 'foto', 'camara', 'grabar', 'escuchar', 'bateria', 'estado', 'sistema', 'hardware', 'diagnostico', 'audit', 'test', 'logs', 'log', 'errores', 'error', 'qr', 'recordar', 'recordatorio', 'nota', 'guardarnota', 'notas', 'borrarnota', 'buscar', 'google', 'agente', 'agentes', 'agregarclave', 'addkey', 'claves', 'listkeys', 'restaurarclaves', 'resetkeys', 'borrarclaves', 'clearkeys', 'comandocrear', 'comandoborrar', 'comandoslista', 'setcanal', 'canal', 'agregarcanal', 'listacanal', 'canales', 'borrarcanal', 'eliminarcanal', 'clima', 'imagina', 'dibuja', 'crear', 'stickercrear', 'traducir', 'calcular', 'resumir'];
            if (comandosSistema.includes(nombre)) {
                return msg.reply(` *Asistente:* El nombre *"${nombre}"* está reservado para el sistema principal.`);
            }

            comandosCustom[nombre] = { tipo, contenido };
            guardarComandosCustom();
            return msg.reply(`S& *Asistente:* Comando personalizado *"!${nombre}"* (tipo: ${tipo}) creado e incorporado.`);
        }

        if (comando === 'comandoborrar' || comando === 'borrarcomando') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            const nombre = argumento.toLowerCase().trim();
            if (!nombre) {
                return msg.reply(" *Asistente:* Formato correcto: *!bot comandoborrar <nombre>*");
            }
            if (!comandosCustom[nombre]) {
                return msg.reply(` *Asistente:* El comando *"!${nombre}"* no existe.`);
            }
            delete comandosCustom[nombre];
            guardarComandosCustom();
            return msg.reply(`S& *Asistente:* Comando personalizado *"!${nombre}"* eliminado.`);
        }

        if (comando === 'comandoslista' || comando === 'listacomandos') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            const keys = Object.keys(comandosCustom);
            if (keys.length === 0) {
                return msg.reply(" *Asistente:* No hay comandos personalizados registrados.");
            }
            let list = `x *COMANDOS PERSONALIZADOS ACTIVOS:*\n\n`;
            keys.forEach(key => {
                const cmd = comandosCustom[key];
                list += ` *!${key}* (${cmd.tipo}): ${cmd.contenido.substring(0, 80)}...\n`;
            });
            return msg.reply(list);
        }

        // --- NUEVAS CAPACIDADES - FASE 4.5 ---

        // 1. Alarmas y Temporizadores
        if (comando === 'alarma') {
            if (!argumento) {
                return msg.reply("Uso: !bot alarma <minutos o HH:MM> <mensaje>\nEjemplo: !bot alarma 5 cerrar navegador");
            }
            const parsed = parsearAlarma(argumento);
            if (parsed) {
                return msg.reply(procesarNuevaAlarma(parsed, chatId));
            }
            return msg.reply("Formato no reconocido. Ejemplo: !bot alarma en 5 minutos cerrar navegador");
        }

        if (comando === 'alarmas') {
            return msg.reply(formatearAlarmas());
        }

        if (comando === 'alarmaborrar') {
            if (!argumento) {
                return msg.reply("Uso: !bot alarmaborrar <número> o !bot alarmaborrar todas");
            }
            return msg.reply(cancelarAlarma(argumento));
        }

        // --- SECCIÓN: FINANZAS Y TARJETAS (PWA INTEGRATION) ---
        if (comando === 'vencimientos' || comando === 'alertas') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            if (!dbFirebase) inicializarFirebase();
            if (!dbFirebase) {
                return msg.reply(" *Asistente:* No se ha detectado el archivo `serviceAccount.json`. Consiga sus credenciales de Firebase para conectar su PWA de finanzas.");
            }
            if (!firebaseUid) {
                return msg.reply(" *Asistente:* Primero configure su UID de Firebase con el comando *!bot setuid <UID>*");
            }

            await msg.reply(" *Asistente:* Consultando estado de vencimientos y pagos de tarjetas...");
            await chequearVencimientosYNotificar(true);
            return;
        }

        if (comando === 'setuid') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            const uidInput = argumento.trim();
            if (!uidInput) {
                return msg.reply(" *Asistente:* Proporcione su UID de Firebase. Ejemplo: *!bot setuid aBc123XyZ*");
            }
            firebaseUid = uidInput;
            guardarAdminJson();
            return msg.reply(` *Asistente:* UID de Firebase establecido con éxito: \`${firebaseUid}\``);
        }

        if (comando === 'settelegramtoken' || comando === 'settelegram' || comando === 'telegramtoken') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            const tokenInput = argumento.trim();
            if (!tokenInput) {
                return msg.reply(" *Asistente:* Proporcione su Token de Bot de Telegram obtenido de @BotFather.\n\nEjemplo: `!bot settelegram 123456789:ABCdefGhIJKlmNoPQ`");
            }
            telegramBotToken = tokenInput;
            guardarAdminJson();
            telegramPollingActive = false;
            iniciarTelegramPolling();
            return msg.reply(` *Asistente:* Token del Bot de Telegram registrado exitosamente. Servicio de escucha activado.`);
        }

        if (comando === 'telegram' || comando === 'estadotelegram') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            if (!telegramBotToken) {
                return msg.reply("ℹ *Asistente:* El Bot de Telegram no está configurado actualmente.\nPara activarlo escribe: `!bot settelegram <TOKEN_DE_BOTFATHER>`");
            }
            const estado = telegramPollingActive ? " Activo y escuchando" : " Detenido";
            const mask = telegramBotToken.substring(0, 8) + '...' + telegramBotToken.substring(telegramBotToken.length - 5);
            return msg.reply(` *ESTADO DE TELEGRAM (Finanzas King):*\n\n• Token: \`${mask}\`\n• Estado: *${estado}*\n\nPuedes enviar estados de cuenta (PDF o foto), comprobantes o tickets directamente a tu bot de Telegram y se sincronizarán automáticamente con Finanzas King.`);
        }

        if (comando === 'sethf' || comando === 'sethftoken' || comando === 'tokenhf') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply("Comando restringido al administrador");
            const keyInput = argumento.trim();
            if (!keyInput) {
                return msg.reply("Uso: !bot sethf <token_huggingface>\nObtén tu token gratis en huggingface.co/settings/tokens");
            }
            hfToken = keyInput;
            guardarAdminJson();
            return msg.reply("Token de Hugging Face configurado con éxito. Motor FLUX.1 y SDXL activado.");
        }

        if (comando === 'setpollinations' || comando === 'pollinationskey') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply("Comando restringido al administrador");
            const keyInput = argumento.trim();
            if (!keyInput) {
                return msg.reply("Uso: !bot setpollinations <clave>\nObtén tu clave en enter.pollinations.ai");
            }
            pollinationsApiKey = keyInput;
            guardarAdminJson();
            return msg.reply("Clave de Pollinations configurada con éxito.");
        }

        if (comando === 'setopenai' || comando === 'setopenaikey' || comando === 'openaikey') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply("Comando restringido al administrador");
            const keyInput = argumento.trim();
            if (!keyInput) {
                return msg.reply("Uso: !bot setopenai <clave_openai>");
            }
            openaiApiKey = keyInput;
            guardarAdminJson();
            return msg.reply("Clave de OpenAI registrada exitosamente.");
        }

        if (comando === 'openai' || comando === 'estadoopenai' || comando === 'motoresimagen' || comando === 'motores') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply("Comando restringido al administrador");
            const hfStatus = hfToken ? `Activo (${hfToken.substring(0, 7)}...)` : "No configurado (recomendado: 100% gratis en huggingface.co)";
            const polliStatus = pollinationsApiKey ? `Activo (${pollinationsApiKey.substring(0, 7)}...)` : "No configurado";
            const oaiStatus = openaiApiKey ? `Activo (${openaiApiKey.substring(0, 7)}...)` : "No configurado";
            return msg.reply(`*Motores de Generación de Imagen:*\n\n1. Hugging Face (FLUX.1 / SDXL): ${hfStatus}\n2. Pollinations: ${polliStatus}\n3. OpenAI (DALL-E): ${oaiStatus}\n\nPara activar Hugging Face gratis:\n1. Ve a huggingface.co/settings/tokens y crea un token tipo "Read".\n2. Envíame: !bot sethf hf_tu_token`);
        }

        if (comando === 'tarjetas' || comando === 'finanzas') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            if (!dbFirebase) inicializarFirebase();
            if (!dbFirebase) {
                return msg.reply(" *Asistente:* No se ha detectado el archivo `serviceAccount.json`. Consiga sus credenciales de Firebase para conectar su PWA de finanzas.");
            }
            if (!firebaseUid) {
                return msg.reply(" *Asistente:* Primero configure su UID de Firebase con el comando *!bot setuid <UID>*");
            }

            try {
                const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                const snapshot = await cardsRef.get();
                if (snapshot.empty) {
                    return msg.reply(" *Asistente:* No tiene tarjetas registradas en su base de datos de finanzas.");
                }

                const cardQuery = argumento ? argumento.trim() : null;
                if (cardQuery) {
                    // Consulta de una tarjeta específica
                    const q = cardQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    let matchingCard = null;
                    snapshot.forEach(doc => {
                        const c = doc.data();
                        const cName = (c.name || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                        if (cName.includes(q) || q.includes(cName)) {
                            matchingCard = { id: doc.id, ...c };
                        }
                    });

                    if (matchingCard) {
                        const debt = parseFloat(matchingCard.balance || 0);
                        const limit = parseFloat(matchingCard.limit || 0);
                        const payGoal = parseFloat(matchingCard.payGoal || 0);
                        const avail = limit > 0 ? (limit - debt) : 0;
                        const pct = limit > 0 ? ((debt / limit) * 100).toFixed(0) : 0;

                        let report = ` *DETALLE DE TARJETA: ${matchingCard.name}*\n\n`;
                        if (matchingCard.last4) report += ` *Terminación:* •••• ${matchingCard.last4}\n`;
                        report += ` *Deuda Actual:* $${debt.toFixed(2)}\n`;
                        if (payGoal > 0) report += ` *Pago p/no intereses:* $${payGoal.toFixed(2)}\n`;
                        if (limit > 0) {
                            report += ` *Límite:* $${limit.toFixed(2)} | *Disponible:* $${avail.toFixed(2)} (${100 - pct}% libre)\n`;
                        }
                        if (matchingCard.cutDay) report += ` *Día de corte:* ${matchingCard.cutDay}\n`;
                        if (matchingCard.payDay) report += ` *Día de pago:* ${matchingCard.payDay}\n`;

                        return msg.reply(report);
                    } else {
                        return msg.reply(` *Asistente:* No se encontró la tarjeta "${cardQuery}" en Finanzas King.`);
                    }
                }

                // Resumen general
                let tDebt = 0;
                let tLimit = 0;
                let cardsReport = ` *ESTADO DE TARJETAS (Finanzas King)* \n\n`;

                snapshot.forEach(doc => {
                    const c = doc.data();
                    const debt = parseFloat(c.balance || 0);
                    const limit = parseFloat(c.limit || 0);
                    tDebt += debt;
                    tLimit += limit;

                    const avail = limit > 0 ? (limit - debt) : 0;
                    const corteStr = c.cutDay ? `Corte: ${c.cutDay}` : '';
                    const pagoStr = c.payDay ? `Pago: ${c.payDay}` : '';
                    const fechas = [corteStr, pagoStr].filter(Boolean).join(' | ');

                    cardsReport += ` *${c.name}* ${c.last4 ? `(••${c.last4})` : ''}\n`;
                    cardsReport += `    Deuda: $${debt.toFixed(2)} ${limit > 0 ? `/ Límite: $${limit.toFixed(2)}` : ''}\n`;
                    if (limit > 0) cardsReport += `    Disp: $${avail.toFixed(2)}\n`;
                    if (fechas) cardsReport += `    ${fechas}\n`;
                    cardsReport += `\n`;
                });

                const ratio = tLimit > 0 ? (tDebt / tLimit) * 100 : 0;
                cardsReport += ` *Resumen Global:*\n`;
                cardsReport += ` *Deuda Total:* $${tDebt.toFixed(2)}\n`;
                cardsReport += ` *Disponible Total:* $${(tLimit - tDebt).toFixed(2)}\n`;
                cardsReport += ` *Endeudamiento:* ${ratio.toFixed(1)}%\n\n`;

                if (ratio < 30) cardsReport += ` *Estado óptimo.*`;
                else if (ratio < 50) cardsReport += ` *Estado moderado.*`;
                else cardsReport += ` *Alerta: Nivel de deuda elevado.*`;

                return msg.reply(cardsReport);
            } catch (e) {
                console.error("Error en tarjetas firebase:", e);
                return msg.reply(` *Asistente:* Error al acceder a Firestore: ${e.message}`);
            }
        }

        if (comando === 'gasto' || comando === 'abono') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            if (!dbFirebase) inicializarFirebase();
            if (!dbFirebase) {
                return msg.reply(" *Asistente:* No se ha detectado el archivo `serviceAccount.json`.");
            }
            if (!firebaseUid) {
                return msg.reply(" *Asistente:* Primero configure su UID de Firebase con el comando *!bot setuid <UID>*");
            }

            const parts = argumento.split('|').map(p => p.trim());
            const textGasto = parts[0] || '';
            const cardQuery = parts[1] || '';
            const catQuery = parts[2] || '';

            const firstSpace = textGasto.indexOf(' ');
            if (firstSpace === -1 || !cardQuery) {
                return msg.reply(` *Asistente:* Formato correcto:\n*!bot ${comando} <monto> <concepto> | <tarjeta> [| <categoría>]*\n\nEjemplo: *!bot gasto 15 Cena | Bac Gold | Comida*`);
            }

            const amtStr = textGasto.substring(0, firstSpace);
            const concept = textGasto.substring(firstSpace).trim();
            const amt = parseFloat(amtStr);

            if (isNaN(amt) || amt <= 0 || !concept) {
                return msg.reply(" *Asistente:* El monto y el concepto son obligatorios.");
            }

            try {
                const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                const cardsSnap = await cardsRef.get();
                let matchingCard = null;
                const qName = cardQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                
                cardsSnap.forEach(doc => {
                    const c = doc.data();
                    const cName = (c.name || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    if (cName.includes(qName) || qName.includes(cName)) {
                        matchingCard = { id: doc.id, ...c };
                    }
                });

                if (!matchingCard) {
                    return msg.reply(` *Asistente:* No se encontró ninguna tarjeta registrada en Finanzas King que coincida con "${cardQuery}".`);
                }

                const type = (comando === 'gasto') ? 'expense' : 'payment';
                const defaultCats = [' Supermercado', ' Comida', ' Transporte', ' Hormiga', ' Servicios', ' Compras', ' Salud', ' Educación'];
                const defaultPayCats = [' Abono Capital', ' Sueldo/Ingreso', ' Transferencia'];
                
                let category = (type === 'payment') ? ' Abono Capital' : ' Hormiga';

                if (catQuery) {
                    const cleanCat = catQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                    const listToSearch = (type === 'payment') ? defaultPayCats : defaultCats;
                    for (const cat of listToSearch) {
                        const cleanListCat = cat.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                        if (cleanListCat.includes(cleanCat)) {
                            category = cat;
                            break;
                        }
                    }
                }

                let newBal = parseFloat(matchingCard.balance || 0);
                if (type === 'expense') {
                    newBal += amt;
                } else {
                    newBal = Math.max(0, newBal - amt);
                }

                const batch = dbFirebase.batch();
                const expRef = dbFirebase.collection('users').doc(firebaseUid).collection('expenses').doc(Math.random().toString(36).slice(2));
                const payload = {
                    amount: amt,
                    type,
                    cardId: matchingCard.id,
                    cardName: matchingCard.name,
                    concept,
                    category,
                    date: adminFirebase.firestore.Timestamp.fromDate(new Date())
                };

                batch.set(expRef, payload);
                batch.update(cardsRef.doc(matchingCard.id), { balance: newBal });
                await batch.commit();

                const titulo = type === 'expense' ? 'Gasto Registrado' : 'Abono Registrado';
                let respMsg = ` *${titulo}*\n\n`;
                respMsg += `• *Monto:* $${amt.toFixed(2)}\n`;
                respMsg += `• *Tarjeta:* ${matchingCard.name}\n`;
                respMsg += `• *Concepto:* ${concept}\n`;
                respMsg += `• *Categoría:* ${category}\n\n`;
                respMsg += ` _Guardado exitosamente_`;
                return msg.reply(respMsg);

            } catch (e) {
                console.error("Error al registrar movimiento:", e);
                return msg.reply(` *Asistente:* Error en Firebase: ${e.message}`);
            }
        }

        // 2. Lista de Tareas
        if (comando === 'tarea') {
            const parts = argumento.split(' ');
            const subComando = parts[0]?.toLowerCase();
            const desc = parts.slice(1).join(' ').trim();
            if (subComando === 'agregar' || subComando === 'crear' || subComando === 'add') {
                if (!desc) return msg.reply(" *Asistente:* Especifique la descripción de la tarea.");
                tareasGuardadas.push({ texto: desc, completada: false, fecha: new Date().toLocaleDateString() });
                guardarTareas();
                return msg.reply(`S& *Asistente:* Tarea agregada: _"${desc}"_.`);
            }
            return msg.reply(" *Asistente:* Formato correcto: *!bot tarea agregar <descripción>*. O use *!bot tareas*.");
        }

        
        if (comando === 'programar') {
            if (!argumento) {
                return msg.reply("Uso: !bot programar <hora> <instrucción>\nEjemplo: !bot programar 07:00 AM resumen de noticias");
            }
            const parsed = parsearInstruccionProgramacion(argumento);
            if (!parsed) {
                return msg.reply("Indica la hora y la instrucción. Ejemplo: !bot programar 07:00 AM resumen de noticias");
            }
            return msg.reply(procesarNuevaTareaProgramada(parsed, chatId));
        }

        if (comando === 'programados') {
            return msg.reply(formatearTareasProgramadas());
        }

        if (comando === 'desprogramar') {
            if (!argumento) {
                return msg.reply("Uso: !bot desprogramar <número> o !bot desprogramar todas");
            }
            return msg.reply(cancelarTareaProgramada(argumento));
        }

        if (comando === 'tareas') {
            if (tareasGuardadas.length === 0) {
                return msg.reply(" *Asistente:* No hay tareas pendientes.");
            }
            let list = `x 9 *LISTA DE TAREAS PENDIENTES:*\n\n`;
            tareasGuardadas.forEach((t, idx) => {
                const mark = t.completada ? 'S&' : 'S';
                list += `${idx + 1}. ${mark} ${t.texto} _(${t.fecha})_\n`;
            });
            list += `\n_Para completar: *!bot tareacompletar <índice>*_`;
            list += `\n_Para borrar: *!bot tareaborrar <índice>*_`;
            return msg.reply(list);
        }

        if (comando === 'tareacompletar' || comando === 'completartarea') {
            const index = parseInt(argumento) - 1;
            if (isNaN(index) || index < 0 || index >= tareasGuardadas.length) {
                return msg.reply(" *Asistente:* Índice de tarea no válido.");
            }
            const completada = tareasGuardadas.splice(index, 1)[0];
            guardarTareas();
            return msg.reply(`S& *Asistente:* ¡Excelente trabajo! Tarea completada: _"${completada.texto}"_. 0`);
        }

        if (comando === 'tareaborrar' || comando === 'borrartarea') {
            const index = parseInt(argumento) - 1;
            if (isNaN(index) || index < 0 || index >= tareasGuardadas.length) {
                return msg.reply(" *Asistente:* Índice de tarea no válido.");
            }
            const borrada = tareasGuardadas.splice(index, 1)[0];
            guardarTareas();
            return msg.reply(`*Asistente:* Tarea eliminada de la lista: _"${borrada.texto}"_.`);
        }

        // 3. Ficha de Películas y Series (IMDb/TMDB fallback)
        if (comando === 'info' || comando === 'pelicula' || comando === 'serie') {
            if (!argumento) return msg.reply(" *Asistente:* Indíqueme el nombre de la película o serie que desea consultar.");
            await msg.reply(` *Asistente:* Consultando información sobre "${argumento}"...`);
            try {
                const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(argumento + ' pelicula serie tmdb imdb sinopsis reparto')}`;
                const searchRes = await fetch(searchUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                let searchContext = "";
                if (searchRes.ok) {
                    const html = await searchRes.text();
                    const snippets = [];
                    const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
                    let m;
                    let count = 0;
                    while ((m = regex.exec(html)) !== null && count < 5) {
                        snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
                        count++;
                    }
                    searchContext = snippets.join('\n- ');
                }
                
                const prompt = `Analiza estos datos de búsqueda sobre la película/serie "${argumento}":\n\n${searchContext}\n\nEscribe una ficha descriptiva en español muy bonita con la personalidad de Kinbot. Debe incluir:\n1. TÍTULO (Año)\n2. PUNTUACIN (de 1 a 10 estrellas xRx)\n3. SINOPSIS (breve y emocionante)\n4. ELENCO/REPARTO (actores principales)\n5. TRAILER (Sugerir enlace de búsqueda de YouTube para el trailer). No inventes datos.`;
                
                const respuesta = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([prompt]);
                    return result.response.text();
                });
                const respuestaLimpia = limpiarRespuestaGemini(respuesta);
                return msg.reply(respuestaLimpia);
            } catch (e) {
                console.error(e);
                return msg.reply(" *Asistente:* Ocurrió un error al buscar la información cinematográfica.");
            }
        }

        // 4. Generador de Memes
        if (comando === 'meme') {
            if (!argumento) {
                return msg.reply(" *Asistente:* Formato correcto:\n*!bot meme plantilla | texto arriba | texto abajo*\nPlantillas populares: drake, doge, fine, two-buttons, disastergirl, success, sad-pablo, trump.");
            }
            if (argumento.includes('|')) {
                const parts = argumento.split('|').map(p => p.trim());
                const plantilla = parts[0].toLowerCase().replace(/\s+/g, '-');
                const texto1 = parts[1] || ' ';
                const texto2 = parts[2] || ' ';
                
                const memeUrl = `https://api.memegen.link/images/${encodeURIComponent(plantilla)}/${encodeURIComponent(texto1)}/${encodeURIComponent(texto2)}.png`;
                await msg.reply(" *Asistente:* Generando el meme solicitado...");
                try {
                    const resMeme = await fetch(memeUrl);
                    if (resMeme.ok) {
                        const buffer = await resMeme.arrayBuffer();
                        const base64 = Buffer.from(buffer).toString('base64');
                        const media = new MessageMedia('image/png', base64, 'meme.png');
                        return msg.reply(media);
                    }
                } catch(e) {}
                return msg.reply(" *Asistente:* Plantilla no soportada o error en el servidor de memes.");
            } else {
                await msg.reply("x *Asistente:* Analizando tu idea para diseñar el meme ideal...");
                try {
                    const prompt = `Analiza la siguiente idea de meme del usuario: "${argumento}"\n\nDebes mapearla a una de las siguientes plantillas de memegen.link:\n- drake\n- fine\n- doge\n- two-buttons\n- disastergirl\n- success\n- sad-pablo\n- trump\n\nResponde aNICAMENTE en el siguiente formato JSON, sin markdown, sin comillas adicionales:\n{\n  "plantilla": "nombre_plantilla",\n  "texto1": "texto superior corto",\n  "texto2": "texto inferior corto"\n}`;
                    const respuesta = await ejecutarGeminiConRetries(async (model) => {
                        const result = await model.generateContent([prompt]);
                        return result.response.text();
                    });
                    const cleanJSON = respuesta.replace(/```json|```/g, '').trim();
                    const memeData = JSON.parse(cleanJSON);
                    
                    const memeUrl = `https://api.memegen.link/images/${encodeURIComponent(memeData.plantilla)}/${encodeURIComponent(memeData.texto1)}/${encodeURIComponent(memeData.texto2)}.png`;
                    const resMeme = await fetch(memeUrl);
                    if (resMeme.ok) {
                        const buffer = await resMeme.arrayBuffer();
                        const base64 = Buffer.from(buffer).toString('base64');
                        const media = new MessageMedia('image/png', base64, 'meme.png');
                        return msg.reply(media);
                    }
                } catch (e) {
                    console.error("Error en meme inteligente:", e);
                }
                return msg.reply(" *Asistente:* No he podido procesar esa idea de meme. Intenta con el formato estructurado.");
            }
        }

        // 5. Voz a Texto (Manual)
        if (comando === 'transcribir' || comando === 'vozatexto') {
            let mensajeConAudio = mensajeAProcesar;
            if (!mensajeConAudio.hasMedia || (mensajeConAudio.type !== 'audio' && mensajeConAudio.type !== 'ptt')) {
                return msg.reply(" *Asistente:* Por favor, responda a una nota de voz o mensaje de audio con este comando.");
            }
            await msg.reply("*Asistente:* Transcribiendo el archivo de audio...");
            try {
                const media = await descargarMediaSeguro(mensajeConAudio);
                if (media && media.data) {
                    const modelActivo = obtenerModel();
                    const promptTrans = "Transcribe el siguiente audio exactamente en español. Responde únicamente con el texto transcrito, sin notas de introducción ni metadatos.";
                    const result = await modelActivo.generateContent([
                        promptTrans,
                        { inlineData: { data: media.data, mimeType: media.mimetype } }
                    ]);
                    const voiceTranscript = result.response.text().trim();
                    if (voiceTranscript) {
                        return msg.reply(`x *Transcripción:* \n\n_"${voiceTranscript}"_`);
                    }
                }
            } catch (e) {
                console.error("Error en comando transcribir:", e);
            }
            return msg.reply(" *Asistente:* No pude transcribir este audio.");
        }

        // 6. Acortador de URLs
        if (comando === 'acortar' || comando === 'short') {
            if (!argumento) return msg.reply(" *Asistente:* Proporcione la URL que desea acortar.");
            try {
                new URL(argumento);
            } catch (e) {
                return msg.reply(" *Asistente:* El enlace tiene un formato incorrecto.");
            }
            await msg.reply("x *Asistente:* Generando enlace corto...");
            try {
                const response = await fetch('https://cleanuri.com/api/v1/shorten', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ url: argumento })
                });
                if (response.ok) {
                    const data = await response.json();
                    return msg.reply(`x *Enlace acortado:* ${data.result_url}`);
                }
            } catch (e) {
                console.error("Error acortando URL:", e);
            }
            return msg.reply(" *Asistente:* Servidor de acortamiento fuera de línea.");
        }

        // 7. Conversor de divisas
        if (comando === 'divisas' || comando === 'convertir' || comando === 'convert') {
            const match = argumento.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]{3})\s*(?:a|to)\s*([a-zA-Z]{3})$/i);
            if (!match) {
                return msg.reply(" *Asistente:* Formato correcto: *!bot divisas <cantidad> <origen> a <destino>*. Ejemplo: *!bot divisas 100 usd a eur*");
            }
            const cantidad = parseFloat(match[1]);
            const origen = match[2].toUpperCase();
            const destino = match[3].toUpperCase();
            
            await msg.reply(`x *Asistente:* Calculando tipo de cambio para ${cantidad} ${origen}...`);
            try {
                const res = await fetch(`https://open.er-api.com/v6/latest/${origen}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.rates && data.rates[destino]) {
                        const tasa = data.rates[destino];
                        const resultado = (cantidad * tasa).toFixed(2);
                        return msg.reply(`x *Conversión de Divisas:*\n\nx *Original:* ${cantidad.toFixed(2)} ${origen}\nx *Resultado:* ${resultado} ${destino}\nx *Tasa de cambio:* 1 ${origen} = ${tasa.toFixed(4)} ${destino}`);
                    }
                }
            } catch (e) {
                console.error(e);
            }
            return msg.reply(` *Asistente:* Moneda no soportada o error al consultar el tipo de cambio.`);
        }

        // 8. Búsqueda en Wikipedia
        if (comando === 'wiki' || comando === 'wikipedia') {
            if (!argumento) return msg.reply(" *Asistente:* Indíqueme el término que desea buscar en Wikipedia.");
            await msg.reply(`x *Asistente:* Buscando "${argumento}" en Wikipedia...`);
            try {
                const url = `https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(argumento)}`;
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (res.ok) {
                    const data = await res.json();
                    let responseMsg = `x *${data.title}* (Wikipedia)\n\n${data.extract}\n\nx *Enlace:* ${data.content_urls?.desktop?.page || ''}`;
                    if (data.thumbnail && data.thumbnail.source) {
                        try {
                            const imgRes = await fetch(data.thumbnail.source);
                            const buffer = await imgRes.arrayBuffer();
                            const base64 = Buffer.from(buffer).toString('base64');
                            const media = new MessageMedia('image/jpeg', base64, 'wiki.jpg');
                            return msg.reply(media, undefined, { caption: responseMsg });
                        } catch (e) {}
                    }
                    return msg.reply(responseMsg);
                }
            } catch (e) {
                console.error(e);
            }
            return msg.reply(" *Asistente:* No se encontró ningún artículo en Wikipedia para esa consulta.");
        }

        // 9. Noticias RSS (BBC)
        if (comando === 'noticias' || comando === 'news') {
            await msg.reply("x *Asistente:* Extrayendo los titulares y noticias internacionales más recientes...");
            try {
                const feed = await rssParser.parseURL('https://www.bbc.com/mundo/index.xml');
                if (feed.items && feed.items.length > 0) {
                    let newsReport = `*PRINCIPALES NOTICIAS DEL DÍA (BBC Mundo):*\n\n`;
                    const items = feed.items.slice(0, 5);
                    items.forEach((item, idx) => {
                        newsReport += `${idx + 1}. *${item.title}*\n   _${item.contentSnippet || item.content || ''}_\n   x   ${item.link}\n\n`;
                    });
                    return msg.reply(newsReport);
                }
            } catch (e) {
                console.error("Error en noticias RSS:", e);
            }
            return msg.reply(" *Asistente:* No se pudo recuperar el feed de noticias.");
        }

        // 10. Resultados Deportivos (Gemini + search)
        if (comando === 'deportes' || comando === 'marcador') {
            if (!argumento) return msg.reply(" *Asistente:* Especifique el deporte, equipo o competición. Ejemplo: *!bot deportes resultados Liga Española de Futbol*");
            await msg.reply(`a *Asistente:* Buscando últimos resultados deportivos sobre "${argumento}"...`);
            try {
                const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(argumento + ' resultados deportivos marcador clasificacion')}`;
                const searchRes = await fetch(searchUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                let searchContext = "";
                if (searchRes.ok) {
                    const html = await searchRes.text();
                    const snippets = [];
                    const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
                    let m;
                    let count = 0;
                    while ((m = regex.exec(html)) !== null && count < 5) {
                        snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
                        count++;
                    }
                    searchContext = snippets.join('\n- ');
                }
                if (!searchContext) searchContext = "No se encontraron resultados.";
                
                const prompt = `Resultados deportivos de búsqueda web sobre "${argumento}":\n- ${searchContext}\n\nEscribe un resumen de los marcadores deportivos más recientes en español como Kinbot.`;
                
                const respuesta = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([prompt]);
                    return result.response.text();
                });
                const respuestaLimpia = limpiarRespuestaGemini(respuesta);
                return msg.reply(respuestaLimpia);
            } catch (e) {
                console.error(e);
                return msg.reply(" *Asistente:* Error en los servidores deportivos.");
            }
        }

        // 11. Leer SMS del teléfono (Termuonly)
        if (comando === 'sms') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            if (!isTermux) {
                return msg.reply("x *Ejecutándose en Windows:* La lectura de SMS requiere que el bot esté activo en TermuAndroid.");
            }
            await msg.reply("x *Asistente:* Consultando bandeja de entrada de SMS...");
            exec('termux-sms-list -l 5', async (err, stdout) => {
                if (err) return msg.reply(" Error al leer la bandeja de SMS. Asegúrese de otorgar permisos.");
                try {
                    const dataSMS = JSON.parse(stdout);
                    if (dataSMS.length === 0) {
                        return msg.reply(" *Asistente:* La bandeja de entrada de SMS está vacía.");
                    }
                    let report = "x *aLTIMOS SMS RECIBIDOS:*\n\n";
                    dataSMS.forEach((sms, idx) => {
                        report += (idx + 1) + ". *De:* " + sms.number + "\n   *Fecha:* " + sms.received + "\n   *Mensaje:* " + sms.body + "\n\n";
                    });
                    await msg.reply(report);
                } catch (e) {
                    await msg.reply(" Error decodificando la lista de SMS.");
                }
            });
            return;
        }

        // 12. Terminal Remota (Exec command)
        if (comando === 'cmd' || comando === 'run') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            if (!argumento) return msg.reply(" *Asistente:* Indíqueme el comando de consola a ejecutar, Señor.");
            await msg.reply("x *Asistente:* Ejecutando comando en consola remota...");
            exec(argumento, { timeout: 10000 }, async (err, stdout, stderr) => {
                let output = "";
                if (stdout) output += "*STDOUT:*\n```\n" + stdout.substring(0, 1500) + "\n```\n";
                if (stderr) output += "*STDERR:*\n```\n" + stderr.substring(0, 1000) + "\n```\n";
                if (err) output += " *ERROR DE EJECUCIN:* " + err.message + "\n";
                if (!output) output = "S& *Comando ejecutado con éxito.* (Sin salida de consola)";
                await msg.reply(output);
            });
            return;
        }

        // 13. Encuestas de Grupo (Native Polls)
        if (comando === 'encuesta' || comando === 'voto' || comando === 'poll') {
            const parts = argumento.split('|').map(p => p.trim());
            const pregunta = parts[0];
            const opciones = parts.slice(1);
            if (!pregunta || opciones.length < 2) {
                return msg.reply(" *Asistente:* Formato correcto: *!bot encuesta ¿Pregunta? | Opción 1 | Opción 2 | ...* (Mínimo 2 opciones)");
            }
            if (opciones.length > 12) {
                return msg.reply(" *Asistente:* WhatsApp tiene un límite de 12 opciones por encuesta.");
            }
            try {
                const pollObj = new Poll(pregunta, opciones, { allowMultipleAnswers: false });
                await client.sendMessage(chatId, pollObj);
            } catch (e) {
                console.error("Error al enviar encuesta nativa:", e);
                return msg.reply(" *Asistente:* No se pudo enviar la encuesta nativa.");
            }
            return;
        }

        // 14. Juegos en Grupo (Trivia, Adivinar, Cancelar)
        if (comando === 'juego' || comando === 'juegos') {
            const partsJuego = argumento.split(' ');
            const subJuego = partsJuego[0]?.toLowerCase();
            if (subJuego === 'cancelar' || subJuego === 'salir' || subJuego === 'stop') {
                if (juegosEstado.has(chatId)) { juegosEstado.delete(chatId); return msg.reply(" *Juego en ejecución CANCELADO.*"); }
                return msg.reply(" *Asistente:* No hay ningún juego activo en este chat.");
            }
            if (subJuego === 'trivia') {
                if (juegosEstado.has(chatId)) return msg.reply("a *Asistente:* Ya hay un juego activo. Escriba *!bot juego cancelar* para terminarlo.");
                await msg.reply(" *Asistente:* Solicitando pregunta de trivia...");
                try {
                    const promptTrivia = 'Genera una pregunta de trivia en español (cultura general, ciencia, geografía o tecnología). 4 opciones A, B, C, D. Responde SOLO en JSON sin markdown:\n{"pregunta":"¿...","opcionA":"...","opcionB":"...","opcionC":"...","opcionD":"...","correcta":"B"}';
                    const rTrivia = await ejecutarGeminiConRetries(async (model) => { const r = await model.generateContent([promptTrivia]); return r.response.text(); });
                    const triviaData = JSON.parse(rTrivia.replace(/```json|```/g, '').trim());
                    juegosEstado.set(chatId, { tipo: 'trivia', respuesta: triviaData.correcta.toUpperCase().trim(), chatId });
                    return msg.reply(" *TRIVIA GRUPAL ACTIVA* \n\n*Pregunta:* " + triviaData.pregunta + "\n\nx! " + triviaData.opcionA + "\nx! " + triviaData.opcionB + "\nx! " + triviaData.opcionC + "\nx! " + triviaData.opcionD + "\n\n_¡Responda solo con la letra (A, B, C, D)!_");
                } catch (e) { console.error("Error trivia:", e); return msg.reply(" *Asistente:* No pude generar la trivia en este momento."); }
            }
            if (subJuego === 'adivinar' || subJuego === 'numero') {
                if (juegosEstado.has(chatId)) return msg.reply("a *Asistente:* Ya hay un juego activo en este chat.");
                const numS = Math.floor(Math.random() * 100) + 1;
                juegosEstado.set(chatId, { tipo: 'adivinar', numero: numS, intentos: 0, chatId });
                return msg.reply("x *JUEGO DEL NaMERO SECRETO* x\n\nHe pensado en un número del *1 al 100*.\n\n_¡Intenten adivinar!_");
            }
            return msg.reply(" *JUEGOS ASISTENTE:*\n\n *!bot juego trivia* - Trivia de cultura general.\n *!bot juego adivinar* - Adivina el número secreto.\n *!bot juego cancelar* - Termina el juego en curso.");
        }

        // 15. OCR (Imagen a texto)
        if (comando === 'ocr' || comando === 'leertexto') {
            if (!mensajeAProcesar.hasMedia) return msg.reply(" *Asistente:* Por favor, responda a una imagen con este comando.");
            await msg.reply("x *Asistente:* Extrayendo y analizando texto de la imagen con IA...");
            try {
                const mediaOCR = await descargarMediaSeguro(mensajeAProcesar);
                if (mediaOCR && mediaOCR.data) {
                    const promptOCR = "Analiza esta imagen y extrae todo el texto legible. Devuelve únicamente el texto extraído sin comentarios ni metadatos.";
                    const rOCR = await ejecutarGeminiConRetries(async (model) => { const r = await model.generateContent([promptOCR, { inlineData: { data: mediaOCR.data, mimeType: mediaOCR.mimetype } }]); return r.response.text(); });
                    return msg.reply(limpiarRespuestaGemini(rOCR));
                }
            } catch (e) { console.error("Error en OCR:", e); }
            return msg.reply(" *Asistente:* No se pudo leer el texto de la imagen.");
        }

        // --- GESTI N DE CLAVES API DINÁMICAS ---
        if (comando === 'agregarclave' || comando === 'addkey') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            if (!argumento || (!argumento.startsWith('AIzaSy') && !argumento.startsWith('AQ.'))) return msg.reply(" *Asistente:* Proporcione una clave API de Gemini válida.");
            sincronizarLlavesDesdeArchivo();
            const existingIdx = API_KEYS.indexOf(argumento);
            if (existingIdx !== -1) {
                keyStatus[existingIdx] = { status: 'Activa', requestsToday: 0, lastRequest: new Date().toISOString() };
                currentKeyIndex = existingIdx;
                currentModelIndex = 0;
                guardarKeysYCuotas();
                return msg.reply(` *Asistente:* La clave API ya existía y ha sido *reactivada* (Clave #${existingIdx + 1}).`);
            }
            API_KEYS.push(argumento);
            const newIdxK = API_KEYS.length - 1;
            keyStatus[newIdxK] = { status: 'Activa', requestsToday: 0, lastRequest: null };
            currentKeyIndex = newIdxK;
            currentModelIndex = 0;
            guardarKeysYCuotas();
            return msg.reply(" *Asistente:* Clave API agregada y guardada automáticamente en tu bloc de notas. Total: " + API_KEYS.length);
        }
        if (comando === 'claves' || comando === 'listkeys') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            sincronizarLlavesDesdeArchivo();
            let listK = ` *ESTADO DE CLAVES API GEMINI:*\nModelo activo: *${MODELS[currentModelIndex]}*\n\n`;
            API_KEYS.forEach((key, idx) => {
                const mask = key.substring(0, 10) + '...' + key.substring(key.length - 4);
                const st = keyStatus[idx]?.status === 'Activa' ? ' Activa' : ' Agotada';
                const cnt = keyStatus[idx]?.requestsToday || 0;
                const am = idx === currentKeyIndex ? '  (En uso)' : '';
                listK += (idx + 1) + ". `" + mask + "`\n   Estado: " + st + "\n   Consultas hoy: " + cnt + am + "\n\n";
            });
            listK += "_Para agregar: *!bot agregarclave <clave>*_\n_Para restaurar: *!bot restaurarclaves*_";
            return msg.reply(listK);
        }
        if (comando === 'restaurarclaves' || comando === 'resetkeys') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            API_KEYS.forEach((key, idx) => { if (keyStatus[idx]) { keyStatus[idx].status = 'Activa'; keyStatus[idx].requestsToday = 0; } });
            currentKeyIndex =  0; currentModelIndex =  0;
            guardarKeysYCuotas();
            return msg.reply(" *Asistente:* Todas las claves API restablecidas a *Activa* y contadores reiniciados.");
        }
        if (comando === 'borrarclaves' || comando === 'clearkeys') {
            if (isGroup || !esAdmin(chatId, msg)) return msg.reply(" Comando restringido solo al Administrador.");
            API_KEYS.splice(0, API_KEYS.length);
            if (Array.isArray(keyStatus)) {
                keyStatus.splice(0, keyStatus.length);
            } else {
                keyStatus = [];
            }
            currentKeyIndex = 0;
            currentModelIndex = 0;
            guardarKeysYCuotas();
            return msg.reply(" *Asistente:* Todas las claves API han sido eliminadas permanentemente. El sistema ahora no tiene llaves. Usa `!bot addkey <llave>` para agregar nuevas.");
        }

        // --- INTERCEPTOR DE ARCHIVOS Y DOCUMENTOS FINANCIEROS ---
        let esDocumentoFinanciero = false;
        if (!isGroup && chatId === adminChatId && mensajeAProcesar.hasMedia) {
            try {
                const media = await descargarMediaSeguro(mensajeAProcesar);
                if (media) {
                    // Si el usuario envía serviceAccount.json por WhatsApp
                    if ((media.filename && media.filename.toLowerCase().includes('serviceaccount')) || (media.mimetype && media.mimetype.includes('json'))) {
                        try {
                            const jsonText = Buffer.from(media.data, 'base64').toString('utf8');
                            const parsed = JSON.parse(jsonText);
                            if (parsed.project_id && parsed.private_key) {
                                fs.writeFileSync('serviceAccount.json', jsonText, 'utf8');
                                dbFirebase = null;
                                adminFirebase = null;
                                inicializarFirebase();
                                return msg.reply(" *Asistente:* Archivo `serviceAccount.json` recibido y guardado con éxito. Conexión con Firebase Firestore (Finanzas King) activada.");
                            }
                        } catch (errJson) {}
                    }
                    if (media.mimetype === 'application/pdf' || (media.mimetype && media.mimetype.startsWith('image/'))) {
                        esDocumentoFinanciero = await procesarDocumentoFinanciero(media, msg);
                    }
                }
            } catch (errFin) {
                console.error("[Interceptor Financiero] Error al procesar media:", errFin);
            }
        }
        if (esDocumentoFinanciero) return;

        // Interceptor de texto financiero directo (ej. notificaciones bancarias reenviadas a WhatsApp)
        if (!isGroup && chatId === adminChatId && !mensajeAProcesar.hasMedia && textoLimpio && textoLimpio.length > 20) {
            const esTextoFinanciero = await procesarTextoFinanciero(textoLimpio, msg);
            if (esTextoFinanciero) return;
        }

        // INTELIGENCIA ARTIFICIAL GEMINI
        try {
            const _chatTyp = await msg.getChat();
            if (_chatTyp && _chatTyp.sendStateTyping) await _chatTyp.sendStateTyping();
        } catch (eTyp) {}
        let contenido = [];
        let senderName = "Usuario";
        try {
            const contact = await msg.getContact();
            if (contact) senderName = contact.pushname || contact.name || contact.number || "Usuario";
        } catch (eCont) {}

        let textoParaGemini = textoLimpio;
        if (isGroup && textoLimpio) textoParaGemini = '[Mensaje de ' + senderName + ']: ' + textoLimpio;
        if (textoParaGemini && comando !== 'sticker') contenido.push(textoParaGemini);

        // Mensaje de espera Asistente para consultas largas (omitido para admin)
        if (!isGroup && textoParaGemini && textoParaGemini.length > 30 && !chatsActivos.has(chatId) && !esAdmin(chatId, msg)) {
            const _loadMsgs = ['*Asistente:* Procesando su consulta...', '*Asistente:* Analizando su solicitud...', '*Asistente:* Consultando sistemas internos...', '*Asistente:* Procesando la información...'];
            try { await msg.reply(_loadMsgs[Math.floor(Math.random() * _loadMsgs.length)]); } catch(e) {}
        }

        let downloadedMedia = null;
        if (mensajeAProcesar.hasMedia) {
            try {
                downloadedMedia = await descargarMediaSeguro(mensajeAProcesar);
            } catch (errDl) {
                console.error("[descargarMedia] Error al descargar media para Gemini:", errDl);
            }
            if (comando === 'sticker') {
                if (downloadedMedia) {
                    await msg.reply(downloadedMedia, msg.from, { sendMediaAsSticker: true, stickerName: 'Bot VIP Multiplataforma', stickerAuthor: 'Geovanny' });
                } else {
                    await msg.reply(' *Asistente:* No se pudo descargar el archivo multimedia para crear el sticker.');
                }
                return;
            }
            if (downloadedMedia && downloadedMedia.data) {
                contenido.push({ inlineData: { data: downloadedMedia.data, mimeType: downloadedMedia.mimetype } });
            }
        }
        if (contenido.length === 0) contenido.push("Analiza esto.");

        let respuestaTexto = "";
        let exitoGemini = false;

        try {
            let isConversational = chatsActivos.has(chatId) && sesionesChat.has(chatId);
            if (!isConversational && !isGroup && esAdmin(chatId, msg)) {
                chatsActivos.add(chatId);
                const systemPromptFluid = agentesCustom["kingbot"];
                sesionesChat.set(chatId, [
                    { role: "user", parts: [{ text: systemPromptFluid }] },
                    { role: "model", parts: [{ text: "Entendido. Protocolo del Agente \"kingbot\" activado y en línea." }] }
                ]);
                isConversational = true;
            }
            const historial = isConversational ? sesionesChat.get(chatId) : null;
            let partsGuardar = [];
            const fechaContexto = obtenerFechaContexto();
            const memoriaContexto = (!isGroup && esAdmin(chatId, msg)) ? formatearMemoriaParaPrompt() : '';

            if (isConversational) {
                let entradaMessage = `[${fechaContexto}]${memoriaContexto}\n${textoParaGemini}`;
                if (mensajeAProcesar.hasMedia && downloadedMedia && downloadedMedia.data) {
                    let partsUsuario = [];
                    partsUsuario.push({ text: `[${fechaContexto}]${memoriaContexto}\n${textoParaGemini || 'Analiza esta imagen.'}` });
                    partsUsuario.push({ inlineData: { data: downloadedMedia.data, mimeType: downloadedMedia.mimetype } });
                    entradaMessage = partsUsuario;
                }

                respuestaTexto = await ejecutarGeminiConRetries(async (model) => {
                    const chatInstance = model.startChat({ history: historial });
                    const result = await chatInstance.sendMessage(entradaMessage);
                    return result.response.text();
                });

                if (mensajeAProcesar.hasMedia && downloadedMedia && downloadedMedia.data) {
                    if (textoParaGemini) partsGuardar.push({ text: `[${fechaContexto}]\n${textoParaGemini}` });
                    else partsGuardar.push({ text: `[${fechaContexto}]\nAnaliza esta imagen.` });
                    partsGuardar.push({ inlineData: { data: downloadedMedia.data, mimeType: downloadedMedia.mimetype } });
                } else { partsGuardar = [{ text: `[${fechaContexto}]\n${textoParaGemini}` }]; }
            } else {
                respuestaTexto = await ejecutarGeminiConRetries(async (model) => {
                    let contenidoCopia = [...contenido];
                    const esTercero = isGroup || !esAdmin(chatId, msg);
                    let promptStr = "";
                    if (esTercero) {
                        promptStr = `Eres el asistente personal humano de Geovanny Pacheco. Estás interactuando con otra persona en WhatsApp que busca comunicarse con Geovanny o necesita ayuda. 
Bajo ninguna circunstancia debes referirte a ti mismo como un 'bot', 'asistente virtual' o 'inteligencia artificial'. 
Háblales como lo haría un secretario humano real: de forma empática, natural, educada y profesional, sin sonar a robot. 
NORMAS ESTRICTAS DE PRIVACIDAD: 
1. PRIVACIDAD TOTAL: Tienes ESTRICTAMENTE PROHIBIDO revelar cualquier dato personal, privado, números de teléfono, tarjetas, finanzas o contraseñas de Geovanny. 
2. COMANDOS PROHIBIDOS: Tienes terminantemente prohibido usar tags de finanzas ([ACTION_FINANCE_*]), notas, memoria, tareas o sistema. 
FUNCIONES PERMITIDAS: Responder cualquier duda y usar [ACTION_SEARCH: consulta] o [ACTION_VIDEO_BUSCAR: titulo] si es necesario buscar información externa. 
Responde directamente como un humano profesional, sin lenguaje de bot y ABSOLUTAMENTE SIN EMOJIS. ${fechaContexto}`;
                    } else {
                        promptStr = `Eres el asistente personal humano y exclusivo de Geovanny Pacheco. 
Bajo ninguna circunstancia debes referirte a ti mismo como un 'bot', 'asistente virtual' o 'inteligencia artificial'. 
Eres su asistente de confianza. 
ESTILO DE RESPUESTA OBLIGATORIO:
- Respuestas precisas, concisas y directas al grano. Proporciona única y exclusivamente lo necesario y requerido por Geovanny.
- CERO drama, CERO relleno, CERO rodeos, CERO frases de cortesía innecesarias ("Estimado...", "Con gusto procedo...", "¡Hola Geovanny!").
- ABSOLUTAMENTE CERO EMOJIS en todos tus mensajes. Queda estrictamente prohibido usar cualquier emoji.
Conoces sus áreas de interés (Métricas, Helados, Linux, ESIT, Gym) pero responde con precisión directa. NUNCA menciones estos temas a menos que él lo pregunte. 
Si Geovanny te pide guardar una nota, ver notas, borrar notas, recordar algo, responder en audio, buscar en la web, revisar videos, guardar datos en memoria, olvidar datos, consultar el clima, programar alarmas, tareas recurrentes, crear o dibujar imágenes, ver tarjetas o registrar gastos/abonos, usa los siguientes tags internos (sin explicarlos en el texto): 
[ACTION_IMAGE: descripcion_detallada_en_espanol], [ACTION_NOTE_ADD: texto], [ACTION_NOTE_LIST], [ACTION_NOTE_DELETE: indice], [ACTION_REMIND: minutos | mensaje], [ACTION_SEARCH: consulta], [ACTION_CLIMA: ciudad], [ACTION_AUDIO: texto], [ACTION_YOUTUBE_CHECK], [ACTION_YOUTUBE_CHECK: canal], [ACTION_MEMORY_SAVE: tema | valor], [ACTION_MEMORY_DELETE: tema_o_numero], [ACTION_MEMORY_LIST], [ACTION_SCHEDULE: HH:MM | diaria | instruccion_completa | breve_descripcion], [ACTION_SCHEDULE_LIST], [ACTION_SCHEDULE_DELETE: indice_o_todas], [ACTION_ALARM_ADD: HH:MM | mensaje | diaria], [ACTION_ALARM_DELETE: indice_o_hora], [ACTION_FINANCE_CARDS], [ACTION_FINANCE_ADD: type | amount | concept | card_name | category]. 
IMPORTANTE: No utilices razonamientos silenciosos ni prefijos como '[SILENT]'. Tu respuesta debe ser escrita directamente en español, como un mensaje de texto de WhatsApp normal. ${fechaContexto}${memoriaContexto}`;
                    }
                    contenidoCopia.unshift(promptStr);
                    const result = await model.generateContent(contenidoCopia);
                    return result.response.text();
                });
            }

            // --- PROCESAR TAGS DE ACCI N AGENTICA ---
            let loops = 0;
            while (loops < 3) {
                loops++;
                
                // Tareas programadas (Agentic)
                if (respuestaTexto.includes('[ACTION_SCHEDULE_LIST]')) {
                    const listaFormateada = formatearTareasProgramadas();
                    if (respuestaTexto.includes('!bot programar') || respuestaTexto.includes('procedo con la consulta') || respuestaTexto.includes('pueden gestionarse')) {
                        respuestaTexto = listaFormateada;
                    } else {
                        respuestaTexto = respuestaTexto.replace(/\[ACTION_SCHEDULE_LIST\]/g, `\n\n${listaFormateada}`).trim();
                    }
                }

                if (respuestaTexto.includes('[ACTION_SCHEDULE_DELETE:') || respuestaTexto.includes('[ACTION_SCHEDULE_CANCEL:')) {
                    const matchDel = respuestaTexto.match(/\[ACTION_SCHEDULE_(?:DELETE|CANCEL):\s*([^\]]+)\]/);
                    if (matchDel) {
                        const resDel = cancelarTareaProgramada(matchDel[1].trim());
                        respuestaTexto = respuestaTexto.replace(matchDel[0], `\n\n${resDel}`).trim();
                    }
                }

                // Clima (Agentic)
                if (respuestaTexto.includes('[ACTION_CLIMA:')) {
                    const match = respuestaTexto.match(/\[ACTION_CLIMA:\s*([^\]]+)\]/);
                    if (match) {
                        const ciudadClima = match[1].trim();
                        const reporte = await obtenerReporteClima(ciudadClima);
                        respuestaTexto = respuestaTexto.replace(match[0], `\n\n${reporte}`).trim();
                    }
                } else if (respuestaTexto.includes('[ACTION_CLIMA]')) {
                    const reporte = await obtenerReporteClima('Chalchuapa');
                    respuestaTexto = respuestaTexto.replace('[ACTION_CLIMA]', `\n\n${reporte}`).trim();
                }

                // Notas (Agentic)
                if (respuestaTexto.includes('[ACTION_NOTE_ADD:')) {
                    const match = respuestaTexto.match(/\[ACTION_NOTE_ADD:\s*([^\]]+)\]/);
                    if (match) {
                        const noteText = match[1].trim();
                        notasGuardadas.push(noteText);
                        guardarNotas();
                        console.log(`[ Agentic Note Add]: ${noteText}`);
                        respuestaTexto = respuestaTexto.replace(match[0], `\n\n *Nota guardada:* "${noteText}"`).trim();
                    }
                }
                
                if (respuestaTexto.includes('[ACTION_NOTE_LIST]')) {
                    if (notasGuardadas.length === 0) {
                        respuestaTexto = respuestaTexto.replace('[ACTION_NOTE_LIST]', `\n\n *No tienes notas guardadas.*`).trim();
                    } else {
                        let listStr = `\n\n *Notas Guardadas:*\n` + notasGuardadas.map((n, i) => `${i + 1}. ${n}`).join('\n');
                        respuestaTexto = respuestaTexto.replace('[ACTION_NOTE_LIST]', listStr).trim();
                    }
                }
                
                if (respuestaTexto.includes('[ACTION_NOTE_DELETE:')) {
                    const match = respuestaTexto.match(/\[ACTION_NOTE_DELETE:\s*([^\]]+)\]/);
                    if (match) {
                        const argBorrar = match[1].trim();
                        const noteIndex = parseInt(argBorrar) - 1;
                        let borrada = null;
                        if (!isNaN(noteIndex) && noteIndex >= 0 && noteIndex < notasGuardadas.length) {
                            borrada = notasGuardadas.splice(noteIndex, 1)[0];
                        } else {
                            const idx = notasGuardadas.findIndex(n => n.toLowerCase().includes(argBorrar.toLowerCase()));
                            if (idx !== -1) borrada = notasGuardadas.splice(idx, 1)[0];
                        }
                        if (borrada) {
                            guardarNotas();
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\n *Nota eliminada:* "${borrada}"`).trim();
                        } else {
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\n *No se encontró ninguna nota que coincida con:* "${argBorrar}"`).trim();
                        }
                    }
                }

                // Búsqueda Web
                if (respuestaTexto.includes('[ACTION_SEARCH:')) {
                    const match = respuestaTexto.match(/\[ACTION_SEARCH:\s*([^\]]+)\]/);
                    if (match) {
                        const query = match[1].trim();
                        console.log(`[ Agentic Search]: Ejecutando búsqueda para: ${query}`);
                        await msg.reply(` *Asistente:* Buscando "${query}" en la red, un momento...`);
                        
                        let searchContext = "";
                        try {
                            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
                            const searchRes = await fetch(searchUrl, {
                                headers: {
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                                }
                            });
                            if (searchRes.ok) {
                                const html = await searchRes.text();
                                const snippets = [];
                                const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
                                let m;
                                let count = 0;
                                while ((m = regex.exec(html)) !== null && count < 5) {
                                    snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
                                    count++;
                                }
                                searchContext = snippets.join('\n- ');
                            }
                        } catch (e) {
                            console.error("Error en búsqueda automática:", e);
                        }
                        
                        if (!searchContext) searchContext = "No se encontraron resultados.";

                        const searchPrompt = `Resultados de búsqueda web sobre "${query}":\n- ${searchContext}\n\nPor favor, responde a mi pregunta anterior de manera elegante basándose en estos resultados como Kinbot.`;

                        try {
                            respuestaTexto = await ejecutarGeminiConRetries(async (modelActivo) => {
                                if (isConversational) {
                                    const tempHistory = [...historial];
                                    tempHistory.push({ role: 'user', parts: partsGuardar });
                                    tempHistory.push({ role: 'model', parts: [{ text: 'Entendido, Señor. Realizaré una búsqueda rápida en la red.' }] });
                                    const chatInstance = modelActivo.startChat({ history: tempHistory });
                                    const result = await chatInstance.sendMessage(searchPrompt);
                                    return result.response.text();
                                } else {
                                    const result = await modelActivo.generateContent([
                                        'Eres Kinbot, el asistente personal de Geovanny Pacheco. Tu personalidad es inteligente, servicial y sofisticada como Jarvis. IMPORTANTE: No utilices pensamientos internos, razonamientos silenciosos ni prefijos como \'[SILENT]\'. Tu respuesta debe estar directamente en español.',
                                        `El usuario preguntó: "${textoLimpio}"\n\n${searchPrompt}`
                                    ]);
                                    return result.response.text();
                                }
                            });
                            continue;
                        } catch (e) {
                            console.error("Error llamando a Gemini después de búsqueda:", e);
                            respuestaTexto = "Señor, he realizado la búsqueda pero no he podido formular una respuesta.";
                            break;
                        }
                    }
                }
                
                // Nota Add
                if (respuestaTexto.includes('[ACTION_NOTE_ADD:')) {
                    const match = respuestaTexto.match(/\[ACTION_NOTE_ADD:\s*([^\]]+)\]/);
                    if (match) {
                        const notaTexto = match[1].trim();
                        notasGuardadas.push({ texto: notaTexto, fecha: new Date().toLocaleDateString() });
                        fs.writeFileSync('notas.json', JSON.stringify(notasGuardadas, null, 2));
                        console.log(`[ Agentic Note Add]: Nota guardada: ${notaTexto}`);
                        respuestaTexto = respuestaTexto.replace(match[0], `\n\n *Nota guardada:* "${notaTexto}"`).trim();
                    }
                }
                
                // Nota List
                if (respuestaTexto.includes('[ACTION_NOTE_LIST]')) {
                    let lista = "";
                    if (notasGuardadas.length === 0) {
                        lista = "\n\n *Bloc de notas vacío.*";
                    } else {
                        lista = `\n\n *SUS NOTAS ARCHIVADAS:*\n`;
                        notasGuardadas.forEach((n, index) => {
                            lista += `${index + 1}. [${n.fecha}] ${n.texto}\n`;
                        });
                    }
                    respuestaTexto = respuestaTexto.replace('[ACTION_NOTE_LIST]', lista).trim();
                }
                
                // Nota Delete
                if (respuestaTexto.includes('[ACTION_NOTE_DELETE:')) {
                    const match = respuestaTexto.match(/\[ACTION_NOTE_DELETE:\s*([^\]]+)\]/);
                    if (match) {
                        const argBorrar = match[1].trim();
                        const index = parseInt(argBorrar) - 1;
                        let notaEliminada = null;
                        if (!isNaN(index) && index >= 0 && index < notasGuardadas.length) {
                            notaEliminada = notasGuardadas.splice(index, 1)[0];
                        } else {
                            const idx = notasGuardadas.findIndex(n => n.texto.toLowerCase().includes(argBorrar.toLowerCase()));
                            if (idx !== -1) notaEliminada = notasGuardadas.splice(idx, 1)[0];
                        }
                        if (notaEliminada) {
                            fs.writeFileSync('notas.json', JSON.stringify(notasGuardadas, null, 2));
                            console.log(`[x  Agentic Note Delete]: Nota eliminada: ${notaEliminada.texto}`);
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\nx   *Nota eliminada con éxito:* "${notaEliminada.texto}"`).trim();
                        } else {
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\na *No se encontró ninguna nota que coincida con:* "${argBorrar}"`).trim();
                        }
                    }
                }
                
                // Recordatorio
                if (respuestaTexto.includes('[ACTION_REMIND:')) {
                    const match = respuestaTexto.match(/\[ACTION_REMIND:\s*([^\]]+)\]/);
                    if (match) {
                        const parts = match[1].split('|');
                        const minutosStr = parts[0]?.trim();
                        const mensajeRecordatorio = parts.slice(1).join('|')?.trim();
                        const minutos = parseFloat(minutosStr);
                        
                        if (!isNaN(minutos) && minutos > 0 && mensajeRecordatorio) {
                            console.log(`[x  Agentic Remind]: Recordatorio en ${minutos}m: ${mensajeRecordatorio}`);
                            setTimeout(async () => {
                                try {
                                    const alertMsg = `*NOTIFICACI N DE KINBOT:*\n\nSeñor Geovanny, le recuerdo su tarea programada:\n\n_"${mensajeRecordatorio}"_`;
                                    await client.sendMessage(chatId, alertMsg);
                                } catch (e) {
                                    console.error("Error al disparar recordatorio automático:", e);
                                }
                            }, minutos * 60 * 1000);
                            respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        } else {
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\na *No se pudo agendar el recordatorio.*`).trim();
                        }
                    }
                }

                // Video Download - Universal (Agentic)
                const _agVideoTag = respuestaTexto.includes('[ACTION_DOWNLOAD:') ? '[ACTION_DOWNLOAD:' : (respuestaTexto.includes('[ACTION_TIKTOK:') ? '[ACTION_TIKTOK:' : null);
                if (_agVideoTag) {
                    const _agVidRegex = _agVideoTag === '[ACTION_DOWNLOAD:' ? /\[ACTION_DOWNLOAD:\s*([^\]]+)\]/ : /\[ACTION_TIKTOK:\s*([^\]]+)\]/;
                    const match = respuestaTexto.match(_agVidRegex);
                    if (match) {
                        const rawUrl = match[1].trim();
                        const urlExtract = rawUrl.match(/(https?:\/\/[^\s\]]+)/);
                        const urlStr = urlExtract ? urlExtract[1] : rawUrl;
                        respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        descargarYEnviarVideo(urlStr, msg).catch(e => console.error('[!] Error en descarga agentic:', e.message));
                    }
                }

                // Audio/Musica desde URL - Agentic
                if (respuestaTexto.includes('[ACTION_MUSICA_URL:')) {
                    const match = respuestaTexto.match(/\[ACTION_MUSICA_URL:\s*([^\]]+)\]/);
                    if (match) {
                        const rawUrl = match[1].trim();
                        const urlExtract = rawUrl.match(/(https?:\/\/[^\s\]]+)/);
                        const urlStr = urlExtract ? urlExtract[1] : rawUrl;
                        console.log(`[x  Agentic Música URL]: Descargando audio de: ${urlStr}`);
                        
                        // Remove tag from response
                        respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        
                        const outputAudio = 'musica_' + Date.now() + '.mp3';
                        const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
                        const searchArgs = [
                            '--user-agent', ua,
                            '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                            '--embed-thumbnail', '--add-metadata',
                            '-o', outputAudio,
                            urlStr
                        ];
                        
                        const { spawn } = require('child_process');
                        const child = spawn(getYtDlpBinary(), searchArgs, { shell: false });
                        
                        child.on('error', (err) => {
                            console.error('[!] Error en búsqueda de música agentic URL:', err);
                            msg.reply(" *Asistente:* yt-dlp no disponible. Instala con: pip install yt-dlp").catch(()=>{});
                        });
                        
                        child.on('close', async (code) => {
                            const possibleFile = fs.existsSync(outputAudio) ? outputAudio : outputAudio.replace('.mp3', '') + '.mp3';
                            if (code !== 0 || !fs.existsSync(possibleFile)) {
                                msg.reply(` *Asistente:* No pude descargar el audio del enlace proporcionado.`).catch(()=>{});
                                return;
                            }
                            try {
                                const { MessageMedia } = require('@juzi/whatsapp-web.js');
                                const stats = fs.statSync(possibleFile);
                                const sizeMB = stats.size / (1024 * 1024);
                                const media = MessageMedia.fromFilePath(possibleFile);
                                if (sizeMB > 15) {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: true });
                                    await msg.reply(' *Asistente:* El audio se envió como documento debido a que es muy pesado/largo (' + sizeMB.toFixed(1) + ' MB).');
                                } else {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: false });
                                }
                                if (fs.existsSync(possibleFile)) fs.unlinkSync(possibleFile);
                            } catch (err) {
                                console.error('[!] Error enviando música agentic URL:', err);
                            }
                        });
                    }
                }

                // ACTION_YOUTUBE_CHECK (Verificar últimos videos de YouTube de canales)
                if (respuestaTexto.includes('[ACTION_YOUTUBE_CHECK')) {
                    const match = respuestaTexto.match(/\[ACTION_YOUTUBE_CHECK(?::\s*([^\]]+))?\]/);
                    if (match) {
                        const targetCanal = match[1] ? match[1].trim() : null;
                        let videosReporte = '';

                        try {
                            if (targetCanal) {
                                // Buscar canal específico
                                let canalId = await obtenerIdCanal(targetCanal);
                                if (!canalId) {
                                    const matchSaved = canalesYoutube.find(c => c.nombre.toLowerCase().includes(targetCanal.toLowerCase()));
                                    if (matchSaved) canalId = matchSaved.id;
                                }

                                if (canalId) {
                                    const info = await obtenerUltimosVideosCanal(canalId, 3);
                                    if (info && info.videos && info.videos.length > 0) {
                                        videosReporte = ` *Últimos videos de ${info.canalNombre}:*\n\n`;
                                        info.videos.forEach((v, idx) => {
                                            const f = v.fecha ? ` _(${v.fecha})_` : '';
                                            videosReporte += `*${idx + 1}.* *${v.titulo}*${f}\n ${v.link}\n\n`;
                                        });
                                        videosReporte += `_Para descargar un video escribe: *!bot video <enlace>*_`;
                                    } else {
                                        videosReporte = ` *Canal:* ${info?.canalNombre || targetCanal}\nNo se encontraron videos recientes o el canal no tiene publicaciones públicas.`;
                                    }
                                } else {
                                    videosReporte = ` No pude localizar el canal "${targetCanal}" en YouTube. Verifica el nombre o utiliza *!bot agregarcanal <enlace>*.`;
                                }
                            } else {
                                // Consultar todos los canales registrados
                                if (canalesYoutube.length === 0) {
                                    videosReporte = " No tienes canales de YouTube registrados en monitoreo.\nPuedes agregar uno escribiendo: `!bot agregarcanal <enlace o @canal>`";
                                } else {
                                    videosReporte = " *ÚLTIMOS VIDEOS DE TUS CANALES DE YOUTUBE:*\n\n";
                                    let totalEncontrados = 0;
                                    for (const c of canalesYoutube) {
                                        const info = await obtenerUltimosVideosCanal(c.id, 2);
                                        if (info && info.videos && info.videos.length > 0) {
                                            totalEncontrados++;
                                            c.nombre = info.canalNombre;
                                            c.ultimoVideo = info.videos[0].link;
                                            videosReporte += ` *${info.canalNombre}*\n`;
                                            info.videos.forEach(v => {
                                                const f = v.fecha ? ` _(${v.fecha})_` : '';
                                                videosReporte += `• *${v.titulo}*${f}\n   ${v.link}\n`;
                                            });
                                            videosReporte += '\n';
                                        }
                                    }
                                    guardarCanales();
                                    if (totalEncontrados === 0) {
                                        videosReporte = " No se encontraron videos recientes en los canales monitoreados en este momento.";
                                    } else {
                                        videosReporte += "_Para descargar cualquiera de ellos escribe: *!bot video <enlace>*_";
                                    }
                                }
                            }
                        } catch (errYt) {
                            console.error("[Agentic YouTube Check Error]:", errYt.message);
                            videosReporte = " Ocurrió un inconveniente al consultar los canales de YouTube.";
                        }

                        respuestaTexto = respuestaTexto.replace(match[0], `\n\n${videosReporte}`).trim();
                    }
                }

                // ACTION_MEMORY_SAVE (Guardar datos en memoria permanente)
                if (respuestaTexto.includes('[ACTION_MEMORY_SAVE:')) {
                    const match = respuestaTexto.match(/\[ACTION_MEMORY_SAVE:\s*([^|]+)\|([^\]]+)\]/);
                    if (match) {
                        if (!esAdmin(chatId, msg)) {
                            respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        } else {
                            const clave = match[1].trim();
                            const valor = match[2].trim();
                            const resultado = guardarDatoEnMemoria(clave, valor);
                            const claveCap = clave.charAt(0).toUpperCase() + clave.slice(1);
                            const accionTxt = resultado && resultado.accion === 'actualizado' ? 'REGISTRO ACTUALIZADO' : 'REGISTRO GUARDADO';
                            const confirmacion = `\n\n*${accionTxt} EN MEMORIA*\n• *Tema:* ${claveCap}\n• *Información:* ${valor}\n• *Fecha:* ${resultado.item.fecha}`;
                            respuestaTexto = respuestaTexto.replace(match[0], confirmacion).trim();
                            console.log(`[Memoria] Dato guardado (${resultado?.accion}): "${clave}" = "${valor}"`);
                        }
                    }
                }

                // ACTION_MEMORY_DELETE (Olvidar / borrar dato de memoria)
                if (respuestaTexto.includes('[ACTION_MEMORY_DELETE:')) {
                    const match = respuestaTexto.match(/\[ACTION_MEMORY_DELETE:\s*([^\]]+)\]/);
                    if (match) {
                        if (!esAdmin(chatId, msg)) {
                            respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        } else {
                            const target = match[1].trim();
                            const eliminado = eliminarDatoDeMemoria(target);
                            if (eliminado) {
                                const claveCap = eliminado.clave.charAt(0).toUpperCase() + eliminado.clave.slice(1);
                                respuestaTexto = respuestaTexto.replace(match[0], `\n\n*REGISTRO ELIMINADO DE MEMORIA*\n• *Tema:* ${claveCap}\n• *Información anterior:* ${eliminado.valor}`).trim();
                            } else {
                                respuestaTexto = respuestaTexto.replace(match[0], `\n\n*Asistente:* No se encontró ningún dato en memoria que coincida con "${target}".`).trim();
                            }
                        }
                    }
                }

                // ACTION_MEMORY_LIST (Ver datos guardados)
                if (respuestaTexto.includes('[ACTION_MEMORY_LIST]')) {
                    if (!esAdmin(chatId, msg)) {
                        respuestaTexto = respuestaTexto.replace('[ACTION_MEMORY_LIST]', '').trim();
                    } else {
                        const listStr = `\n\n` + formatearListaMemoria(memoriaGlobal);
                        respuestaTexto = respuestaTexto.replace('[ACTION_MEMORY_LIST]', listStr).trim();
                    }
                }

                // ACTION_SCHEDULE (Tareas programadas recurrentes)
                if (respuestaTexto.includes('[ACTION_SCHEDULE:')) {
                    const match = respuestaTexto.match(/\[ACTION_SCHEDULE:\s*([^\]]+)\]/);
                    if (match) {
                        const partes = match[1].split('|').map(p => p.trim());
                        let horaStr = partes[0] || '08:00';
                        let recurrente = true;
                        let instruccion = '';
                        let descripcion = '';

                        if (partes.length === 2) {
                            // Formato: HH:MM | instruccion
                            instruccion = partes[1];
                            descripcion = partes[1];
                        } else if (partes.length === 3) {
                            // HH:MM | diaria/unavez | instruccion  O  cron | descripcion | instruccion
                            if (['diaria', 'diario', 'recurrente', 'unavez', 'una vez', 'once'].includes(partes[1].toLowerCase())) {
                                recurrente = !['unavez', 'una vez', 'once'].includes(partes[1].toLowerCase());
                                instruccion = partes[2];
                                descripcion = partes[2];
                            } else {
                                descripcion = partes[1];
                                instruccion = partes[2];
                            }
                        } else if (partes.length >= 4) {
                            // Formato: HH:MM | diaria/unavez | instruccion | descripcion
                            recurrente = !['unavez', 'una vez', 'once'].includes(partes[1].toLowerCase());
                            instruccion = partes[2];
                            descripcion = partes[3];
                        }

                        if (!instruccion) instruccion = descripcion || "Tarea programada";
                        if (!descripcion) descripcion = instruccion;

                        const cronExpr = horaToCron(horaStr);
                        if (cronExpr) {
                            const destNormalizado = normalizarDestinoChat(chatId);
                            const indexExistente = tareasProgramadas.findIndex(t => {
                                const mismoChat = sonMismoChatDestino(t.chatId, destNormalizado);
                                const mismaHora = (t.hora === horaStr || t.cron === cronExpr);
                                return mismoChat && mismaHora;
                            });

                            if (indexExistente !== -1) {
                                // Actualizar tarea existente para este chat en este horario en vez de duplicarla
                                const tareaExistente = tareasProgramadas[indexExistente];
                                tareaExistente.accion = instruccion;
                                tareaExistente.prompt = instruccion;
                                tareaExistente.descripcion = descripcion.length > 60 ? descripcion.substring(0, 57) + '...' : descripcion;
                                tareaExistente.recurrente = recurrente;
                                tareaExistente.hora = horaStr;
                                tareaExistente.cron = cronExpr;
                                tareaExistente.chatId = destNormalizado;
                                tareaExistente.actualizada = new Date().toISOString();
                                guardarTareasProgramadas();
                                if (typeof global.inicializarTareas === 'function') {
                                    global.inicializarTareas();
                                }
                                console.log(`[ Agentic] Tarea programada actualizada: "${descripcion}" a las ${horaStr} para ${destNormalizado}`);
                            } else {
                                const nuevaTarea = {
                                    id: Date.now(),
                                    hora: horaStr,
                                    cron: cronExpr,
                                    recurrente: recurrente,
                                    accion: instruccion,
                                    prompt: instruccion,
                                    descripcion: descripcion.length > 60 ? descripcion.substring(0, 57) + '...' : descripcion,
                                    chatId: destNormalizado,
                                    creada: new Date().toISOString()
                                };

                                tareasProgramadas.push(nuevaTarea);
                                guardarTareasProgramadas();
                                if (typeof global.inicializarTareas === 'function') {
                                    global.inicializarTareas();
                                }
                                console.log(`[ Agentic] Tarea programada guardada: "${descripcion}" a las ${horaStr} (${cronExpr}) para ${destNormalizado}`);
                            }

                            const tipoTexto = recurrente ? "Diaria" : "Una vez";
                            const destLabel = destNormalizado.endsWith('@g.us') ? 'Grupo' : 'Privado';
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\nTarea programada: ${horaStr} (${tipoTexto})\nInstrucción: ${descripcion}\nDestino: ${destLabel}`).trim();
                        } else {
                            console.error(`[ Agentic] Formato de hora/cron inválido: ${horaStr}`);
                            respuestaTexto = respuestaTexto.replace(match[0], `\nHora no válida "${horaStr}". Usa formato como 05:00 o 5:00 PM.`).trim();
                        }
                    }
                }

                if (respuestaTexto.includes('[ACTION_MUSICA_BUSCAR:')) {
                    const match = respuestaTexto.match(/\[ACTION_MUSICA_BUSCAR:\s*([^\]]+)\]/);
                    if (match) {
                        const partes = match[1].split('|');
                        const cancion = partes[0]?.trim() || '';
                        const artista = partes[1]?.trim() || '';
                        const query = artista ? `${cancion} ${artista}` : cancion;
                        
                        console.log(`[ Agentic Música]: Buscando: ${query}`);
                        await msg.reply(` *Asistente:* Buscando la canción "${query}", por favor espere...`);
                        respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        
                        const outputAudio = 'musica_' + Date.now() + '.mp3';
                        const searchArgs = [
                            '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                            '--embed-thumbnail', '--add-metadata',
                            '-o', outputAudio,
                            `ytsearch1:${query}`
                        ];
                        
                        const child = spawn(getYtDlpBinary(), searchArgs, { shell: false });
                        
                        child.on('error', (err) => {
                            console.error('[!] Error en búsqueda de música agentic:', err);
                            msg.reply(" *Asistente:* yt-dlp no disponible. Instala con: pip install yt-dlp").catch(()=>{});
                        });
                        
                        child.on('close', async (code) => {
                            // yt-dlp may save as .mp3 or as .mp3.mp3 depending on version
                            const possibleFile = fs.existsSync(outputAudio) ? outputAudio : outputAudio.replace('.mp3', '') + '.mp3';
                            if (code !== 0 || !fs.existsSync(possibleFile)) {
                                msg.reply(` *Asistente:* No encontré "${cancion}" de "${artista}". Verifica el nombre del artista o canción.`).catch(()=>{});
                                return;
                            }
                            try {
                                const stats = fs.statSync(possibleFile);
                                const sizeMB = stats.size / (1024 * 1024);
                                const media = MessageMedia.fromFilePath(possibleFile);
                                if (sizeMB > 15) {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: true });
                                    await msg.reply(' *Asistente:* El audio se envió como documento debido a que es muy pesado/largo (' + sizeMB.toFixed(1) + ' MB).');
                                } else {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: false });
                                }
                                if (fs.existsSync(possibleFile)) fs.unlinkSync(possibleFile);
                            } catch (err) {
                                console.error('[!] Error enviando música agentic:', err);
                                msg.reply(" *Asistente:* Error al enviar el archivo de audio.").catch(()=>{});
                            }
                        });
                    }
                }

                // Interceptor for AI hallucinated text commands
                if (respuestaTexto.toLowerCase().includes('!bot video')) {
                    const matchTextCmd = respuestaTexto.match(/!bot video\s+(.+)/i);
                    if (matchTextCmd) {
                        const query = matchTextCmd[1].replace(/<[^>]+>/g, '').trim(); // Remove brackets like <enlace>
                        if (query && query !== 'enlace' && query !== 'inserte_aqui_el_enlace' && query.length > 2) {
                            console.log('[x  Interceptor] Transformando comando texto a tag:', query);
                            respuestaTexto += ` \n[ACTION_VIDEO_BUSCAR: ${query}]`;
                        } else {
                            // If it's just telling the user to use the command but didn't provide the query, we extract the query from the user's original text!
                            console.log('[x  Interceptor] AI sugirió comando vacío, forzando tag de descarga...');
                            respuestaTexto += ` \n[ACTION_VIDEO_BUSCAR: ${textoOriginal.replace(/descarga el video de|en youtube/ig, '').trim()}]`;
                        }
                    }
                }

                
                // Imagen (Agentic)
                if (respuestaTexto.includes('[ACTION_IMAGE:')) {
                    const matchImg = respuestaTexto.match(/\[ACTION_IMAGE:\s*([^\]]+)\]/);
                    if (matchImg) {
                        const promptImg = matchImg[1].trim();
                        console.log(`[Agentic Image]: Generando imagen para: ${promptImg}`);
                        await generarImagenIA(promptImg, msg);
                        respuestaTexto = respuestaTexto.replace(matchImg[0], '').trim();
                    }
                }

                // Notas (Agentic)
                if (respuestaTexto.includes('[ACTION_NOTE_ADD:')) {
                    const match = respuestaTexto.match(/\[ACTION_NOTE_ADD:\s*([^\]]+)\]/);
                    if (match) {
                        if (!esAdmin(chatId, msg)) {
                            respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        } else {
                            const noteText = match[1].trim();
                            notasGuardadas.push(noteText);
                            guardarNotas();
                            console.log(`[ Agentic Note Add]: ${noteText}`);
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\n *Nota guardada:* "${noteText}"`).trim();
                        }
                    }
                }
                
                if (respuestaTexto.includes('[ACTION_NOTE_LIST]')) {
                    if (!esAdmin(chatId, msg)) {
                        respuestaTexto = respuestaTexto.replace('[ACTION_NOTE_LIST]', '').trim();
                    } else {
                        if (notasGuardadas.length === 0) {
                            respuestaTexto = respuestaTexto.replace('[ACTION_NOTE_LIST]', `\n\n *No tienes notas guardadas.*`).trim();
                        } else {
                            let listStr = `\n\n *Notas Guardadas:*\n` + notasGuardadas.map((n, i) => `${i + 1}. ${n}`).join('\n');
                            respuestaTexto = respuestaTexto.replace('[ACTION_NOTE_LIST]', listStr).trim();
                        }
                    }
                }
                
                if (respuestaTexto.includes('[ACTION_NOTE_DELETE:')) {
                    const match = respuestaTexto.match(/\[ACTION_NOTE_DELETE:\s*([^\]]+)\]/);
                    if (match) {
                        if (!esAdmin(chatId, msg)) {
                            respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        } else {
                            const argBorrar = match[1].trim();
                            const noteIndex = parseInt(argBorrar) - 1;
                            let borrada = null;
                            if (!isNaN(noteIndex) && noteIndex >= 0 && noteIndex < notasGuardadas.length) {
                                borrada = notasGuardadas.splice(noteIndex, 1)[0];
                            } else {
                                const idx = notasGuardadas.findIndex(n => n.toLowerCase().includes(argBorrar.toLowerCase()));
                                if (idx !== -1) borrada = notasGuardadas.splice(idx, 1)[0];
                            }
                            if (borrada) {
                                guardarNotas();
                                respuestaTexto = respuestaTexto.replace(match[0], `\n\n *Nota eliminada:* "${borrada}"`).trim();
                            } else {
                                respuestaTexto = respuestaTexto.replace(match[0], `\n\n *No se encontró ninguna nota que coincida con:* "${argBorrar}"`).trim();
                            }
                        }
                    }
                }
// Audio TTS\n                // Video por nombre
                if (respuestaTexto.includes('[ACTION_VIDEO_BUSCAR:')) {
                    const match = respuestaTexto.match(/\[ACTION_VIDEO_BUSCAR:\s*([^\]]+)\]/);
                    if (match) {
                        const query = match[1].trim();
                        console.log(`[ Agentic Video]: Buscando: ${query}`);
                        await msg.reply(` *Asistente:* Buscando el video "${query}", por favor espere...`);
                        respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        
                        const outputVideo = 'video_' + Date.now() + '.mp4';
                        const searchArgs = [
                            '-f', '18/b[height<=480][ext=mp4]/b[ext=mp4]/worst',
                            '--max-filesize', '60m',
                            '-o', outputVideo,
                            `ytsearch1:${query}`
                        ];
                        
                        const child = spawn(getYtDlpBinary(), searchArgs, { shell: false });
                        
                        child.on('error', (err) => {
                            console.error('[!] Error en búsqueda de video agentic:', err);
                            msg.reply(" *Asistente:* yt-dlp no disponible. Instala con: pip install yt-dlp").catch(()=>{});
                        });

                        child.on('close', async (code) => {
                            if (code !== 0 || !fs.existsSync(outputVideo)) {
                                msg.reply(` *Asistente:* No pude descargar el video de la búsqueda "${query}". Es posible que no exista o esté muy restringido.`).catch(()=>{});
                                return;
                            }
                            try {
                                const stats = fs.statSync(outputVideo);
                                const sizeMB = stats.size / (1024 * 1024);
                                const media = MessageMedia.fromFilePath(outputVideo);
                                if (sizeMB > 15) {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: true, caption: `x *Asistente:* "${query}" se envía como documento debido a su peso (${sizeMB.toFixed(1)} MB).` });
                                } else {
                                    await msg.reply(media, undefined, { caption: ` *Asistente:* "${query}"` });
                                }
                                if (fs.existsSync(outputVideo)) fs.unlinkSync(outputVideo);
                            } catch (err) {
                                console.error('[!] Error enviando video agentic:', err);
                                msg.reply(" *Asistente:* Error al enviar el archivo de video.").catch(()=>{});
                            }
                        });
                    }
                }

                // Audio TTS
                if (respuestaTexto.includes('[ACTION_AUDIO:')) {
                    const match = respuestaTexto.match(/\[ACTION_AUDIO:\s*([^\]]+)\]/);
                    if (match) {
                        const audioTexto = match[1].trim();
                        console.log(`[x Agentic Audio]: Generando audio para: ${audioTexto}`);
                        const ttsExito = await generarAudioTTS(audioTexto, msg);
                        if (ttsExito) {
                            respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        } else {
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\na *No se pudo modular la voz en este momento.*`).trim();
                        }
                    }
                }

                // Alarma Add (Agentic)
                if (respuestaTexto.includes('[ACTION_ALARM_ADD:')) {
                    const match = respuestaTexto.match(/\[ACTION_ALARM_ADD:\s*([^\]]+)\]/);
                    if (match) {
                        const parts = match[1].split('|');
                        const hora = parts[0]?.trim();
                        const msgAlarma = parts[1]?.trim();
                        const diariaStr = parts[2]?.trim().toLowerCase();
                        const recurrente = (diariaStr === 'true' || diariaStr === 'diaria');
                        
                        if (/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(hora) && msgAlarma) {
                            alarmasGuardadas.push({ hora, mensaje: msgAlarma, chatId, recurrente, fecha: getFechaObjetivoAlarma(hora) });
                            guardarAlarmas();
                            console.log(`[x Agentic Alarm Add]: Alarma a las ${hora} recurrente=${recurrente}: ${msgAlarma}`);
                            // Calcular hora actual GT para mostrarla
                            const _horaActualGT = getHoraElSalvador(new Date());
                            const _alarmMsg = '\n\n *Asistente  Alarma Configurada:*\nxR Hora programada: *' + hora + '*  _(hora actual: ' + _horaActualGT + ')_\nx Recordatorio: _"' + msgAlarma + '"_\n' + (recurrente ? 'x Tipo: Diaria (se repite cada día)' : 'x" Tipo: Una sola vez (se autodestruye al dispararse)');
                            respuestaTexto = respuestaTexto.replace(match[0], _alarmMsg).trim();
                        } else {
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\na *Error al programar alarma.*`).trim();
                        }
                    }
                }

                // Alarma Delete (Agentic)
                if (respuestaTexto.includes('[ACTION_ALARM_DELETE:')) {
                    const match = respuestaTexto.match(/\[ACTION_ALARM_DELETE:\s*([^\]]+)\]/);
                    if (match) {
                        const argBorrar = match[1].trim();
                        const index = parseInt(argBorrar) - 1;
                        let borrada = null;
                        if (!isNaN(index) && index >= 0 && index < alarmasGuardadas.length) {
                            borrada = alarmasGuardadas.splice(index, 1)[0];
                        } else {
                            const idx = alarmasGuardadas.findIndex(al => al.hora === argBorrar || al.mensaje.toLowerCase().includes(argBorrar.toLowerCase()));
                            if (idx !== -1) borrada = alarmasGuardadas.splice(idx, 1)[0];
                        }
                        if (borrada) {
                            guardarAlarmas();
                            console.log(`[x Agentic Alarm Delete]: Alarma eliminada: ${borrada.hora}`);
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\nS& *Alarma eliminada:* [${borrada.hora}] ${borrada.mensaje}`).trim();
                        } else {
                            respuestaTexto = respuestaTexto.replace(match[0], `\n\na *No se encontró ninguna alarma que coincida con:* "${argBorrar}"`).trim();
                        }
                    }
                }

                // Finance Cards (Agentic: consulta general o de una tarjeta específica)
                if (respuestaTexto.includes('[ACTION_FINANCE_CARDS')) {
                    const match = respuestaTexto.match(/\[ACTION_FINANCE_CARDS(?::\s*([^\]]+))?\]/);
                    if (match) {
                        if (!esAdmin(chatId, msg)) {
                            respuestaTexto = respuestaTexto.replace(match[0], '\n\n Las funciones de finanzas están restringidas al Administrador.').trim();
                        } else {
                            if (!dbFirebase) inicializarFirebase();
                            if (!dbFirebase || !firebaseUid) {
                                respuestaTexto = respuestaTexto.replace(match[0], '\n\n Firebase no está configurado (falta serviceAccount.json o firebaseUid).').trim();
                            } else {
                                try {
                                    const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                                    const snapshot = await cardsRef.get();
                                    if (snapshot.empty) {
                                        respuestaTexto = respuestaTexto.replace(match[0], '\n\n *No hay tarjetas registradas en Finanzas King.*').trim();
                                    } else {
                                        const cardQuery = match[1] ? match[1].trim() : null;
                                        if (cardQuery) {
                                            // Consulta de una tarjeta específica
                                            const q = cardQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                                            let matchingCard = null;
                                            snapshot.forEach(doc => {
                                                const c = doc.data();
                                                const cName = (c.name || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                                                if (cName.includes(q) || q.includes(cName)) {
                                                    matchingCard = { id: doc.id, ...c };
                                                }
                                            });

                                            if (matchingCard) {
                                                const debt = parseFloat(matchingCard.balance || 0);
                                                const limit = parseFloat(matchingCard.limit || 0);
                                                const payGoal = parseFloat(matchingCard.payGoal || 0);
                                                const avail = limit > 0 ? (limit - debt) : 0;
                                                const pct = limit > 0 ? ((debt / limit) * 100).toFixed(0) : 0;

                                                let report = `\n\n *DETALLE DE TARJETA: ${matchingCard.name}*\n\n`;
                                                if (matchingCard.last4) report += ` *Terminación:* •••• ${matchingCard.last4}\n`;
                                                report += ` *Deuda Actual:* $${debt.toFixed(2)}\n`;
                                                if (payGoal > 0) report += ` *Pago p/no intereses:* $${payGoal.toFixed(2)}\n`;
                                                if (limit > 0) {
                                                    report += ` *Límite:* $${limit.toFixed(2)} | *Disponible:* $${avail.toFixed(2)} (${100 - pct}% libre)\n`;
                                                }
                                                if (matchingCard.cutDay) report += ` *Día de corte:* ${matchingCard.cutDay}\n`;
                                                if (matchingCard.payDay) report += ` *Día de pago:* ${matchingCard.payDay}\n`;

                                                respuestaTexto = respuestaTexto.replace(match[0], report).trim();
                                            } else {
                                                respuestaTexto = respuestaTexto.replace(match[0], `\n\n No se encontró la tarjeta "${cardQuery}" en Finanzas King.`).trim();
                                            }
                                        } else {
                                            // Resumen general de todas las tarjetas
                                            let tDebt = 0, tLimit = 0;
                                            let cardsReport = `\n\n *ESTADO DE TARJETAS (Finanzas King)* \n\n`;
                                            snapshot.forEach(doc => {
                                                const c = doc.data();
                                                const debt = parseFloat(c.balance || 0);
                                                const limit = parseFloat(c.limit || 0);
                                                tDebt += debt; tLimit += limit;
                                                const avail = limit > 0 ? (limit - debt) : 0;
                                                const corteStr = c.cutDay ? `Corte: ${c.cutDay}` : '';
                                                const pagoStr = c.payDay ? `Pago: ${c.payDay}` : '';
                                                const fechas = [corteStr, pagoStr].filter(Boolean).join(' | ');

                                                cardsReport += ` *${c.name}* ${c.last4 ? `(••${c.last4})` : ''}\n`;
                                                cardsReport += `    Deuda: $${debt.toFixed(2)} ${limit > 0 ? `/ Límite: $${limit.toFixed(2)}` : ''}\n`;
                                                if (limit > 0) cardsReport += `    Disp: $${avail.toFixed(2)}\n`;
                                                if (fechas) cardsReport += `    ${fechas}\n`;
                                                cardsReport += `\n`;
                                            });

                                            const ratio = tLimit > 0 ? (tDebt / tLimit) * 100 : 0;
                                            cardsReport += ` *Resumen Global:*\n`;
                                            cardsReport += ` *Deuda Total:* $${tDebt.toFixed(2)}\n`;
                                            cardsReport += ` *Disponible Total:* $${(tLimit - tDebt).toFixed(2)}\n`;
                                            cardsReport += ` *Endeudamiento:* ${ratio.toFixed(1)}%`;
                                            respuestaTexto = respuestaTexto.replace(match[0], cardsReport).trim();
                                        }
                                    }
                                } catch (e) {
                                    console.error("Error en agentic cards:", e);
                                    respuestaTexto = respuestaTexto.replace(match[0], `\n\n Error al obtener tarjetas: ${e.message}`).trim();
                                }
                            }
                        }
                    }
                }

                // Finance Alerts (Agentic: alertas de vencimiento de tarjetas)
                if (respuestaTexto.includes('[ACTION_FINANCE_ALERTS]')) {
                    if (!esAdmin(chatId, msg)) {
                        respuestaTexto = respuestaTexto.replace('[ACTION_FINANCE_ALERTS]', '\n\n Funciones de finanzas restringidas al Administrador.').trim();
                    } else {
                        if (!dbFirebase) inicializarFirebase();
                        if (!dbFirebase || !firebaseUid) {
                            respuestaTexto = respuestaTexto.replace('[ACTION_FINANCE_ALERTS]', '\n\n Firebase no configurado.').trim();
                        } else {
                            try {
                                const alertaStr = await chequearVencimientosYNotificar(true);
                                respuestaTexto = respuestaTexto.replace('[ACTION_FINANCE_ALERTS]', alertaStr ? `\n\n${alertaStr}` : '\n\n *No hay vencimientos próximos pendientes.*').trim();
                            } catch (errAl) {
                                respuestaTexto = respuestaTexto.replace('[ACTION_FINANCE_ALERTS]', `\n\n Error verificando vencimientos: ${errAl.message}`).trim();
                            }
                        }
                    }
                }

                // Finance Add (Agentic: registrar gastos o abonos en Firestore)
                if (respuestaTexto.includes('[ACTION_FINANCE_ADD:')) {
                    const match = respuestaTexto.match(/\[ACTION_FINANCE_ADD:\s*([^\]]+)\]/);
                    if (match) {
                        if (!esAdmin(chatId, msg)) {
                            respuestaTexto = respuestaTexto.replace(match[0], '\n\n Función de finanzas restringida al Administrador.').trim();
                        } else {
                            if (!dbFirebase) inicializarFirebase();
                            if (!dbFirebase || !firebaseUid) {
                                respuestaTexto = respuestaTexto.replace(match[0], '\n\n Firebase no configurado.').trim();
                            } else {
                                const parts = match[1].split('|').map(p => p.trim());
                                const type = parts[0]?.toLowerCase() === 'payment' ? 'payment' : 'expense';
                                const amt = parseFloat(parts[1]);
                                const concept = parts[2] || (type === 'payment' ? 'Abono a tarjeta' : 'Gasto registrado');
                                const cardQuery = parts[3] || '';
                                const catQuery = parts[4] || '';

                                if (isNaN(amt) || amt <= 0 || !cardQuery) {
                                    respuestaTexto = respuestaTexto.replace(match[0], '\n\n Datos de transacción inválidos en la acción de finanzas.').trim();
                                } else {
                                    try {
                                        const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                                        const cardsSnap = await cardsRef.get();
                                        let matchingCard = null;
                                        const qName = cardQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

                                        cardsSnap.forEach(doc => {
                                            const c = doc.data();
                                            const cName = (c.name || '').toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                                            if (cName.includes(qName) || qName.includes(cName)) {
                                                matchingCard = { id: doc.id, ...c };
                                            }
                                        });

                                        if (!matchingCard) {
                                            respuestaTexto = respuestaTexto.replace(match[0], `\n\n Tarjeta "${cardQuery}" no encontrada en Finanzas King.`).trim();
                                        } else {
                                            const defaultCats = [' Supermercado', ' Comida', ' Transporte', ' Hormiga', ' Servicios', ' Compras', ' Salud', ' Educación'];
                                            const defaultPayCats = [' Abono Capital', ' Sueldo/Ingreso', ' Transferencia'];
                                            let category = (type === 'payment') ? ' Abono Capital' : ' Hormiga';

                                            if (catQuery) {
                                                const cleanCat = catQuery.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                                                const listToSearch = (type === 'payment') ? defaultPayCats : defaultCats;
                                                for (const cat of listToSearch) {
                                                    const cleanListCat = cat.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                                                    if (cleanListCat.includes(cleanCat)) {
                                                        category = cat;
                                                        break;
                                                    }
                                                }
                                            }

                                            let newBal = parseFloat(matchingCard.balance || 0);
                                            if (type === 'expense') newBal += amt;
                                            else newBal = Math.max(0, newBal - amt);

                                            const batch = dbFirebase.batch();
                                            const expRef = dbFirebase.collection('users').doc(firebaseUid).collection('expenses').doc(Math.random().toString(36).slice(2));
                                            
                                            const payload = {
                                                amount: amt,
                                                type,
                                                cardId: matchingCard.id,
                                                cardName: matchingCard.name,
                                                concept,
                                                category,
                                                date: adminFirebase.firestore.Timestamp.fromDate(new Date())
                                            };

                                            batch.set(expRef, payload);
                                            batch.update(cardsRef.doc(matchingCard.id), { balance: newBal });
                                            await batch.commit();

                                            const titulo = type === 'expense' ? 'Gasto Registrado' : 'Abono Registrado';
                                            let regReport = `\n\n *${titulo}*\n`;
                                            regReport += `• *Monto:* $${amt.toFixed(2)}\n`;
                                            regReport += `• *Tarjeta:* ${matchingCard.name}\n`;
                                            regReport += `• *Concepto:* ${concept}\n`;
                                            regReport += `• *Categoría:* ${category}\n`;
                                            regReport += `_Guardado exitosamente._`;
                                            respuestaTexto = respuestaTexto.replace(match[0], regReport).trim();
                                        }
                                    } catch (e) {
                                        console.error("Error en agentic finance add:", e);
                                        respuestaTexto = respuestaTexto.replace(match[0], `\n\n Error al registrar movimiento: ${e.message}`).trim();
                                    }
                                }
                            }
                        }
                    }
                }

                            break;
            }

            // Limpieza final de la respuesta
            respuestaTexto = limpiarRespuestaGemini(respuestaTexto);

            // Purgar y guardar el historial limpio
            if (isConversational) {
                historial.push({ role: 'user', parts: partsGuardar });
                historial.push({ role: 'model', parts: [{ text: respuestaTexto }] });

                if (historial.length > 82) {
                    const systemPrompt = historial.slice(0, 2);
                    const ultimosMensajes = historial.slice(historial.length - 80);
                    sesionesChat.set(chatId, [...systemPrompt, ...ultimosMensajes]);
                }
            }

            exitoGemini = true;
        } catch (error) {
            console.error('[!] Error en ciclo de conversación Gemini:', error.message);
        }

        if (exitoGemini) {
            if (respuestaTexto.trim()) {
                await msg.reply(respuestaTexto);
            }
        } else {
            await msg.reply(" *Las llaves API de Gemini están agotadas o inhabilitadas por Google.*\n\nObtén una llave gratis en https://aistudio.google.com/app/apikey y agrégala con:\n*!bot addkey <TU_API_KEY>*");
        }
    } catch (error) {
        console.error("Error general:", error);
        try { await msg.reply("*Asistente:* Ocurrió un error interno. No se preocupe, sigo en pie."); } catch(e) {}
    }
});

// ============================================================
// MANEJADORES GLOBALES DE ERRORES  PREVIENEN QUE EL BOT MUERA
// ============================================================
let _reconectando = false;

process.on('uncaughtException', (error) => {
    console.error('\n[!] ERROR NO CAPTURADO:', error.message);
    
    const esErrorFatal = error.message && (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Session closed') ||
        error.message.includes('Target closed') ||
        error.message.includes('browser has disconnected') ||
        error.message.includes('Protocol error')
    );

    if (esErrorFatal) {
        console.log('[!] Error crítico de Chromium/WhatsApp Web. Reiniciando mediante Watchdog en 2s...');
        setTimeout(() => process.exit(1), 2000);
        return;
    }

    const esErrorNoCritico = error.message && (
        error.message.includes('canCheckStatusRanking') ||
        error.message.includes('window.require') ||
        error.message.includes('is not a function')
    );

    if (!esErrorNoCritico) {
        console.error('[!] Error capturado, el proceso continúa.');
    }
});

process.on('unhandledRejection', (reason) => {
    const msgErr = reason instanceof Error ? reason.message : String(reason);
    if (msgErr.includes('canCheckStatusRanking') ||
        msgErr.includes('window.require') ||
        msgErr.includes('Execution context') ||
        msgErr.includes('Session closed') ||
        msgErr.includes('msg.from.endsWith is not a function')) {
        return; // Ignorar errores conocidos de WhatsApp Web
    }
    console.error('[xPROMESA RECHAZADA]:', msgErr);
    // notificarErrorWhatsApp('Promesa Rechazada (async)', msgErr);
});

process.on('SIGTERM', () => {
    console.log('[a Asistente]: SIGTERM recibido. Cerrando...');
    client.destroy().finally(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('\n[a Asistente]: SIGINT recibido (Ctrl+C). Cerrando...');
    client.destroy().finally(() => process.exit(0));
});

async function startBot() {
    try {
        await client.initialize();
    } catch (e) {
        console.error('Error in initialize:', e.message);
        if (e.message.includes('Execution context was destroyed')) {
            console.log('Reiniciando bot por error de contexto...');
            setTimeout(() => { process.exit(1); }, 3000);
        }
    }
}
startBot();




process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection:', reason); if (reason && reason.message && reason.message.includes('Execution context was destroyed')) { process.exit(1); } });




