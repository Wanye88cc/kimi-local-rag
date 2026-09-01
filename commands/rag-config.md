---
description: Show or tune retrieval config (cosineFloor, minTokenCoverage, relativeThreshold, topK, model...)
---

Parse `$ARGUMENTS` as "<key> [value]". With only a key (or nothing), call `rag_config` to read; with key and value, call `rag_config` to set. Pass the current project root as `dir`. When a value was set, briefly explain what the knob does — especially the relevance-gate knobs (cosineFloor, minTokenCoverage, relativeThreshold), where higher means stricter.
