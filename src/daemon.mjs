import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { RagStore } from './core/store.mjs';
import { search, formatInjection } from './core/search.mjs';
import { refresh } from './core/indexer.mjs';
import { daemonFilePath } from './core/daemon-client.mjs';

/**
 * Warm daemon: keeps the embedding model and the in-memory vector matrix
 * loaded so per-prompt injection stays fast. One daemon per store directory.
 * Auto-exits after 30 minutes idle.
 */

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function parseArgs() {
  const i = process.argv.indexOf('--dir');
  if (i === -1 || !process.argv[i + 1]) {
    console.error('usage: daemon.mjs --dir <ragDir>');
    process.exit(1);
  }
  return process.argv[i + 1];
}

const ragDir = parseArgs();
const store = new RagStore(ragDir);
const token = crypto.randomBytes(24).toString('hex');
let idleTimer = null;

function bumpIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), IDLE_TIMEOUT_MS);
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try {
    return JSON.parse(data || '{}');
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  bumpIdle();
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
  store.reloadConfig();

  try {
    const body = await readBody(req);
    if (req.url === '/health') {
      return send(200, { ok: true, pid: process.pid });
    }
    if (req.url === '/query') {
      const out = await search(store, body.query || '', { topK: body.topK, semantic: body.semantic !== false });
      return send(200, out);
    }
    if (req.url === '/inject') {
      const out = await search(store, body.prompt || '', {});
      return send(200, { text: formatInjection(out.results, store.config), reason: out.reason });
    }
    if (req.url === '/refresh') {
      const stats = await refresh(store);
      return send(200, stats);
    }
    return send(404, { error: 'unknown route' });
  } catch (err) {
    return send(500, { error: String(err?.message || err) });
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(
    daemonFilePath(ragDir),
    JSON.stringify({ pid: process.pid, port, token, dir: ragDir, startedAt: Date.now() }),
    { mode: 0o600 }
  );
  bumpIdle();
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
