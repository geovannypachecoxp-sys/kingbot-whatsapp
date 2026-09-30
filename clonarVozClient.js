// ==============================================================================
// CLIENTE DE INTEGRACIÓN: CLONADOR DE VOZ LOCAL (QWEN3-TTS & LLAMA.CPP)
// ==============================================================================
// Permite al bot interactuar con el servicio local de clonación de voz:
// - Listar voces clonadas guardadas
// - Registrar nuevas voces a partir de notas de voz enviadas en WhatsApp
// - Sintetizar texto con una voz clonada específica y retornar el audio
// ==============================================================================

const fs = require('fs');
const path = require('path');

const CLONAR_VOZ_DEFAULT_URL = process.env.CLONAR_VOZ_URL || 'http://127.0.0.1:8080';

class ClonarVozClient {
    constructor(baseUrl = CLONAR_VOZ_DEFAULT_URL) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    /**
     * Comprueba si el servidor local de clonación de voz está activo.
     */
    async verificarServicio() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(`${this.baseUrl}/api/config`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const config = await res.json();
                return { activo: true, url: this.baseUrl, config };
            }
        } catch (e) {
            // Servicio no conectado o apagado
        }
        return { activo: false, url: this.baseUrl };
    }

    /**
     * Lista todas las voces clonadas disponibles en la biblioteca.
     */
    async listarVoces() {
        try {
            const res = await fetch(`${this.baseUrl}/api/voces`, {
                headers: { 'Accept': 'application/json' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            console.error('[ClonarVozClient] Error al listar voces:', e.message);
            return [];
        }
    }

    /**
     * Registra una nueva voz a partir de un Buffer de audio (ej. nota de voz de WhatsApp).
     * @param {string} nombre - Nombre identificador de la voz (ej. "Geovanny", "Locutor")
     * @param {Buffer} audioBuffer - Buffer binario del archivo de audio
     * @param {string} mimeType - Tipo MIME (audio/ogg, audio/mp3, audio/wav, etc.)
     * @param {string} transcripcion - Texto de referencia opcional
     */
    async guardarVoz(nombre, audioBuffer, mimeType = 'audio/ogg', transcripcion = '') {
        try {
            let extension = 'ogg';
            if (mimeType.includes('mpeg') || mimeType.includes('mp3')) extension = 'mp3';
            else if (mimeType.includes('wav')) extension = 'wav';
            else if (mimeType.includes('m4a') || mimeType.includes('mp4')) extension = 'm4a';

            const boundary = `----WebKitFormBoundary${Date.now().toString(16)}`;
            
            // Construir payload multipart manual compatible con Node 18+ sin dependencias externas
            const partes = [];
            
            // Campo nombre
            partes.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="nombre"\r\n\r\n` +
                `${nombre}\r\n`
            ));

            // Campo transcripción
            partes.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="transcripcion"\r\n\r\n` +
                `${transcripcion}\r\n`
            ));

            // Campo archivo de audio
            partes.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="audio"; filename="muestra.${extension}"\r\n` +
                `Content-Type: ${mimeType}\r\n\r\n`
            ));
            partes.push(audioBuffer);
            partes.push(Buffer.from(`\r\n--${boundary}--\r\n`));

            const cuerpoCompleto = Buffer.concat(partes);

            const res = await fetch(`${this.baseUrl}/api/voces`, {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': cuerpoCompleto.length.toString()
                },
                body: cuerpoCompleto
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Error en el servidor de clonación: ${errText}`);
            }

            return await res.json();
        } catch (e) {
            console.error('[ClonarVozClient] Error al registrar voz:', e.message);
            throw e;
        }
    }

    /**
     * Sintetiza texto hablado utilizando una voz clonada específica.
     * @param {string} texto - Texto a sintetizar
     * @param {string} idVoz - ID o nombre de la voz guardada
     * @param {object} opciones - Parámetros opcionales (idioma, dispositivo, etc.)
     * @returns {Promise<Buffer>} - Buffer binario con el audio generado en WAV
     */
    async sintetizarTexto(texto, idVoz = null, opciones = {}) {
        try {
            // Si pasan un nombre en lugar de un ID, intentar buscar su ID
            let targetVozId = idVoz;
            if (idVoz) {
                const lista = await this.listarVoces();
                const coincidencia = lista.find(v => 
                    v.id === idVoz || 
                    v.nombre.toLowerCase().trim() === idVoz.toLowerCase().trim() ||
                    v.nombre.toLowerCase().includes(idVoz.toLowerCase().trim())
                );
                if (coincidencia) {
                    targetVozId = coincidencia.id;
                }
            }

            const bodyPayload = {
                texto: texto.trim(),
                voz: targetVozId || undefined,
                idioma: opciones.idioma || 'es',
                dispositivo: opciones.dispositivo || 'auto'
            };

            const iniciarRes = await fetch(`${this.baseUrl}/api/generar`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bodyPayload)
            });

            if (!iniciarRes.ok) {
                const errData = await iniciarRes.text();
                throw new Error(`Fallo al iniciar generación: ${errData}`);
            }

            const dataInicio = await iniciarRes.json();
            const archivoDestino = dataInicio.archivo; // Nombre de archivo generado (ej. 20260930-...wav)

            // Esperar que la síntesis concluya revisando periódicamente /api/salidas/{archivo}
            const audioBuffer = await this._esperarArchivoSalida(archivoDestino, 120000); // hasta 2 minutos
            return audioBuffer;
        } catch (e) {
            console.error('[ClonarVozClient] Error al sintetizar voz:', e.message);
            throw e;
        }
    }

    /**
     * Espera a que el archivo de audio generado esté disponible en /api/salidas/{archivo}
     */
    async _esperarArchivoSalida(nombreArchivo, timeoutMs = 120000) {
        const inicio = Date.now();
        const urlAudio = `${this.baseUrl}/api/salidas/${nombreArchivo}`;

        while (Date.now() - inicio < timeoutMs) {
            await new Promise(r => setTimeout(r, 1500));
            try {
                const res = await fetch(urlAudio);
                if (res.ok) {
                    const arrayBuf = await res.arrayBuffer();
                    const buf = Buffer.from(arrayBuf);
                    if (buf.length > 1000) { // Archivo WAV completado
                        return buf;
                    }
                }
            } catch (e) {
                // Continuar esperando
            }
        }
        throw new Error('Tiempo de espera agotado para la síntesis de voz.');
    }

    /**
     * Elimina una voz clonada por su ID.
     */
    async eliminarVoz(idVoz) {
        try {
            const res = await fetch(`${this.baseUrl}/api/voces/${idVoz}`, {
                method: 'DELETE'
            });
            return res.ok;
        } catch (e) {
            return false;
        }
    }
}

module.exports = new ClonarVozClient();
