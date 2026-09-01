import { tokenizeQuery, tokenizeText, tokenCoverage, identifierHits } from './tokenizer.mjs';
import { embed } from './embedder.mjs';
import path from 'node:path';
import os from 'node:os';

/* ------------------------------------------------------------------ *
 * Pure ranking primitives (exported for unit tests)
 * ------------------------------------------------------------------ */

/** Reciprocal Rank Fusion over multiple ranked id lists. Scale-invariant:
 *  unlike linear blending of normalized scores, a garbage modality cannot
 *  manufacture a high score for an irrelevant chunk. */
export function rrfFuse(rankings, k = 60) {
  const scores = new Map();
  for (const list of rankings) {
    list.forEach((id, idx) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + idx + 1));
    });
  }
  return [...scores.entries()].map(([id, rrf]) => ({ id, rrf })).sort((a, b) => b.rrf - a.rrf);
}

/**
 * The evidence gate — the core fix for "loose matches".
 * A chunk is only eligible if it presents INDEPENDENT evidence:
 *   - semantic: cosine >= cosineFloor, or
 *   - lexical:  it contains >= minTokenCoverage of the query content terms, or
 *   - anchor:   it contains >= minIdentifierHits exact identifiers from the query
 * If nothing passes, the caller injects NOTHING. pi-local-rag always injected
 * topK chunks no matter how weak; that is where the noise came from.
 */
export function passesGate({ cosine, coverage, identifierHits: idHits }, cfg) {
  if (idHits > 0 && idHits >= cfg.minIdentifierHits) return true;
  if (cosine != null && cosine >= cfg.cosineFloor) return true;
  if (coverage >= cfg.minTokenCoverage) return true;
  return false;
}

export function scoreCandidate(c, cfg) {
  // Normalize RRF by its theoretical max (rank 1 in two lists)
  const rrfNorm = c.rrf / (2 / (cfg.rrfK + 1));
  return (
    rrfNorm +
    cfg.wIdentifier * Math.min(c.identifierHits, 3) +
    cfg.wCoverage * c.coverage +
    cfg.wCosine * Math.max(0, c.cosine ?? 0) +
    (c.fileBoost || 0)
  );
}

/** Keep only candidates within `ratio` of the top score — kills the weak tail. */
export function relativeCutoff(scored, ratio) {
  if (scored.length === 0) return scored;
  const top = scored[0].score;
  return scored.filter((c) => c.score >= top * ratio);
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

/** MMR-lite diversity: cap per file, drop near-duplicate chunks. */
export function diversify(ranked, { maxPerFile = 2, nearDupCosine = 0.92, vecOf = null } = {}) {
  const selected = [];
  const perFile = new Map();
  for (const c of ranked) {
    const count = perFile.get(c.path) || 0;
    if (count >= maxPerFile) continue;
    if (vecOf) {
      const v = vecOf(c.id);
      if (v) {
        let dup = false;
        for (const s of selected) {
          const sv = vecOf(s.id);
          if (sv && cosineSim(v, sv) >= nearDupCosine) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
      }
    }
    perFile.set(c.path, count + 1);
    selected.push(c);
  }
  return selected;
}

/* ------------------------------------------------------------------ *
 * Full pipeline
 * ------------------------------------------------------------------ */

function modelsDir() {
  const home = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(home, 'rag', 'models');
}

function fileNameBoost(contentTerms, filePath, boost) {
  const base = path.basename(filePath).toLowerCase();
  const nameTokens = new Set(tokenizeText(base));
  for (const t of contentTerms) {
    if (t.length >= 3 && (base.includes(t) || nameTokens.has(t))) return boost;
  }
  return 0;
}

/**
 * Hybrid search with evidence gating.
 *
 * @param {import('./store.mjs').RagStore} store
 * @param {string} query
 * @param {{topK?: number, semantic?: boolean, embedFn?: (texts: string[], isQuery: boolean) => Promise<Float32Array[]>}} opts
 *   embedFn — test hook to substitute the embedding model.
 * @returns {Promise<{results: Array, reason: string, meta: object}>}
 *   reason: 'ok' | 'empty-query' | 'no-candidates' | 'gated-out'
 */
export async function search(store, query, opts = {}) {
  const cfg = store.config;
  const topK = opts.topK ?? cfg.topK;
  const { contentTerms, identifiers } = tokenizeQuery(query);
  const meta = { contentTerms, identifiers, semantic: opts.semantic !== false };

  if (contentTerms.length === 0 && identifiers.length === 0) {
    return { results: [], reason: 'empty-query', meta };
  }

  const candN = Math.min(200, Math.max(40, topK * 8));

  // 1. lexical ranking (always available, fast)
  const bm25Hits = store.ftsSearch(contentTerms, candN);

  // 2. semantic ranking (skippable for latency-critical paths like hooks
  //    before the daemon is warm)
  let vecHits = [];
  if (opts.semantic !== false) {
    try {
      const embedFn = opts.embedFn || ((texts, isQuery) => embed(texts, cfg, modelsDir(), { isQuery }));
      // Never let a cold model load (or an unreachable HF) block the whole
      // query: after semanticTimeoutMs we answer lexical-only this turn.
      const timeoutMs = cfg.semanticTimeoutMs ?? 8000;
      const [qvec] = await Promise.race([
        embedFn([query], true),
        new Promise((_, reject) => setTimeout(() => reject(new Error('semantic timeout')), timeoutMs)),
      ]);
      vecHits = store.vectorSearch(Array.from(qvec), candN);
    } catch {
      vecHits = [];
    }
  }

  if (bm25Hits.length === 0 && vecHits.length === 0) {
    return { results: [], reason: 'no-candidates', meta };
  }

  // 3. RRF fusion
  const rankings = [];
  if (bm25Hits.length) rankings.push(bm25Hits.map((h) => h.id));
  if (vecHits.length) rankings.push(vecHits.map((h) => h.id));
  const fused = rrfFuse(rankings, cfg.rrfK).slice(0, candN);

  // 4. compute per-candidate evidence
  const rows = store.getChunksByIds(fused.map((f) => f.id));
  const cosineById = new Map(vecHits.map((h) => [h.id, h.cosine]));
  const candidates = [];
  for (const f of fused) {
    const row = rows.get(f.id);
    if (!row) continue;
    const chunkTokenSet = new Set((row.tokens || '').split(' ').filter(Boolean));
    candidates.push({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      rrf: f.rrf,
      cosine: cosineById.get(row.id) ?? null,
      coverage: tokenCoverage(contentTerms, chunkTokenSet),
      identifierHits: identifierHits(identifiers, row.text),
      fileBoost: fileNameBoost(contentTerms, row.path, cfg.fileNameBoost),
    });
  }

  // 5. evidence gate — nothing passes, nothing is returned
  const gated = candidates.filter((c) => passesGate(c, cfg));
  meta.candidates = candidates.length;
  meta.gated = gated.length;
  if (gated.length === 0) {
    return { results: [], reason: 'gated-out', meta };
  }

  // 6. score + relative cutoff
  const scored = gated
    .map((c) => ({ ...c, score: scoreCandidate(c, cfg) }))
    .sort((a, b) => b.score - a.score);
  const cut = relativeCutoff(scored, cfg.relativeThreshold);

  // 7. diversify
  let vecOf = null;
  if (vecHits.length) {
    const { ids, mat, dim } = store.vectors();
    const posById = new Map([...ids].map((id, i) => [id, i]));
    vecOf = (id) => {
      const i = posById.get(id);
      return i == null ? null : new Float32Array(mat.buffer, mat.byteOffset + i * dim * 4, dim);
    };
  }
  const selected = diversify(cut, {
    maxPerFile: cfg.maxPerFile,
    nearDupCosine: cfg.nearDupCosine,
    vecOf,
  }).slice(0, topK);

  return { results: selected, reason: 'ok', meta };
}

/**
 * Format search results as an injectable context block.
 * Returns '' when there is nothing worth injecting.
 */
export function formatInjection(results, cfg) {
  if (!results.length) return '';
  const budget = cfg.maxInjectTokens * 4;
  const parts = [];
  let used = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const body = r.text.length > cfg.maxChunkChars ? r.text.slice(0, cfg.maxChunkChars) + '\n…' : r.text;
    const block = `### ${i + 1}. ${r.path}:${r.startLine}-${r.endLine} (score ${r.score.toFixed(2)})\n${body}`;
    if (used + block.length > budget) break;
    used += block.length;
    parts.push(block);
  }
  if (!parts.length) return '';
  return (
    `<rag-context>\n` +
    `The following excerpts were retrieved from the local kimi-local-rag index because they scored above the relevance gate. Use them if helpful; ignore them if they are not relevant to the request.\n\n` +
    parts.join('\n\n') +
    `\n</rag-context>`
  );
}
