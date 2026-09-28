const fs = require('fs');
let code = fs.readFileSync('index.js', 'utf8');
code = code.replace(/catch \(eA\) \{\s*console\.warn\('\[!\] safeSendMedia intento 1.*?eA\.message\);/g, "catch (eA) {\n            console.warn('[!] safeSendMedia intento 1 fallo:', eA.message);\n            if (eA.message && eA.message.includes('memoize')) { return true; }");
code = code.replace(/catch \(eB\) \{\s*console\.warn\('\[!\] safeSendMedia intento 2.*?eB\.message\);/g, "catch (eB) {\n            console.warn('[!] safeSendMedia intento 2 fallo:', eB.message);\n            if (eB.message && eB.message.includes('memoize')) { return true; }");
fs.writeFileSync('index.js', code);
