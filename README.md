# kimi-local-rag

Local hybrid RAG plugin for **Kimi Code**. Index your local files and search them with BM25 + vector similarity — **zero cloud dependency, works fully offline** after a one-time ~35 MB model download.

Inspired by [pi-local-rag](https://github.com/vahidkowsari/pi-local-rag), with the retrieval pipeline rebuilt to fix its most common complaint: **irrelevant context getting injected**.

## Why matches are tighter than pi-local-rag

pi-local-rag blends `alpha × BM25 + (1−alpha) × cosine` with min-max normalization and a 0.1 threshold. Min-max normalization forces *some* chunk to score ≈1.0 on every query — so weak matches always clear the bar, and `topK=5` slots are always filled even when nothing is relevant. This plugin instead requires **independent evidence** before any chunk can be returned:

| Mechanism | What it does |
| --- | --- |
| **Evidence gate** | A chunk is eligible only if it clears at least one bar: cosine ≥ `cosineFloor` (semantic evidence), token coverage ≥ `minTokenCoverage` (lexical evidence), or ≥ `minIdentifierHits` exact identifier hits (anchor evidence). Nothing passes → nothing is injected. |
| **RRF fusion** | Reciprocal Rank Fusion (k=60) replaces linear score blending — scale-invariant, so a garbage modality can't manufacture high scores. |
| **Code-aware tokenizer** | Indexes both `verifyStripeWebhook` and its parts (`verify`/`stripe`/`webhook`), so lexical search actually works on code. |
| **Identifier anchors** | Rare identifiers (`STRIPE_WEBHOOK_SECRET`, `config.json`) in the query act as high-precision anchors. |
| **Relative cutoff** | Results below `topScore × relativeThreshold` are dropped — no weak tail filling up topK. |
| **MMR-lite diversity** | Max 2 chunks per file, near-duplicates (cos ≥ 0.92) skipped. |
| **Boundary-aware chunking** | Breaks at blank lines / function / class / header boundaries with overlap, instead of blind 50-line cuts. |

Practical result: a question with no answer in the index injects **zero** context instead of five vaguely-related chunks.

## Features

- Hybrid BM25 (SQLite FTS5) + 384-dim vector search (in-memory cosine, sub-100 ms at 50k chunks)
- Local ONNX embeddings via Transformers.js — `Xenova/bge-small-en-v1.5` by default (q8, ~35 MB), configurable
- Many formats: source code, Markdown, JSON/YAML/TOML, text, PDF, DOCX, HTML (auto-converted)
- Per-project storage at `.kimi-code/rag/` (walk-up resolution), global fallback at `~/.kimi-code/rag/`
- **Auto-injection** via a `UserPromptSubmit` hook, served by a warm background daemon (model stays loaded; the first prompt after idle falls back to a fast lexical-only pass)
- **Auto-refresh** of stale indexes (>24 h) on session start, detached and non-blocking
- **Self-bootstrapping** — dependencies install themselves in the background on first use, no manual `npm install`
- 8 MCP tools (`rag_index`, `rag_query`, `rag_status`, `rag_refresh`, `rag_rebuild`, `rag_clear`, `rag_exclude`, `rag_config`)
- Slash commands `/kimi-local-rag:rag-index`, `:rag-search`, `:rag-status`, `:rag-refresh`, `:rag-rebuild`, `:rag-clear`, `:rag-exclude`, `:rag-on`, `:rag-off`, `:rag-config`

## Requirements

- Node.js ≥ 20 (on `PATH`)
- Kimi Code CLI ≥ 0.32 (hook events used here)

## Install

In Kimi Code:

```
/plugins install https://github.com/Wanye88cc/kimi-local-rag
```

That's it. On the first prompt (or session start) the plugin notices its Node dependencies are missing and installs them **by itself, in the background** — a minute or two later everything is active. No manual `npm install` step.

> Why not bundled like Kimi's built-in plugins? Built-ins ship inside the CLI's own installation. Third-party plugins are plain git clones, and this plugin needs a platform-specific native module (better-sqlite3) — native binaries can't be pre-built into the repo for every OS/arch. So the plugin bootstraps itself on first use instead. If the machine is offline or npm is not on `PATH`, run `npm install` manually in `~/.kimi-code/plugins/managed/kimi-local-rag`.

Finally `/reload` (or start a new session). The first indexing run downloads the embedding model; after that everything is offline.

> 国内网络下载模型慢的话：先 `export HF_ENDPOINT=https://hf-mirror.com` 再做首次索引。

## Quick start

```
/kimi-local-rag:rag-index .          # index current project
/kimi-local-rag:rag-status           # see what got indexed
/kimi-local-rag:rag-search stripe webhook signature verification
```

After indexing, just ask questions normally — relevant excerpts are injected automatically when (and only when) they clear the relevance gate.

## Tuning relevance

All knobs live in `<ragDir>/config.json` (edit via `/kimi-local-rag:rag-config <key> <value>`):

| Key | Default | Higher means |
| --- | --- | --- |
| `cosineFloor` | 0.32 | stricter semantic evidence |
| `minTokenCoverage` | 0.5 | stricter lexical evidence |
| `minIdentifierHits` | 1 | more exact identifiers required |
| `relativeThreshold` | 0.45 | tighter tail cutoff |
| `topK` | 5 | more chunks (still gate-limited) |
| `maxInjectTokens` | 1800 | larger injection budget |

If injected context still feels loose: raise `relativeThreshold` to 0.6 and `minTokenCoverage` to 0.65. If it feels too sparse: lower `cosineFloor` to 0.28.

Chinese-heavy content: switch models for better multilingual semantics —

```
/kimi-local-rag:rag-config model Xenova/multilingual-e5-small
/kimi-local-rag:rag-config queryPrefix "query: "
/kimi-local-rag:rag-config passagePrefix "passage: "
/kimi-local-rag:rag-rebuild force
```

## How it works

1. **Index** — files are chunked at semantic boundaries (~80 lines, 8-line overlap), tokenized code-aware for FTS5, embedded locally, stored in `rag.db` (SQLite, WAL). Content-hash makes re-indexing incremental.
2. **Search** — FTS5 BM25 and in-memory cosine each produce a ranking → RRF fusion → per-candidate evidence (cosine / token coverage / identifier hits) → gate → weighted score → relative cutoff → per-file / near-dup diversification.
3. **Auto-inject** — the `UserPromptSubmit` hook queries a per-store background daemon (model warm, <100 ms) and prints a `<rag-context>` block that Kimi Code appends after your prompt. If nothing passes the gate, nothing is printed.
4. **Auto-refresh** — the `SessionStart` hook spawns a detached incremental refresh when the index is stale.

## Storage

| Rule | Location |
| --- | --- |
| `$KIMI_RAG_DIR` set | wins over everything |
| Walk-up from project root finds `.kimi-code/rag/rag.db` | project store |
| Otherwise | `~/.kimi-code/rag/` (global) |

The embedding model cache is shared globally at `~/.kimi-code/rag/models/`.

## Development

```sh
npm install
node test/run-tests.mjs           # unit tests (pure ranking logic, no native deps)
node test/integration.mjs         # end-to-end with deterministic fake embeddings (offline)
node test/integration.mjs --real  # end-to-end with the real ONNX model (one-time download)
node src/cli.mjs index <path>     # standalone CLI
```

## License

MIT
