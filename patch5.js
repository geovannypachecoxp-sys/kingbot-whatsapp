const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');

const target = `client.initialize().catch(err => {
    console.error('\\n[!] Error crítico inicializando WhatsApp Web:', err);
});`;

const target2 = `client.initialize().catch(err => {
    console.error('\\n[!] Error crtico inicializando WhatsApp Web:', err);
});`;

const replacement = `async function startBot() {
    try {
        await client.initialize();
    } catch (err) {
        console.error('\\n[!] Error crítico inicializando WhatsApp Web:', err);
        if (err.message && (err.message.includes('Execution context was destroyed') || err.message.includes('Session closed') || err.message.includes('Target closed'))) {
            console.log('\\n[!] WhatsApp Web forzó un reinicio. Reintentando en 5 segundos...');
            try { await client.destroy().catch(()=>{}); } catch(e){}
            setTimeout(startBot, 5000);
        } else {
            console.log('\\n[!] Reiniciando proceso en 10 segundos...');
            setTimeout(() => process.exit(1), 10000);
        }
    }
}
startBot();`;

let oldLen = code.length;
code = code.replace(target, replacement);
code = code.replace(target2, replacement);
// also regex just in case
code = code.replace(/client\.initialize\(\)\.catch\(err => \{\s*console\.error\('.*?Error cr.tico inicializando WhatsApp Web:', err\);\s*\}\);/g, replacement);

if (code.length !== oldLen) {
    fs.writeFileSync('index.js', code);
    console.log("Patched!");
} else {
    console.log("Could not find the target to patch.");
}
