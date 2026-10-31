// Compiles the Discord audio helper to vendor/process-audio.exe with the C# compiler that comes with Windows.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const csc = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
execFileSync(
	csc,
	[
		'/nologo',
		'/optimize',
		'/platform:x64',
		'/target:exe',
		`/out:${path.join(root, 'vendor', 'process-audio.exe')}`,
		path.join(__dirname, 'ProcessAudio.cs')
	],
	{ stdio: 'inherit' }
);
