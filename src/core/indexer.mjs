import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { walkFiles } from './walker.mjs';
import { extractText } from './extract.mjs';
import { chunkText } from './chunker.mjs';
import { tokenizeText } from './tokenizer.mjs';
import { embed } from './embedder.mjs';

const EMBED_BATCH = 32;

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function modelsDir() {
  // Share the model cache globally across project stores — it is ~35 MB.
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'rag', 'models');
}

/**
 * Index one or more paths (files or directories). Idempotent via content hash.
 * @returns {Promise<{indexed: number, unchanged: number, skipped: number, chunks: number}>}
 */
export async function indexPaths(store, paths, opts = {}) {
  const { onProgress, force = false } = opts;
  const cfg = store.config;
  const stats = { indexed: 0, unchanged: 0, skipped: 0, chunks: 0 };
  const allFiles = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) {
      stats.skipped++;
      continue;
    }
    allFiles.push(...walkFiles(abs, cfg));
  }

  // Embed with a dimension guard against model changes.
  // opts.embedFn is a test hook to substitute the embedding model.
  const embedVecs = async (texts) => {
    const vecs = opts.embedFn
      ? await opts.embedFn(texts, false)
      : await embed(texts, cfg, modelsDir(), { isQuery: false });
    const dim = vecs[0]?.length;
    const stored = store.getMeta('vec_dim');
    if (dim && !stored) {
      store.setMeta('vec_dim', dim);
      store.setMeta('model', cfg.model);
    } else if (dim && stored && Number(stored) !== dim) {
      throw new Error(
        `Embedding dimension mismatch: index was built with ${stored}-dim model ` +
        `"${store.getMeta('model')}", current model "${cfg.model}" produces ${dim}. ` +
        `Run rag_rebuild --force after changing the model.`
      );
    }
    return vecs;
  };

  let done = 0;
  for (const f of allFiles) {
    done++;
    onProgress?.({ done, total: allFiles.length, file: f.rel });
    let text;
    try {
      text = await extractText(f.abs);
    } catch {
      text = null;
    }
    if (!text || !text.trim()) {
      stats.skipped++;
      continue;
    }
    const hash = sha1(text);
    const existing = store.getFileByPath(f.rel);
    if (!force && existing && existing.hash === hash) {
      stats.unchanged++;
      continue;
    }

    const chunks = chunkText(text, {
      targetLines: cfg.chunkTargetLines,
      minLines: cfg.chunkMinLines,
      overlapLines: cfg.chunkOverlapLines,
    });
    if (chunks.length === 0) {
      stats.skipped++;
      continue;
    }

    // Batch-embed all chunks of this file
    const rows = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vecs = await embedVecs(batch.map((c) => c.text));
      batch.forEach((c, j) => {
        rows.push({
          ...c,
          tokens: tokenizeText(c.text).join(' '),
          vec: vecs[j],
        });
      });
    }

    store.upsertFile({ path: f.rel, mtime: f.mtime, size: f.size, hash }, rows);
    stats.indexed++;
    stats.chunks += rows.length;
  }

  store.setMeta('last_build', new Date().toISOString());
  return stats;
}

/** Incremental refresh of all tracked paths: index new/changed, drop deleted. */
export async function refresh(store, opts = {}) {
  const cfg = store.config;
  const stats = await indexPaths(store, cfg.trackedPaths, opts);
  // Remove files that disappeared from disk
  let removed = 0;
  const roots = cfg.trackedPaths.map((p) => path.resolve(p));
  for (const f of store.allFiles()) {
    const abs = roots.map((r) => path.join(r, f.path)).find((a) => fs.existsSync(a));
    if (!abs) {
      store.deleteFileByPath(f.path);
      removed++;
    }
  }
  store.setMeta('last_build', new Date().toISOString());
  return { ...stats, removed };
}
