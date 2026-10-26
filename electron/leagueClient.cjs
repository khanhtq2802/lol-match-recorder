// Reads the match state from the League Client API (LCU) and the game's Live Client Data API.
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const DEFAULT_INSTALL_DIR = 'C:/Riot Games/League of Legends';
const PRODUCT_SETTINGS =
	'C:/ProgramData/Riot Games/Metadata/league_of_legends.live/league_of_legends.live.product_settings.yaml';
// Riot Live Client Data API, served by the game client while a match is running
// @see https://developer.riotgames.com/docs/lol#game-client-api_live-client-data-api
const LIVE_CLIENT = { host: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata' };

// the LCU and the game serve a self-signed Riot certificate on localhost
const agent = new https.Agent({ rejectUnauthorized: false });

let installDir;
// champion names by id, per client session (the password changes when the client restarts)
let championNames = { password: null, byId: null };

function getInstallDir() {
	if (installDir) return installDir;
	try {
		const settings = fs.readFileSync(PRODUCT_SETTINGS, 'utf8');
		installDir = settings.match(/product_install_full_path:\s*"?([^"\r\n]+)"?/)?.[1];
	} catch {
		// Riot metadata not found
	}
	installDir ??= DEFAULT_INSTALL_DIR;
	return installDir;
}

// The lockfile only exists while the client is running: "LeagueClient:<pid>:<port>:<password>:https"
function readLockfile() {
	try {
		const [, , port, password] = fs
			.readFileSync(path.join(getInstallDir(), 'lockfile'), 'utf8')
			.split(':');
		return { port, password };
	} catch {
		return null;
	}
}

/** GETs JSON, resolves null on any error or non-200 status */
function getJson(options) {
	return new Promise((resolve) => {
		const req = https.get({ agent, timeout: 1500, ...options }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => {
				try {
					resolve(res.statusCode === 200 ? JSON.parse(body) : null);
				} catch {
					resolve(null);
				}
			});
		});
		req.on('timeout', () => req.destroy());
		req.on('error', () => resolve(null));
	});
}

function request(credentials, endpoint) {
	return getJson({
		host: '127.0.0.1',
		port: credentials.port,
		path: endpoint,
		auth: `riot:${credentials.password}`
	});
}

/**
 * The gameflow phase of the client: None, Lobby, Matchmaking, ReadyCheck, ChampSelect, GameStart,
 * InProgress, Reconnect, WaitingForStats, PreEndOfGame, EndOfGame...
 * @returns {Promise<string | null>} null when the client is not running
 */
async function fetchPhase() {
	const credentials = readLockfile();
	if (!credentials) return null;
	const phase = await request(credentials, '/lol-gameflow/v1/gameflow-phase');
	return typeof phase === 'string' ? phase : null;
}

async function championName(credentials, id) {
	if (championNames.password !== credentials.password || !championNames.byId) {
		const summary = await request(credentials, '/lol-game-data/assets/v1/champion-summary.json');
		if (!Array.isArray(summary)) return null;
		championNames = {
			password: credentials.password,
			byId: new Map(summary.map((c) => [c.id, c.name]))
		};
	}
	return championNames.byId.get(id) ?? null;
}

/**
 * The queue and the champion of the logged in player, to name the recording.
 * The champion is only known once it is picked (or hovered) in champ select.
 * @returns {Promise<{ queue: string | null, champion: string | null }>}
 */
async function fetchMatchInfo() {
	const credentials = readLockfile();
	if (!credentials) return { queue: null, champion: null };

	const session = await request(credentials, '/lol-gameflow/v1/session');
	const queue = session?.gameData?.queue;
	const queueName = queue?.description || queue?.gameMode || null;

	const championId = await request(credentials, '/lol-champ-select/v1/current-champion');
	const champion =
		typeof championId === 'number' && championId > 0
			? await championName(credentials, championId)
			: null;

	return { queue: queueName, champion };
}

/**
 * Whether a match is running, from the game itself (works without the League Client).
 * @returns {Promise<{ champion: string | null } | null>}
 */
async function fetchLiveGame() {
	const data = await getJson(LIVE_CLIENT);
	if (!data || !Array.isArray(data.allPlayers)) return null;
	const me = data.allPlayers.find(
		(p) =>
			p.riotId === data.activePlayer?.riotId || p.summonerName === data.activePlayer?.summonerName
	);
	return { champion: me?.championName ?? null };
}

module.exports = { fetchPhase, fetchMatchInfo, fetchLiveGame };
