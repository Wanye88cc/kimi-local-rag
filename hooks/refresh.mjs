import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStoreDir } from '../src/core/store.mjs';
import { loadConfig } from '../src/core/config.mjs';

/**
 * SessionStart hook — if the index for this project is stale (>24h by
 * default), kick off an incremental refresh in a detached process so the
 * session is never blocked by re-embedding.
 */

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

async function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(PLUGIN_ROOT, 'node_modules', 'better-sqlite3'))) return;
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    return;
  }
  const cwd = payload.cwd || process.cwd();
  const storeDir = resolveStoreDir({ startDir: cwd });
  const dbFile = path.join(storeDir, 'rag.db');
  if (!fs.existsSync(dbFile)) return;

  const cfg = loadConfig(storeDir);
  if (!cfg.trackedPaths.length) return;

  let stale = true;
  try {
    // cheap staleness check without opening sqlite: db file mtime vs threshold
    const mtime = fs.statSync(dbFile).mtimeMs;
    stale = Date.now() - mtime > cfg.staleAfterHours * 3600 * 1000;
  } catch {
    /* treat as stale */
  }
  if (!stale) return;

  const cliPath = path.join(PLUGIN_ROOT, 'src', 'cli.mjs');
  const child = spawn(process.execPath, [cliPath, 'refresh', '--dir', storeDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

main().catch(() => process.exit(0));
