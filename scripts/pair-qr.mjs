// Pairing helper: prints the WhatsApp linking QR in the terminal AND saves it as a
// PNG so it can also be scanned straight from an image.
// Usage: node scripts/pair-qr.mjs [outfile.png]
import path from 'node:path';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { WaClient } from '../dist/client.js';
import { baileysFactory } from '../dist/baileys.js';
import { defaultAuthDir } from '../dist/auth.js';

const authDir = defaultAuthDir();
const out = path.resolve(process.argv[2] ?? 'pair-qr.png');
const log = (msg) => process.stderr.write(String(msg) + '\n');

const client = new WaClient({ authDir, factory: baileysFactory, log });
client.onQr(async (qr) => {
  qrcodeTerminal.generate(qr, { small: true }, (art) => log('\nScan this QR in WhatsApp > Settings > Linked devices > Link a device:\n' + art));
  await QRCode.toFile(out, qr, { width: 720, margin: 2 });
  log('PNG saved: ' + out + '\n');
});

try {
  await client.pair({ timeoutMs: 300000 });
  log('PAIRED OK');
} catch (err) {
  log('PAIR FAILED: ' + String(err?.message ?? err));
} finally {
  await client.stop();
  process.exit(0);
}
