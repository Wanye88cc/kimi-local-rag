---
description: Index a file or directory into the local RAG store (default: current project)
---

Call the `rag_index` tool with path `$ARGUMENTS` (if the argument is empty, use the current project root). Pass the current project root as `dir`. Then reply with one or two sentences: how many files/chunks were indexed, note that the first run downloads a ~35 MB embedding model (one time only), and whether the store is project-local or global.
