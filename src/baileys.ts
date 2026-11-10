import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import type { SocketFactory, WaSocketLike } from './client.js';

/** Logger writes to stderr only: stdout is reserved for the MCP protocol. */
export function makeLogger(level = process.env['WA_MCP_LOG_LEVEL'] ?? 'silent') {
  return pino({ level }, pino.destination(2));
}

/** Real Baileys (multi-device) socket factory. */
export const baileysFactory: SocketFactory = async ({ authDir }) => {
  const logger = makeLogger();
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const latest = await fetchLatestBaileysVersion({ signal: AbortSignal.timeout(5000) });
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    version: latest.version,
    logger,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
  return { sock: sock satisfies WaSocketLike, saveCreds };
};
