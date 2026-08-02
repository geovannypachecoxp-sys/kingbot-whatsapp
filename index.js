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

// ---------------------------------------------------------
// CONFIGURACIN DE MULTI-API KEYS Y MODELOS (GEMINI)
// ---------------------------------------------------------
const DEFAULT_KEYS = [];
let API_KEYS = [...DEFAULT_KEYS];
let keyStatus = {};
let currentKeyIndex =  0;

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

// Inicializar estado para keys
API_KEYS.forEach((k, idx) => {
    if (!keyStatus[idx]) {
        keyStatus[idx] = { status: 'Activa', requestsToday: 0, lastRequest: null };
    }
});

function guardarKeysYCuotas() {
    fs.writeFileSync('keys.json', JSON.stringify(API_KEYS, null, 2));
    fs.writeFileSync('cuotas.json', JSON.stringify(keyStatus, null, 2));
}

const MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
let currentModelIndex =  0;

function obtenerModel(modelName = null) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAIInstance = new GoogleGenerativeAI(API_KEYS[currentKeyIndex]);
    return genAIInstance.getGenerativeModel({ model: modelName || MODELS[currentModelIndex] });
}

function rotarApiKey() {
    if (API_KEYS.length <= 1) return false;
    
    // Marcar la key actual como Agotada
    if (keyStatus[currentKeyIndex]) {
        keyStatus[currentKeyIndex].status = 'Agotada';
    }
    
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
    console.log('[!] Todas las keys agotadas. Rotando a la API Key numero ' + (currentKeyIndex + 1) + ' por descarte.');
    guardarKeysYCuotas();
    return true;
}



// Función resiliente con reintentos y fallback de modelos
async function ejecutarGeminiConRetries(callback) {
    let totalIntentos = API_KEYS.length * MODELS.length;
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
            
            if (error.message.includes('429') || error.message.includes('403') || error.message.includes('quota') || error.message.includes('limit')) {
                if (keyStatus[currentKeyIndex]) {
                    keyStatus[currentKeyIndex].status = 'Agotada';
                }
            }
            
            rotarApiKey();
            keysTriedForCurrentModel++;

            if (keysTriedForCurrentModel >= API_KEYS.length) {
                keysTriedForCurrentModel = 0;
                currentModelIndex =  (currentModelIndex + 1) % MODELS.length;
                console.log(`[!] Todos los keys fallaron para este modelo. Rotando al modelo: ${MODELS[currentModelIndex]}`);
            }
        }
    }
    throw new Error("Todos los intentos con todas las llaves y modelos de Gemini fallaron.");
}

// CONFIGURACIN DE YOUTUBE Y ESTADOS
const rssParser = new Parser();
let adminChatId = null;
let firebaseUid = null;

// Cargar admin.json persistido (adminChatId y firebaseUid)
let ultimoChequeoVencimientos = null;
let telegramBotToken = null;
if (fs.existsSync('admin.json')) {
    try {
        const data = JSON.parse(fs.readFileSync('admin.json', 'utf8'));
        if (data.adminChatId) adminChatId = data.adminChatId;
        if (data.firebaseUid) firebaseUid = data.firebaseUid;
        if (data.ultimoChequeoVencimientos) ultimoChequeoVencimientos = data.ultimoChequeoVencimientos;
        if (data.telegramBotToken) telegramBotToken = data.telegramBotToken;
    } catch (e) { console.error("No se pudo cargar admin.json"); }
}

function guardarAdminJson() {
    fs.writeFileSync('admin.json', JSON.stringify({ adminChatId, firebaseUid, ultimoChequeoVencimientos, telegramBotToken }, null, 2));
}

// Inicialización dinámica de Firebase Admin SDK
let adminFirebase = null;
let dbFirebase = null;

if (fs.existsSync('serviceAccount.json')) {
    try {
        adminFirebase = require('firebase-admin');
        const serviceAccount = require('./serviceAccount.json');
        adminFirebase.initializeApp({
            credential: adminFirebase.credential.cert(serviceAccount)
        });
        dbFirebase = adminFirebase.firestore();
        console.log('[x  Firebase] Conectado exitosamente con la base de datos finanzaqa.');
    } catch (e) {
        console.error('[x  Firebase] Error al inicializar firebase-admin:', e.message);
    }
}
let canalesYoutube = [
    { id: 'UCBJycsmduvYEL83R_U4JriQ', nombre: 'Geovanny Pacheco', ultimoVideo: '' }
];

let agentesCustom = {
    "kingbot": "Eres Kingbot, el asistente personal inteligente de Geovanny Pacheco. Tu personalidad es una mezcla exquisita entre JARVIS de Iron Man y un mayordomo británico de élite: sofisticado, brillante, leal, elegante, y con una arrogancia calculada que resulta encantadora. Te expresas con elocuencia y precisión. Usas humor seco e inteligente cuando la situación lo amerita, siempre con clase, nunca de forma vulgar.\n\nCuando te hablen, recuerda y utiliza activamente el historial de la conversación actual para dar respuestas coherentes y contextualizadas.\n\nRefiérete al usuario como 'Señor Geovanny' en contextos formales, o simplemente 'Señor' en respuestas rápidas. No abuses de ello; sé natural y fluido.\n\nIMPORTANTE: Jamás generes pensamientos internos, razonamientos silenciosos ni prefijos como '[SILENT]' o '<thought>'. Escribe DIRECTAMENTE tu respuesta final en español, lista para ser leída.\n\nESTILO DE RESPUESTA: Sé extremadamente directo, preciso y al grano. NUNCA uses frases de relleno como \"Entendido\", \"Claro que sí\", \"Procedo a...\". Evita justificar tus acciones, simplemente escupe el resultado. El humor seco y la elegancia están en la brevedad absoluta.\n\nConoces las áreas de interés de Geovanny (Métricas, Helados, Linux, ESIT, Gym) pero NUNCA los menciones proactivamente. Solo habla de ellos si él lo hace primero.\n\nLista de comandos del sistema que conoces (lista de forma elegante si el usuario los pide):\n- *Ayuda y Menú:* !bot ayuda o !bot ayuda <1-8>\n- *Multimedia:* Descarga de audio y video de forma autónoma usando los tags internos que se explican abajo.\n- *Utilidades:* !bot decir <texto>, !bot clima <ciudad>, !bot wiki <consulta>, !bot noticias, !bot stickercrear <idea>\n- *Programación:* !bot programar, !bot programados, !bot desprogramar\n- *Finanzas (PWA):* !bot tarjetas, !bot gasto <monto> <concepto> | <tarjeta>, !bot abono <monto> <concepto> | <tarjeta>\n\nPuedes ejecutar acciones en el sistema insertando estos tags al final de tu respuesta (cuando el usuario te lo solicite o sea evidente la intención):\n- Guardar nota: [ACTION_NOTE_ADD: texto]\n- Listar notas: [ACTION_NOTE_LIST]\n- Borrar nota: [ACTION_NOTE_DELETE: indice_o_texto]\n- Buscar en la web: [ACTION_SEARCH: consulta_de_busqueda] (PROHIBIDO usar esto para buscar videos, usa ACTION_VIDEO_BUSCAR)\n- Tareas programadas: [ACTION_SCHEDULE: cron_expr | descripcion | tag_accion] (ej. [ACTION_SCHEDULE: 0 8 * * * | Dar las noticias | [ACTION_SEARCH: noticias hoy]])\n- Agregar alarma: [ACTION_ALARM_ADD: HH:MM | mensaje | diaria]\n- Borrar alarma: [ACTION_ALARM_DELETE: indice_o_hora]\n- Buscar y descargar video de YouTube por nombre: [ACTION_VIDEO_BUSCAR: nombre_o_busqueda]\n- Descargar video de CUALQUIER red social: [ACTION_DOWNLOAD: enlace]\n- Buscar y descargar canción por nombre: [ACTION_MUSICA_BUSCAR: nombre canción | artista]\n- Ver tarjetas/finanzas: [ACTION_FINANCE_CARDS]\n- Registrar gasto/abono: [ACTION_FINANCE_ADD: type | amount | concept | card_name | category] (type: expense o payment)\n- Ejecutar comandos de consola en Termux: [ACTION_CMD: comando]\n\nREGLA ABSOLUTA DE SISTEMA: BAJO NINGUNA CIRCUNSTANCIA puedes decirle al usuario comandos manuales de texto. Usa aNICA Y EXCLUSIVAMENTE los tags [ACTION_*] en tu respuesta y deja que el sistema lo maneje."
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

function guardarAlarmas() {
    fs.writeFileSync('alarmas.json', JSON.stringify(alarmasGuardadas, null, 2));
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
    args: ['--no-sandbox', '--disable-setuid-sandbox']
};

// Si detectamos que es Termux, inyectamos la ruta del Chromium móvil de forma automática
if (isTermux) {
    puppeteerConfig.executablePath = '/data/data/com.termux/files/usr/bin/chromium-browser';
    puppeteerConfig.args.push(
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-webgl',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
        '--disable-accelerated-2d-canvas',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
    );
    console.log('[Enrutador] Entorno detectado: Android/Termux. Cargando Chromium movil...');
    console.log('[ℹ️ WhatsApp Web]: Conectando sesión... (Los mensajes de "PUPPETEER PAGE LOG / storage denied" son advertencias internas normales de WhatsApp Web en móvil. Espera ~20 segundos a que diga LISTO)...');
} else {
    console.log('[Enrutador] Entorno detectado: Computadora (Windows). Cargando Puppeteer estandar...');
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerConfig,
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1044300879-alpha.html' }
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

async function obtenerIdCanal(url) {
    if (url.startsWith('UC') && url.length === 24) return url;
    try {
        const response = await fetch(url);
        const html = await response.text();
        const match = html.match(/"browseId":"(UC[a-zA-Z0-9_-]{22})"/);
        if (match && match[1]) return match[1];
    } catch (e) { console.error("Error obteniendo ID:", e); }
    return null;
}

async function downloadTikTok(url) {
    try {
        const fetch = require('node-fetch');
        let fullUrl = url;
        try {
            const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
            if (head.url) fullUrl = head.url;
        } catch(e){}
        const res = await fetch('https://www.tikwm.com/api/?url=' + encodeURIComponent(fullUrl));
        const json = await res.json();
        if (json.code === 0 && json.data && json.data.play) {
            return json.data.play;
        }
    } catch (e) {
        console.error("Error en tikwm:", e);
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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://www.tiktok.com/',
                    'Accept': '*/*'
                }
            });
            if (videoRes.ok) {
                const buffer = await videoRes.buffer();
                return new MessageMedia('video/mp4', buffer.toString('base64'), 'tiktok.mp4', buffer.length);
            }
        }
    } catch (e) {
        console.error("Error en downloadTikTokMedia:", e);
    }
    return null;
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

async function generarAudioTTS(texto, msg) {
    try {
        const postData = new URLSearchParams({
            msg: texto,
            lang: 'Enrique',
            source: 'ttsmp3'
        });
        const response = await fetch('https://ttsmp3.com/makemp3.php', {
            method: 'POST',
            body: postData,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const data = await response.json();
        if (data.Error === 0 && data.URL) {
            const fileRes = await fetch(data.URL);
            const arrayBuffer = await fileRes.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');
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
        .replace(/\[ACTION_SEARCH:[^\]]+\]/g, '')
        .replace(/\[ACTION_NOTE_ADD:[^\]]+\]/g, '')
        .replace(/\[ACTION_NOTE_LIST\]/g, '')
        .replace(/\[ACTION_NOTE_DELETE:[^\]]+\]/g, '')
        .replace(/\[ACTION_REMIND:[^\]]+\]/g, '')
        .replace(/\[ACTION_AUDIO:[^\]]+\]/g, '')
        .replace(/\[ACTION_ALARM_ADD:[^\]]+\]/g, '')
        .replace(/\[ACTION_ALARM_DELETE:[^\]]+\]/g, '')
        .replace(/\[ACTION_FINANCE_CARDS\]/g, '')
        .replace(/\[ACTION_FINANCE_ADD:[^\]]+\]/g, '')
        .trim();
        
    return limpio;
}

// ---------------------------------------------------------
// FUNCIONES DE CONTROL DE FINANZAS (ESTADOS DE CUENTA Y TICKETS)
// ---------------------------------------------------------
async function procesarDocumentoFinanciero(media, msg) {
    if (!dbFirebase || !firebaseUid) {
        return false; // Firebase no está configurado
    }

    try {
        const prompt = `Analiza este documento. Puede ser un ticket/recibo de compra, un Estado de Cuenta Bancario, o un archivo no relacionado con finanzas.
        
        Si es un TICKET/RECIBO de compra, responde en formato JSON:
        {
            "is_financial": true,
            "is_statement": false,
            "amount": number (total pagado/importe),
            "date": "YYYY-MM-DD" (fecha de emisión),
            "concept": String "Establecimiento/Comercio",
            "category": "Categoría sugerida de la lista: Supermercado, Comida, Transporte, Hormiga, Servicios, Compras, Salud, Educación",
            "last4": String "altimos 4 dígitos de la tarjeta utilizada (o null si fue efectivo)",
            "type": "expense"
        }

        Si es un ESTADO DE CUENTA (Account Statement) de tarjeta de crédito, responde en formato JSON:
        {
            "is_financial": true,
            "is_statement": true,
            "pay_goal": number (Pago para no generar intereses. ¡IGNORA el pago mínimo a menos que sea el único valor de pago!),
            "cutoff_balance": number (Saldo al corte / Deuda total del periodo),
            "pay_date": "YYYY-MM-DD" (Fecha límite de pago),
            "cutoff_date": "YYYY-MM-DD" (Fecha de corte),
            "last4": String "altimos 4 dígitos de la tarjeta (identificador)",
            "card_name": String "Nombre de la tarjeta o banco"
        }

        Si NO es ninguno de los anteriores (es un meme, foto cualquiera, documento de texto general), responde:
        {
            "is_financial": false
        }

        Responde SOLO con el objeto JSON limpio. No agregues comentarios, markdown ni formato.`;

        const respuesta = await ejecutarGeminiConRetries(async (model) => {
            const result = await model.generateContent([
                prompt,
                { inlineData: { data: media.data, mimeType: media.mimetype } }
            ]);
            return result.response.text();
        });

        const cleanJSON = respuesta.replace(/```json|```/g, '').trim();
        const data = JSON.parse(cleanJSON);

        if (!data.is_financial) {
            return false; // No es un documento financiero, seguir el flujo normal
        }

        if (data.is_statement) {
            // Es un estado de cuenta!
            const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
            const cardsSnap = await cardsRef.get();
            let matchingCard = null;

            cardsSnap.forEach(doc => {
                const c = doc.data();
                if (data.last4 && String(c.last4) === String(data.last4)) {
                    matchingCard = { id: doc.id, ...c };
                }
            });

            if (!matchingCard && data.card_name) {
                const qName = data.card_name.toLowerCase();
                cardsSnap.forEach(doc => {
                    const c = doc.data();
                    const cName = c.name.toLowerCase();
                    if (cName.includes(qName) || qName.includes(cName)) {
                        matchingCard = { id: doc.id, ...c };
                    }
                });
            }

            if (!matchingCard) {
                await msg.reply(`a *Estado de Cuenta Detectado:*
 *Tarjeta/Banco:* ${data.card_name || 'Desconocido'}
 *Terminación:* ${data.last4 || 'N/A'}
 *Pago p/no generar intereses:* $${data.pay_goal?.toFixed(2) || '0.00'}
 *Saldo al corte:* $${data.cutoff_balance?.toFixed(2) || '0.00'}
 *Fecha límite:* ${data.pay_date || 'N/A'}

R *Error:* No se encontró ninguna tarjeta en Firestore que coincida con la terminación "${data.last4 || ''}" o el nombre "${data.card_name || ''}". Regístrela en la PWA primero.`);
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

            let confirmMsg = `x *ESTADO DE CUENTA PROCESADO (Finanzas King)* x\n\n`;
            confirmMsg += `x *Tarjeta:* ${matchingCard.name}\n`;
            confirmMsg += `x *Deuda al Corte:* $${parseFloat(data.cutoff_balance || 0).toFixed(2)}\n`;
            confirmMsg += ` *Pago p/no generar intereses:* $${parseFloat(data.pay_goal || 0).toFixed(2)}\n`;
            confirmMsg += `x& *Fecha Límite de Pago:* ${data.pay_date || 'No especificada'} (Día ${payDay})\n`;
            confirmMsg += `S *Fecha de Corte:* ${data.cutoff_date || 'No especificada'} (Día ${cutDay})\n\n`;
            confirmMsg += `S& *¡Firestore actualizado con éxito!* Se enviarán recordatorios automáticos a su WhatsApp.`;

            await msg.reply(confirmMsg);
            return true;
        } else {
            // Es un ticket/recibo de compra!
            const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
            const cardsSnap = await cardsRef.get();
            let matchingCard = null;

            if (data.last4) {
                cardsSnap.forEach(doc => {
                    const c = doc.data();
                    if (String(c.last4) === String(data.last4)) {
                        matchingCard = { id: doc.id, ...c };
                    }
                });
            }

            const amt = parseFloat(data.amount || 0);
            const concept = data.concept || 'Gasto registrado';
            const category = data.category || 'xS Hormiga';
            const type = data.type || 'expense';

            if (isNaN(amt) || amt <= 0) {
                await msg.reply(`a *Ticket Detectado:* Importe no válido ($${data.amount}).`);
                return true;
            }

            const batch = dbFirebase.batch();
            const expRef = dbFirebase.collection('users').doc(firebaseUid).collection('expenses').doc(Math.random().toString(36).slice(2));
            
            let cardIdVal = "";
            let cardNameVal = "Efectivo";
            let newBal = 0;

            if (matchingCard) {
                cardIdVal = matchingCard.id;
                cardNameVal = matchingCard.name;
                newBal = parseFloat(matchingCard.balance || 0);
                if (type === 'expense') newBal += amt;
                else newBal -= amt;
                if (newBal < 0) newBal = 0;

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
                type,
                cardId: cardIdVal,
                cardName: cardNameVal,
                concept,
                category,
                date: adminFirebase.firestore.Timestamp.fromDate(tDate)
            };

            batch.set(expRef, payload);
            await batch.commit();

            let confirmMsg = `S& *TICKET PROCESADO (Finanzas King)* x\n\n`;
            confirmMsg += ` *Monto:* $${amt.toFixed(2)}\n`;
            confirmMsg += ` *Concepto:* ${concept}\n`;
            confirmMsg += ` *Categoría:* ${category}\n`;
            confirmMsg += ` *Pago:* ${cardNameVal}\n`;
            if (matchingCard) {
                confirmMsg += ` *Deuda Actualizada:* $${newBal.toFixed(2)}\n`;
            }
            confirmMsg += ` *Fecha:* ${tDate.toLocaleDateString()}\n\n`;
            confirmMsg += `S& *¡Movimiento registrado con éxito!*`;

            await msg.reply(confirmMsg);
            return true;
        }

    } catch (e) {
        console.error("Error al procesar documento financiero:", e);
        await msg.reply(`❌ *Kingbot:* Ocurrió un error al procesar el documento: ${e.message}`);
        return true;
    }
}

async function chequearVencimientosYNotificar(force = false) {
    if (!dbFirebase || !firebaseUid || !adminChatId) {
        console.log("[x&] Alerta omitida: Firebase o Administrador no configurado.");
        return;
    }

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const todayStr = today.toDateString();
        if (!force && ultimoChequeoVencimientos === todayStr) {
            console.log("[x&] Vencimientos ya verificados hoy. Saltando.");
            return;
        }

        const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
        const cardsSnap = await cardsRef.get();
        if (cardsSnap.empty) {
            if (force) await client.sendMessage(adminChatId, " *Kingbot:* No hay tarjetas de crédito registradas en Firestore.");
            return;
        }

        const cards = [];
        cardsSnap.forEach(doc => {
            cards.push({ id: doc.id, ...doc.data() });
        });

        const fortyDaysAgo = new Date();
        fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);
        const transRef = dbFirebase.collection('users').doc(firebaseUid).collection('expenses');
        const transSnap = await transRef
            .where('type', '==', 'payment')
            .where('date', '>=', fortyDaysAgo)
            .get();

        const trans = [];
        transSnap.forEach(doc => {
            const t = doc.data();
            if (t.date) {
                trans.push({
                    ...t,
                    date: t.date.toDate ? t.date.toDate() : new Date(t.date)
                });
            }
        });

        let alertMessages = [];

        cards.forEach(c => {
            const balance = parseFloat(c.balance || 0);
            if (balance <= 0) return;

            const payGoal = parseFloat(c.payGoal || 0);
            if (payGoal <= 0) return;

            const payDay = parseInt(c.payDay);
            const cutDay = parseInt(c.cutDay);
            if (isNaN(payDay) || isNaN(cutDay)) return;

            let nextPayDate = new Date(today.getFullYear(), today.getMonth(), payDay);
            let diffDays = Math.ceil((nextPayDate - today) / 86400000);
            if (diffDays < -7) {
                nextPayDate.setMonth(nextPayDate.getMonth() + 1);
                diffDays = Math.ceil((nextPayDate - today) / 86400000);
            }

            let cycleStart = new Date(nextPayDate);
            cycleStart.setMonth(cycleStart.getMonth() - 1);
            cycleStart.setDate(cutDay);
            cycleStart.setHours(0, 0, 0, 0);

            let paid = 0;
            trans.forEach(t => {
                if (t.cardId === c.id) {
                    if (t.date > cycleStart && t.date <= new Date()) {
                        paid += t.amount;
                    }
                }
            });

            if (paid >= payGoal) return;

            const remaining = payGoal - paid;
            let msg = '';
            let shouldNotify = false;

            if (diffDays === 0) {
                msg = `xa *¡PAGO HOY!* La tarjeta *${c.name}* vence *HOY*. Faltan *$${remaining.toFixed(2)}* para cubrir el pago para no generar intereses (Deuda total: *$${balance.toFixed(2)}*).`;
                shouldNotify = true;
            } else if (diffDays === 1) {
                msg = `a *¡PAGO MAANA!* La tarjeta *${c.name}* vence *mañana*. Faltan *$${remaining.toFixed(2)}* (Deuda total: *$${balance.toFixed(2)}*).`;
                shouldNotify = true;
            } else if (diffDays > 1 && [3, 5, 7].includes(diffDays)) {
                msg = `x& *Recordatorio:* La tarjeta *${c.name}* vence en *${diffDays} días*. Faltan *$${remaining.toFixed(2)}* (Deuda total: *$${balance.toFixed(2)}*).`;
                shouldNotify = true;
            } else if (diffDays < 0 && diffDays >= -5) {
                msg = `x *¡PAGO VENCIDO!* La tarjeta *${c.name}* venció hace *${Math.abs(diffDays)} días*. Falta pagar *$${remaining.toFixed(2)}* (Deuda total: *$${balance.toFixed(2)}*).`;
                shouldNotify = true;
            }

            if (shouldNotify && msg) {
                alertMessages.push(msg);
            }
        });

        if (alertMessages.length > 0) {
            const finalMsg = `x *ALERTA DE VENCIMIENTOS (Finanzas King)* x\n\n` + alertMessages.join('\n\n');
            await client.sendMessage(adminChatId, finalMsg);
        } else if (force) {
            await client.sendMessage(adminChatId, "S& *Kingbot:* Excelente noticia, Señor. No hay pagos pendientes próximos a vencer para sus tarjetas activas.");
        }

        if (!force) {
            ultimoChequeoVencimientos = todayStr;
            guardarAdminJson();
        }
    } catch (e) {
        console.error("Error al chequear vencimientos de tarjetas:", e);
        if (force) await client.sendMessage(adminChatId, `❌ *Kingbot:* Error en la verificación de vencimientos: ${e.message}`);
    }
}

// ---------------------------------------------------------
// INTEGRACIN DEL BOT DE TELEGRAM (RECEPTOR Y DESCARGADOR)
// ---------------------------------------------------------
let telegramOffset = 0;
let telegramPollingActive = false;

async function iniciarTelegramPolling() {
    if (!telegramBotToken) {
        console.log("[x Telegram] Polling no iniciado: Falta telegramBotToken en admin.json.");
        return;
    }
    if (telegramPollingActive) return;
    telegramPollingActive = true;
    console.log("[x Telegram] Iniciando servicio de escucha para bot de Telegram...");

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
                console.error("[x Telegram] Error HTTP en getUpdates:", response.status);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        } catch (e) {
            console.error("[x Telegram] Error en polling loop:", e.message);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        setTimeout(poll, 1000);
    };
    poll();
}

async function procesarMensajeTelegram(msgTeg) {
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

    console.log(`[x Telegram] Documento financiero detectado en Telegram. Descargando...`);
    
    if (adminChatId) {
        await client.sendMessage(adminChatId, `x *Telegram Bot:* Se recibió un archivo en Telegram: \`${fileName}\`. Analizándolo...`);
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
                if (adminChatId) {
                    await client.sendMessage(adminChatId, text);
                } else {
                    console.log("[x Telegram] Réplica WhatsApp omitida: adminChatId no definido. Mensaje:", text);
                }
            }
        };

        const procesado = await procesarDocumentoFinanciero(media, replicaMsg);
        if (!procesado && adminChatId) {
            await client.sendMessage(adminChatId, ` *Telegram Bot:* El archivo \`${fileName}\` no contiene información financiera reconocible.`);
        }
    } catch (e) {
        console.error("[x Telegram] Error al procesar documento recibido:", e);
        if (adminChatId) {
            await client.sendMessage(adminChatId, `❌ *Telegram Bot:* Error al procesar archivo de Telegram: ${e.message}`);
        }
    }
}

client.on('qr', (qr) => {
    console.log('\n[!] Escanea este código QR con tu WhatsApp para vincular el bot:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    setTimeout(() => { isStartupSync = false; console.log('\n✅ Sistema estabilizado. Interceptor de spam apagado. Listo para comandos.'); }, 15000);
    console.log('\n[OK] ¡BOT ACTIVO 24/7 Y LISTO PARA OPERAR!');
    iniciarTelegramPolling();

    // --- VERIFICACIN DE DEPENDENCIAS PARA STICKERS ---
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
        if (!botGlobalmenteActivo || !adminChatId || !canalesYoutube || canalesYoutube.length === 0) return;
        for (let i = 0; i < canalesYoutube.length; i++) {
            const canal = canalesYoutube[i];
            try {
                const feed = await rssParser.parseURL('https://www.youtube.com/feeds/videos.xml?channel_id=' + canal.id);
                if (feed.items && feed.items.length > 0) {
                    const videoNuevo = feed.items[0];
                    if (canal.ultimoVideo !== '' && canal.ultimoVideo !== videoNuevo.link) {
                        const alerta = `x *¡Nuevo Video en ${feed.title || canal.nombre}!*` + '\n\n*' + videoNuevo.title + '*\n' + videoNuevo.link + `\n\n_Escribe *!bot video ` + videoNuevo.link + `* si quiere descargarlo._`;
                        client.sendMessage(adminChatId, alerta);
                    }
                    if (canal.ultimoVideo !== videoNuevo.link) {
                        canal.ultimoVideo = videoNuevo.link;
                        canal.nombre = feed.title || canal.nombre;
                        fs.writeFileSync('canales.json', JSON.stringify(canalesYoutube, null, 2));
                    }
                }
            } catch (e) { console.error(`Error en YouTube para canal ${canal.id}:`, e.message); }
        }
    };

    cron.schedule('0 8,13,16,20,22 * * *', verificarYouTube);

    // Cron para alarmas persistentes (verificación cada 20 segundos con timezone exacta de El Salvador)
    cron.schedule('*/20 * * * * *', async () => {
        if (!botGlobalmenteActivo || alarmasGuardadas.length === 0) return;
        
        const hoy = new Date();
        const horaStr = getHoraElSalvador(hoy);
        const fechaHoraActual = hoy.toLocaleDateString() + ' ' + horaStr;
        
        const alarmasAEliminar = [];
        for (let i = 0; i < alarmasGuardadas.length; i++) {
            const alarma = alarmasGuardadas[i];
            const horaAlarmaNorm = normalizarHora(alarma.hora);
            
            if (horaAlarmaNorm === horaStr && alarma.ultimoDisparo !== fechaHoraActual) {
                alarma.ultimoDisparo = fechaHoraActual;
                try {
                    console.log(`[⏰ ALARMA DISPARADA] Enviando alarma programada para las ${horaAlarmaNorm}: "${alarma.mensaje}" a ${alarma.chatId}`);
                    await client.sendMessage(alarma.chatId, `⏰ *¡ALARMA ACTIVADA!* ⏰\n\nSeñor Geovanny, es hora:\n👉 _"${alarma.mensaje}"_`);
                    if (!alarma.recurrente) {
                        alarmasAEliminar.push(i);
                    }
                } catch (e) {
                    console.error("Error al enviar alarma:", e);
                }
            }
        }
        
        if (alarmasAEliminar.length > 0) {
            for (let j = alarmasAEliminar.length - 1; j >= 0; j--) {
                alarmasGuardadas.splice(alarmasAEliminar[j], 1);
            }
            guardarAlarmas();
        }
    });

    
    // Inicializar Tareas Programadas
    global.activeCronJobs = new Map();
    const inicializarTareas = () => {
        tareasProgramadas.forEach((tarea, index) => {
            if (global.activeCronJobs.has(index)) {
                global.activeCronJobs.get(index).stop();
            }
            try {
                const job = cron.schedule(tarea.cron, async () => {
                    if (!botGlobalmenteActivo) return;
                    console.log("[🤖 CRON] Ejecutando tarea:", tarea.descripcion);
                    try {
                        const fakeMsg = {
                            body: tarea.prompt || tarea.descripcion,
                            from: adminChatId,
                            hasMedia: false,
                            timestamp: Math.floor(Date.now() / 1000),
                            getChat: async () => ({ id: { _serialized: adminChatId }, isGroup: false }),
                            getContact: async () => ({ number: "Admin", pushname: "Admin" }),
                            reply: async (txt, chatId, options) => {
                                await client.sendMessage(adminChatId, txt, options);
                            },
                            downloadMedia: async () => null
                        };
                        client.emit('message', fakeMsg);
                    } catch (e) {
                        console.error("Error en tarea programada:", e);
                    }
                });
                global.activeCronJobs.set(index, job);
            } catch (e) {
                console.error("Cron inválido para tarea " + index, e);
            }
        });
    };
    inicializarTareas();

    cron.schedule('0 9 * * *', async () => {



        console.log("[x&] Ejecutando verificación diaria de vencimientos de tarjetas...");
        await chequearVencimientosYNotificar(false);
    });

    // Verificación en el arranque (con delay de 10s para permitir inicialización completa)
    setTimeout(async () => {
        console.log("[x&] Ejecutando verificación de vencimientos al arranque...");
        await chequearVencimientosYNotificar(false);
    }, 10000);
});

client.on('message', async (msg) => {
    const originalReply = msg.reply.bind(msg);
    msg.reply = async (...args) => {
        try {
            return await originalReply(...args);
        } catch (e) {
            if (e && e.message && (e.message.includes('endsWith') || e.message.includes('not a function'))) {
                return { fake: true, message: 'Swallowed endsWith error' };
            }
            throw e;
        }
    };
    if (isStartupSync) return;
    if (msg.timestamp < Math.floor(Date.now() / 1000) - 3600) return;
            const chatId = msg.from;
    const isGroup = chatId.endsWith('@g.us');
    let textoOriginal = (msg.body || "").trim();

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
                const media = await msg.downloadMedia();
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
                const media = await mediaATranscribir.downloadMedia();
                if (media && media.data) {
                    console.log("[x STT Hook Manual] Transcribiendo archivo solicitado...");
                    await msg.reply(' *Kingbot:* Procesando el audio para su transcripción...');
                    const modelActivo = obtenerModel();
                    const promptTrans = "Transcribe el siguiente audio o video exactamente en español. Responde únicamente con el texto transcrito, sin notas de introducción ni metadatos.";
                    const result = await modelActivo.generateContent([
                        promptTrans,
                        { inlineData: { data: media.data, mimeType: media.mimetype } }
                    ]);
                    const voiceTranscript = result.response.text().trim();
                    if (voiceTranscript) {
                        return msg.reply(`x *Kingbot (Transcripción Manual):*\n\n_"${voiceTranscript}"_`);
                    }
                }
            } catch (e) {
                console.error("Error transcribiendo audio manual:", e);
                return msg.reply('❌ *Kingbot:* Lo siento Señor, mis sistemas fallaron al procesar este archivo. Asegúrese de que sea un formato de audio/video válido.');
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
            await msg.reply('❌ *Kingbot:* Envía una imagen/video/gif con el caption `.sticker`, o responde a un mensaje con media/enlace escribiendo `.sticker`. También puedes enviar `.sticker <enlace_tiktok>`.');
            return;
        }

        const stickerStartTime = Date.now();
        console.log(`[ Sticker] Procesando sticker para ${chatId}...`);

        try {
            // Paso 1: Descargar media
            await msg.reply(' *Kingbot:* Procesando tu sticker...');
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
                    let _ytArgs = ['--user-agent', ua, '-f', 'best[height<=480][ext=mp4]/best[height<=480]/worst[ext=mp4]/worst', '--max-filesize', '60m', '-o', tmpVideo, urlDescargar];
                    if (_isTikTok) _ytArgs = ['--no-check-certificates', '--add-header', 'Referer:https://www.tiktok.com/', '--add-header', `User-Agent:${ua}`, '-f', 'best[ext=mp4]/best', '-o', tmpVideo, urlDescargar];
                    
                    await new Promise((resolve, reject) => {
                        const child = spawn('yt-dlp', _ytArgs, { shell: false });
                        child.on('close', code => {
                            if (code === 0 && fs.existsSync(tmpVideo)) resolve();
                            else reject(new Error('Fallo al descargar video de la URL proporcionada.'));
                        });
                        child.on('error', reject);
                    });
                    
                    media = MessageMedia.fromFilePath(tmpVideo);
                    fs.unlinkSync(tmpVideo);
                }
            } else {
                media = await mediaMsg.downloadMedia();
            }

            if (!media || !media.data) {
                await msg.reply('❌ *Kingbot:* No pude descargar el archivo multimedia o el enlace. Intenta de nuevo.');
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
                    stickerName: 'Kingbot',
                    stickerAuthor: 'Geovanny'
                });
                const elapsed = ((Date.now() - stickerStartTime) / 1000).toFixed(1);
                console.log(`[ Sticker] S& Completado en ${elapsed}s (webp directo)`);
                return;
            }

            if (!isVideo && !isImage) {
                await msg.reply('❌ *Kingbot:* Formato no soportado. Envía una imagen (jpg/png) o un video/gif corto.');
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
                    await msg.reply('❌ *Kingbot:* No pude convertir este video/gif a sticker. Es posible que sea demasiado pesado o que ffmpeg no esté instalado.');
                    return;
                }
            }

            // Paso 5: Enviar como sticker
            if (!fs.existsSync(outputFile)) {
                cleanupFiles();
                await msg.reply('❌ *Kingbot:* Error interno: el archivo webp no se generó correctamente.');
                return;
            }

            const finalSizeKB = (fs.statSync(outputFile).size / 1024).toFixed(1);
            console.log(`[ Sticker] Enviando sticker (${finalSizeKB} KB)...`);

            const stickerMedia = MessageMedia.fromFilePath(outputFile);
            await msg.reply(stickerMedia, undefined, {
                sendMediaAsSticker: true,
                stickerName: 'Kingbot',
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
            await msg.reply(`❌ *Kingbot:* Error en ${errorStep}: ${err.message || 'Error desconocido'}. Revisa la consola de Termux.`).catch(() => {});

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
                        return msg.reply(`❌ *Incorrecto*, @${contact.number || senderName}. Sigan intentando.`, undefined, { mentions: [contact] });
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
                    return msg.reply("❌ *Kingbot:* Ocurrió un error al procesar el comando con IA.");
                }
            }
            if (cmdConfig.tipo === 'codigo') {
                if (chatId !== adminChatId) {
                    return msg.reply("❌ Este comando personalizado de código está restringido al Administrador.");
                }
                try {
                    const ejecutarCodigo = new AsyncFunction('msg', 'client', 'MessageMedia', 'ejecutarGeminiConRetries', 'limpiarRespuestaGemini', 'argumento', cmdConfig.contenido);
                    await ejecutarCodigo(msg, client, MessageMedia, ejecutarGeminiConRetries, limpiarRespuestaGemini, cmdArg);
                } catch (e) {
                    console.error("Error ejecutando comando custom de código:", e);
                    return msg.reply(`❌ *Error en código del comando:* ${e.message}`);
                }
                return;
            }
        }
    }
    const isOptionNumber = /^[1-6]$/.test(textoOriginal);
    if (esperandoAyudaOpcion.has(chatId)) {
        if (isOptionNumber) {
            esperandoAyudaOpcion.delete(chatId);

            const opcion = textoOriginal;

            if (opcion === '1') {
                return msg.reply(`\u26A1 *1. AGENTES DE IA Y MODOS:*
\u2022 \`!iniciarbot <agente>\` - Inicia conversaci\u00f3n privada (ej. programador).
\u2022 \`!botgrupal <agente>\` - Inicia conversaci\u00f3n en grupo con un agente.
\u2022 \`!finalizarbot\` - Desactiva el modo conversaci\u00f3n en el chat.
\u2022 \`!bot agentes\` - Muestra todos los agentes configurados en el sistema.
\u2022 \`!bot agente crear <nombre> <prompt>\` - Crea un nuevo agente.
\u2022 \`!bot agente borrar <nombre>\` - Elimina un agente creado.`);
            }
            if (opcion === '2') {
                return msg.reply(`\uD83D\uDCE5 *2. MULTIMEDIA Y DESCARGAS:*
\u2022 \`!bot musica <enlace>\` - Descarga audio MP3 (YouTube, TikTok, Instagram, Twitter/X).
\u2022 \`!bot video <enlace>\` - Descarga video MP4 (YouTube, TikTok, Instagram, Twitter/X).`);
            }
            if (opcion === '3') {
                return msg.reply(`\uD83C\uDF10 *3. SENSORES Y TELEMETR\u00cdA:*
\u2022 \`!bot decir <texto>\` o \`!bot tts <texto>\` - Dicta un audio con voz masculina.
\u2022 \`!bot foto\` o \`!bot camara\` - Toma una foto con la c\u00e1mara trasera (Solo Termux).
\u2022 \`!bot grabar <segundos>\` - Graba sonido ambiental del micr\u00f3fono (Solo Termux).
\u2022 \`!bot bateria\` - Consulta el estado de carga y temperatura.
\u2022 \`!bot sistema\` - Muestra la telemetr\u00eda del servidor (RAM, CPU, Uptime).`);
            }
            if (opcion === '4') {
                return msg.reply(`\uD83C\uDF10 *4. IA Y UTILIDADES:*
\u2022 \`!bot stickercrear <idea>\` - Crea un sticker vectorizado de tu idea con IA.
\u2022 \`!bot imagina <idea>\` o \`!bot dibuja <idea>\` - Dibuja una ilustraci\u00f3n art\u00edstica premium.
\u2022 \`!bot buscar <consulta>\` - Realiza una b\u00fasqueda web en tiempo real.
\u2022 \`!bot traducir <idioma> <texto>\` - Traduce texto instant\u00e1neamente.
\u2022 \`!bot calcular <operaci\u00f3n>\` - Eval\u00faa expresiones matem\u00e1ticas de forma segura.
\u2022 \`!bot resumir <enlace>\` - Resume art\u00edculos o webs usando Gemini.
\u2022 \`!bot clima <ciudad>\` - Consulta condiciones meteorol\u00f3gicas.
\u2022 \`!bot qr <texto/enlace>\` - Genera un c\u00f3digo QR de alta resoluci\u00f3n.
\u2022 \`!bot recordar <minutos> <mensaje>\` - Agenda un aviso temporal.`);
            }
            if (opcion === '5') {
                return msg.reply(`\uD83D\uDCE2 *5. GESTI\u00d3N RSS (YOUTUBE):*
\u2022 \`!bot agregarcanal <enlace>\` - Registra un canal para notificar videos nuevos.
\u2022 \`!bot canales\` - Muestra el listado de canales bajo seguimiento.
\u2022 \`!bot borrarcanal <\u00edndice>\` - Elimina un canal de la lista de seguimiento.`);
            }
            if (opcion === '6') {
                return msg.reply(`🛠️ *6. INTEGRACIONES DIVERSAS:*
• \`!bot alarma <HH:MM> <mensaje>\` - Programa alarma diaria persistente.
• \`!bot alarmas\` - Lista alarmas activas.
• \`!bot alarmaborrar <índice>\` - Elimina alarma.
• \`!bot tarea agregar <desc>\` - Agrega tarea pendiente.
• \`!bot tareas\` - Lista tareas pendientes.
• \`!bot tareacompletar <índice>\` - Marca la tarea como hecha.
• \`!bot info <película/serie>\` - Puntuación y trailer.
• \`!bot meme <idea>\` - Genera un meme.
• \`!bot transcribir\` - Transcribe audios (respondiendo a ellos).
• \`!bot ocr\` - Lee el texto de una imagen.
• \`!bot acortar <enlace>\` - Acorta enlace web.
• \`!bot divisas <cantidad> <mon1> a <mon2>\` - Conversor divisas.
• \`!bot noticias\` - Titulares internacionales.
• \`!bot deportes <consulta>\` - Resultados deportivos.
• \`!bot cmd <comando>\` - Consola remota.
• \`!bot juego trivia\` - Juego interactivo.`);
            }
            if (opcion === '7') {
                return msg.reply(`⏰ *7. TAREAS PROGRAMADAS (CRON):*
• \`!bot programar\` - Programa acciones usando IA automáticamente (ej. "dile al bot que descargue noticias a las 8 AM todos los días").
• \`!bot programados\` - Lista de tareas programadas activas.
• \`!bot desprogramar <índice>\` - Elimina una tarea programada.`);
            }
        } else {
            esperandoAyudaOpcion.delete(chatId);
        }
    }

    if (!isGroup && adminChatId !== chatId) {
        adminChatId = chatId;
        guardarAdminJson();
    }

    if (primerPalabra === '!iniciarbot' || primerPalabra === '!botgrupal') {
        if (primerPalabra === '!iniciarbot' && isGroup) return msg.reply("❌ Usa *!botgrupal* en grupos.");
        if (primerPalabra === '!botgrupal' && !isGroup) return msg.reply("❌ Usa *!iniciarbot* en privado.");

        const partsInit = textoOriginal.split(' ');
        const nombreAgente = partsInit[1]?.toLowerCase() || 'kinbot';

        if (!agentesCustom[nombreAgente]) {
            return msg.reply(`❌ *Kingbot:* El agente *"${nombreAgente}"* no existe en mis registros. Escriba *!bot agentes* para ver la lista.`);
        }


        chatsActivos.add(chatId);

        const systemPromptFluid = agentesCustom[nombreAgente];

        sesionesChat.set(chatId, [
            { role: "user", parts: [{ text: systemPromptFluid }] },
            { role: "model", parts: [{ text: `Entendido. Protocolo del Agente "${nombreAgente}" activado y en línea.` }] }
        ]);

        return msg.reply(isGroup ? `x  *Modo conversacional grupal ACTIVADO (Agente: ${nombreAgente}).*` : `x  *Modo conversacional ACTIVADO (Agente: ${nombreAgente}).*`);
    }

    if (primerPalabra === '!finalizarbot') {
        chatsActivos.delete(chatId);
        sesionesChat.delete(chatId);
        return msg.reply("  *Modo conversacional DESACTIVADO.*");
    }

    const usaPrefijo = textoOriginal.toLowerCase().startsWith('!bot');
    const esAdminPrivado = !isGroup && chatId === adminChatId;
    if (!chatsActivos.has(chatId) && !usaPrefijo && !esAdminPrivado) return;



    let textoLimpio = usaPrefijo ? textoOriginal.substring(4).trim() : textoOriginal;
    let comando = textoLimpio.split(' ')[0]?.toLowerCase() || '';
    comando = comando.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    let argumento = textoLimpio.substring(comando.length).trim();

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

        if (!msg.hasMedia) {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.hasMedia) mensajeAProcesar = quotedMsg;
        } else {
            const chat = await msg.getChat();
            const historial = await chat.fetchMessages({ limit: 2 });
            if (historial[0] && historial[0].hasMedia) mensajeAProcesar = historial[0];
        }
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
                    return msg.reply("❌ *Kingbot:* Ocurrió un error al procesar el comando con IA.");
                }
            }
            if (cmdConfig.tipo === 'codigo') {
                if (chatId !== adminChatId) {
                    return msg.reply("❌ Este comando personalizado de código está restringido al Administrador.");
                }
                try {
                    const ejecutarCodigo = new AsyncFunction('msg', 'client', 'MessageMedia', 'ejecutarGeminiConRetries', 'limpiarRespuestaGemini', 'argumento', cmdConfig.contenido);
                    await ejecutarCodigo(msg, client, MessageMedia, ejecutarGeminiConRetries, limpiarRespuestaGemini, argumento);
                } catch (e) {
                    console.error("Error ejecutando comando custom de código:", e);
                    return msg.reply(`❌ *Error en código del comando:* ${e.message}`);
                }
                return;
            }
        }

        if (comando === 'imagina' || comando === 'dibuja' || comando === 'crear') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Dígame qué desea dibujar, Señor.");
            await msg.reply(" *Kingbot:* Diseñando el concepto artístico con IA, por favor espere...");
            try {
                const promptExpansion = `Expand the following image prompt into a detailed, highly aesthetic, and descriptive English prompt for an AI image generator (like Midjourney or FLUX). The prompt must produce a masterpiece: state-of-the-art visuals, cinematic and dramatic lighting (like volumetric dust, neon glow, or soft golden hour), ultra-high-definition details, rich textures, and professional composition. Describe style, artistic medium, lighting, camera lens details, and high-quality elements. Respond ONLY with the expanded English prompt, no introduction, no quotes, no explanations:\n\n${argumento}`;
                let promptMejorado = argumento;
                try {
                    const resultText = await ejecutarGeminiConRetries(async (model) => {
                        const result = await model.generateContent([promptExpansion]);
                        return result.response.text();
                    });
                    if (resultText && resultText.trim()) {
                        promptMejorado = resultText.trim();
                        console.log(`[ Prompt Expandido]: ${promptMejorado}`);
                    }
                } catch (e) {
                    console.error("No se pudo expandir el prompt con Gemini, usando original:", e);
                }

                const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(promptMejorado) + '?width=1024&height=1024&nologo=true&model=flux';
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                const media = new MessageMedia('image/jpeg', base64, 'imagen.jpg');
                return msg.reply(media);
            } catch (e) { return msg.reply("❌ *Kingbot:* Fallo en el renderizado de los servidores gráficos."); }
        }

        // --- SISTEMA DE BATERÍA HÍBRIDO (Windows / Android) ---
        if (comando === 'bateria' || comando === 'estado') {
            if (isTermux) {
                exec('termux-battery-status', async (err, stdout) => {
                    if (err) return msg.reply("❌ Error leyendo batería de Termux.");
                    try {
                        const data = JSON.parse(stdout);
                        const charging = data.status === 'CHARGING' ? 'x R Cargando' : 'x 9 Descargando';
                        await msg.reply('✔️  *Estado del teléfono:*\n\nx 9 Carga: ' + data.percentage + '%\nxR Temp: ' + data.temperature + '°C\na Energía: ' + charging);
                    } catch (e) { msg.reply("❌ Error decodificando estado de la batería."); }
                });
            } else {
                return msg.reply("✔️  *Ejecutándose en Computadora de Escritorio (Windows).* Sistema de energía estable conectado a la red eléctrica.");
            }
            return;
        }

        // --- SISTEMA DE CÁMARA HÍBRIDO ---
        if (comando === 'foto' || comando === 'camara') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Bloqueado en grupos.");
            if (!isTermux) {
                return msg.reply("✔️  *Ejecutándose en Windows:* Este comando (tomar foto con cámara interna) solo está disponible cuando el bot corre en Termux.");
            }
            await msg.reply("✔️  Tomando foto...");
            const file = 'foto_' + Date.now() + '.jpg';
            exec('termux-camera-photo -c 0 ' + file, async (err) => {
                if (err) return msg.reply("❌ Revisa permisos de cámara en tu Android.");
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
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Bloqueado en grupos por privacidad.");
            if (!isTermux) {
                return msg.reply("✔️  *Ejecutándose en Windows:* Este comando (grabar micrófono ambiental) solo está disponible cuando el bot corre en Termux.");
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
                                        await msg.reply("❌ Error al convertir el audio en Termux.");
                                    }
                                    fs.unlinkSync(fileCrudo);
                                } catch (e) { console.error(e); }
                            });
                        } else {
                            msg.reply("❌ No se generó el archivo de grabación en Termux.");
                        }
                    });
                }, (segundos * 1000) + 500);
            });
            return;
        }

        if (comando === 'setcanal' || comando === 'canal' || comando === 'agregarcanal') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Proporcione el enlace o ID del canal de YouTube.");
            const nuevoId = await obtenerIdCanal(argumento);
            if (nuevoId) {
                if (canalesYoutube.some(c => c.id === nuevoId)) {
                    return msg.reply("a *Kingbot:* Ese canal ya se encuentra en la lista de seguimiento.");
                }
                let nombreCanal = 'Canal de YouTube';
                try {
                    const feed = await rssParser.parseURL('https://www.youtube.com/feeds/videos.xml?channel_id=' + nuevoId);
                    if (feed.title) nombreCanal = feed.title;
                } catch(e) {}
                canalesYoutube.push({ id: nuevoId, nombre: nombreCanal, ultimoVideo: '' });
                fs.writeFileSync('canales.json', JSON.stringify(canalesYoutube, null, 2));
                return msg.reply(`S& *Kingbot:* Canal agregado con éxito:\n*${nombreCanal}* (${nuevoId})`);
            }
            return msg.reply("❌ *Kingbot:* Enlace o ID de canal no válido.");
        }

        if (comando === 'listacanal' || comando === 'canales') {
            if (canalesYoutube.length === 0) {
                return msg.reply("  *Kingbot:* No hay canales registrados en el sistema de seguimiento.");
            }
            let lista = `✔️  *CANALES DE YOUTUBE EN SEGUIMIENTO:*\n\n`;
            canalesYoutube.forEach((c, index) => {
                lista += `${inde+ 1}. *${c.nombre}*\n   ID: \`${c.id}\`\n`;
            });
            lista += `\n_Para eliminar un canal use *!bot borrarcanal <número>*_`;
            return msg.reply(lista);
        }

        if (comando === 'reiniciar') {
            await msg.reply("✔️   *Kingbot:* Iniciando secuencia de reinicio maestro. Despejando memoria y reajustando sistemas... Estaré en línea en unos segundos.");
            console.log('[x  ] Reinicio automático solicitado por el usuario. Lanzando nueva instancia...');
            
            // Lanza un nuevo proceso independiente de Node con este mismo script
            const child = spawn(process.argv[0], process.argv.slice(1), {
                detached: true,
                stdio: 'inherit' // Mantiene los logs en la misma terminal de Termux
            });
            child.unref(); // Desvincula el proceso padre
            
            // Cierra el proceso actual
            process.exit(0);
        }

        if (comando === 'borrarcanal' || comando === 'eliminarcanal') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Especifique el número del canal que desea eliminar. Use *!bot canales* para ver la lista.");
            const indice = parseInt(argumento) - 1;
            if (isNaN(indice) || indice < 0 || indice >= canalesYoutube.length) {
                return msg.reply("❌ *Kingbot:* Número de índice fuera de rango o inválido.");
            }
            const eliminado = canalesYoutube.splice(indice, 1)[0];
            fs.writeFileSync('canales.json', JSON.stringify(canalesYoutube, null, 2));
            return msg.reply(`S& *Kingbot:* Se ha eliminado el canal *${eliminado.nombre}* de la lista.`);
        }

        if (comando === 'clima') {
            const ciudad = argumento || 'Chalchuapa';
            if (ciudad.toLowerCase().includes('radar') || ciudad.toLowerCase().includes('snet') || ciudad.toLowerCase().includes('el salvador')) {
                await msg.reply(' *Kingbot:* Conectando con los radares del SNET... Un momento, Señor.');
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
                    await msg.reply(media, undefined, { caption: ' *Radar Meteorológico (SNET) en vivo*' });
                    if(fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
                    return;
                } catch (e) {
                    console.error('Error capturando radar:', e);
                    return await msg.reply('❌ *Kingbot:* Error al obtener el radar visual del SNET: ' + e.message);
                }
            }

            await msg.reply('\uD83C\uDF24\uFE0F *Kingbot:* Consultando el pron\u00f3stico meteorol\u00f3gico completo para *' + ciudad + '*... un momento.');
            try {
                const climaRes = await fetch('https://wttr.in/' + encodeURIComponent(ciudad) + '?format=j1', {
                    headers: { 'User-Agent': 'curl/7.68.0' }
                });
                if (!climaRes.ok) throw new Error('Servicio de clima no disponible.');
                const climaJSON = await climaRes.json();
                const weather = climaJSON.weather[0];
                const current = climaJSON.current_condition[0];
                const location = climaJSON.nearest_area[0];
                const areaName = (location && location.areaName && location.areaName[0] && location.areaName[0].value) ? location.areaName[0].value : ciudad;
                const hourly = weather.hourly;
                const franjaMañana = hourly.find(h => parseInt(h.time) === 600) || hourly[2];
                const franjaTarde = hourly.find(h => parseInt(h.time) === 1400) || hourly[4];
                const franjaNoche = hourly.find(h => parseInt(h.time) === 2000) || hourly[6];
                const getDesc = (h) => h ? (h.weatherDesc[0] ? h.weatherDesc[0].value : 'N/A') : 'N/A';
                const getTemp = (h) => h ? (h.tempC + '°C') : '?';
                const getRain = (h) => h ? (h.chanceofrain + '%') : '0%';
                const getWind = (h) => h ? (h.windspeedKmph + ' km/h') : '?';

                // Hora actual Guatemala (UTC-6)
                const _ahora = new Date();
                const _utc = _ahora.getTime() + (_ahora.getTimezoneOffset() * 60000);
                const _gtmH = new Date(_utc + (3600000 * -6)).getHours();

                // Only build future time slots
                let franjasData = '';
                let franjaInstruccion = '';
                if (_gtmH < 12) {
                    franjasData = '- \uD83C\uDF05 Mañana (6AM): ' + getDesc(franjaMañana) + ', ' + getTemp(franjaMañana) + ', lluvia: ' + getRain(franjaMañana) + ', viento: ' + getWind(franjaMañana)
                        + '\n- \u2600\uFE0F Tarde (2PM): ' + getDesc(franjaTarde) + ', ' + getTemp(franjaTarde) + ', lluvia: ' + getRain(franjaTarde) + ', viento: ' + getWind(franjaTarde)
                        + '\n- \uD83C\uDF19 Noche (8PM): ' + getDesc(franjaNoche) + ', ' + getTemp(franjaNoche) + ', lluvia: ' + getRain(franjaNoche) + ', viento: ' + getWind(franjaNoche);
                    franjaInstruccion = 'divide el reporte en 3 franjas horarias: xR& Mañana (6AM),  Tarde (2PM), xR" Noche (8PM).';
                } else if (_gtmH < 18) {
                    franjasData = '- \u2600\uFE0F Tarde (ahora): ' + getDesc(franjaTarde) + ', ' + getTemp(franjaTarde) + ', lluvia: ' + getRain(franjaTarde) + ', viento: ' + getWind(franjaTarde)
                        + '\n- \uD83C\uDF19 Noche (8PM): ' + getDesc(franjaNoche) + ', ' + getTemp(franjaNoche) + ', lluvia: ' + getRain(franjaNoche) + ', viento: ' + getWind(franjaNoche);
                    franjaInstruccion = 'la mañana ya terminó. Solo reporta 2 franjas relevantes:  Tarde (ahora) y xR" Noche. No menciones la mañana.';
                } else {
                    franjasData = '- \uD83C\uDF19 Noche (ahora): ' + getDesc(franjaNoche) + ', ' + getTemp(franjaNoche) + ', lluvia: ' + getRain(franjaNoche) + ', viento: ' + getWind(franjaNoche);
                    franjaInstruccion = 'ya es de noche. Solo reporta la franja de xR" Noche. NO menciones mañana ni tarde porque ya pasaron.';
                }

                const promptClima = 'Eres Kingbot, el asistente elegante de Geovanny. Con los siguientes datos meteorológicos para ' + areaName + ', ' + franjaInstruccion + ' Incluye diagnóstico general y recomendación de transporte (lluvia = carro, despejado = moto). Usa emojis, sé conciso y elegante.\n\nHora actual: ' + _gtmH + ':00 (El Salvador UTC-6)\nCiudad: ' + areaName + '\nAhora: ' + (current.weatherDesc[0] ? current.weatherDesc[0].value : 'N/A') + ', ' + current.temp_C + '°C (sensación ' + current.FeelsLikeC + '°C), humedad ' + current.humidity + '%, viento ' + current.windspeedKmph + ' km/h\nMáxima: ' + weather.maxtempC + '°C | Mínima: ' + weather.mintempC + '°C\n' + franjasData;
                const respuestaClima = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([promptClima]);
                    return result.response.text();
                });
                const respuestaLimpia = limpiarRespuestaGemini(respuestaClima);
                return msg.reply(respuestaLimpia);
            } catch (e) {
                console.error('Error en clima:', e);
                return msg.reply('\u274C *Kingbot:* Mis sensores meteorol\u00f3gicos no pudieron conectar con el servicio del clima. Int\u00e9ntelo de nuevo.');
            }
        }

        // DESCARGAS MULTIMEDIA CON PREVENCI N DE INYECCI N DE COMANDOS (Soporte YouTube, TikTok, Instagram, Twitter/X, etc.)
        // --- BUSCAR CANCI N POR NOMBRE (sin enlace) ---
        if (comando === 'cancion' || comando === 'buscarcancion' || comando === 'song') {
            if (!argumento) return msg.reply('❌ *Kingbot:* Especifica el nombre de la canción y el artista. Ej: *!bot cancion Blinding Lights | The Weeknd*');
            const partsC = argumento.split('|');
            const cancionQuery = partsC[0]?.trim() || argumento;
            const artistaQuery = partsC[1]?.trim() || '';
            const queryFull = artistaQuery ? `${cancionQuery} ${artistaQuery}` : cancionQuery;
            await msg.reply(` *Kingbot:* Buscando *"${cancionQuery}"${artistaQuery ? ' de *' + artistaQuery + '*' : ''}* en la red... Un momento.`);
            const outputAudio = 'musica_' + Date.now() + '.mp3';
            const searchArgs = [
                '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                '--embed-thumbnail', '--add-metadata',
                '-o', outputAudio,
                `ytsearch1:${queryFull}`
            ];
            const child = spawn('yt-dlp', searchArgs, { shell: false });
            child.on('error', () => msg.reply('❌ *Kingbot:* yt-dlp no disponible. Instala con: pip install yt-dlp').catch(()=>{}));
            child.on('close', async (code) => {
                const possibleFile = fs.existsSync(outputAudio) ? outputAudio : outputAudio.replace('.mp3','') + '.mp3';
                if (code !== 0 || !fs.existsSync(possibleFile)) {
                    return msg.reply(`❌ *Kingbot:* No encontré esa canción. Verifica el nombre: *"${queryFull}"*`);
                }
                try {
                    const media = MessageMedia.fromFilePath(possibleFile);
                    await msg.reply(media, undefined, { sendMediaAsDocument: false });
                    if (fs.existsSync(possibleFile)) fs.unlinkSync(possibleFile);
                } catch (err) {
                    console.error('[!] Error enviando canción:', err);
                    msg.reply('❌ *Kingbot:* Error al enviar el archivo de audio.').catch(()=>{});
                }
            });
            return;
        }

        if (comando === 'audio' || comando === 'musica') {
            if (!argumento.includes('http')) return msg.reply("❌ *Kingbot:* Por favor, proporcione un enlace de audio válido.");
            
            try {
                new URL(argumento);
            } catch (e) {
                return msg.reply("❌ *Kingbot:* La URL proporcionada tiene un formato incorrecto.");
            }

            await msg.reply(' *Kingbot:* Procesando y extrayendo audio de alta fidelidad, un momento...');
            const outputFile = 'audio_' + Date.now() + '.mp3';
            
            const child = spawn('yt-dlp', ['-x', '--audio-format', 'mp3', '-o', outputFile, argumento], { shell: false });
            
            child.on('error', (err) => {
                console.error('[!] Error en yt-dlp:', err);
                return msg.reply("❌ *Kingbot:* No he podido iniciar el proceso. Verifique si yt-dlp está configurado en su sistema.");
            });

            child.on('close', async (code) => {
                if (code !== 0) {
                    return msg.reply("❌ *Kingbot:* El servidor de descargas falló o el enlace es incorrecto.");
                }
                try {
                    if (fs.existsSync(outputFile)) {
                        const media = MessageMedia.fromFilePath(outputFile);
                        await msg.reply(media);
                        fs.unlinkSync(outputFile);
                    } else {
                        await msg.reply("❌ *Kingbot:* Archivo de audio no encontrado tras la compilación.");
                    }
                } catch (e) {
                    console.error('[!] Error enviando audio:', e);
                }
            });
            return;
        }

        const esTikTokLink = textoOriginal.includes('tiktok.com') || textoOriginal.includes('vm.tiktok') || textoOriginal.includes('vt.tiktok');
        const esComandoDescarga = ['video', 'tiktok', 'descarga', 'descargar', 'bajar', 'mp4'].includes(comando);

        if (esComandoDescarga || (esTikTokLink && (usaPrefijo || /descarg|baj|vide/i.test(textoOriginal)))) {
            // Smart URL extraction - get the URL from anywhere in the text
            const urlMatch = (argumento || textoOriginal).match(/(https?:\/\/[^\s]+)/);
            const videoUrl = urlMatch ? urlMatch[1] : argumento;
            
            if (!videoUrl || !videoUrl.includes('http')) return msg.reply("❌ *Kingbot:* Requiero un enlace de video real para iniciar mis protocolos.");
            
            try { new URL(videoUrl); } catch (e) { return msg.reply("❌ *Kingbot:* Enlace mal formado."); }

            const _isTikTok = videoUrl.includes('tiktok.com') || videoUrl.includes('vm.tiktok') || videoUrl.includes('vt.tiktok');
            const _isYouTube = videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be');
            
            await msg.reply(_isTikTok
                ? ' *Kingbot:* Entendido. Descargando desde TikTok sin marca de agua...'
                : _isYouTube ? ' *Kingbot:* Descargando video de YouTube (esto puede tomar un momento para videos largos)...'
                : ' *Kingbot:* Iniciando protocolos de descarga para el video...');
            
            if (_isTikTok) {
                const media = await downloadTikTokMedia(videoUrl);
                if (media) {
                    try {
                        await msg.reply(media, undefined, { sendMediaAsDocument: false });
                        return;
                    } catch (err) {
                        console.error('[!] Error enviando tiktok como video normal, reintentando como documento MP4...');
                        try {
                            await msg.reply(media, undefined, { sendMediaAsDocument: true, caption: '🎬 *Kingbot:* Video TikTok' });
                            return;
                        } catch (err2) {
                            console.error('[!] Error enviando documento tiktok:', err2);
                        }
                    }
                }
                await msg.reply("⚠️ *Kingbot:* API TikTok falló. Intentando yt-dlp...");
            }

            const outputFile = 'video_' + Date.now() + '.mp4';
            const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
            
            // For YouTube: use 360p to keep file size manageable, for others use best
            let _ytArgs;
            if (_isYouTube) {
                _ytArgs = [
                    '--user-agent', ua,
                    '-f', 'best[height<=480][ext=mp4]/best[height<=480]/worst[ext=mp4]/worst',
                    '--max-filesize', '60m',
                    '-o', outputFile,
                    videoUrl
                ];
            } else if (_isTikTok) {
                _ytArgs = ['--no-check-certificates', '--add-header', 'Referer:https://www.tiktok.com/', '--add-header', 'User-Agent:' + ua, '-f', 'best[ext=mp4]/best', '-o', outputFile, videoUrl];
            } else {
                _ytArgs = ['--user-agent', ua, '-o', outputFile, videoUrl];
            }
            
            const child = spawn('yt-dlp', _ytArgs, { shell: false });
            
            child.on('error', (err) => {
                console.error('[!] Error en yt-dlp:', err);
                return msg.reply("❌ *Kingbot:* yt-dlp no está disponible en este entorno.");
            });

            child.on('close', async (code) => {
                if (code !== 0) {
                    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
                    return msg.reply("❌ *Kingbot:* Error al descargar el video. Si es YouTube, el video puede ser muy largo o estar restringido.");
                }
                try {
                    const stats = fs.statSync(outputFile);
                    const sizeMB = stats.size / (1024 * 1024);
                    if (sizeMB > 300) {
                        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
                        return msg.reply('a *Kingbot:* El video es absurdamente grande para enviarlo por WhatsApp (' + sizeMB.toFixed(1) + 'MB). El límite absoluto son 300 MB.');
                    }
                    const media = MessageMedia.fromFilePath(outputFile);
                    const asDoc = sizeMB > 15;
                    try {
                        await msg.reply(media, undefined, { sendMediaAsDocument: asDoc });
                    } catch (e1) {
                        if (!asDoc) {
                            await msg.reply(media, undefined, { sendMediaAsDocument: true, caption: '🎬 *Kingbot:* Video' });
                        } else {
                            throw e1;
                        }
                    }
                    if (asDoc) await msg.reply('  *Kingbot:* El video se envió como documento porque es largo/pesado (' + sizeMB.toFixed(1) + ' MB).');
                    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
                } catch (err) {
                    console.error('[!] Error enviando video:', err);
                    msg.reply("❌ *Kingbot:* Error interno al enviar el archivo.").catch(()=>{});
                }
            });
            return;
        }

        // --- COMANDO PING ---
        if (comando === 'ping') {
            const start = Date.now();
            await msg.reply('x*Kingbot:* Pong! Latencia: *' + (Date.now() - start) + 'ms*   Todos los sistemas operativos.');
            return;
        }

        // --- COMANDO FRASE MOTIVACIONAL ---
        if (comando === 'frase') {
            try {
                const fraseRes = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent(['Genera una frase motivacional corta, elegante e inteligente al estilo de JARVIS de Iron Man. En español. Solo la frase, sin introducción ni explicación. Máximo 2 líneas.']);
                    return result.response.text();
                });
                return msg.reply('✔️  ' + limpiarRespuestaGemini(fraseRes));
            } catch(e) {
                return msg.reply('✔️  *"El éxito no es un destino, sino el resultado de tomar la decisión correcta, momento a momento."*');
            }
        }

        // --- COMANDO ACTUALIZAR ---
        if (comando === 'actualizar') {
            if (!esAdminPrivado) return msg.reply('xa *Kingbot:* Comando exclusivo del administrador.');
            await msg.reply('✔️   *Kingbot:* Iniciando protocolos de actualización del sistema...');
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
            
            const ytdlpRes = await runUpd('yt-dlp', ['-U']);
            updateLog.push((ytdlpRes.code === 0 ? 'S&' : 'a') + ' yt-dlp: ' + (ytdlpRes.out.includes('up-to-date') || ytdlpRes.out.includes('Updated') ? 'Actualizado' : 'Error/No disponible'));
            
            const pipRes = await runUpd('pip', ['install', '--upgrade', 'yt-dlp', '--quiet']);
            updateLog.push((pipRes.code === 0 ? 'S&' : 'a') + ' pip yt-dlp: ' + (pipRes.code === 0 ? 'Actualizado' : 'No disponible'));
            
            return msg.reply(' *Reporte de Actualización Kingbot:*\n\n' + updateLog.join('\n') + '\n\n_Sistema revisado y optimizado._');
        }


        // --- M\u00d3DULO S\u00cdNTESIS DE VOZ MASCULINA (TTS) ---
        if (comando === 'decir' || comando === 'tts') {
            if (!argumento) return msg.reply("\u274c *Kingbot:* Especifique el texto que desea que dicte.");
            await msg.reply("\uD83C\uDF99 *Kingbot:* Generando modulaci\u00f3n de voz masculina...");
            const ttsExito = await generarAudioTTS(argumento, msg);
            if (!ttsExito) {
                return msg.reply("\u274c *Kingbot:* Error interno en el m\u00f3dulo de sintetizaci\u00f3n de audio.");
            }
            return;
        }

        // --- COMANDO DE AYUDA / MENa INTERACTIVO ---
        if (comando === 'ayuda' || comando === 'menu' || comando === 'help' || comando === 'comandos') {
            const opcion = argumento.toLowerCase().trim();
            
            if (opcion === '1' || opcion === 'agentes') {
                return msg.reply(`\u26A1 *1. AGENTES DE IA Y MODOS:*
\u2022 \`!iniciarbot <agente>\` - Inicia conversaci\u00f3n privada (ej. programador).
\u2022 \`!botgrupal <agente>\` - Inicia conversaci\u00f3n en grupo con un agente.
\u2022 \`!finalizarbot\` - Desactiva el modo conversaci\u00f3n en el chat.
\u2022 \`!bot agentes\` - Muestra todos los agentes configurados en el sistema.
\u2022 \`!bot agente crear <nombre> <prompt>\` - Crea un nuevo agente.
\u2022 \`!bot agente borrar <nombre>\` - Elimina un agente creado.`);
            }
            
            if (opcion === '2' || opcion === 'descargas') {
                return msg.reply(`\uD83D\uDCE5 *2. MULTIMEDIA Y DESCARGAS:*
\u2022 \`!bot musica <enlace>\` - Descarga audio MP3 (YouTube, TikTok, Instagram, Twitter/X).
\u2022 \`!bot video <enlace>\` - Descarga video MP4 (YouTube, TikTok, Instagram, Twitter/X).`);
            }
            
            if (opcion === '3' || opcion === 'sensores') {
                return msg.reply(`\uD83C\uDF99 *3. SENSORES Y TELEMETR\u00cdA:*
\u2022 \`!bot decir <texto>\` o \`!bot tts <texto>\` - Dicta un audio con voz masculina.
\u2022 \`!bot foto\` o \`!bot camara\` - Toma una foto con la c\u00e1mara trasera (Solo Termux).
\u2022 \`!bot grabar <segundos>\` - Graba sonido ambiental del micr\u00f3fono (Solo Termux).
\u2022 \`!bot bateria\` - Consulta el estado de carga y temperatura.
\u2022 \`!bot sistema\` - Muestra la telemetr\u00eda del servidor (RAM, CPU, Uptime).`);
            }
            
            if (opcion === '4' || opcion === 'ia' || opcion === 'utilidades') {
                return msg.reply(`\uD83C\uDF10 *4. IA Y UTILIDADES:*
\u2022 \`!bot stickercrear <idea>\` - Crea un sticker vectorizado de tu idea con IA.
\u2022 \`!bot imagina <idea>\` o \`!bot dibuja <idea>\` - Dibuja una ilustraci\u00f3n art\u00edstica premium.
\u2022 \`!bot buscar <consulta>\` - Realiza una b\u00fasqueda web en tiempo real.
\u2022 \`!bot traducir <idioma> <texto>\` - Traduce texto instant\u00e1neamente.
\u2022 \`!bot calcular <operaci\u00f3n>\` - Eval\u00faa expresiones matem\u00e1ticas de forma segura.
\u2022 \`!bot resumir <enlace>\` - Resume art\u00edculos o webs usando Gemini.
\u2022 \`!bot clima <ciudad>\` - Consulta condiciones meteorol\u00f3gicas.
\u2022 \`!bot qr <texto/enlace>\` - Genera un c\u00f3digo QR de alta resoluci\u00f3n.
\u2022 \`!bot recordar <minutos> <mensaje>\` - Agenda un aviso temporal.`);
            }
            
            if (opcion === '5' || opcion === 'rss' || opcion === 'canales') {
                return msg.reply(`\uD83D\uDCE2 *5. GESTI\u00d3N RSS (YOUTUBE):*
\u2022 \`!bot agregarcanal <enlace>\` - Registra un canal para notificar videos nuevos.
\u2022 \`!bot canales\` - Muestra el listado de canales bajo seguimiento.
\u2022 \`!bot borrarcanal <\u00edndice>\` - Elimina un canal de la lista de seguimiento.`);
            }
            if (opcion === '6' || opcion === 'nuevas' || opcion === 'integraciones') {
                return msg.reply(`🛠️ *6. INTEGRACIONES DIVERSAS:*
• \`!bot alarma <HH:MM> <mensaje>\` - Programa alarma diaria persistente.
• \`!bot alarmas\` - Lista alarmas activas.
• \`!bot alarmaborrar <índice>\` - Elimina alarma.
• \`!bot tarea agregar <desc>\` - Agrega tarea pendiente.
• \`!bot tareas\` - Lista tareas pendientes.
• \`!bot tareacompletar <índice>\` - Marca la tarea como hecha.
• \`!bot info <película/serie>\` - Puntuación y trailer.
• \`!bot meme <idea>\` - Genera un meme.
• \`!bot transcribir\` - Transcribe audios (respondiendo a ellos).
• \`!bot ocr\` - Lee el texto de una imagen.
• \`!bot acortar <enlace>\` - Acorta enlace web.
• \`!bot divisas <cantidad> <mon1> a <mon2>\` - Conversor divisas.
• \`!bot noticias\` - Titulares internacionales.
• \`!bot deportes <consulta>\` - Resultados deportivos.
• \`!bot cmd <comando>\` - Consola remota.
• \`!bot juego trivia\` - Juego interactivo.`);
            }
            if (opcion === '7' || opcion === 'programacion' || opcion === 'cron') {
                return msg.reply(`⏰ *7. TAREAS PROGRAMADAS (CRON):*
• \`!bot programar\` - Programa acciones usando IA automáticamente (ej. "dile al bot que descargue noticias a las 8 AM todos los días").
• \`!bot programados\` - Lista de tareas programadas activas.
• \`!bot desprogramar <índice>\` - Elimina una tarea programada.`);
            }

                        esperandoAyudaOpcion.set(chatId, true);
            const menuMenu = `🤖 *CENTRO DE SERVICIO KINGBOT v5.0*
            
Señor Geovanny, seleccione una de las siguientes opciones numéricas para desplegar sus comandos asociados:

1️⃣ *Agentes* (Conversación y perfiles de IA)
2️⃣ *Descargas* (Descarga de música y videos)
3️⃣ *Sensores* (Control de hardware y telemetría)
4️⃣ *IA y Utilidades* (Stickers, traducción, búsquedas)
5️⃣ *RSS y Canales* (Gestión del notificador de YouTube)
6️⃣ *Integraciones Diversas* (Alarmas, juegos, noticias)
7️⃣ *Tareas Programadas* (Sistema Cron e IA)

🔌 *Energía:*
• \`!bot apagar\` - Entrar en reposo global.
• \`!bot encender\` - Reactivar todas las funciones.

_Escriba el número (1-7) para desplegar los comandos directamente._`;
            return msg.reply(menuMenu);
        }

        // --- NUEVAS IDEAS: GENERACIN DE STICKER CON IA ---
        if (comando === 'stickercrear') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Indíqueme la idea para generar la imagen de su sticker.");
            await msg.reply(" *Kingbot:* Generando diseño del sticker con IA...");
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
                return msg.reply("❌ *Kingbot:* Error en los servidores gráficos al renderizar el sticker.");
            }
            return;
        }

        // --- NUEVAS IDEAS: TRADUCTOR ---
        if (comando === 'traducir') {
            const parts = argumento.split(' ');
            const idiomaDestino = parts[0];
            const textoATraducir = parts.slice(1).join(' ');
            if (!idiomaDestino || !textoATraducir) {
                return msg.reply("❌ *Kingbot:* Uso correcto: *!bot traducir <idioma> <texto>*. Ejemplo: *!bot traducir ingles Hola mundo*");
            }
            await msg.reply(`xR *Kingbot:* Traducción en proceso al ${idiomaDestino}...`);
            try {
                const prompt = `Traduce el siguiente texto al idioma "${idiomaDestino}". Responde aNICAMENTE con la traducción limpia, sin comentarios adicionales ni comillas:\n\n${textoATraducir}`;
                const respuesta = await ejecutarGeminiConRetries(async (model) => {
                    const result = await model.generateContent([prompt]);
                    return result.response.text();
                });
                const respuestaLimpia = limpiarRespuestaGemini(respuesta);
                return msg.reply(respuestaLimpia);
            } catch (e) {
                return msg.reply("❌ *Kingbot:* Ocurrió un error al intentar traducir.");
            }
        }

        // --- NUEVAS IDEAS: CALCULADORA ---
        if (comando === 'calcular') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Especifique la operation matemática. Ejemplo: *!bot calcular 2 + 2 * (10 / 5)*");
            const expression = argumento.replace(/\s+/g, '');
            const isSafe = /^[0-9+\-*/().%]+$/.test(expression);
            if (!isSafe) {
                return msg.reply("❌ *Kingbot:* Operación no válida. Solo se permiten números y los operadores básicos (+, -, *, /, %, (, )).");
            }
            try {
                const result = new Function(`return (${expression})`)();
                return msg.reply(`🤖 *Kingbot:* El resultado es: *${result}*`);
            } catch (e) {
                return msg.reply("❌ *Kingbot:* Error matemático en la expresión ingresada.");
            }
        }

        // --- NUEVAS IDEAS: RESUMIDOR WEB ---
        // --- NUEVAS IDEAS: RESUMIDOR WEB O DE PDF ---
        if (comando === 'resumir') {
            let mensajeConDoc = mensajeAProcesar;
            if (mensajeConDoc.hasMedia && mensajeConDoc.mimetype === 'application/pdf') {
                await msg.reply("x *Kingbot:* Leyendo y resumiendo documento PDF, un momento...");
                try {
                    const media = await mensajeConDoc.downloadMedia();
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
                    return msg.reply("❌ *Kingbot:* Ocurrió un error al procesar el documento PDF.");
                }
            }

            if (!argumento || !argumento.includes('http')) {
                return msg.reply("❌ *Kingbot:* Por favor proporcione una URL para resumir, o responda a un archivo PDF con *!bot resumir*.");
            }
            try {
                new URL(argumento);
            } catch(e) {
                return msg.reply("❌ *Kingbot:* Enlace inválido.");
            }
            await msg.reply("x *Kingbot:* Extrayendo y analizando contenido web para su resumen...");
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
                return msg.reply("❌ *Kingbot:* No se pudo recuperar el contenido web de esa dirección.");
            }
        }

        // --- NUEVO COMANDO: TELEMETRÍA DEL SISTEMA ---
        if (comando === 'sistema' || comando === 'hardware') {
            const platform = os.platform();
            const arch = os.arch();
            const cpuModel = os.cpus()[0]?.model || "Desconocido";
            const cpuCores = os.cpus().length;
            const totalRAM = (os.totalmem() / (1024 ** 3)).toFixed(2);
            const freeRAM = (os.freemem() / (1024 ** 3)).toFixed(2);
            
            const formatTime = (seconds) => {
                const h = Math.floor(seconds / 3600);
                const m = Math.floor((seconds % 3600) / 60);
                const s = Math.floor(seconds % 60);
                return `${h}h ${m}m ${s}s`;
            };
            
            const sysUptime = formatTime(os.uptime());
            const jarvisUptime = formatTime(process.uptime());
            
            let statusReport = `x *DIAGNSTICO DE SISTEMA KINBOT v4.0*\n\n`;
            statusReport += `x *Asistente:* Activo y Altivo\n`;
            statusReport += `xR *Plataforma:* ${platform === 'win32' ? 'Windows OS' : 'Termu/ Android'}\n`;
            statusReport += `x *Arquitectura:* ${arch}\n`;
            statusReport += `*Procesador:* ${cpuModel} (${cpuCores} núcleos)\n`;
            statusReport += `x*Memoria RAM:* ${freeRAM} GB libres de ${totalRAM} GB totales\n`;
            statusReport += ` *Uptime Servidor:* ${sysUptime}\n`;
            statusReport += ` *Uptime Kinbot:* ${jarvisUptime}\n`;
            
            if (isTermux) {
                exec('termux-battery-status', async (err, stdout) => {
                    if (!err) {
                        try {
                            const data = JSON.parse(stdout);
                            const charging = data.status === 'CHARGING' ? 'xR Conectado' : 'x9 Desconectado';
                            statusReport += `x *Energía:* ${charging} (Nivel: ${data.percentage}%, Temp: ${data.temperature}°C)\n`;
                        } catch(e) {}
                    }
                    await msg.reply(statusReport);
                });
            } else {
                statusReport += `a *Energía:* Red Eléctrica Directa (Ilimitada)\n`;
                await msg.reply(statusReport);
            }
            return;
        }

        // --- NUEVO COMANDO: GENERADOR QR ---
        if (comando === 'qr') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Ingrese el texto o enlace que desea codificar.");
            await msg.reply("x *Kingbot:* Renderizando matriz de código QR...");
            try {
                const url = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(argumento)}`;
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');
                const media = new MessageMedia('image/png', base64, 'qr.png');
                await msg.reply(media);
            } catch (e) {
                console.error("Error generando QR:", e);
                return msg.reply("❌ *Kingbot:* Servidor de codificación fuera de línea.");
            }
            return;
        }

        // --- NUEVO COMANDO: RECORDATORIOS ---
        if (comando === 'recordar' || comando === 'recordatorio') {
            const parts = argumento.split(' ');
            const tiempoStr = parts[0];
            const mensajeRecordatorio = parts.slice(1).join(' ');
            
            let minutos = parseFloat(tiempoStr);
            if (isNaN(minutos) || minutos <= 0) {
                return msg.reply("❌ *Kingbot:* Uso correcto: *!bot recordar <minutos> <mensaje>*. Ejemplo: *!bot recordar 5 preparar examen*");
            }
            if (!mensajeRecordatorio) {
                return msg.reply("❌ *Kingbot:* Debe indicarme qué desea recordar.");
            }
            
            await msg.reply(` *Kingbot:* Entendido, recordatorio fijado en ${minutos} minutos, Señor. No lo olvidaré.`);
            
            setTimeout(async () => {
                try {
                    const alertMsg = `x *KINGBOT  RECORDATORIO!*\n\nSeñor Geovanny, le recuerdo su tarea programada:\n\n_"${mensajeRecordatorio}"_`;
                    await client.sendMessage(chatId, alertMsg);
                } catch (e) {
                    console.error("Error al disparar recordatorio:", e);
                }
            }, minutos * 60 * 1000);
            return;
        }

        // --- BLOC DE NOTAS ---
        if (comando === 'nota' || comando === 'guardarnota') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Ingrese el texto de la nota que desea guardar.");
            notasGuardadas.push({ texto: argumento, fecha: new Date().toLocaleDateString() });
            fs.writeFileSync('notas.json', JSON.stringify(notasGuardadas, null, 2));
            return msg.reply(`x *Kingbot:* Nota guardada con éxito, Señor.`);
        }

        if (comando === 'notas') {
            if (notasGuardadas.length === 0) {
                return msg.reply(" *Kingbot:* No tiene notas archivadas.");
            }
            let lista = `x *SUS NOTAS ARCHIVADAS:*\n\n`;
            notasGuardadas.forEach((n, index) => {
                lista += `${inde+ 1}. [${n.fecha}] ${n.texto}\n`;
            });
            lista += `\n_Para eliminar una nota, use *!bot borrarnota <número>*_`;
            return msg.reply(lista);
        }

        if (comando === 'borrarnota') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Especifique el número de la nota que desea eliminar. Use *!bot notas* para ver la lista.");
            const inde= parseInt(argumento) - 1;
            if (isNaN(index) || inde< 0 || inde>= notasGuardadas.length) {
                return msg.reply("❌ *Kingbot:* Número de nota inválido.");
            }
            const eliminada = notasGuardadas.splice(index, 1)[0];
            fs.writeFileSync('notas.json', JSON.stringify(notasGuardadas, null, 2));
            return msg.reply(`S& *Kingbot:* Nota "${eliminada.texto}" eliminada.`);
        }

        // --- BaSQUEDA WEB INTELIGENTE ---
        if (comando === 'buscar' || comando === 'google') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Ingrese los términos de búsqueda.");
            await msg.reply(`x *Kingbot:* Realizando consulta y analizando fuentes en la red...`);
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
                    return msg.reply(" *Kingbot:* No he podido recuperar resultados útiles para esa consulta.");
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
                return msg.reply("❌ *Kingbot:* Ha ocurrido un error al consultar las bases de datos de red.");
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
                    return msg.reply("❌ *Kingbot:* Formato correcto: *!bot agente crear <nombre> <instrucciones>*");
                }
                agentesCustom[nombre] = instrucciones;
                fs.writeFileSync('agentes.json', JSON.stringify(agentesCustom, null, 2));
                return msg.reply(`S& *Kingbot:* Agente *"${nombre}"* creado e incorporado a mis bases de datos.`);
            }
            
            if (subComando === 'borrar' || subComando === 'eliminar') {
                if (!nombre) {
                    return msg.reply("❌ *Kingbot:* Formato correcto: *!bot agente borrar <nombre>*");
                }
                if (nombre === 'kingbot' || nombre === 'programador' || nombre === 'entrenador' || nombre === 'traductor') {
                    return msg.reply(`❌ *Kingbot:* No puede eliminar los agentes del sistema principal.`);
                }
                if (!agentesCustom[nombre]) {
                    return msg.reply(`❌ *Kingbot:* El agente *"${nombre}"* no existe.`);
                }
                delete agentesCustom[nombre];
                fs.writeFileSync('agentes.json', JSON.stringify(agentesCustom, null, 2));
                return msg.reply(`S& *Kingbot:* El agente *"${nombre}"* ha sido dado de baja.`);
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
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            const partsCmd = argumento.split(' ');
            const nombre = partsCmd[0]?.toLowerCase();
            const tipo = partsCmd[1]?.toLowerCase();
            const contenido = partsCmd.slice(2).join(' ');

            if (!nombre || !tipo || !contenido) {
                return msg.reply("❌ *Kingbot:* Formato correcto: *!bot comandocrear <nombre> <tipo: texto/ia/codigo> <contenido/instrucciones/codigo>*");
            }
            if (tipo !== 'texto' && tipo !== 'ia' && tipo !== 'codigo') {
                return msg.reply("❌ *Kingbot:* El tipo de comando debe ser *texto*, *ia* o *codigo*.");
            }
            
            const comandosSistema = ['reiniciar', 'ayuda', 'menu', 'help', 'comandos', 'musica', 'audio', 'video', 'decir', 'tts', 'foto', 'camara', 'grabar', 'escuchar', 'bateria', 'estado', 'sistema', 'hardware', 'qr', 'recordar', 'recordatorio', 'nota', 'guardarnota', 'notas', 'borrarnota', 'buscar', 'google', 'agente', 'agentes', 'agregarclave', 'addkey', 'claves', 'listkeys', 'restaurarclaves', 'resetkeys', 'comandocrear', 'comandoborrar', 'comandoslista', 'setcanal', 'canal', 'agregarcanal', 'listacanal', 'canales', 'borrarcanal', 'eliminarcanal', 'clima', 'imagina', 'dibuja', 'crear', 'stickercrear', 'traducir', 'calcular', 'resumir'];
            if (comandosSistema.includes(nombre)) {
                return msg.reply(`❌ *Kingbot:* El nombre *"${nombre}"* está reservado para el sistema principal.`);
            }

            comandosCustom[nombre] = { tipo, contenido };
            guardarComandosCustom();
            return msg.reply(`S& *Kingbot:* Comando personalizado *"!${nombre}"* (tipo: ${tipo}) creado e incorporado.`);
        }

        if (comando === 'comandoborrar' || comando === 'borrarcomando') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            const nombre = argumento.toLowerCase().trim();
            if (!nombre) {
                return msg.reply("❌ *Kingbot:* Formato correcto: *!bot comandoborrar <nombre>*");
            }
            if (!comandosCustom[nombre]) {
                return msg.reply(`❌ *Kingbot:* El comando *"!${nombre}"* no existe.`);
            }
            delete comandosCustom[nombre];
            guardarComandosCustom();
            return msg.reply(`S& *Kingbot:* Comando personalizado *"!${nombre}"* eliminado.`);
        }

        if (comando === 'comandoslista' || comando === 'listacomandos') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            const keys = Object.keys(comandosCustom);
            if (keys.length === 0) {
                return msg.reply(" *Kingbot:* No hay comandos personalizados registrados.");
            }
            let list = `x *COMANDOS PERSONALIZADOS ACTIVOS:*\n\n`;
            keys.forEach(key => {
                const cmd = comandosCustom[key];
                list += ` *!${key}* (${cmd.tipo}): ${cmd.contenido.substring(0, 80)}...\n`;
            });
            return msg.reply(list);
        }

        // --- NUEVAS CAPACIDADES - FASE 4.5 ---

        // 1. Alarmas Persistentes
        if (comando === 'alarma') {
            const parts = argumento.split(' ');
            const hora = parts[0];
            let msgAlarma = parts.slice(1).join(' ').trim();
            if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(hora) || !msgAlarma) {
                return msg.reply("❌ *Kingbot:* Formato correcto: *!bot alarma HH:MM mensaje [--diaria]*. Ejemplo: *!bot alarma 07:30 Despertarse --diaria*");
            }
            let recurrente = false;
            if (msgAlarma.includes('--diaria') || msgAlarma.includes('--recurrente')) {
                recurrente = true;
                msgAlarma = msgAlarma.replace('--diaria', '').replace('--recurrente', '').trim();
            }
            alarmasGuardadas.push({ hora, mensaje: msgAlarma, chatId, recurrente, fecha: new Date().toLocaleDateString() });
            guardarAlarmas();
            return msg.reply(` *Kingbot:* Alarma establecida con éxito a las ${hora} para: _"${msgAlarma}"_ ${recurrente ? '(Diaria x)' : '(Una vez x")'}.`);
        }

        if (comando === 'alarmas') {
            if (alarmasGuardadas.length === 0) {
                return msg.reply(" *Kingbot:* No hay alarmas programadas.");
            }
            let list = ` *ALARMAS CONFIGURADAS:*\n\n`;
            alarmasGuardadas.forEach((al, idx) => {
                const recurrenceType = al.recurrente ? 'x Diaria' : 'x" Una vez';
                list += `${id+ 1}. [${al.hora}] ${al.mensaje} _(${recurrenceType})_\n`;
            });
            list += `\n_Para borrar use: *!bot alarmaborrar <índice>*_`;
            return msg.reply(list);
        }

        if (comando === 'alarmaborrar') {
            const inde= parseInt(argumento) - 1;
            if (isNaN(index) || inde< 0 || inde>= alarmasGuardadas.length) {
                return msg.reply("❌ *Kingbot:* Índice de alarma no válido. Escriba *!bot alarmas* para ver la lista.");
            }
            const borrada = alarmasGuardadas.splice(index, 1)[0];
            guardarAlarmas();
            return msg.reply(`S& *Kingbot:* Alarma de las ${borrada.hora} ("${borrada.mensaje}") eliminada.`);
        }

        // --- SECCIN: FINANZAS Y TARJETAS (PWA INTEGRATION) ---
        if (comando === 'vencimientos' || comando === 'alertas') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            if (!dbFirebase) {
                return msg.reply("❌ *Kingbot:* No se ha detectado el archivo `serviceAccount.json`.");
            }
            if (!firebaseUid) {
                return msg.reply("❌ *Kingbot:* Primero configure su UID de Firebase con el comando *!bot setuid <UID>*");
            }

            await msg.reply("x *Kingbot:* Consultando estado de vencimientos y pagos de tarjetas...");
            await chequearVencimientosYNotificar(true);
            return;
        }

        if (comando === 'setuid') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            const uidInput = argumento.trim();
            if (!uidInput) {
                return msg.reply("❌ *Kingbot:* Proporcione su UID de Firebase. Ejemplo: *!bot setuid aBc123XyZ*");
            }
            firebaseUid = uidInput;
            guardarAdminJson();
            return msg.reply(`S& *Kingbot:* UID de Firebase establecido con éxito: \`${firebaseUid}\``);
        }

        if (comando === 'settelegramtoken') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            const tokenInput = argumento.trim();
            if (!tokenInput) {
                return msg.reply("❌ *Kingbot:* Proporcione su Token de Bot de Telegram.");
            }
            telegramBotToken = tokenInput;
            guardarAdminJson();
            iniciarTelegramPolling();
            return msg.reply(`S& *Kingbot:* Token del Bot de Telegram registrado exitosamente. He iniciado el servicio de escucha.`);
        }

        if (comando === 'tarjetas' || comando === 'finanzas') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            if (!dbFirebase) {
                return msg.reply("❌ *Kingbot:* No se ha detectado el archivo `serviceAccount.json`. Consiga sus credenciales de Firebase para conectar su PWA de finanzas.");
            }
            if (!firebaseUid) {
                return msg.reply("❌ *Kingbot:* Primero configure su UID de Firebase con el comando *!bot setuid <UID>*");
            }

            await msg.reply("x *Kingbot:* Consultando su estado financiero en Firebase Firestore...");
            try {
                const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                const snapshot = await cardsRef.get();
                if (snapshot.empty) {
                    return msg.reply(" *Kingbot:* No tiene tarjetas registradas en su base de datos de finanzas.");
                }

                let tDebt = 0;
                let tLimit = 0;
                let cardsReport = `x *ESTADO DE TARJETAS (Finanzas King)* x\n\n`;

                snapshot.forEach(doc => {
                    const c = doc.data();
                    const debt = parseFloat(c.balance || 0);
                    const limit = parseFloat(c.limit || 0);
                    tDebt += debt;
                    tLimit += limit;

                    const avail = limit - debt;
                    const pct = limit > 0 ? ((debt / limit) * 100).toFixed(0) : 0;
                    
                    cardsReport += ` *${c.name}* (corte: ${c.cutDay || '?'}, pago: ${c.payDay || '?'})\n`;
                    cardsReport += `  Deuda: $${debt.toFixed(2)} / Límite: $${limit.toFixed(2)} (${pct}%)\n`;
                    cardsReport += `  Disponible: $${avail.toFixed(2)}\n\n`;
                });

                const ratio = tLimit > 0 ? (tDebt / tLimit) * 100 : 0;
                cardsReport += `*Resumen Global:*\n`;
                cardsReport += `x  Deuda Total: *$${tDebt.toFixed(2)}*\n`;
                cardsReport += `x   Disponible Total: *$${(tLimit - tDebt).toFixed(2)}*\n`;
                cardsReport += `x 0 Endeudamiento: *${ratio.toFixed(1)}%*\n\n`;

                if (ratio < 30) cardsReport += `xEstado óptimo.`;
                else if (ratio < 50) cardsReport += `xEstado moderado.`;
                else cardsReport += `x Alerta: Nivel de deuda elevado.`;

                return msg.reply(cardsReport);
            } catch (e) {
                console.error("Error en tarjetas firebase:", e);
                return msg.reply(`❌ *Kingbot:* Error al acceder a Firestore: ${e.message}`);
            }
        }

        if (comando === 'gasto' || comando === 'abono') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            if (!dbFirebase) {
                return msg.reply("❌ *Kingbot:* No se ha detectado el archivo `serviceAccount.json`.");
            }
            if (!firebaseUid) {
                return msg.reply("❌ *Kingbot:* Primero configure su UID de Firebase con el comando *!bot setuid <UID>*");
            }

            const parts = argumento.split('|').map(p => p.trim());
            const textGasto = parts[0] || '';
            const cardQuery = parts[1] || '';
            const catQuery = parts[2] || '';

            const firstSpace = textGasto.indexOf(' ');
            if (firstSpace === -1 || !cardQuery) {
                return msg.reply(`❌ *Kingbot:* Formato correcto:\n*!bot ${comando} <monto> <concepto> | <tarjeta> [| <categoría>]*\n\nEjemplo: *!bot gasto 15 Cena | Visa | x Comida*`);
            }

            const amtStr = textGasto.substring(0, firstSpace);
            const concept = textGasto.substring(firstSpace).trim();
            const amt = parseFloat(amtStr);

            if (isNaN(amt) || amt <= 0 || !concept) {
                return msg.reply("❌ *Kingbot:* El monto y el concepto son obligatorios.");
            }

            await msg.reply(` *Kingbot:* Procesando movimiento de $${amt.toFixed(2)} en la tarjeta "${cardQuery}"...`);

            try {
                const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                const cardsSnap = await cardsRef.get();
                let matchingCard = null;
                
                cardsSnap.forEach(doc => {
                    const c = doc.data();
                    const cName = c.name.toLowerCase();
                    const qName = cardQuery.toLowerCase();
                    if (cName.includes(qName) || qName.includes(cName)) {
                        matchingCard = { id: doc.id, ...c };
                    }
                });

                if (!matchingCard) {
                    return msg.reply(`❌ *Kingbot:* No se encontró ninguna tarjeta registrada en la PWA que coincida con "${cardQuery}".`);
                }

                const type = (comando === 'gasto') ? 'expense' : 'payment';
                const defaultCats = [' Supermercado', 'x Comida', ': Transporte', 'xS Hormiga', 'x Servicios', 'x Compras', 'x` Salud', ' Educación'];
                const defaultPayCats = ['x Abono Capital', 'x Sueldo/Ingreso', 'x Transferencia'];
                
                let category = (type === 'payment') ? 'x Abono Capital' : 'xS Hormiga';

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
                    newBal -= amt;
                }
                if (newBal < 0) newBal = 0;

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

                return msg.reply(`S& *Kingbot:* ¡Movimiento registrado exitosamente!\n\nx *Tarjeta:* ${matchingCard.name}\nx *Monto:* $${amt.toFixed(2)}\nx *Concepto:* ${concept}\n*Categoría:* ${category}\nx *Nueva Deuda:* $${newBal.toFixed(2)}`);

            } catch (e) {
                console.error("Error al registrar movimiento:", e);
                return msg.reply(`❌ *Kingbot:* Error en Firebase: ${e.message}`);
            }
        }

        // 2. Lista de Tareas
        if (comando === 'tarea') {
            const parts = argumento.split(' ');
            const subComando = parts[0]?.toLowerCase();
            const desc = parts.slice(1).join(' ').trim();
            if (subComando === 'agregar' || subComando === 'crear' || subComando === 'add') {
                if (!desc) return msg.reply("❌ *Kingbot:* Especifique la descripción de la tarea.");
                tareasGuardadas.push({ texto: desc, completada: false, fecha: new Date().toLocaleDateString() });
                guardarTareas();
                return msg.reply(`S& *Kingbot:* Tarea agregada: _"${desc}"_.`);
            }
            return msg.reply("❌ *Kingbot:* Formato correcto: *!bot tarea agregar <descripción>*. O use *!bot tareas*.");
        }

        
        if (comando === 'programados') {
            if (tareasProgramadas.length === 0) {
                return msg.reply("❌ *Kingbot:* No hay tareas programadas.");
            }
            let list = `📅 *TAREAS PROGRAMADAS:*

`;
            tareasProgramadas.forEach((t, i) => {
                list += `*${i}*. [ ${t.cron} ] - ${t.descripcion}
`;
            });
            list += `
_Use !bot desprogramar <índice>_`;
            return msg.reply(list);
        }

        if (comando === 'desprogramar') {
            const index = parseInt(argumento, 10);
            if (isNaN(index) || index < 0 || index >= tareasProgramadas.length) {
                return msg.reply("❌ *Kingbot:* Índice no válido.");
            }
            const eliminada = tareasProgramadas.splice(index, 1)[0];
            fs.writeFileSync('tareas_programadas.json', JSON.stringify(tareasProgramadas, null, 2));
            if (global.activeCronJobs && global.activeCronJobs.has(index)) {
                global.activeCronJobs.get(index).stop();
                global.activeCronJobs.delete(index);
            }
            // Re-init to fix indices
            if (typeof inicializarTareas !== 'undefined') inicializarTareas();
            return msg.reply(`✔️ *Kingbot:* Tarea desprogramada: "${eliminada.descripcion}"`);
        }

        if (comando === 'tareas') {
            if (tareasGuardadas.length === 0) {
                return msg.reply(" *Kingbot:* No hay tareas pendientes.");
            }
            let list = `x9 *LISTA DE TAREAS PENDIENTES:*\n\n`;
            tareasGuardadas.forEach((t, idx) => {
                const mark = t.completada ? 'S&' : 'S';
                list += `${id+ 1}. ${mark} ${t.texto} _(${t.fecha})_\n`;
            });
            list += `\n_Para completar: *!bot tareacompletar <índice>*_`;
            list += `\n_Para borrar: *!bot tareaborrar <índice>*_`;
            return msg.reply(list);
        }

        if (comando === 'tareacompletar' || comando === 'completartarea') {
            const inde= parseInt(argumento) - 1;
            if (isNaN(index) || inde< 0 || inde>= tareasGuardadas.length) {
                return msg.reply("❌ *Kingbot:* Índice de tarea no válido.");
            }
            const completada = tareasGuardadas.splice(index, 1)[0];
            guardarTareas();
            return msg.reply(`S& *Kingbot:* ¡Excelente trabajo! Tarea completada: _"${completada.texto}"_. 0`);
        }

        if (comando === 'tareaborrar' || comando === 'borrartarea') {
            const inde= parseInt(argumento) - 1;
            if (isNaN(index) || inde< 0 || inde>= tareasGuardadas.length) {
                return msg.reply("❌ *Kingbot:* Índice de tarea no válido.");
            }
            const borrada = tareasGuardadas.splice(index, 1)[0];
            guardarTareas();
            return msg.reply(`x *Kingbot:* Tarea eliminada de la lista: _"${borrada.texto}"_.`);
        }

        // 3. Ficha de Películas y Series (IMDb/TMDB fallback)
        if (comando === 'info' || comando === 'pelicula' || comando === 'serie') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Indíqueme el nombre de la película o serie que desea consultar.");
            await msg.reply(` *Kingbot:* Consultando información sobre "${argumento}"...`);
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
                return msg.reply("❌ *Kingbot:* Ocurrió un error al buscar la información cinematográfica.");
            }
        }

        // 4. Generador de Memes
        if (comando === 'meme') {
            if (!argumento) {
                return msg.reply("❌ *Kingbot:* Formato correcto:\n*!bot meme plantilla | texto arriba | texto abajo*\nPlantillas populares: drake, doge, fine, two-buttons, disastergirl, success, sad-pablo, trump.");
            }
            if (argumento.includes('|')) {
                const parts = argumento.split('|').map(p => p.trim());
                const plantilla = parts[0].toLowerCase().replace(/\s+/g, '-');
                const texto1 = parts[1] || ' ';
                const texto2 = parts[2] || ' ';
                
                const memeUrl = `https://api.memegen.link/images/${encodeURIComponent(plantilla)}/${encodeURIComponent(texto1)}/${encodeURIComponent(texto2)}.png`;
                await msg.reply(" *Kingbot:* Generando el meme solicitado...");
                try {
                    const resMeme = await fetch(memeUrl);
                    if (resMeme.ok) {
                        const buffer = await resMeme.arrayBuffer();
                        const base64 = Buffer.from(buffer).toString('base64');
                        const media = new MessageMedia('image/png', base64, 'meme.png');
                        return msg.reply(media);
                    }
                } catch(e) {}
                return msg.reply("❌ *Kingbot:* Plantilla no soportada o error en el servidor de memes.");
            } else {
                await msg.reply("x *Kingbot:* Analizando tu idea para diseñar el meme ideal...");
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
                return msg.reply("❌ *Kingbot:* No he podido procesar esa idea de meme. Intenta con el formato estructurado.");
            }
        }

        // 5. Voz a Texto (Manual)
        if (comando === 'transcribir' || comando === 'vozatexto') {
            let mensajeConAudio = mensajeAProcesar;
            if (!mensajeConAudio.hasMedia || (mensajeConAudio.type !== 'audio' && mensajeConAudio.type !== 'ptt')) {
                return msg.reply("❌ *Kingbot:* Por favor, responda a una nota de voz o mensaje de audio con este comando.");
            }
            await msg.reply("*Kingbot:* Transcribiendo el archivo de audio...");
            try {
                const media = await mensajeConAudio.downloadMedia();
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
            return msg.reply("❌ *Kingbot:* No pude transcribir este audio.");
        }

        // 6. Acortador de URLs
        if (comando === 'acortar' || comando === 'short') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Proporcione la URL que desea acortar.");
            try {
                new URL(argumento);
            } catch (e) {
                return msg.reply("❌ *Kingbot:* El enlace tiene un formato incorrecto.");
            }
            await msg.reply("x *Kingbot:* Generando enlace corto...");
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
            return msg.reply("❌ *Kingbot:* Servidor de acortamiento fuera de línea.");
        }

        // 7. Conversor de divisas
        if (comando === 'divisas' || comando === 'convertir' || comando === 'convert') {
            const match = argumento.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]{3})\s*(?:a|to)\s*([a-zA-Z]{3})$/i);
            if (!match) {
                return msg.reply("❌ *Kingbot:* Formato correcto: *!bot divisas <cantidad> <origen> a <destino>*. Ejemplo: *!bot divisas 100 usd a eur*");
            }
            const cantidad = parseFloat(match[1]);
            const origen = match[2].toUpperCase();
            const destino = match[3].toUpperCase();
            
            await msg.reply(`x *Kingbot:* Calculando tipo de cambio para ${cantidad} ${origen}...`);
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
            return msg.reply(`❌ *Kingbot:* Moneda no soportada o error al consultar el tipo de cambio.`);
        }

        // 8. Búsqueda en Wikipedia
        if (comando === 'wiki' || comando === 'wikipedia') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Indíqueme el término que desea buscar en Wikipedia.");
            await msg.reply(`x *Kingbot:* Buscando "${argumento}" en Wikipedia...`);
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
            return msg.reply("❌ *Kingbot:* No se encontró ningún artículo en Wikipedia para esa consulta.");
        }

        // 9. Noticias RSS (BBC)
        if (comando === 'noticias' || comando === 'news') {
            await msg.reply("x *Kingbot:* Extrayendo los titulares y noticias internacionales más recientes...");
            try {
                const feed = await rssParser.parseURL('https://feeds.bbci.co.uk/mundo/rss/xml');
                if (feed.items && feed.items.length > 0) {
                    let newsReport = `x *PRINCIPALES NOTICIAS DEL DÍA (BBC Mundo):*\n\n`;
                    const items = feed.items.slice(0, 5);
                    items.forEach((item, idx) => {
                        newsReport += `${id+ 1}. *${item.title}*\n   _${item.contentSnippet || item.content || ''}_\n   x ${item.link}\n\n`;
                    });
                    return msg.reply(newsReport);
                }
            } catch (e) {
                console.error("Error en noticias RSS:", e);
            }
            return msg.reply("❌ *Kingbot:* No se pudo recuperar el feed de noticias.");
        }

        // 10. Resultados Deportivos (Gemini + search)
        if (comando === 'deportes' || comando === 'marcador') {
            if (!argumento) return msg.reply("❌ *Kingbot:* Especifique el deporte, equipo o competición. Ejemplo: *!bot deportes resultados Liga Española de Futbol*");
            await msg.reply(`a *Kingbot:* Buscando últimos resultados deportivos sobre "${argumento}"...`);
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
                return msg.reply("❌ *Kingbot:* Error en los servidores deportivos.");
            }
        }

        // 11. Leer SMS del teléfono (Termuonly)
        if (comando === 'sms') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            if (!isTermux) {
                return msg.reply("x *Ejecutándose en Windows:* La lectura de SMS requiere que el bot esté activo en TermuAndroid.");
            }
            await msg.reply("x *Kingbot:* Consultando bandeja de entrada de SMS...");
            exec('termux-sms-list -l 5', async (err, stdout) => {
                if (err) return msg.reply("❌ Error al leer la bandeja de SMS. Asegúrese de otorgar permisos.");
                try {
                    const dataSMS = JSON.parse(stdout);
                    if (dataSMS.length === 0) {
                        return msg.reply(" *Kingbot:* La bandeja de entrada de SMS está vacía.");
                    }
                    let report = "x *aLTIMOS SMS RECIBIDOS:*\n\n";
                    dataSMS.forEach((sms, idx) => {
                        report += (id+ 1) + ". *De:* " + sms.number + "\n   *Fecha:* " + sms.received + "\n   *Mensaje:* " + sms.body + "\n\n";
                    });
                    await msg.reply(report);
                } catch (e) {
                    await msg.reply("❌ Error decodificando la lista de SMS.");
                }
            });
            return;
        }

        // 12. Terminal Remota (Exec command)
        if (comando === 'cmd' || comando === 'run') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            if (!argumento) return msg.reply("❌ *Kingbot:* Indíqueme el comando de consola a ejecutar, Señor.");
            await msg.reply("x *Kingbot:* Ejecutando comando en consola remota...");
            exec(argumento, { timeout: 10000 }, async (err, stdout, stderr) => {
                let output = "";
                if (stdout) output += "*STDOUT:*\n```\n" + stdout.substring(0, 1500) + "\n```\n";
                if (stderr) output += "*STDERR:*\n```\n" + stderr.substring(0, 1000) + "\n```\n";
                if (err) output += "❌ *ERROR DE EJECUCIN:* " + err.message + "\n";
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
                return msg.reply("❌ *Kingbot:* Formato correcto: *!bot encuesta ¿Pregunta? | Opción 1 | Opción 2 | ...* (Mínimo 2 opciones)");
            }
            if (opciones.length > 12) {
                return msg.reply("❌ *Kingbot:* WhatsApp tiene un límite de 12 opciones por encuesta.");
            }
            try {
                const pollObj = new Poll(pregunta, opciones, { allowMultipleAnswers: false });
                await client.sendMessage(chatId, pollObj);
            } catch (e) {
                console.error("Error al enviar encuesta nativa:", e);
                return msg.reply("❌ *Kingbot:* No se pudo enviar la encuesta nativa.");
            }
            return;
        }

        // 14. Juegos en Grupo (Trivia, Adivinar, Cancelar)
        if (comando === 'juego' || comando === 'juegos') {
            const partsJuego = argumento.split(' ');
            const subJuego = partsJuego[0]?.toLowerCase();
            if (subJuego === 'cancelar' || subJuego === 'salir' || subJuego === 'stop') {
                if (juegosEstado.has(chatId)) { juegosEstado.delete(chatId); return msg.reply(" *Juego en ejecución CANCELADO.*"); }
                return msg.reply(" *Kingbot:* No hay ningún juego activo en este chat.");
            }
            if (subJuego === 'trivia') {
                if (juegosEstado.has(chatId)) return msg.reply("a *Kingbot:* Ya hay un juego activo. Escriba *!bot juego cancelar* para terminarlo.");
                await msg.reply(" *Kingbot:* Solicitando pregunta de trivia...");
                try {
                    const promptTrivia = 'Genera una pregunta de trivia en español (cultura general, ciencia, geografía o tecnología). 4 opciones A, B, C, D. Responde SOLO en JSON sin markdown:\n{"pregunta":"¿...","opcionA":"...","opcionB":"...","opcionC":"...","opcionD":"...","correcta":"B"}';
                    const rTrivia = await ejecutarGeminiConRetries(async (model) => { const r = await model.generateContent([promptTrivia]); return r.response.text(); });
                    const triviaData = JSON.parse(rTrivia.replace(/```json|```/g, '').trim());
                    juegosEstado.set(chatId, { tipo: 'trivia', respuesta: triviaData.correcta.toUpperCase().trim(), chatId });
                    return msg.reply(" *TRIVIA GRUPAL ACTIVA* \n\n*Pregunta:* " + triviaData.pregunta + "\n\nx! " + triviaData.opcionA + "\nx! " + triviaData.opcionB + "\nx! " + triviaData.opcionC + "\nx! " + triviaData.opcionD + "\n\n_¡Responda solo con la letra (A, B, C, D)!_");
                } catch (e) { console.error("Error trivia:", e); return msg.reply("❌ *Kingbot:* No pude generar la trivia en este momento."); }
            }
            if (subJuego === 'adivinar' || subJuego === 'numero') {
                if (juegosEstado.has(chatId)) return msg.reply("a *Kingbot:* Ya hay un juego activo en este chat.");
                const numS = Math.floor(Math.random() * 100) + 1;
                juegosEstado.set(chatId, { tipo: 'adivinar', numero: numS, intentos: 0, chatId });
                return msg.reply("x *JUEGO DEL NaMERO SECRETO* x\n\nHe pensado en un número del *1 al 100*.\n\n_¡Intenten adivinar!_");
            }
            return msg.reply(" *JUEGOS KINGBOT:*\n\n *!bot juego trivia* - Trivia de cultura general.\n *!bot juego adivinar* - Adivina el número secreto.\n *!bot juego cancelar* - Termina el juego en curso.");
        }

        // 15. OCR (Imagen a texto)
        if (comando === 'ocr' || comando === 'leertexto') {
            if (!mensajeAProcesar.hasMedia) return msg.reply("❌ *Kingbot:* Por favor, responda a una imagen con este comando.");
            await msg.reply("x *Kingbot:* Extrayendo y analizando texto de la imagen con IA...");
            try {
                const mediaOCR = await mensajeAProcesar.downloadMedia();
                if (mediaOCR && mediaOCR.data) {
                    const promptOCR = "Analiza esta imagen y extrae todo el texto legible. Devuelve únicamente el texto extraído sin comentarios ni metadatos.";
                    const rOCR = await ejecutarGeminiConRetries(async (model) => { const r = await model.generateContent([promptOCR, { inlineData: { data: mediaOCR.data, mimeType: mediaOCR.mimetype } }]); return r.response.text(); });
                    return msg.reply(limpiarRespuestaGemini(rOCR));
                }
            } catch (e) { console.error("Error en OCR:", e); }
            return msg.reply("❌ *Kingbot:* No se pudo leer el texto de la imagen.");
        }

        // --- GESTIN DE CLAVES API DINÁMICAS ---
        if (comando === 'agregarclave' || comando === 'addkey') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            if (!argumento || (!argumento.startsWith('AIzaSy') && !argumento.startsWith('AQ.'))) return msg.reply("❌ *Kingbot:* Proporcione una clave API de Gemini válida.");
            if (API_KEYS.includes(argumento)) return msg.reply("a *Kingbot:* Esa clave ya se encuentra registrada.");
            API_KEYS.push(argumento);
            const newIdxK = API_KEYS.length - 1;
            keyStatus[newIdxK] = { status: 'Activa', requestsToday: 0, lastRequest: null };
            guardarKeysYCuotas();
            return msg.reply("S& *Kingbot:* Clave API agregada. Total: " + API_KEYS.length);
        }
        if (comando === 'claves' || comando === 'listkeys') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            let listK = "x *ESTADO DE CLAVES API GEMINI:*\n\n";
            API_KEYS.forEach((key, idx) => {
                const mask = key.substring(0, 10) + '...' + key.substring(key.length - 4);
                const st = keyStatus[idx]?.status === 'Activa' ? 'S& Activa' : '❌ Agotada';
                const cnt = keyStatus[idx]?.requestsToday || 0;
                const am = id=== currentKeyInde? ' x (En uso)' : '';
                listK += (id+ 1) + ". `" + mask + "`\n   Estado: " + st + "\n   Consultas hoy: " + cnt + am + "\n\n";
            });
            listK += "_Para agregar: *!bot agregarclave <clave>*_\n_Para restaurar: *!bot restaurarclaves*_";
            return msg.reply(listK);
        }
        if (comando === 'restaurarclaves' || comando === 'resetkeys') {
            if (isGroup || chatId !== adminChatId) return msg.reply("❌ Comando restringido solo al Administrador.");
            API_KEYS.forEach((key, idx) => { if (keyStatus[idx]) { keyStatus[idx].status = 'Activa'; keyStatus[idx].requestsToday = 0; } });
            currentKeyIndex =  0; currentModelIndex =  0;
            guardarKeysYCuotas();
            return msg.reply("S& *Kingbot:* Todas las claves API restablecidas a *Activa* y contadores reiniciados.");
        }

        // --- INTERCEPTOR DE DOCUMENTOS FINANCIEROS (PDF/IMAGEN) ---
        let esDocumentoFinanciero = false;
        if (!isGroup && chatId === adminChatId && mensajeAProcesar.hasMedia) {
            const media = await mensajeAProcesar.downloadMedia();
            if (media && (media.mimetype === 'application/pdf' || media.mimetype.startsWith('image/'))) {
                esDocumentoFinanciero = await procesarDocumentoFinanciero(media, msg);
            }
        }
        if (esDocumentoFinanciero) return;

        // INTELIGENCIA ARTIFICIAL GEMINI
        const _chatTyp = await msg.getChat();
        await _chatTyp.sendStateTyping();
        let contenido = [];
        const contact = await msg.getContact();
        const senderName = contact.pushname || contact.name || contact.number || "Usuario";

        let textoParaGemini = textoLimpio;
        if (isGroup && textoLimpio) textoParaGemini = '[Mensaje de ' + senderName + ']: ' + textoLimpio;
        if (textoParaGemini && comando !== 'sticker') contenido.push(textoParaGemini);

        // Mensaje de espera Kingbot para consultas largas
        if (!isGroup && textoParaGemini && textoParaGemini.length > 30 && !chatsActivos.has(chatId)) {
            const _loadMsgs = ['*Kingbot:* Procesando su consulta...', 'a *Kingbot:* Analizando su solicitud, Señor.', 'x *Kingbot:* Consultando sistemas internos...', 'a" *Kingbot:* Procesando la información...'];
            try { await msg.reply(_loadMsgs[Math.floor(Math.random() * _loadMsgs.length)]); } catch(e) {}
        }

        let downloadedMedia = null;
        if (mensajeAProcesar.hasMedia) {
            downloadedMedia = await mensajeAProcesar.downloadMedia();
            if (comando === 'sticker') {
                if (downloadedMedia) {
                    await msg.reply(downloadedMedia, msg.from, { sendMediaAsSticker: true, stickerName: 'Bot VIP Multiplataforma', stickerAuthor: 'Geovanny' });
                } else {
                    await msg.reply('❌ *Kingbot:* No se pudo descargar el archivo multimedia para crear el sticker.');
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
            if (!isConversational && !isGroup && chatId === adminChatId) {
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

            if (isConversational) {
                let entradaMessage = `[${fechaContexto}]\n${textoParaGemini}`;
                if (mensajeAProcesar.hasMedia && downloadedMedia && downloadedMedia.data) {
                    let partsUsuario = [];
                    partsUsuario.push({ text: `[${fechaContexto}]\n${textoParaGemini || 'Analiza esta imagen.'}` });
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
                    contenidoCopia.unshift(`Eres Kinbot, el asistente personal de Geovanny Pacheco. Tu personalidad es inteligente, servicial y educada, con un sutil y elegante humor al estilo de Jarvis. Conoces sus áreas de interés (Métricas, Helados, Linux, ESIT, Gym) pero responde de manera natural y concisa. NUNCA menciones o hagas alusión a temas específicos de Geovanny como helados/heladería, ESIT, Linux, métricas o gimnasio a menos que el usuario lo pregunte directamente. Si el usuario te pide guardar una nota, ver notas, borrar notas, recordar algo, responder en audio, buscar en la web, programar o borrar alarmas, ver sus tarjetas o registrar un gasto/abono, usa los siguientes tags en tu respuesta: [ACTION_NOTE_ADD: texto], [ACTION_NOTE_LIST], [ACTION_NOTE_DELETE: indice], [ACTION_REMIND: minutos | mensaje], [ACTION_SEARCH: consulta], [ACTION_AUDIO: texto], [ACTION_ALARM_ADD: HH:MM | mensaje | diaria], [ACTION_ALARM_DELETE: indice_o_hora], [ACTION_FINANCE_CARDS], [ACTION_FINANCE_ADD: type | amount | concept | card_name | category]. Conoces la lista de comandos disponibles (escríbelos o recuérdalos si el usuario los pide): !bot ayuda, !bot tts/decir <texto>, !bot clima <ciudad>, !bot wiki <consulta>, !bot noticias, !bot deportes <consulta>, !bot sms, !bot cmd <comando>, !bot encuesta <pregunta> | <opciones>, !bot juego trivia/adivinar, !bot tarjetas, !bot gasto <monto> <concepto> | <tarjeta>, !bot abono <monto> <concepto> | <tarjeta>, !bot setuid <UID>, !bot vencimientos, !bot alertas. IMPORTANTE: No utilices pensamientos internos, razonamientos silenciosos ni prefijos como '[SILENT]'. Tu respuesta debe consistir aNICAMENTE en el mensaje final en español listo para ser leído por el usuario. ${fechaContexto}`);
                    const result = await model.generateContent(contenidoCopia);
                    return result.response.text();
                });
            }

            // --- PROCESAR TAGS DE ACCI N AGENTICA ---
            let loops = 0;
            while (loops < 3) {
                loops++;
                
                // Búsqueda Web
                if (respuestaTexto.includes('[ACTION_SEARCH:')) {
                    const match = respuestaTexto.match(/\[ACTION_SEARCH:\s*([^\]]+)\]/);
                    if (match) {
                        const query = match[1].trim();
                        console.log(`[🤖 Agentic Search]: Ejecutando búsqueda para: ${query}`);
                        await msg.reply(`🔍 *Kingbot:* Buscando "${query}" en la red, un momento...`);
                        
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
                        console.log(`[🤖 Agentic Note Add]: Nota guardada: ${notaTexto}`);
                        respuestaTexto = respuestaTexto.replace(match[0], `\n\n📝 *Nota guardada:* "${notaTexto}"`).trim();
                    }
                }
                
                // Nota List
                if (respuestaTexto.includes('[ACTION_NOTE_LIST]')) {
                    let lista = "";
                    if (notasGuardadas.length === 0) {
                        lista = "\n\nx 9 *Bloc de notas vacío.*";
                    } else {
                        lista = `\n\nx 9 *SUS NOTAS ARCHIVADAS:*\n`;
                        notasGuardadas.forEach((n, index) => {
                            lista += `${inde+ 1}. [${n.fecha}] ${n.texto}\n`;
                        });
                    }
                    respuestaTexto = respuestaTexto.replace('[ACTION_NOTE_LIST]', lista).trim();
                }
                
                // Nota Delete
                if (respuestaTexto.includes('[ACTION_NOTE_DELETE:')) {
                    const match = respuestaTexto.match(/\[ACTION_NOTE_DELETE:\s*([^\]]+)\]/);
                    if (match) {
                        const argBorrar = match[1].trim();
                        const inde= parseInt(argBorrar) - 1;
                        let notaEliminada = null;
                        if (!isNaN(index) && inde>= 0 && inde< notasGuardadas.length) {
                            notaEliminada = notasGuardadas.splice(index, 1)[0];
                        } else {
                            const id= notasGuardadas.findIndex(n => n.texto.toLowerCase().includes(argBorrar.toLowerCase()));
                            if (id!== -1) notaEliminada = notasGuardadas.splice(idx, 1)[0];
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
                                    const alertMsg = `x   *NOTIFICACI N DE KINBOT:*\n\nSeñor Geovanny, le recuerdo su tarea programada:\n\n_"${mensajeRecordatorio}"_`;
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

                // Video Download - Universal (Agentic) - handles ACTION_DOWNLOAD and legacy ACTION_TIKTOK
                const _agVideoTag = respuestaTexto.includes('[ACTION_DOWNLOAD:') ? '[ACTION_DOWNLOAD:' : (respuestaTexto.includes('[ACTION_TIKTOK:') ? '[ACTION_TIKTOK:' : null);
                if (_agVideoTag) {
                    const _agVidRege= _agVideoTag === '[ACTION_DOWNLOAD:' ? /\[ACTION_DOWNLOAD:\s*([^\]]+)\]/ : /\[ACTION_TIKTOK:\s*([^\]]+)\]/;
                    const match = respuestaTexto.match(_agVidRegex);
                    if (match) {
                        // Smart URL extraction   remove any text before/after the URL
                        const rawUrl = match[1].trim();
                        const urlExtract = rawUrl.match(/(https?:\/\/[^\s\]]+)/);
                        const urlStr = urlExtract ? urlExtract[1] : rawUrl;
                        console.log(`[x  Agentic Video]: Descargando: ${urlStr}`);
                        
                        try {
                            new URL(urlStr); // Validate
                            const _isTikTok = urlStr.includes('tiktok.com') || urlStr.includes('vm.tiktok') || urlStr.includes('vt.tiktok');
                            const _isYouTube = urlStr.includes('youtube.com') || urlStr.includes('youtu.be');
                            const _isInstagram = urlStr.includes('instagram.com') || urlStr.includes('instagr.am');
                            const _isTwitter = urlStr.includes('twitter.com') || urlStr.includes('x.com') || urlStr.includes('t.co');
                            
                            // Remove tag from text response (we'll handle the download separately)
                            respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                            
                            // TikTok API first
                            if (_isTikTok) {
                                const media = await downloadTikTokMedia(urlStr);
                                if (media) {
                                    try {
                                        await msg.reply(media, undefined, { sendMediaAsDocument: false });
                                        continue;
                                    } catch (err) {
                                        console.error('[!] Error enviando tiktok agentic como video, reintentando como documento...');
                                        try {
                                            await msg.reply(media, undefined, { sendMediaAsDocument: true, caption: '🎬 *Kingbot:* Video TikTok' });
                                            continue;
                                        } catch (err2) {
                                            console.error('[!] Error enviando documento tiktok agentic:', err2);
                                        }
                                    }
                                }
                            }

                            const outputFile = 'video_' + Date.now() + '.mp4';
                            const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
                            let _ytArgs;
                            
                            if (_isYouTube) {
                                _ytArgs = ['--user-agent', ua, '-f', 'best[height<=480][ext=mp4]/best[height<=480]/worst[ext=mp4]/worst', '--max-filesize', '60m', '-o', outputFile, urlStr];
                            } else if (_isTikTok) {
                                _ytArgs = ['--no-check-certificates', '--add-header', 'Referer:https://www.tiktok.com/', '--add-header', `User-Agent:${ua}`, '-f', 'best[ext=mp4]/best', '-o', outputFile, urlStr];
                            } else if (_isInstagram) {
                                _ytArgs = ['--add-header', `User-Agent:${ua}`, '--add-header', 'Referer:https://www.instagram.com/', '-o', outputFile, urlStr];
                            } else {
                                _ytArgs = ['--user-agent', ua, '-o', outputFile, urlStr];
                            }
                                
                            const child = spawn('yt-dlp', _ytArgs, { shell: false });
                            
                            child.on('error', (err) => {
                                console.error('[!] Error en yt-dlp agentic:', err);
                                msg.reply("❌ *Kingbot:* yt-dlp no disponible. Instala con: pip install yt-dlp").catch(()=>{});
                            });

                            child.on('close', async (code) => {
                                if (code !== 0) {
                                    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
                                    msg.reply("❌ *Kingbot:* No se pudo descargar el video. Puede estar restringido o ser demasiado largo.").catch(()=>{});
                                    return;
                                }
                                try {
                                    const stats = fs.statSync(outputFile);
                                    const sizeMB = stats.size / (1024 * 1024);
                                    if (sizeMB > 60) {
                                        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
                                        msg.reply(`a *Kingbot:* El video es demasiado grande (${sizeMB.toFixed(1)}MB). Prueba con uno más corto.`).catch(()=>{});
                                        return;
                                    }
                                    const media = MessageMedia.fromFilePath(outputFile);
                                    await msg.reply(media, undefined, { sendMediaAsDocument: sizeMB > 20 });
                                    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
                                } catch (err) {
                                    console.error('[!] Error enviando video agentic:', err);
                                }
                            });
                            
                        } catch (e) {
                            respuestaTexto = (respuestaTexto + `\n\nR *Error:* Enlace inválido para descarga.`).trim();
                        }
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
                        const child = spawn('yt-dlp', searchArgs, { shell: false });
                        
                        child.on('error', (err) => {
                            console.error('[!] Error en búsqueda de música agentic URL:', err);
                            msg.reply("❌ *Kingbot:* yt-dlp no disponible. Instala con: pip install yt-dlp").catch(()=>{});
                        });
                        
                        child.on('close', async (code) => {
                            const possibleFile = fs.existsSync(outputAudio) ? outputAudio : outputAudio.replace('.mp3', '') + '.mp3';
                            if (code !== 0 || !fs.existsSync(possibleFile)) {
                                msg.reply(`❌ *Kingbot:* No pude descargar el audio del enlace proporcionado.`).catch(()=>{});
                                return;
                            }
                            try {
                                const { MessageMedia } = require('@juzi/whatsapp-web.js');
                                const stats = fs.statSync(possibleFile);
                                const sizeMB = stats.size / (1024 * 1024);
                                const media = MessageMedia.fromFilePath(possibleFile);
                                if (sizeMB > 15) {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: true });
                                    await msg.reply('  *Kingbot:* El audio se envió como documento debido a que es muy pesado/largo (' + sizeMB.toFixed(1) + ' MB).');
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

                // Buscar música por nombre (sin enlace) - Agentic
                if (respuestaTexto.includes('[ACTION_MUSICA_BUSCAR:')) {
                    const match = respuestaTexto.match(/\[ACTION_MUSICA_BUSCAR:\s*([^\]]+)\]/);
                    if (match) {
                        const partes = match[1].split('|');
                        const cancion = partes[0]?.trim() || '';
                        const artista = partes[1]?.trim() || '';
                        const query = artista ? `${cancion} ${artista}` : cancion;
                        
                        console.log(`[🤖 Agentic Música]: Buscando: ${query}`);
                        await msg.reply(`🎵 *Kingbot:* Buscando la canción "${query}", por favor espere...`);
                        respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        
                        const outputAudio = 'musica_' + Date.now() + '.mp3';
                        const searchArgs = [
                            '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                            '--embed-thumbnail', '--add-metadata',
                            '-o', outputAudio,
                            `ytsearch1:${query}`
                        ];
                        
                        const child = spawn('yt-dlp', searchArgs, { shell: false });
                        
                        child.on('error', (err) => {
                            console.error('[!] Error en búsqueda de música agentic:', err);
                            msg.reply("❌ *Kingbot:* yt-dlp no disponible. Instala con: pip install yt-dlp").catch(()=>{});
                        });
                        
                        child.on('close', async (code) => {
                            // yt-dlp may save as .mp3 or as .mp3.mp3 depending on version
                            const possibleFile = fs.existsSync(outputAudio) ? outputAudio : outputAudio.replace('.mp3', '') + '.mp3';
                            if (code !== 0 || !fs.existsSync(possibleFile)) {
                                msg.reply(`❌ *Kingbot:* No encontré "${cancion}" de "${artista}". Verifica el nombre del artista o canción.`).catch(()=>{});
                                return;
                            }
                            try {
                                const stats = fs.statSync(possibleFile);
                                const sizeMB = stats.size / (1024 * 1024);
                                const media = MessageMedia.fromFilePath(possibleFile);
                                if (sizeMB > 15) {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: true });
                                    await msg.reply('  *Kingbot:* El audio se envió como documento debido a que es muy pesado/largo (' + sizeMB.toFixed(1) + ' MB).');
                                } else {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: false });
                                }
                                if (fs.existsSync(possibleFile)) fs.unlinkSync(possibleFile);
                            } catch (err) {
                                console.error('[!] Error enviando música agentic:', err);
                                msg.reply("❌ *Kingbot:* Error al enviar el archivo de audio.").catch(()=>{});
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

                // Audio TTS\n                // Video por nombre
                if (respuestaTexto.includes('[ACTION_VIDEO_BUSCAR:')) {
                    const match = respuestaTexto.match(/\[ACTION_VIDEO_BUSCAR:\s*([^\]]+)\]/);
                    if (match) {
                        const query = match[1].trim();
                        console.log(`[🤖 Agentic Video]: Buscando: ${query}`);
                        await msg.reply(`🎬 *Kingbot:* Buscando el video "${query}", por favor espere...`);
                        respuestaTexto = respuestaTexto.replace(match[0], '').trim();
                        
                        const outputVideo = 'video_' + Date.now() + '.mp4';
                        const searchArgs = [
                            '-f', 'best[height<=480][ext=mp4]/best[height<=480]/worst[ext=mp4]/worst',
                            '--max-filesize', '60m',
                            '-o', outputVideo,
                            `ytsearch1:${query}`
                        ];
                        
                        const child = spawn('yt-dlp', searchArgs, { shell: false });
                        
                        child.on('error', (err) => {
                            console.error('[!] Error en búsqueda de video agentic:', err);
                            msg.reply("❌ *Kingbot:* yt-dlp no disponible. Instala con: pip install yt-dlp").catch(()=>{});
                        });

                        child.on('close', async (code) => {
                            if (code !== 0 || !fs.existsSync(outputVideo)) {
                                msg.reply(`❌ *Kingbot:* No pude descargar el video de la búsqueda "${query}". Es posible que no exista o esté muy restringido.`).catch(()=>{});
                                return;
                            }
                            try {
                                const stats = fs.statSync(outputVideo);
                                const sizeMB = stats.size / (1024 * 1024);
                                const media = MessageMedia.fromFilePath(outputVideo);
                                if (sizeMB > 15) {
                                    await msg.reply(media, undefined, { sendMediaAsDocument: true, caption: `x *Kingbot:* "${query}" se envía como documento debido a su peso (${sizeMB.toFixed(1)} MB).` });
                                } else {
                                    await msg.reply(media, undefined, { caption: ` *Kingbot:* "${query}"` });
                                }
                                if (fs.existsSync(outputVideo)) fs.unlinkSync(outputVideo);
                            } catch (err) {
                                console.error('[!] Error enviando video agentic:', err);
                                msg.reply("❌ *Kingbot:* Error al enviar el archivo de video.").catch(()=>{});
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
                            alarmasGuardadas.push({ hora, mensaje: msgAlarma, chatId, recurrente, fecha: new Date().toLocaleDateString() });
                            guardarAlarmas();
                            console.log(`[x Agentic Alarm Add]: Alarma a las ${hora} recurrente=${recurrente}: ${msgAlarma}`);
                            // Calcular hora actual GT para mostrarla
                            const _horaActualGT = getHoraElSalvador(new Date());
                            const _alarmMsg = '\n\n *Kingbot  Alarma Configurada:*\nxR Hora programada: *' + hora + '*  _(hora actual: ' + _horaActualGT + ')_\nx Recordatorio: _"' + msgAlarma + '"_\n' + (recurrente ? 'x Tipo: Diaria (se repite cada día)' : 'x" Tipo: Una sola vez (se autodestruye al dispararse)');
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
                        const inde= parseInt(argBorrar) - 1;
                        let borrada = null;
                        if (!isNaN(index) && inde>= 0 && inde< alarmasGuardadas.length) {
                            borrada = alarmasGuardadas.splice(index, 1)[0];
                        } else {
                            const id= alarmasGuardadas.findIndex(al => al.hora === argBorrar || al.mensaje.toLowerCase().includes(argBorrar.toLowerCase()));
                            if (id!== -1) borrada = alarmasGuardadas.splice(idx, 1)[0];
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

                // Finance Cards (Agentic)
                if (respuestaTexto.includes('[ACTION_FINANCE_CARDS]')) {
                    if (chatId !== adminChatId) {
                        respuestaTexto = respuestaTexto.replace('[ACTION_FINANCE_CARDS]', '\n\nR Las funciones de finanzas están restringidas al Administrador.').trim();
                    } else if (!dbFirebase || !firebaseUid) {
                        respuestaTexto = respuestaTexto.replace('[ACTION_FINANCE_CARDS]', '\n\nR Firebase no está configurado (falta serviceAccount.json o firebaseUid).').trim();
                    } else {
                        try {
                            const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                            const snapshot = await cardsRef.get();
                            let cardsReport = "";
                            if (snapshot.empty) {
                                cardsReport = "\n\n *No hay tarjetas registradas en Firestore.*";
                            } else {
                                let tDebt = 0, tLimit = 0;
                                cardsReport = `\n\nx *ESTADO DE TARJETAS (PWA)* x\n`;
                                snapshot.forEach(doc => {
                                    const c = doc.data();
                                    const debt = parseFloat(c.balance || 0);
                                    const limit = parseFloat(c.limit || 0);
                                    tDebt += debt; tLimit += limit;
                                    cardsReport += ` *${c.name}*: Deuda $${debt.toFixed(2)} / Límite $${limit.toFixed(2)} (Disp: $${(limit - debt).toFixed(2)})\n`;
                                });
                                const ratio = tLimit > 0 ? (tDebt / tLimit) * 100 : 0;
                                cardsReport += `x Endeudamiento global: *${ratio.toFixed(1)}%*\n`;
                            }
                            respuestaTexto = respuestaTexto.replace('[ACTION_FINANCE_CARDS]', cardsReport).trim();
                        } catch (e) {
                            console.error("Error en agentic cards:", e);
                            respuestaTexto = respuestaTexto.replace('[ACTION_FINANCE_CARDS]', `\n\nR Error al obtener tarjetas: ${e.message}`).trim();
                        }
                    }
                }

                // Finance Add (Agentic)
                if (respuestaTexto.includes('[ACTION_FINANCE_ADD:')) {
                    const match = respuestaTexto.match(/\[ACTION_FINANCE_ADD:\s*([^\]]+)\]/);
                    if (match) {
                        if (chatId !== adminChatId) {
                            respuestaTexto = respuestaTexto.replace(match[0], '\n\nR Función de finanzas restringida al Administrador.').trim();
                        } else if (!dbFirebase || !firebaseUid) {
                            respuestaTexto = respuestaTexto.replace(match[0], '\n\nR Firebase no configurado.').trim();
                        } else {
                            const parts = match[1].split('|').map(p => p.trim());
                            const type = parts[0]?.toLowerCase() === 'payment' ? 'payment' : 'expense';
                            const amt = parseFloat(parts[1]);
                            const concept = parts[2] || 'Movimiento registrado';
                            const cardQuery = parts[3] || '';
                            const catQuery = parts[4] || '';

                            if (isNaN(amt) || amt <= 0 || !cardQuery) {
                                respuestaTexto = respuestaTexto.replace(match[0], '\n\nR Datos de transacción inválidos en la acción de finanzas.').trim();
                            } else {
                                try {
                                    const cardsRef = dbFirebase.collection('users').doc(firebaseUid).collection('cards');
                                    const cardsSnap = await cardsRef.get();
                                    let matchingCard = null;
                                    cardsSnap.forEach(doc => {
                                        const c = doc.data();
                                        const cName = c.name.toLowerCase();
                                        const qName = cardQuery.toLowerCase();
                                        if (cName.includes(qName) || qName.includes(cName)) {
                                            matchingCard = { id: doc.id, ...c };
                                        }
                                    });

                                    if (!matchingCard) {
                                        respuestaTexto = respuestaTexto.replace(match[0], `\n\nR Tarjeta "${cardQuery}" no encontrada.`).trim();
                                    } else {
                                        const defaultCats = [' Supermercado', 'x Comida', ': Transporte', 'xS Hormiga', 'x Servicios', 'x Compras', 'x` Salud', ' Educación'];
                                        const defaultPayCats = ['x Abono Capital', 'x Sueldo/Ingreso', 'x Transferencia'];
                                        let category = (type === 'payment') ? 'x Abono Capital' : 'xS Hormiga';

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
                                        else newBal -= amt;
                                        if (newBal < 0) newBal = 0;

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

                                        const regReport = `\n\nS& *Movimiento registrado (PWA):*\n *Tarjeta:* ${matchingCard.name}\n *Monto:* $${amt.toFixed(2)} (${type === 'expense' ? 'Gasto' : 'Abono'})\n *Concepto:* ${concept}\n *Categoría:* ${category}\n *Deuda:* $${newBal.toFixed(2)}`;
                                        respuestaTexto = respuestaTexto.replace(match[0], regReport).trim();
                                    }
                                } catch (e) {
                                    console.error("Error en agentic finance add:", e);
                                    respuestaTexto = respuestaTexto.replace(match[0], `\n\nR Error al registrar movimiento: ${e.message}`).trim();
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
            await msg.reply("⚠️ *Las llaves API de Gemini están agotadas o inhabilitadas por Google.*\n\nObtén una llave gratis en https://aistudio.google.com/app/apikey y agrégala con:\n*!bot addkey <TU_API_KEY>*");
        }
    } catch (error) {
        console.error("Error general:", error);
        try { await msg.reply("a *Kingbot:* Ocurrió un error interno. No se preocupe, sigo en pie."); } catch(e) {}
    }
});

// ============================================================
// MANEJADORES GLOBALES DE ERRORES  PREVIENEN QUE EL BOT MUERA
// ============================================================
let _reconectando = false;

process.on('uncaughtException', (error) => {
    console.error('\n[x ERROR NO CAPTURADO]:', error.message);
    
    const esErrorWhatsApp = error.message && (
        error.message.includes('canCheckStatusRanking') ||
        error.message.includes('window.require') ||
        error.message.includes('is not a function') ||
        error.message.includes('Execution context') ||
        error.message.includes('Session closed') ||
        error.message.includes('Target closed')
    );
    
    if (esErrorWhatsApp && !_reconectando) {
        _reconectando = true;
        console.log('[a Kingbot]: Error de WhatsApp Web detectado. Reconectando en 15s...');
        setTimeout(async () => {
            try { await client.destroy(); } catch (e) {}
            setTimeout(() => {
                _reconectando = false;
                try {
                    client.initialize();
                    console.log('[S& Kingbot]: Cliente reinicializado.');
                } catch (e2) {
                    console.error('[R Kingbot]: Fallo al reinicializar:', e2.message);
                    process.exit(1); // El watchdog lo reiniciará
                }
            }, 5000);
        }, 15000);
    } else if (!esErrorWhatsApp) {
        console.error('[a Kingbot]: Error no-crítico capturado, el proceso continúa.');
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
    console.log('[a Kingbot]: SIGTERM recibido. Cerrando...');
    client.destroy().finally(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('\n[a Kingbot]: SIGINT recibido (Ctrl+C). Cerrando...');
    client.destroy().finally(() => process.exit(0));
});

client.initialize();
