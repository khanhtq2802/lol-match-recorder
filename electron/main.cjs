const { app, Menu, Notification, Tray, dialog, nativeImage, shell } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const { Recorder } = require('./recorder.cjs');
const { MatchWatcher } = require('./matchWatcher.cjs');
const { getSettings, updateSettings } = require('./settings.cjs');

const APP_NAME = 'LOL Match Recorder';
const TRAY_ICON = path.join(__dirname, '..', 'static', 'desktop-icon.ico');
const BITRATES = [6, 8, 12];
const AUDIO_HELPER = path.join(__dirname, '..', 'vendor', 'process-audio.exe');

/** @type {Tray | null} */
let tray = null;
/** @type {Recorder} */
let recorder;
/** @type {MatchWatcher} */
let watcher;
/** @type {string[]} */
let mics = [];
let icons = { idle: null, recording: null };
let quitting = false;

// the app icon with a red dot in the bottom right corner
function createIcons() {
	const size = 16;
	const idle = nativeImage.createFromPath(TRAY_ICON).resize({ width: size, height: size });
	const bitmap = Buffer.from(idle.toBitmap());
	const [cx, cy, r] = [11.5, 11.5, 4.5];
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
			if (d > r) continue;
			const i = (y * size + x) * 4;
			// BGRA, with a white border
			const border = d > r - 1;
			bitmap[i] = border ? 255 : 40;
			bitmap[i + 1] = border ? 255 : 40;
			bitmap[i + 2] = 255;
			bitmap[i + 3] = 255;
		}
	}
	return { idle, recording: nativeImage.createFromBitmap(bitmap, { width: size, height: size }) };
}

function notify(body, file) {
	if (!Notification.isSupported()) return;
	const notification = new Notification({ title: APP_NAME, body, icon: TRAY_ICON });
	if (file) notification.on('click', () => shell.showItemInFolder(file));
	notification.show();
}

const formatElapsed = (ms) => {
	const s = Math.floor(ms / 1000);
	const pad = (n) => String(n).padStart(2, '0');
	return s >= 3600
		? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
		: `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};

function statusText() {
	if (watcher.state === 'champSelect') return 'Recording champ select';
	if (watcher.state === 'inGame') return 'Recording the match';
	return getSettings().autoRecord ? 'Waiting for champ select...' : 'Auto record is off';
}

function updateTooltip() {
	if (!tray) return;
	const elapsed = recorder.recording ? ` ${formatElapsed(recorder.elapsed)}` : '';
	tray.setToolTip(`${APP_NAME} - ${statusText()}${elapsed}`);
}

// Start with Windows, only for the packaged app (a dev run would register the bare electron.exe)
const startupMarker = () => path.join(app.getPath('userData'), 'startup-initialized');
// the exe is the stock electron.exe, so name the startup entry explicitly (else "electron.app.Electron")
const LOGIN_ITEM = { path: process.execPath, name: APP_NAME };

// Reads the startup entry from the registry: app.getLoginItemSettings() never finds it, it looks up
// the default entry name and fails to match an exe path with spaces ("LOL Match Recorder.exe").
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function opensAtLogin() {
	try {
		const entry = execFileSync('reg', ['query', RUN_KEY, '/v', LOGIN_ITEM.name], {
			encoding: 'utf8',
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return entry.toLowerCase().includes(process.execPath.toLowerCase());
	} catch {
		// no entry
		return false;
	}
}

function setOpenAtLogin(openAtLogin) {
	app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin });
	updateTrayMenu();
}

// turned on the first time the app runs, the tray menu turns it off
function initOpenAtLogin() {
	if (!app.isPackaged || fs.existsSync(startupMarker())) return;
	setOpenAtLogin(true);
	fs.writeFileSync(startupMarker(), '');
}

async function refreshMics() {
	mics = await recorder.listMics();
	updateTrayMenu();
}

async function changeFolder() {
	const { canceled, filePaths } = await dialog.showOpenDialog({
		title: 'Folder for the recordings',
		defaultPath: getSettings().outputDir,
		properties: ['openDirectory', 'createDirectory']
	});
	if (canceled || !filePaths[0]) return;
	updateSettings({ outputDir: filePaths[0] });
	updateTrayMenu();
}

function openFolder() {
	const { outputDir } = getSettings();
	fs.mkdirSync(outputDir, { recursive: true });
	shell.openPath(outputDir);
}

function updateTrayMenu() {
	if (!tray) return;
	const settings = getSettings();
	const recording = watcher.state !== 'idle';
	// the default mic is the first one found
	const currentMic =
		settings.micName && mics.includes(settings.micName) ? settings.micName : mics[0];

	tray.setImage(recording ? icons.recording : icons.idle);
	updateTooltip();
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: `${recording ? '● ' : ''}${statusText()}`, enabled: false },
			{ label: `Encoder: ${recorder.encoder?.name ?? 'detecting...'}`, enabled: false },
			...(recording
				? [
						{ type: 'separator' },
						{ label: 'Stop and keep the recording', click: () => watcher.stopAndKeep() },
						{ label: 'Stop and delete the recording', click: () => watcher.discard() }
				  ]
				: []),
			{ type: 'separator' },
			{
				label: 'Auto record',
				type: 'checkbox',
				checked: settings.autoRecord,
				click: (item) => {
					updateSettings({ autoRecord: item.checked });
					updateTrayMenu();
				}
			},
			{
				label: 'Microphone',
				submenu: [
					{
						label: 'No microphone',
						type: 'radio',
						checked: !settings.micEnabled,
						click: () => {
							updateSettings({ micEnabled: false });
							updateTrayMenu();
						}
					},
					...mics.map((name) => ({
						label: name,
						type: 'radio',
						checked: settings.micEnabled && name === currentMic,
						click: () => {
							updateSettings({ micEnabled: true, micName: name });
							updateTrayMenu();
						}
					})),
					{ type: 'separator' },
					{ label: 'Refresh the list', click: refreshMics }
				]
			},
			{
				label: 'Record Discord voice chat',
				type: 'checkbox',
				checked: settings.discordEnabled,
				click: (item) => {
					updateSettings({ discordEnabled: item.checked });
					updateTrayMenu();
				}
			},
			{
				label: 'Quality',
				submenu: BITRATES.map((mbps) => ({
					label: `${mbps} Mbps (~${Math.round((mbps * 60) / 8 / 10) * 10} MB/min)`,
					type: 'radio',
					checked: settings.bitrateMbps === mbps,
					click: () => {
						updateSettings({ bitrateMbps: mbps });
						updateTrayMenu();
					}
				}))
			},
			{ type: 'separator' },
			{ label: 'Open the recordings folder', click: openFolder },
			{ label: `Change the folder... (${settings.outputDir})`, click: changeFolder },
			{ type: 'separator' },
			{
				label: 'Start with Windows',
				type: 'checkbox',
				enabled: app.isPackaged,
				checked: opensAtLogin(),
				click: (item) => setOpenAtLogin(item.checked)
			},
			{ label: 'Quit', click: () => app.quit() }
		])
	);
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.whenReady().then(() => {
		app.setAppUserModelId(APP_NAME);
		recorder = new Recorder({
			// the packaged app keeps node_modules unpacked (no asar)
			ffmpegPath,
			helperPath: AUDIO_HELPER,
			logFile: path.join(app.getPath('userData'), 'ffmpeg-last.log')
		});
		watcher = new MatchWatcher({ recorder, getSettings });

		icons = createIcons();
		tray = new Tray(icons.idle);
		tray.on('click', () => tray?.popUpContextMenu());
		initOpenAtLogin();
		updateTrayMenu();

		watcher.on('change', updateTrayMenu);
		watcher.on('saved', (file) => notify(`Saved ${path.basename(file)}`, file));
		watcher.on('discarded', (reason) => {
			if (reason === 'dodge') notify('Champ select ended without a match, recording deleted');
		});
		watcher.on('error', (error) => notify(`Recording failed: ${error?.message ?? error}`));
		setInterval(updateTooltip, 1000);

		recorder
			.probeEncoder()
			.catch((error) => notify(error.message))
			.finally(updateTrayMenu);
		refreshMics();
		watcher.start();
	});

	// finish the file before quitting
	app.on('before-quit', (event) => {
		if (quitting || !watcher || watcher.state === 'idle') return;
		event.preventDefault();
		quitting = true;
		watcher.stopAndKeep().finally(() => app.quit());
	});

	// tray only, no windows
	app.on('window-all-closed', () => {});
}
