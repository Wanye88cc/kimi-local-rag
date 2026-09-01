import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { depsInstalled, ensureDeps } from '../src/core/bootstrap.mjs';

/**
 * SessionStart hook — if the index for this project is stale (>24h by
 * default), kick off an incremental refresh in a detached process so the
 * session is never blocked by re-embedding.
 *
 * Heavy modules are imported dynamically AFTER the dependency check so a
 * fresh clone (no node_modules) bootstraps instead of crashing.
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
  // Dependencies missing? Bootstrap them in the background; nothing else to do.
  if (!depsInstalled(PLUGIN_ROOT)) {
    ensureDeps(PLUGIN_ROOT);
    return;
  }

  const { resolveStoreDir } = await import('../src/core/store.mjs');
  const { loadConfig } = await import('../src/core/config.mjs');

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
