// Test infrastructure only. No production import, proxy, persistence or content logging.
import https from 'node:https';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SYNTHETIC_KEY = 'PUBLIC-SYNTHETIC-TEST-ONLY';
const profiles = new Set(['final', 'proposal', '401', '403', '429', '5xx', 'timeout', 'oversize', 'redirect']);
const requiredHeaders = ['authorization', 'content-type', 'x-session-id'];
const standardHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'origin', 'accept', 'accept-encoding', 'accept-language', 'user-agent', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
function closed(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const bytes = text => Buffer.byteLength(text, 'utf8');
function validBody(value) {
  if (!closed(value, ['model', 'messages', 'max_tokens', 'temperature']) || typeof value.model !== 'string' || !value.model.trim() || bytes(value.model) > 128 || /[\r\n]/.test(value.model) ||
      !Number.isInteger(value.max_tokens) || value.max_tokens < 64 || value.max_tokens > 8192 || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2 ||
      !Array.isArray(value.messages) || value.messages.length < 2 || value.messages.length > 32) return false;
  const messages = value.messages;
  const context = messages.length % 2 === 1;
  let total = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const current = index === messages.length - 1;
    const selection = context && index === messages.length - 2;
    const role = index === 0 ? 'system' : current || selection || index % 2 === 1 ? 'user' : 'assistant';
    const cap = role === 'user' ? 8192 : 65536;
    if (!closed(message, ['role', 'content']) || message.role !== role || typeof message.content !== 'string' || bytes(message.content) > cap) return false;
    total += bytes(message.content);
  }
  return total <= 65536;
}
function validConfig(config) {
  return closed(config, ['keyPath', 'certPath', 'listenAddress', 'port', 'prefix', 'profile', 'corsOrigin', 'delayMs']) &&
    typeof config.keyPath === 'string' && config.keyPath.length > 0 && typeof config.certPath === 'string' && config.certPath.length > 0 &&
    isIP(config.listenAddress) !== 0 && !['0.0.0.0', '::'].includes(config.listenAddress) && Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535 &&
    typeof config.prefix === 'string' && config.prefix.length <= 256 && /^(?:\/[A-Za-z0-9_-]+)*$/.test(config.prefix) && profiles.has(config.profile) &&
    typeof config.corsOrigin === 'string' && (config.corsOrigin === 'null' || /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(config.corsOrigin)) &&
    Number.isInteger(config.delayMs) && config.delayMs >= 1 && config.delayMs <= 120000;
}
export async function startMock(config) {
  if (!validConfig(config)) throw new Error('MOCK_CONFIG_INVALID');
  // Snapshot trusted configuration. Never choose a profile from message instructions.
  const { listenAddress, port, prefix, profile, corsOrigin, delayMs } = config;
  let key; let cert;
  try {
    key = await readFile(config.keyPath); cert = await readFile(config.certPath);
    const leaf = new X509Certificate(cert);
    if (Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now() || !leaf.checkPrivateKey(createPrivateKey(key))) throw new Error();
  } catch { throw new Error('MOCK_TLS_INVALID'); }
  const route = `${prefix}/v1/chat/completions`;
  const sockets = new Set(); const timers = new Set(); const sessions = new Set();
  const counts = { requests: 0, accepted: 0, rejected: 0, sessions: 0, repeatedSessions: 0, sessionCapacityReached: false };
  let server;
  try {
    server = https.createServer({ key, cert, minVersion: 'TLSv1.2', maxHeaderSize: 16384, handshakeTimeout: 5000, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
      counts.requests += 1;
      const reply = (status, payload = '') => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
        res.end(payload);
      };
      const reject = status => { counts.rejected += 1; req.resume(); reply(status, '{"error":"SYNTHETIC_REQUEST_REJECTED"}'); };
      if (req.url !== route) { reject(404); return; }
      if (req.headers.origin !== undefined && req.headers.origin !== corsOrigin) { reject(403); return; }
      if (req.headers.origin === corsOrigin) {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin); res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        const requested = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(item => item.trim()).sort();
        if (req.headers.origin !== corsOrigin || req.headers['access-control-request-method'] !== 'POST' || JSON.stringify(requested) !== JSON.stringify(requiredHeaders)) { reject(403); return; }
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Session-ID');
        reply(204); return;
      }
      if (req.method !== 'POST') { reject(405); return; }
      if (req.headers.authorization !== `Bearer ${SYNTHETIC_KEY}`) { reject(401); return; }
      const names = req.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
      if (requiredHeaders.some(name => names.filter(item => item === name).length !== 1) || names.some(name => !requiredHeaders.includes(name) && !standardHeaders.has(name)) ||
          req.headers['content-type'] !== 'application/json' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.headers['x-session-id'] ?? '')) { reject(400); return; }
      if (req.headers['content-length'] !== undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > 98304)) { reject(413); return; }
      let chunks = []; let size = 0; let stopped = false;
      req.on('data', chunk => {
        if (stopped) return;
        size += chunk.length;
        if (size > 98304) { stopped = true; chunks = []; reject(413); return; }
        chunks.push(chunk);
      });
      req.on('error', () => { stopped = true; chunks = []; });
      req.on('aborted', () => { stopped = true; chunks = []; });
      req.on('end', () => {
        if (stopped) return;
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); } catch { chunks = []; reject(400); return; }
        chunks = [];
        if (!validBody(value)) { reject(400); return; }
        value = null; // Do not retain any message content in server/session state.
        counts.accepted += 1;
        const identity = createHash('sha256').update(req.headers['x-session-id'].toLowerCase()).digest('hex');
        if (sessions.has(identity)) counts.repeatedSessions += 1;
        else if (sessions.size < 64) { sessions.add(identity); counts.sessions = sessions.size; }
        else counts.sessionCapacityReached = true;
        if (['401', '403', '429', '5xx'].includes(profile)) { reply(profile === '5xx' ? 503 : Number(profile), '{"error":"SYNTHETIC_CONTROLLED_ERROR"}'); return; }
        if (profile === 'redirect') { res.setHeader('Location', route); reply(307); return; }
        const content = profile === 'proposal' ? { type: 'tool', tool: 'r7_replace_selection', arguments: { text: 'Synthetic replacement.' } } : { type: 'final', message: 'Synthetic final response.' };
        const envelope = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] });
        if (profile === 'oversize') { reply(200, JSON.stringify({ choices: [{ message: { content: 'x'.repeat(131073) } }] })); return; }
        if (profile === 'timeout') {
          const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) reply(200, envelope); }, delayMs);
          timers.add(timer);
          res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
          return;
        }
        reply(200, envelope);
      });
    });
  } catch { throw new Error('MOCK_TLS_INVALID'); }
  key = null; cert = null;
  server.timeout = profile === 'timeout' ? delayMs + 5000 : 5000;
  server.on('timeout', socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => {}); // No raw TLS exceptions or header/key values.
  server.on('clientError', (_error, socket) => socket.destroy());
  try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen({ host: listenAddress, port }, accept); });
  } catch { for (const socket of sockets) socket.destroy(); throw new Error('MOCK_LISTEN_FAILED'); }
  server.removeAllListeners('error'); server.on('error', () => {});
  let closing;
  return Object.freeze({ port: server.address().port,
    stats: () => Object.freeze({ ...counts, activeSockets: sockets.size, pendingTimers: timers.size }),
    close: () => {
      if (!closing) closing = new Promise(accept => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const socket of sockets) socket.destroy();
        sockets.clear(); sessions.clear();
        server.close(() => accept());
      });
      return closing;
    }
  });
}

// Explicit, parent-managed CLI only. Importing this module never starts a service.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = process.env;
    if (!env.R7_MOCK_PORT || !/^\d+$/.test(env.R7_MOCK_PORT) || Number(env.R7_MOCK_PORT) < 1 || !env.R7_MOCK_DELAY_MS || !/^\d+$/.test(env.R7_MOCK_DELAY_MS)) throw new Error();
    const mock = await startMock({ keyPath: env.R7_MOCK_TLS_KEY, certPath: env.R7_MOCK_TLS_CERT, listenAddress: env.R7_MOCK_LISTEN_ADDRESS, port: Number(env.R7_MOCK_PORT), prefix: env.R7_MOCK_PREFIX, profile: env.R7_MOCK_PROFILE, corsOrigin: env.R7_MOCK_CORS_ORIGIN, delayMs: Number(env.R7_MOCK_DELAY_MS) });
    const stop = () => { mock.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    process.stdout.write('SYNTHETIC_HTTPS_MOCK_READY\n');
  } catch { process.stderr.write('SYNTHETIC_HTTPS_MOCK_START_FAILED\n'); process.exitCode = 1; }
}
