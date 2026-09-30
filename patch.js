const fs = require('fs');
const lines = fs.readFileSync('index.js', 'utf8').split('\n');
let start = -1;
let end = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('// Sincronizador de mensajes de dispositivos vinculados (WhatsApp Desktop / chat propio)')) {
        start = i;
    }
    if (start !== -1 && lines[i].includes('}).catch(() => {});')) {
        end = i + 2;
        break;
    }
}

const hookStr = `    // Sincronizador de mensajes de dispositivos vinculados (WhatsApp Desktop / chat propio)
    if (client.pupPage) {
        client.pupPage.evaluate(() => {
            try {
                if (window.__kingbotHooked) return;
                const Msg = window.require('WAWebCollections')?.Msg;
                if (Msg && typeof Msg.on === 'function') {
                    window.__kingbotHooked = true;
                    Msg.on('add', (rawMsg) => {
                        if (!rawMsg || rawMsg.isNewMsg || rawMsg.local || rawMsg.isSendFailure) return;
                        if (window.onAddMessageEvent && window.WWebJS && typeof window.WWebJS.getMessageModel === 'function') {
                            try {
                                const model = window.WWebJS.getMessageModel(rawMsg);
                                if (model && model.id && typeof model.body === 'string') {
                                    const b = model.body.trim().toLowerCase();
                                    if (b.includes('kingbot') || b.includes('[action_')) return;
                                    if (model.id.fromMe && !b.startsWith('!') && !b.startsWith('.')) return;
                                    
                                    window.onAddMessageEvent(model);
                                }
                            } catch(e){}
                        }
                    });
                }
            } catch(e){}
        }).catch(() => {});
    }`;

const newLines = [...lines.slice(0, start), hookStr, ...lines.slice(end)];
fs.writeFileSync('index.js', newLines.join('\n'));
