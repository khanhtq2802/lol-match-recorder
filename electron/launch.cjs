// Starts Electron with the project as the app.
// Editors like VS Code export ELECTRON_RUN_AS_NODE=1, which would make Electron run as plain Node.
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], {
	stdio: 'inherit',
	env
});
child.on('exit', (code) => process.exit(code ?? 0));
