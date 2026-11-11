# chunkchomp — installation

You ran the installer in **custom folder** mode, so the plugin files were written here and OpenCode
does not know about them yet. Pick one of the two ways below.

## What is in this folder

```
index.js                      the plugin itself (already built for your OpenCode version)
chunkchomp.txt                settings, plain key = value
chunkchomp.example.txt        reference settings with comments
tools/logs.mjs                CLI report  (node tools/logs.mjs)
tools/ctl.mjs                 CLI control (node tools/ctl.mjs status)
engine/engine.exe             optional native tokenizer sidecar (Rust)
tok/                          optional tokenizer vocabularies (created only if you chose a download)
```

## Option A — move it into OpenCode (simplest)

1. Create `%USERPROFILE%\.config\opencode\plugins\chunkchomp\` if it does not exist.
2. Copy **everything from this folder** into it.
3. Restart OpenCode. Directory plugins are discovered automatically; no config entry is needed.
4. The report is written to `%USERPROFILE%\.config\opencode\chunkchomp-status.txt`.

## Option B — keep it where it is and point OpenCode at it

Edit `%USERPROFILE%\.config\opencode\opencode.json`:

```json
{
  "plugins": ["C:/full/path/to/this/folder"]
}
```

Use forward slashes or doubled backslashes. A configured local plugin path must be a **directory**,
and it must contain `package.json` (it does if you kept the whole folder).

On OpenCode 1.x the key is `plugin` (singular) or simply drop the folder into the plugins directory.

## After either option

- Restart OpenCode.
- Ask the model to run something with a large output. The result comes back with a header like
  `[2.1 | tool:shell | 58.8KB | 9800tok | ?COMPACT]`, and the model can compact it.
- Check `chunkchomp-status.txt` next to `opencode.json` for the live usage report.

## Settings

Edit `chunkchomp.txt` (or run `node tools/ctl.mjs status`). Saving is enough; it is re-read on the
next request. The important ones:

| key | default | meaning |
|---|---|---|
| `thresholdTokens` | 2000 | minimum size before a chunk is flagged |
| `mandatoryAfterTokens` | 150000 | context size where `?COMPACT` becomes `!COMPACT` |
| `engine` | auto | `auto`, `rust` or `js` |
| `enginePath` | empty | explicit path to `engine.exe` |
| `ignore*` | empty | tools, MCP servers, paths, commands never flagged |

## Uninstall

Delete the folder, remove the entry from `opencode.json` if you added one, and delete
`chunkchomp-status.txt` plus `%USERPROFILE%\.config\opencode\chunkchomp\`.
