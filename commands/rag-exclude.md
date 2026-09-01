---
description: Add/list/remove gitignore-style exclude patterns; prefix with "-" to remove
---

Parse `$ARGUMENTS`: if empty, call `rag_exclude` with no pattern to list. If it starts with "-", call `rag_exclude` with the pattern (without the dash) and remove=true. Otherwise call `rag_exclude` with the pattern to add it. Pass the current project root as `dir`. Remind the user to run rag-refresh (it also happens automatically on the next session) for the change to take effect.
