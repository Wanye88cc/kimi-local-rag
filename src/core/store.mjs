import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { loadConfig } from './config.mjs';

export const STORE_DIR_NAME = path.join('.kimi-code', 'rag');

/** Resolve the effective home for global storage. */
export function kimiHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

/**
 * Store resolution order:
 *   1. $KIMI_RAG_DIR
 *   2. explicit `dir` argument (a rag dir, or a project dir to walk up from)
 *   3. walk up from startDir looking for an existing `.kimi-code/rag/rag.db`
 *      (stops before $HOME)
 *   4. most recently used project store (written by the inject hook)
 *   5. for writes: create a project store at startDir; else: global store
 */
export function resolveStoreDir({ dir, startDir, forWrite = false } = {}) {
  if (process.env.KIMI_RAG_DIR) return process.env.KIMI_RAG_DIR;

  const start = dir || startDir || process.cwd();
  // If `dir` itself looks like a rag dir or a project containing one, honor it directly
  if (dir) {
    if (fs.existsSync(path.join(dir, 'rag.db'))) return dir;
    const direct = path.join(dir, STORE_DIR_NAME);
    if (fs.existsSync(path.join(direct, 'rag.db'))) return direct;
  }

  const home = os.homedir();
  let cur = path.resolve(start);
  while (cur !== home && cur !== path.dirname(cur)) {
    const candidate = path.join(cur, STORE_DIR_NAME);
    if (fs.existsSync(path.join(candidate, 'rag.db'))) return candidate;
    cur = path.dirname(cur);
  }

  // Recently used project store (the hook sees every prompt's cwd)
  const lastSeen = readLastProjectStore(start);
  if (lastSeen) return lastSeen;

  if (forWrite) return path.join(path.resolve(start), STORE_DIR_NAME);
  return path.join(kimiHome(), 'rag');
}

function lastProjectFile() {
  return path.join(kimiHome(), 'rag-last-project.json');
}

export function rememberProjectStore(projectDir, storeDir) {
  try {
    fs.mkdirSync(kimiHome(), { recursive: true });
    fs.writeFileSync(
      lastProjectFile(),
      JSON.stringify({ projectDir, storeDir, at: Date.now() })
    );
  } catch { /* best effort */ }
}

function readLastProjectStore(startDir) {
  try {
    const rec = JSON.parse(fs.readFileSync(lastProjectFile(), 'utf8'));
    const fresh = Date.now() - rec.at < 24 * 3600 * 1000;
    if (!fresh) return null;
    if (!fs.existsSync(path.join(rec.storeDir, 'rag.db'))) return null;
    // Only trust it when the caller is inside that project (or running from a
    // plugin directory, where walk-up found nothing)
    const rel = path.relative(rec.projectDir, path.resolve(startDir));
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    return inside ? rec.storeDir : null;
  } catch {
    return null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  mtime REAL,
  size INTEGER,
  hash TEXT,
  chunk_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ord INTEGER,
  start_line INTEGER,
  end_line INTEGER,
  text TEXT,
  tokens TEXT,
  vec BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  tokens, content='chunks', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, tokens) VALUES (new.id, new.tokens);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, tokens) VALUES('delete', old.id, old.tokens);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, tokens) VALUES('delete', old.id, old.tokens);
  INSERT INTO chunks_fts(rowid, tokens) VALUES (new.id, new.tokens);
END;
`;

export class RagStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, 'rag.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.config = loadConfig(dir);
    this._vecCache = null;
  }

  reloadConfig() {
    this.config = loadConfig(this.dir);
    return this.config;
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  /** Load all vectors into memory. 50k chunks x 384 dims = ~76 MB — fine. */
  vectors() {
    if (this._vecCache) return this._vecCache;
    const rows = this.db.prepare('SELECT id, vec FROM chunks WHERE vec IS NOT NULL').all();
    const n = rows.length;
    const dim = n ? rows[0].vec.length / 4 : 0;
    const ids = new Int32Array(n);
    const mat = new Float32Array(n * dim);
    const norms = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      ids[i] = rows[i].id;
      const v = new Float32Array(rows[i].vec.buffer, rows[i].vec.byteOffset, dim);
      mat.set(v, i * dim);
      let s = 0;
      for (let j = 0; j < dim; j++) s += v[j] * v[j];
      norms[i] = Math.sqrt(s) || 1;
    }
    this._vecCache = { ids, mat, norms, dim, n };
    return this._vecCache;
  }

  invalidateVectors() {
    this._vecCache = null;
  }

  /** Brute-force cosine top-N in JS — sub-100 ms even at 50k chunks. */
  vectorSearch(queryVec, limit) {
    const { ids, mat, norms, dim, n } = this.vectors();
    if (n === 0) return [];
    if (dim !== queryVec.length) {
      throw new Error(
        `Embedding dimension mismatch: index has ${dim}, model produced ${queryVec.length}. ` +
        `Run a full rebuild after changing the embedding model.`
      );
    }
    let qs = 0;
    for (let j = 0; j < dim; j++) qs += queryVec[j] * queryVec[j];
    const qnorm = Math.sqrt(qs) || 1;
    const scores = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let dot = 0;
      const off = i * dim;
      for (let j = 0; j < dim; j++) dot += mat[off + j] * queryVec[j];
      scores[i] = dot / (norms[i] * qnorm);
    }
    const idx = [...Array(n).keys()];
    idx.sort((a, b) => scores[b] - scores[a]);
    const top = idx.slice(0, limit);
    return top.map((i) => ({ id: ids[i], cosine: scores[i] }));
  }

  /** FTS5 BM25 search over the code-aware token stream. Best (lowest) first. */
  ftsSearch(contentTerms, limit) {
    if (contentTerms.length === 0) return [];
    const match = contentTerms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');
    try {
      return this.db
        .prepare('SELECT rowid AS id, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?')
        .all(match, limit);
    } catch {
      return [];
    }
  }

  getChunksByIds(ids) {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT c.id, c.text, c.tokens, c.start_line, c.end_line, f.path
         FROM chunks c JOIN files f ON f.id = c.file_id
         WHERE c.id IN (${placeholders})`
      )
      .all(...ids);
    return new Map(rows.map((r) => [r.id, r]));
  }

  getFileByPath(p) {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(p);
  }

  allFiles() {
    return this.db.prepare('SELECT * FROM files ORDER BY path').all();
  }

  deleteFileByPath(p) {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(p);
    this.invalidateVectors();
  }

  upsertFile({ path: p, mtime, size, hash }, chunkRows) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE path = ?').run(p);
      const info = this.db
        .prepare('INSERT INTO files(path, mtime, size, hash, chunk_count) VALUES (?, ?, ?, ?, ?)')
        .run(p, mtime, size, hash, chunkRows.length);
      const fileId = info.lastInsertRowid;
      const ins = this.db.prepare(
        'INSERT INTO chunks(file_id, ord, start_line, end_line, text, tokens, vec) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      chunkRows.forEach((c, i) => {
        ins.run(fileId, i, c.startLine, c.endLine, c.text, c.tokens, c.vec ? Buffer.from(c.vec.buffer, c.vec.byteOffset, c.vec.byteLength) : null);
      });
    });
    tx();
    this.invalidateVectors();
  }

  clearAll() {
    this.db.exec('DELETE FROM chunks; DELETE FROM files;');
    this.invalidateVectors();
  }

  stats() {
    const files = this.db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const vectors = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vec IS NOT NULL').get().n;
    const totalChars = this.db.prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM chunks').get().n;
    return {
      files,
      chunks,
      vectors,
      approxTokens: Math.round(totalChars / 4),
      model: this.getMeta('model'),
      vecDim: this.getMeta('vec_dim'),
      lastBuild: this.getMeta('last_build'),
    };
  }

  close() {
    this.db.close();
  }
}

export function openStore(dir) {
  return new RagStore(dir);
}
