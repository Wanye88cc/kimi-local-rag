---
description: Search the local RAG index with the relevance-gated hybrid search
---

Call the `rag_query` tool with query `$ARGUMENTS`, passing the current project root as `dir`. Present the returned chunks with their file paths and line numbers. If the tool reports reason "gated-out" or "no-candidates", tell the user plainly that the index contains nothing sufficiently relevant instead of paraphrasing weak results.
