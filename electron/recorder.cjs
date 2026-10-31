// Records the main screen, a microphone and the Discord voice chat with ffmpeg.
// The screen comes from the Desktop Duplication API (ddagrab), encoded on the GPU when there is one.
// It records to .mkv, which stays playable if the app or ffmpeg dies, and remuxes to .mp4 at the end.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FRAMERATE = 30;
const SCREEN_INPUT = ['-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=${FRAMERATE}`];
// ffmpeg gets this long to finish the file after 'q' before it is killed
const STOP_TIMEOUT = 10000;
// an exit this soon after the start is a sound source that can't be opened: retry without it
const EARLY_EXIT = 5000;
// the Discord desktop app, in its release channels
const DISCORD_PROCESSES = ['Discord', 'DiscordPTB', 'DiscordCanary', 'DiscordDevelopment'];
// the audio helper gets this long to start, else the recording goes on without it
const CAPTURE_START_TIMEOUT = 5000;

// ddagrab outputs D3D11 frames: NVENC takes them as is, the others need them in system memory.
// No B-frames, the screen frames come at irregular times.
/** @type {{ name: string, args: (bitrate: number) => string[] }[]} */
const ENCODERS = [
	{
		name: 'h264_nvenc',
		args: (b) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', ...rate(b)]
	},
	{
		name: 'h264_amf',
		args: (b) => [
			'-vf',
			'hwdownload,format=bgra,format=nv12',
			'-c:v',
			'h264_amf',
			'-quality',
			'balanced',
			...rate(b)
		]
	},
	{
		name: 'h264_qsv',
		args: (b) => [
			'-vf',
			'hwdownload,format=bgra,format=nv12',
			'-c:v',
			'h264_qsv',
			'-preset',
			'faster',
			...rate(b)
		]
	},
	{
		name: 'libx264',
		args: (b) => [
			'-vf',
			'hwdownload,format=bgra,format=yuv420p',
			'-c:v',
			'libx264',
			'-preset',
			'veryfast',
			...rate(b)
		]
	}
];

/** @param {number} mbps */
function rate(mbps) {
	return [
		'-b:v',
		`${mbps}M`,
		'-maxrate',
		`${Math.round(mbps * 1.5)}M`,
		'-bufsize',
		`${mbps * 2}M`,
		'-bf',
		'0',
		'-g',
		String(FRAMERATE * 2),
		// constant 30 fps, the screen only sends a frame when it changes
		'-fps_mode',
		'cfr',
		'-r',
		String(FRAMERATE)
	];
}

/** Runs ffmpeg to the end, resolves its exit code and stderr */
function run(ffmpegPath, args) {
	return new Promise((resolve) => {
		const proc = spawn(ffmpegPath, ['-hide_banner', ...args], { windowsHide: true });
		let stderr = '';
		proc.stderr.on('data', (chunk) => (stderr += chunk));
		proc.on('error', () => resolve({ code: -1, stderr }));
		proc.on('exit', (code) => resolve({ code, stderr }));
	});
}

function waitForExit(proc, timeout) {
	return new Promise((resolve) => {
		if (proc.exitCode !== null) return resolve();
		const timer = setTimeout(() => proc.kill(), timeout);
		proc.once('exit', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/**
 * Starts the helper that captures the Discord voice chat (see native/ProcessAudio.cs).
 * @returns {Promise<{ proc: import('node:child_process').ChildProcess, pipe: string } | null>}
 */
function startDiscordCapture(helperPath) {
	return new Promise((resolve) => {
		const name = `lol-match-recorder-${process.pid}-${Date.now()}`;
		const proc = spawn(helperPath, [name, DISCORD_PROCESSES.join(',')], { windowsHide: true });
		const timer = setTimeout(() => proc.kill(), CAPTURE_START_TIMEOUT);
		const done = (capture) => {
			clearTimeout(timer);
			resolve(capture);
		};
		proc.stdout.once('data', () => done({ proc, pipe: `\\\\.\\pipe\\${name}` }));
		proc.on('error', () => done(null));
		proc.on('exit', () => done(null));
	});
}

function removeFile(file) {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// best effort
	}
}

/** file.mp4, or file (2).mp4... when it exists */
function uniquePath(file) {
	const { dir, name, ext } = path.parse(file);
	let candidate = file;
	for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${name} (${i})${ext}`);
	return candidate;
}

class Recorder {
	/**
	 * @param {{ ffmpegPath: string, helperPath: string, logFile?: string }} options
	 */
	constructor({ ffmpegPath, helperPath, logFile }) {
		this.ffmpegPath = ffmpegPath;
		this.helperPath = helperPath;
		this.logFile = logFile;
		/** @type {(typeof ENCODERS)[number] | null} */
		this.encoder = null;
		/** @type {Promise<(typeof ENCODERS)[number]> | null} */
		this.probing = null;
		/** @type {{ proc: import('node:child_process').ChildProcess, file: string, startedAt: number, stopping?: boolean } | null} */
		this.current = null;
	}

	get recording() {
		return this.current !== null;
	}

	/** Finds the first encoder that can encode the screen on this computer, once */
	probeEncoder() {
		this.probing ??= this.findEncoder().catch((error) => {
			// try again on the next recording
			this.probing = null;
			throw error;
		});
		return this.probing;
	}

	async findEncoder() {
		for (const encoder of ENCODERS) {
			const { code } = await run(this.ffmpegPath, [
				'-loglevel',
				'error',
				...SCREEN_INPUT,
				...encoder.args(8),
				'-frames:v',
				'5',
				'-f',
				'null',
				'-'
			]);
			if (code === 0) {
				this.encoder = encoder;
				return encoder;
			}
		}
		throw new Error('No H.264 encoder can record the screen');
	}

	/** Names of the DirectShow microphones */
	async listMics() {
		const { stderr } = await run(this.ffmpegPath, [
			'-list_devices',
			'true',
			'-f',
			'dshow',
			'-i',
			'dummy'
		]);
		return [...stderr.matchAll(/"([^"]+)" \(audio\)/g)].map((m) => m[1]);
	}

	/**
	 * Starts recording to `file` (.mkv).
	 * @param {{ file: string, micName?: string | null, discord?: boolean, bitrateMbps: number }} options
	 */
	async start({ file, micName, discord = false, bitrateMbps }) {
		if (this.current) return;
		const encoder = await this.probeEncoder();
		// record without sound rather than not at all when the mic is unplugged
		const withMic = !!micName && (await this.listMics()).includes(micName);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		await this.spawnRecording({ file, micName: withMic ? micName : null, discord, bitrateMbps, encoder });
	}

	/** @param {NonNullable<Recorder['current']>} [retryOf] the recording this one replaces */
	async spawnRecording({ file, micName, discord, bitrateMbps, encoder }, retryOf) {
		const capture = discord ? await startDiscordCapture(this.helperPath) : null;
		// stopped while the helper was starting
		if (retryOf && (this.current !== retryOf || retryOf.stopping)) {
			capture?.proc.kill();
			return;
		}

		const micInput = micName
			? [
					'-f',
					'dshow',
					'-thread_queue_size',
					'1024',
					'-audio_buffer_size',
					'50',
					'-i',
					`audio=${micName}`
			  ]
			: [];
		const discordInput = capture
			? ['-f', 's16le', '-ar', '48000', '-ac', '2', '-thread_queue_size', '1024', '-i', capture.pipe]
			: [];
		// the screen is input 0, the sounds follow it
		const audioMap =
			micName && capture
				? [
						'-filter_complex',
						// no normalizing, it would turn the voices down. The limiter keeps the sum from clipping.
						'[1:a][2:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.97:level=0[audio]',
						'-map',
						'[audio]'
				  ]
				: micName || capture
				? ['-map', '1:a']
				: [];
		const audioOutput = audioMap.length ? [...audioMap, '-c:a', 'aac', '-b:a', '160k'] : [];
		const args = [
			'-hide_banner',
			'-loglevel',
			'warning',
			'-y',
			...SCREEN_INPUT,
			...micInput,
			...discordInput,
			'-map',
			'0:v',
			...encoder.args(bitrateMbps),
			...audioOutput,
			file
		];

		const proc = spawn(this.ffmpegPath, args, { windowsHide: true });
		const current = { proc, file, startedAt: Date.now() };
		this.current = current;

		const log = this.logFile ? fs.createWriteStream(this.logFile) : null;
		log?.write(`ffmpeg ${args.join(' ')}\n\n`);
		const writeLog = (chunk) => {
			if (log && !log.writableEnded) log.write(chunk);
		};
		proc.stderr.on('data', writeLog);
		capture?.proc.stderr.on('data', writeLog);
		proc.on('error', () => capture?.proc.kill());
		proc.on('exit', (code) => {
			capture?.proc.kill();
			log?.end(`\nexit ${code}\n`);
			// still the running recording, and it was not stopped: ffmpeg failed
			if (this.current !== current || current.stopping) return;
			if ((micName || capture) && Date.now() - current.startedAt < EARLY_EXIT) {
				// the mic first, it is the most likely to fail
				const retry = { file, micName: null, discord: micName ? !!capture : false, bitrateMbps, encoder };
				this.spawnRecording(retry, current);
			}
		});
	}

	/** Elapsed recording time in ms, 0 when not recording */
	get elapsed() {
		return this.current ? Date.now() - this.current.startedAt : 0;
	}

	/**
	 * Finishes the recording and saves it as `mp4File` (renamed when it exists).
	 * @returns {Promise<string | null>} the saved file, the .mkv when the remux fails
	 */
	async stop(mp4File) {
		const current = this.current;
		if (!current) return null;
		current.stopping = true;
		if (current.proc.exitCode === null) {
			// 'q' lets ffmpeg finish the file
			current.proc.stdin.write('q');
			await waitForExit(current.proc, STOP_TIMEOUT);
		}
		this.current = null;

		if (!fs.existsSync(current.file)) return null;
		const target = uniquePath(mp4File);
		const { code } = await run(this.ffmpegPath, [
			'-loglevel',
			'error',
			'-y',
			'-i',
			current.file,
			'-c',
			'copy',
			'-movflags',
			'+faststart',
			target
		]);
		if (code !== 0) {
			removeFile(target);
			return current.file;
		}
		removeFile(current.file);
		return target;
	}

	/** Stops the recording and deletes its file */
	async discard() {
		const current = this.current;
		if (!current) return;
		current.stopping = true;
		if (current.proc.exitCode === null) {
			current.proc.kill();
			await waitForExit(current.proc, STOP_TIMEOUT);
		}
		this.current = null;
		removeFile(current.file);
	}
}

module.exports = { Recorder, FRAMERATE };
