# Changelog

## 1.0.2 - 2026-11-21

- compact_chunk takes only two fields now: chunk_id and summary. The optional reason field is gone; models were putting their text there and leaving summary empty, which produced reject loops.
- Tool and summary descriptions rewritten: summary is required, non-empty, and has no minimum or maximum length.
- Policy text and AGENTS.md updated to match.


## 1.0.1 — 2026-11-20

- Fixed portable config resolution in both entries: `CHUNKCHOMP_CONFIG_DIR` → `XDG_CONFIG_HOME/opencode` → `~/.config/opencode`.
- The V2 adapter now runs correctly in an isolated XDG sandbox without reading or writing the real `~/.config/opencode`.
- `~/.omo/.last-model` fallback now honors `OMO_HOME`.
- Verified against OpenCode 2.3.2: the plugin loads and `compact_chunk` executes.
- Rebuilt `dist/chunkchomp-install.exe` with the updated sources.

## 1.0.0

- Initial release.
