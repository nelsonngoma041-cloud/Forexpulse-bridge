// ForexPulse bridge loader. The code is split into part1.js .. part4.js so it
// can be pasted on GitHub from a phone. The parts are joined and run as one program.
const fs = require('fs');
const path = require('path');
let code = '';
for (let i = 1; i <= 4; i++) code += fs.readFileSync(path.join(__dirname, 'part' + i + '.js'), 'utf8') + '\n';
const run = new Function('require', 'process', 'console', 'module', code);
run(require, process, console, module);
