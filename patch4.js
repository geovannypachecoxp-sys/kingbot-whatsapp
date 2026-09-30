const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const oldMsgReply = `    const originalReply = msg.reply.bind(msg);
    msg.reply = async function(content, chatId, options = {}) {
        try {
            const res = await originalReply(content, chatId, options);
            if (res) registrarMensajeEnviadoPorBot(res);
            return res;
        } catch(err) {
            console.warn('[msg.reply] originalReply falló (' + err.message + '), usando client.sendMessage directo...');
            try {
                let target = chatId || msg.from;
                const res = await client.sendMessage(target, content, options);
                if (res) registrarMensajeEnviadoPorBot(res);
                return res;
            } catch(err1) {
                if (err1.message && err1.message.includes('memoize')) {
                    console.warn('[msg.reply] Error memoize detectado. Reintentando puro sin opciones...');
                    const res2 = await client.sendMessage(target, content);
                    if (res2) registrarMensajeEnviadoPorBot(res2);
                    return res2;
                }
                console.warn('[msg.reply fallback] Falló client.sendMessage directo a ' + target + ': ' + (err1.message||err1));
                return null;
            }
        }
    };`;

const newMsgReply = `    const originalReply = msg.reply.bind(msg);
    msg.reply = async function(content, chatId, options = {}) {
        try {
            const res = await originalReply(content, chatId, options);
            if (res) registrarMensajeEnviadoPorBot(res);
            return res;
        } catch(err) {
            if (err.message && err.message.includes('memoize')) {
                return { id: { _serialized: 'memoize_sent_' + Date.now() }, body: content };
            }
            console.warn('[msg.reply] originalReply falló (' + err.message + '), usando client.sendMessage directo...');
            try {
                let target = chatId || msg.from;
                const res = await client.sendMessage(target, content, options);
                if (res) registrarMensajeEnviadoPorBot(res);
                return res;
            } catch(err1) {
                if (err1.message && err1.message.includes('memoize')) {
                    return { id: { _serialized: 'memoize_sent_' + Date.now() }, body: content };
                }
                console.warn('[msg.reply fallback] Falló client.sendMessage directo a ' + target + ': ' + (err1.message||err1));
                return null;
            }
        }
    };`;

code = code.replace(oldMsgReply, newMsgReply);

code = code.replace(/if \(e\.message && e\.message\.includes\('memoize'\)\) \{[\s\S]*?\} catch\(e2\)\{\}[\s\S]*?\}/g, "if (e.message && e.message.includes('memoize')) { return true; }");
code = code.replace(/if \(eB\.message && eB\.message\.includes\('memoize'\)\) \{[\s\S]*?\} catch\(eB2\)\{\}[\s\S]*?\}/g, "if (eB.message && eB.message.includes('memoize')) { return true; }");
code = code.replace(/if \(eC\.message && eC\.message\.includes\('memoize'\)\) \{[\s\S]*?\} catch\(eC2\)\{\}[\s\S]*?\}/g, "if (eC.message && eC.message.includes('memoize')) { return true; }");
code = code.replace(/if \(eD\.message && eD\.message\.includes\('memoize'\)\) \{[\s\S]*?\} catch\(eD2\)\{\}[\s\S]*?\}/g, "if (eD.message && eD.message.includes('memoize')) { return true; }");

fs.writeFileSync('index.js', code);
