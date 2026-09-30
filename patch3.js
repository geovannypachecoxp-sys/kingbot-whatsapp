const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const regex1 = /\s*\/\/ Sincronizador de mensajes de dispositivos vinculados[\s\S]*?await this\.pupPage\.evaluate\(\(\) => \{[\s\S]*?\}\)\.catch\(\(\) => \{\}\);/;
const regex2 = /\s*\/\/ Sincronizador de mensajes de dispositivos vinculados[\s\S]*?if \(client\.pupPage\) \{[\s\S]*?\}\)\.catch\(\(\) => \{\}\);\s*\}/;

const newHook1 = `
            // Sincronizador de mensajes de dispositivos vinculados (WhatsApp Desktop / chat propio)
            await this.pupPage.evaluate(() => {
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
            }).catch(() => {});`;

const newHook2 = `
    // Sincronizador de mensajes de dispositivos vinculados (WhatsApp Desktop / chat propio)
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

code = code.replace(regex1, newHook1);
code = code.replace(regex2, newHook2);
fs.writeFileSync('index.js', code);
