// User settings, in %APPDATA%\lol-match-recorder\settings.json
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const file = () => path.join(app.getPath('userData'), 'settings.json');

const defaults = () => ({
	autoRecord: true,
	outputDir: path.join(app.getPath('videos'), 'LOL Match Recorder'),
	// null: the first microphone found
	micName: null,
	// false: record without sound
	micEnabled: true,
	bitrateMbps: 8
});

/** @type {ReturnType<typeof defaults> | null} */
let settings = null;

function getSettings() {
	if (!settings) {
		settings = defaults();
		try {
			Object.assign(settings, JSON.parse(fs.readFileSync(file(), 'utf8')));
		} catch {
			// first run or unreadable: defaults
		}
	}
	return settings;
}

/** @param {Partial<ReturnType<typeof defaults>>} changes */
function updateSettings(changes) {
	Object.assign(getSettings(), changes);
	try {
		fs.writeFileSync(file(), JSON.stringify(settings, null, '\t'));
	} catch {
		// best effort
	}
	return settings;
}

module.exports = { getSettings, updateSettings };
