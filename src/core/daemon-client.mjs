import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The inject hook fires on every user prompt, so it cannot afford to load the
 * ONNX model each time. A per-store background daemon keeps the embedding
 * model warm; the hook asks the daemon (semantic path) and falls back to
 * lexical-only search while the daemon is still starting.
 */

const DAEMON_FILE = 'daemon.json';
const DEFAULT_TIMEOUT_MS = 2500;

export function daemonFilePath(ragDir) {
  return path.join(ragDir, DAEMON_FILE);
}

export function readDaemonInfo(ragDir) {
  try {
    return JSON.parse(fs.readFileSync(daemonFilePath(ragDir), 'utf8'));
  } catch {
    return null;
  }
}

export async function queryDaemon(ragDir, route, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const info = readDaemonInfo(ragDir);
  if (!info?.port || !info?.token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget: start the daemon detached so the next prompt is warm. */
export function ensureDaemon(ragDir) {
  const info = readDaemonInfo(ragDir);
  if (info?.pid) {
    try {
      process.kill(info.pid, 0); // alive
      return;
    } catch {
      /* stale pid file — respawn */
    }
  }
  const daemonPath = fileURLToPath(new URL('../daemon.mjs', import.meta.url));
  const child = spawn(process.execPath, [daemonPath, '--dir', ragDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
