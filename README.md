# chunkchomp

**chunkchomp keeps long OpenCode sessions small.** Every tool result — logs, file dumps, build spew — is paid
for again on every request. chunkchomp flags anything oversized and lets the model replace it with a short
summary of what actually mattered, while the full text stays on disk. Nothing is lost, and the context stops
growing with things the model already read.

Context compaction for [OpenCode](https://opencode.ai). It finds oversized tool output, hands the
model a compact header instead of the whole blob, and lets the model replace it with a dense summary
— keeping the original on disk.

```
[2.1 | tool:shell | 58.8KB | 9800tok | ?COMPACT]
```

The model answers with `compact_chunk(chunk_id="2.1", summary="…")`, and from the next request on
that chunk is:

```
[2.1 | tool:shell | 58.8KB -> 1.2KB | COMPACTED]
```

Nothing is deleted. The raw text stays in the session state and on disk.

## Why

Long agent sessions drown in tool output: file dumps, logs, build spew. Every one of those tokens is
paid for on every subsequent request. chunkchomp lets the model keep what matters and drop what it
already used, without losing the ability to look again.

Measured in a live session: a 51,408-byte shell output became a 31-byte summary, and context grew by
120 tokens instead of ~13,000.

## Two tag types

| tag | when | meaning |
|---|---|---|
| `!COMPACT` | context ≥ `mandatoryAfterTokens` (default 150000) | mandatory, compact every one |
| `?COMPACT` | context below the limit | optional, the model decides |

A flag never expires. A `?COMPACT` chunk hardens into `!COMPACT` on its own once the conversation
crosses the limit. Everything without a header stays raw.

## Features

- **Exact token counting** with each model family's own `tokenizer.json` (18 families), pinned
  DeepSeek V4.1 build, proxy for closed models, calibrated estimate otherwise.
- **Native Rust sidecar** (optional): 36 MB for a vocabulary instead of 104 MB, and outside your
  host process. Falls back to the JS tokenizer, then to estimates.
- **Sticky chunk IDs**: compact a chunk now or forty requests later.
- **Nothing excluded by default**: no tool, MCP server, path or command is skipped unless you add it.
- **Plain-text settings**, no JSON, re-read on every request.
- **Usage report** written to `chunkchomp-status.txt` next to `opencode.json`.
- **Both plugin APIs**: OpenCode 1.x (named export) and 2.x (`Plugin.define`).

## Install

Download `chunkchomp-install.exe` from releases and run it. It asks where to install, which build
to use, the threshold, and whether to download tokenizers.

| choice | result |
|---|---|
| opencode config | `~/.config/opencode/plugins/chunkchomp/` (auto-loaded) |
| custom folder | raw files in a folder you pick, plus `INSTRUCTIONS_FOR_INSTALLATION.md` |
| tokenizers: all | 18 families, ~205 MB, exact everywhere |
| tokenizers: deepseek | 6.4 MB, pinned DeepSeek build only |
| tokenizers: none | estimates, ~1 MB of memory |

From source: `install.bat` at the repo root does the same.

## Settings

`chunkchomp.txt`, plain `key = value`, `#` comments. A shortcut is created by the installer.

| key | default | meaning |
|---|---|---|
| `enabled` | true | master switch |
| `thresholdTokens` | 2000 | minimum size before a chunk is flagged |
| `toolThresholds` | empty | per-tool override, `shell:4000, read:8000` |
| `mandatoryAfterTokens` | 150000 | context size where `?` becomes `!` |
| `engine` | auto | `auto`, `rust`, `js` |
| `enginePath` | empty | explicit path to `engine.exe` |
| `useTokenizer` | true | real tokenizer vs estimate |
| `charsPerToken` | 4.24 | estimate baseline |
| `activeModels` | empty | restrict to model globs |
| `protectedTools`, `ignoreTools`, `ignoreToolPrefixes`, `ignoreMcpServers`, `ignorePathPrefixes`, `ignoreCommandPrefixes` | empty | never flag these |

## Docs

- [DEV.md](DEV.md) — architecture, hook contracts, engine protocol, installer internals, testing, release.
- [docs/VERIFY.md](docs/VERIFY.md) — a self-contained verification procedure, including isolated OpenCode 2 testing.

## Requirements

OpenCode 1.18+ or 2.x. Windows for the `.exe` installer; the plugin itself is plain ESM and runs
wherever OpenCode does. Node 18+ only for the optional CLI tools.

## License

MIT.

---

If this tool saved you money, and you'd like to donate:

EVM: 0x876Dbb0D860e813Ea57885B717fc860039Db7337
Bitcoin: bc1qv7f4v8djjw46wyhw0c8nfdufdy9mgnwcndvyyc
Solana: 7uCSuGumHHAKLw8KAwEthhwJgGvFprjZs8pQ4c7vvNud
Tron: TCU9ruV2qAbdfPkby28WXNGwv7WDDexXsV
Ton: UQBmx9jzmKV6hhUF6mZ-2DIHKSBc8zwYtqAZZRL6UPAApFmx
