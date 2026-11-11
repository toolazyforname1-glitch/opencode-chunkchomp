# DEV.md — chunkchomp internals

For maintainers. Everything here is derived from the code and from live runs against OpenCode 1.19.0
and 2.2.7, not from documentation guesses.

---

## 1. Repository map

```
opencode-chunkchomp/
├─ src/
│  ├─ chunkchomp.v1.js      OpenCode 1.x entry, self-contained (~950 lines)
│  └─ chunkchomp.v2.js      OpenCode 2.x entry, same body + adapter
├─ engine/
│  ├─ Cargo.toml            Rust sidecar (tokenizers crate)
│  └─ src/main.rs           stdio JSON protocol
├─ tools/
│  ├─ ctl.mjs               on/off/status/get/set/stats-reset against the config
│  └─ logs.mjs              renders stats.json as a table
├─ docs/
│  └─ VERIFY.md             verification procedure for a fresh agent
├─ chunkchomp.txt           reference settings (copied by the installer)
├─ INSTRUCTIONS.template.md shipped to the target folder as INSTRUCTIONS_FOR_INSTALLATION.md
├─ install.bat              Windows questionnaire installer
├─ install.mjs              cross-platform installer, source of the .exe
├─ build-exe.mjs            embeds the sources + engine and compiles the .exe
├─ README.md
└─ DEV.md
```

Both entries are **self-contained on purpose**: a single file survives being copied by hand, by the
installer, or by a package manager without a bundler step. The cost is duplication — sections 5–9
exist twice. `chunkchomp.v2.js` is `chunkchomp.v1.js` plus the adapter in section 4; when you change
one, change the other in the same commit.

---

## 2. Runtime model

OpenCode runs plugins inside its server (Bun). Two plugin APIs exist and they are not compatible.

### 2.1 OpenCode 1.x (1.18.29 … 1.19.x)

```js
export const ChunkChomp = async () => ({
  "experimental.chat.system.transform": async (input, output) => {},
  "experimental.chat.messages.transform": async (input, output) => {},
  "experimental.text.complete": async (input, output) => {},
  tool: { compact_chunk: tool({ ... }) },
})
```

- The loader calls **every export** as a plugin factory.
- `output` is live; mutating it mutates what is sent to the model.
- `tool()` comes from `@opencode-ai/plugin` and provides a zod-like schema builder.

### 2.2 OpenCode 2.x (2.0+)

```js
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "chunkchomp",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => { /* event.system, event.messages */ })
    await ctx.tool.transform((editor) => { editor.add({ name, description, input, execute }) })
    return () => {}
  },
})
```

- Requires a **default** definition with `id` plus `setup` or `effect`.
- No `@opencode-ai/plugin`; tools take JSON Schema in `input`.

---

## 3. Loader traps (read before touching exports)

**Trap 1 — every export becomes a plugin (1.x).** A non-factory export, or a factory returning
`null`, puts `null` into the plugin array and **every hook in the app throws**:

```
TypeError: null is not an object (evaluating 'z[G]')
Plugin.trigger → SessionPrompt.createUserMessage
```

Nothing names your plugin, `--pure` works, and the cause is invisible. Rule: **one export only** on 1.x.

**Trap 2 — a missing plugin poisons the array too.** A name listed in config but not installed
produces the same null entry. Check the plugin list against `node_modules` before debugging code.

**Trap 3 — V2 rejects V1 exports wholesale.** No shim, no alias. Ship two files.

**Trap 4 — `run` attaches to the background service.** `opencode run` without `--standalone` uses the
already-running server and therefore *its* config and *its* plugin instance. Isolated tests must pass
`--standalone`, and `XDG_CONFIG_HOME` must point at `~/.config`, not `~/.config/opencode`.

---

## 4. V2 adapter

`chunkchomp.v2.js` keeps the 1.x hooks intact and adapts at the boundary:

```js
export default Plugin.define({
  id: "chunkchomp",
  async setup(ctx) {
    const hooks = await ChunkChomp()
    await ctx.session.hook("context", async (event) => {
      const { out: v1Messages, pairs } = toV1Messages(event.messages, event.sessionID)
      const out = { system: event.system, messages: v1Messages }
      await hooks["experimental.chat.system.transform"](model, out)
      await hooks["experimental.chat.messages.transform"](model, out)
      syncBack(pairs)          // writes tags/summaries into the host's own objects
    })
    await ctx.tool.transform((editor) => editor.add({ name: "compact_chunk", input: {…JSON Schema…}, execute }))
    return () => {}
  },
})
```

Shape translation (verified on 2.2.7):

| | V1 | V2 |
|---|---|---|
| message | `{info, parts}` | `{role, content:[…]}` |
| text part | `part.text` | `{type:"text", text}` |
| tool output | `part.state.output` | `{type:"tool-result", name, result:{type:"text", value}}` |
| tool name | `bash` | `shell` |
| model | message info | `event.model {id, providerID}` |

`toV1Messages` builds V1-shaped objects plus a pair list; `syncBack` copies `text` / `state.output`
back into the *same* V2 objects the host holds. Nothing is re-created, so the host's own references
stay valid.

`tool()` is shimmed locally (`schemaNode`) because V2 has no zod builder; only `.describe()` and
`.optional()` are needed.

---

## 5. Hook pipeline

| hook | when | what happens |
|---|---|---|
| `experimental.chat.system.transform` | before each request | tags `[S1 \| system \| raw]`, appends policy text once |
| `experimental.chat.messages.transform` | before each request | builds chunks, flags them, swaps bodies for summaries, writes stats |
| `experimental.text.complete` | per text output | strips tags that leaked into prose |

`messages.transform` is the engine: it sees the whole conversation, so it can measure context size,
choose the tier, and rewrite any part.

---

## 6. Chunk model

A chunk is one message part (a tool result or an assistant text block).

```js
{ step, kind, role, tool, id, input, bytes, outBytes, tok, compressible, required }
```

- `compressible` — kind is tool/text, it has output, and it is not ignored.
- `required` — compressible and `tok >= toolThresholds[tool] ?? thresholdTokens`.
- `step` — display key (`2.1`).

Per-session registry:

```js
st.reg       Map<partId, { key, first, kind, tool, outBytes, tok, compressible, flagged }>
st.replaced  Map<partId, { summary, wasChars, key, reason }>
```

`flagged` is **sticky**. Only a successful `compact_chunk` clears it, which is what lets a chunk be
compacted many requests later.

---

## 7. Tagging rules

```
if (replaced)                          -> [key | kind | was -> now | COMPACTED]
else if (flagged && ctx >= mandatory)  -> [key | kind | size | tok | !COMPACT]
else if (flagged)                      -> [key | kind | size | tok | ?COMPACT]
else                                   -> raw body, no header
```

`ctxTok` is the sum of every chunk's token count for that request — an approximation of the real
context (no system prompt, no tool schemas), but monotonic with it, which is all the tier split needs.
Because the tag is recomputed each request, a `?COMPACT` hardens into `!COMPACT` by itself.

Token marks: `9800tok` exact, `≈9800tok` proxy tokenizer, `~9800tok` estimate.

---

## 8. Token counting

```js
var FAMILIES = [{ id, file, re, proxy }]   // matched against model id, first wins
var SPECIFIC = [{ id, file, dir, re }]     // pinned build, checked first
```

Resolution: `SPECIFIC` → `FAMILIES` → generic estimate.

- DeepSeek V4.1 Flash is pinned to `~/.config/opencode/chunkchomp/tokenizer.json`.
- `ensureEncoder` loads `tok/<file>` lazily, keeps **one** encoder, keyed `s:<id>` / `g:<id>`.
- Counts are cached by `slot|partId|length`, so only new chunks are encoded.
- Fallback table `CAL[family] = [prose, code, json, cjk, minor, words]` in chars/token; `minor` uses a
  run formula (`len/8 + lines*1.5`).

Accuracy was checked against the Rust reference for every shipped family: 0 mismatches on 8 content
types. Estimates land within ~±10% on prose and logs, worse on pathological repeats.

---

## 9. Rust sidecar

`engine/` builds `chunkchomp-engine.exe` (2.95 MB) with the real `tokenizers` crate. Protocol is
line-delimited JSON on stdio:

```json
→ {"op":"count","family":"deepseek-v41","file":"…","texts":["a","b"]}
← {"tokens":[9800,12],"load_ms":158,"encode_ms":1}
→ {"op":"ping"}
→ {"op":"bench","family":"…","file":"…","text":"…","n":50}
```

Measured against the JS path, same tokenizer and text:

| | JS | Rust |
|---|---|---|
| load | 212 ms | 158 ms |
| RSS for the vocabulary | +104 MB (host) | 35.8 MB (own process) |
| encode 60 KB | ~5 ms | ~7 ms |
| effect on host RSS | +104 MB | 0 |

The win is memory and isolation, not throughput. The plugin spawns it once, serialises requests
through a promise queue, times out after 4 s and marks it dead, and `unref`s the child so it can
never keep OpenCode alive.

`engine = auto | rust | js`; `enginePath` overrides discovery (`<plugin>/engine.exe`, then
`~/.config/opencode/chunkchomp/engine.exe`).

---

## 10. Config

`chunkchomp.txt`, parsed line by line: `#` comments, blank lines ignored, `key = value`. Lists are
comma separated and trimmed; numbers accepted only if finite. Cached by mtime, so saving applies on
the next request. `CHUNKCHOMP_CONFIG` overrides the path (used by the harnesses).

---

## 11. Stats and logging

Three surfaces, all fed from the same in-memory counters:

| surface | content |
|---|---|
| `live.log` | one line per request: `sid, model, tok, fam, enc, ctx, mode, d, chunks, fresh, flagged, applied, stripped` |
| `stats.json` | totals, mandatory/optional split, `byModel` `{transforms, flagged, compacted, bytesSaved, tokensSaved}`, `byTool` `{seen, flagged, compacted, bytes, tokens}`, `byDay`, `rejections` |
| `chunkchomp-status.txt` | human table next to `opencode.json`, written at most every 3 s with a trailing flush, forced on compaction |

`byTool` counts only chunks **new in that request**; without that, a chunk still present on later
requests inflates the numbers and the per-tool flag sum stops matching the global counter.

---

## 12. Installer

`install.bat` (batch TUI) and `install.mjs` (Node, compiled to `.exe`) do the same:

1. detect `opencode --version` → pick the 1.x or 2.x entry
2. choose target: opencode plugins dir, or a custom folder
3. choose shortcut: Desktop, next to the plugin, or none
4. threshold, mandatory limit, model filter
5. tokenizers: all 18 / DeepSeek pinned only / none
6. write `index.js`, `chunkchomp.txt`, example, `tools/`, `engine.exe`, `INSTRUCTIONS_FOR_INSTALLATION.md`

The `.exe` embeds the plugin sources, config template, tools, instructions and the engine binary via
a generated `globalThis.__CHUNKCHOMP_FILES__` map, because a compiled binary cannot read the repo.

---

## 13. Testing

```powershell
node --check src/chunkchomp.v1.js
node --check src/chunkchomp.v2.js
bun <plugin>/semantics.mjs        # flagging, ignores, sticky flags, compaction, re-render
```

Isolated OpenCode 2 test (never touches the real install):

```powershell
$V = "$env:TEMP\oc-v2"; npm install --prefix $V "@opencode/cli-windows-x64@2.2.7"
$H = "$V\home"; $C = "$H\.config\opencode"
# plugin at $C\plugins\chunkchomp\{index.js,package.json}, config at $C\opencode.json
$env:HOME=$H; $env:USERPROFILE=$H; $env:XDG_CONFIG_HOME="$H\.config"; $env:XDG_DATA_HOME="$H\.local\share"
& "$V\node_modules\@opencode\cli-windows-x64\bin\opencode.exe" run --standalone "…" -m opencode/glm-5.3-flash-free
```

Full procedure, expected values and the replacement proof are in `docs/VERIFY.md`.

---

## 14. Release

```bash
node --check src/chunkchomp.v1.js && node --check src/chunkchomp.v2.js
node build-exe.mjs                       # dist/chunkchomp-install.exe (~98 MB)
git add -A && git commit -m "chunkchomp X.Y.Z"
git tag -a vX.Y.Z -m "chunkchomp X.Y.Z"
git push origin main --tags
gh release create vX.Y.Z dist/chunkchomp-install.exe --title "chunkchomp X.Y.Z"
```

The exe embeds the sources; a stale binary ships old code. Always rebuild after touching `src/`,
`tools/`, the config template, the instructions or the engine.

---

## 15. Contribution rules

- **One symbol per 1.x entry.** No helper exports.
- **Change both entries together.** Same commit, both harnesses re-run.
- **Never claim exact counts without a reference run.**
- Estimates keep `~`, proxies keep `≈`; only real tokenizer output gets a bare number.
- **Never test V2 in the user's environment.** Isolated home, `--standalone`, delete the copied
  `auth.json` afterwards.
