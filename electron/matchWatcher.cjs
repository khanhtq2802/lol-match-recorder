// Starts the recording on champ select, keeps it through the match and stops it when the match
// ends. A champ select that ends without a match (someone dodged) deletes the recording.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { fetchPhase, fetchMatchInfo, fetchLiveGame } = require('./leagueClient.cjs');

const POLL_INTERVAL = 1000;
const IN_GAME_PHASES = ['GameStart', 'InProgress', 'Reconnect'];
const MATCH_PHASES = ['ChampSelect', ...IN_GAME_PHASES];

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(
		d.getMinutes()
	)}`;
// characters Windows doesn't allow in file names
const safe = (text) =>
	text
		.replace(/[/\\]/g, '-')
		.replace(/[<>:"|?*\x00-\x1f]/g, '')
		.trim();

class MatchWatcher extends EventEmitter {
	/**
	 * @param {{ recorder: import('./recorder.cjs').Recorder, getSettings: typeof import('./settings.cjs').getSettings }} options
	 */
	constructor({ recorder, getSettings }) {
		super();
		this.recorder = recorder;
		this.getSettings = getSettings;
		/** @type {'idle' | 'champSelect' | 'inGame'} */
		this.state = 'idle';
		/** @type {{ startedAt: Date, outputDir: string, queue: string | null, champion: string | null } | null} */
		this.match = null;
		// the match was not recorded (auto record off, stopped by hand, failed): wait for the next one
		this.skipMatch = false;
		// the poll and the tray actions run one at a time
		this.queue = Promise.resolve();
	}

	start() {
		const loop = () =>
			this.enqueue(() => this.tick()).finally(() => setTimeout(loop, POLL_INTERVAL));
		loop();
	}

	enqueue(task) {
		this.queue = this.queue.then(task).catch((error) => this.emit('error', error));
		return this.queue;
	}

	setState(state) {
		if (state === this.state) return;
		this.state = state;
		this.emit('change', state);
	}

	async tick() {
		const phase = await fetchPhase();

		if (this.state === 'idle') {
			if (!MATCH_PHASES.includes(phase)) {
				this.skipMatch = false;
				return;
			}
			if (this.skipMatch || !this.getSettings().autoRecord) {
				this.skipMatch = true;
				return;
			}
			await this.startRecording(phase === 'ChampSelect' ? 'champSelect' : 'inGame');
			return;
		}

		if (this.state === 'champSelect') {
			if (phase === 'ChampSelect') {
				await this.updateMatchInfo();
			} else if (IN_GAME_PHASES.includes(phase)) {
				await this.updateMatchInfo();
				this.setState('inGame');
			} else {
				// back to the lobby, the queue, or the client closed: no match
				await this.discardRecording('dodge');
			}
			return;
		}

		// in game
		if (IN_GAME_PHASES.includes(phase)) {
			if (!this.match?.champion) await this.updateMatchInfo();
			return;
		}
		// the client can restart during a match, ask the game itself
		if (phase === null && (await fetchLiveGame())) return;
		await this.keepRecording();
	}

	async startRecording(state) {
		const settings = this.getSettings();
		const startedAt = new Date();
		this.match = { startedAt, outputDir: settings.outputDir, queue: null, champion: null };
		const micName = settings.micEnabled
			? settings.micName ?? (await this.recorder.listMics())[0] ?? null
			: null;
		try {
			await this.recorder.start({
				file: path.join(settings.outputDir, `${stamp(startedAt)}_recording.mkv`),
				micName,
				bitrateMbps: settings.bitrateMbps
			});
		} catch (error) {
			this.match = null;
			this.skipMatch = true;
			throw error;
		}
		this.setState(state);
		await this.updateMatchInfo();
	}

	async updateMatchInfo() {
		if (!this.match) return;
		const info = await fetchMatchInfo();
		this.match.queue = info.queue ?? this.match.queue;
		this.match.champion = info.champion ?? this.match.champion;
		if (!this.match.champion && this.state === 'inGame') {
			this.match.champion = (await fetchLiveGame())?.champion ?? null;
		}
	}

	fileName() {
		const { startedAt, queue, champion } = this.match;
		const parts = [stamp(startedAt), queue, champion].filter(Boolean).map(safe).filter(Boolean);
		return `${parts.join('_')}.mp4`;
	}

	async keepRecording() {
		if (!this.match) return;
		const file = await this.recorder.stop(path.join(this.match.outputDir, this.fileName()));
		this.match = null;
		this.setState('idle');
		if (file) this.emit('saved', file);
	}

	/** @param {'dodge' | 'manual'} reason */
	async discardRecording(reason) {
		await this.recorder.discard();
		this.match = null;
		this.setState('idle');
		this.emit('discarded', reason);
	}

	// tray actions: don't start recording the same match again

	stopAndKeep() {
		return this.enqueue(async () => {
			if (this.state === 'idle') return;
			this.skipMatch = true;
			await this.keepRecording();
		});
	}

	discard() {
		return this.enqueue(async () => {
			if (this.state === 'idle') return;
			this.skipMatch = true;
			await this.discardRecording('manual');
		});
	}
}

module.exports = { MatchWatcher };
