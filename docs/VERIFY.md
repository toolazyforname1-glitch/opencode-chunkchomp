# VERIFY.md — chunkchomp feature verification

You are an agent verifying an installed copy of **chunkchomp**. No prior context is needed.
Work through the phases in order. Each phase ends with **PASS**/**FAIL** criteria.
Record results and do not leave the system modified: every test uses a throwaway config.

---

## Rules for you, the agent

1. Run the commands exactly. Report the real output, never an assumption.
2. If a check fails, capture the actual value and the "If it fails" hint.
3. Do not edit the user's real `chunkchomp.txt`. The harness uses a temp config via `CHUNKCHOMP_CONFIG`.
4. One test writes the real status file (`~/.config/opencode/chunkchomp-status.txt`). That is expected; the running plugin rewrites it on the next request.
5. Finish with the report template in Phase E.

## Paths

| thing | path |
|---|---|
| config root | `%USERPROFILE%\.config\opencode` |
| server plugin (single file install) | `…\opencode\plugins\chunkchomp.js` |
| server plugin (directory install) | `…\opencode\plugins\chunkchomp\index.js` |
| config | same folder as the entry, or `…\plugins\chunkchomp.txt` |
| tokenizers | `<plugin dir>\tok\*.json` |
| runtime stats | `<plugin dir>\stats.json` |
| status report | `…\opencode\chunkchomp-status.txt` |
| event log | `…\opencode\chunkchomp\live.log` |

OpenCode **2.x** loads the entry that starts with `export default Plugin.define`. OpenCode **1.x** loads
`export { ChunkChomp }`. Both carry the same engine.

---

## Phase A — installation and static shape

```powershell
$O = "$env:USERPROFILE\.config\opencode"
Get-ChildItem "$O\plugins" -Recurse -File | Select-Object FullName,Length
Get-Content "$O\plugins\chunkchomp.txt" -TotalCount 20
```

**Expected**
- Exactly one server entry: `plugins\chunkchomp.js` **or** `plugins\chunkchomp\index.js`. Two of them means a duplicate load — FAIL.
- `chunkchomp.txt` exists with `thresholdTokens`, `mandatoryAfterTokens`, `useTokenizer`, and the `ignore*` keys.

Then check the entry matches its OpenCode major:

```powershell
$E = if (Test-Path "$O\plugins\chunkchomp.js") { "$O\plugins\chunkchomp.js" } else { "$O\plugins\chunkchomp\index.js" }
Select-String -Path $E -Pattern "Plugin.define|export \{ ChunkChomp \}|export default"
```

| build | must show |
|---|---|
| V2 (2.x) | `export default Plugin.define` and **no** `export { ChunkChomp }` |
| V1 (1.x) | `export { ChunkChomp }` |

```powershell
# a V2 entry must not import the 1.x SDK; count must be 0
(Select-String -Path $E -Pattern '^import \{ tool \} from "@opencode-ai/plugin"').Count
```

**PASS**: one entry, config present, export matches the runtime, and the count is `0` on V2.

**If it fails**: two entries → delete the stale one. Wrong export → wrong build installed (rerun the installer with `--build 1|2`).

---

## Phase B — tokenizer files

```powershell
$T = Join-Path (Split-Path $E) "tok"
Get-ChildItem $T -Filter *.json -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch 'config' } |
  Select-Object Name,Length | Sort-Object Name
```

**Expected**: up to 18 files (`deepseek-v41`, `deepseek-v4`, `glm`, `ling`, `ring`, `mimo`, `minimax`,
`qwen`, `longcat`, `hunyuan`, `seed`, `step`, `nemotron`, `trinity`, `inkling`, `laguna`, `beam`, `gpt`),
each a few MB. Missing files are not fatal — counting falls back to an estimate and tags show `~`.

---

## Phase C — behaviour harness (deterministic, no model calls)

Save this as `verify.mjs` in the plugin directory and run it with `node`:

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { homedir } from "os"
import { pathToFileURL } from "url"

const HOME = homedir()
const OC = join(HOME, ".config", "opencode")
const ENTRY = [join(OC, "plugins", "chunkchomp.js"), join(OC, "plugins", "chunkchomp", "index.js")].find(existsSync)
if (!ENTRY) { console.log("FAIL entry: no chunkchomp entry found"); process.exit(1) }
const PLUG = dirname(ENTRY)
const TMP = join(PLUG, "verify-tmp")
mkdirSync(TMP, { recursive: true })
const CFG = join(TMP, "chunkchomp.txt")

const base = {
  enabled: "true",
  thresholdTokens: "800",
  toolThresholds: "",
  mandatoryAfterTokens: "1000000",
  useTokenizer: "false",
  charsPerToken: "4.24",
  activeModels: "",
  protectedTools: "",
  ignoreTools: "ignoreme",
  ignoreToolPrefixes: "pref_",
  ignoreMcpServers: "exa",
  ignorePathPrefixes: String.raw`C:\secret`,
  ignoreCommandPrefixes: "git push"
}
async function writeCfg(over) {
  const cfg = { ...base, ...over }
  writeFileSync(CFG, Object.entries(cfg).map(([k, v]) => `${k} = ${v}`).join("\n") + "\n")
  await new Promise((r) => setTimeout(r, 25))
}
await writeCfg({})
process.env.CHUNKCHOMP_CONFIG = CFG

const { ChunkChomp } = await import(pathToFileURL(ENTRY).href)
const plugin = await ChunkChomp()
const sys = plugin["experimental.chat.system.transform"]
const msgs = plugin["experimental.chat.messages.transform"]
const compact = plugin.tool.compact_chunk

const BIG = ("line " + "x".repeat(80) + "\n").repeat(400)
const tool = (id, name, output, input) => ({ type: "tool", id, tool: name, state: { status: "completed", input: input ?? {}, output } })
function conv(sid, parts) {
  return [
    { info: { id: sid + "-u", role: "user", sessionID: sid, model: { providerID: "opencode", modelID: "glm-5.3-flash-free" } }, parts: [{ type: "text", id: sid + "-t", text: "go" }] },
    { info: { id: sid + "-a", role: "assistant", sessionID: sid, providerID: "opencode", modelID: "glm-5.3-flash-free" }, parts: [{ type: "step-start", id: sid + "-s" }, ...parts, { type: "step-finish", id: sid + "-e" }] }
  ]
}
const head = (p) => (p.state.output.startsWith("[") ? p.state.output.split("\n")[0] : "RAW")
let pass = 0, fail = 0
function check(name, cond, actual) {
  if (cond) { pass++; console.log("PASS  " + name) }
  else { fail++; console.log("FAIL  " + name + "  ->  " + actual) }
}

// 1 flag over threshold
let sid = "v1-" + Date.now()
let c = conv(sid, [tool(sid + "-a1", "bash", BIG, { command: "cat log" })])
await msgs({}, { messages: c })
const h1 = head(c[1].parts[1])
check("flags oversized output", h1.includes("?COMPACT"), h1)

// 2 under threshold
sid = "v2-" + Date.now()
c = conv(sid, [tool(sid + "-a1", "bash", "ok", { command: "true" })])
await msgs({}, { messages: c })
check("leaves small output raw", head(c[1].parts[1]) === "RAW", head(c[1].parts[1]))

// 3 ignorePathPrefixes
sid = "v3-" + Date.now()
c = conv(sid, [tool(sid + "-a1", "read", BIG, { filePath: String.raw`C:\secret\x.txt` })])
await msgs({}, { messages: c })
check("ignorePathPrefixes", head(c[1].parts[1]) === "RAW", head(c[1].parts[1]))

// 4 ignoreMcpServers
sid = "v4-" + Date.now()
c = conv(sid, [tool(sid + "-a1", "exa_web_search_exa", BIG, { query: "x" })])
await msgs({}, { messages: c })
check("ignoreMcpServers", head(c[1].parts[1]) === "RAW", head(c[1].parts[1]))

// 5 ignoreCommandPrefixes
sid = "v5-" + Date.now()
c = conv(sid, [tool(sid + "-a1", "bash", BIG, { command: "git push origin main" })])
await msgs({}, { messages: c })
check("ignoreCommandPrefixes", head(c[1].parts[1]) === "RAW", head(c[1].parts[1]))

// 6 ignoreTools / ignoreToolPrefixes
sid = "v6-" + Date.now()
c = conv(sid, [tool(sid + "-a1", "ignoreme", BIG, {}), tool(sid + "-a2", "pref_x", BIG, {})])
await msgs({}, { messages: c })
check("ignoreTools + ignoreToolPrefixes", head(c[1].parts[1]) === "RAW" && head(c[1].parts[2]) === "RAW", head(c[1].parts[1]) + " / " + head(c[1].parts[2]))

// 7 sticky flag on the next request
sid = "v7-" + Date.now()
c = conv(sid, [tool(sid + "-a1", "bash", BIG, { command: "cat log" })])
await msgs({}, { messages: c })
const before = head(c[1].parts[1])
await msgs({}, { messages: c })
const after = head(c[1].parts[1])
check("flag stays on later requests", before.includes("?COMPACT") && after.includes("?COMPACT"), before + " -> " + after)

// 8 compact from a later request + COMPACTED render
const key = after.split("|")[0].replace("[", "").trim()
const r = await compact.execute({ chunk_id: key, summary: "- a\n- b\n- c" }, { sessionID: sid })
await msgs({}, { messages: c })
check("compacts from a later request", r.startsWith("OK chunk"), r)
check("renders COMPACTED", head(c[1].parts[1]).includes("COMPACTED"), head(c[1].parts[1]))

// 9 no summary cap
sid = "v9-" + Date.now()
c = conv(sid, [tool(sid + "-a1", "bash", BIG, { command: "cat log" })])
await msgs({}, { messages: c })
const k2 = head(c[1].parts[1]).split("|")[0].replace("[", "").trim()
const long = "- " + "detail ".repeat(600)
const r2 = await compact.execute({ chunk_id: k2, summary: long }, { sessionID: sid })
check("accepts a " + long.length + "-char summary", r2.startsWith("OK chunk"), r2)

// 10 mandatory tier
await writeCfg({ mandatoryAfterTokens: "1" })
sid = "v10-" + Date.now()
c = conv(sid, [tool(sid + "-a1", "bash", BIG, { command: "cat log" })])
await msgs({}, { messages: c })
check("mandatory tier above the limit", head(c[1].parts[1]).includes("!COMPACT"), head(c[1].parts[1]))

// 11 stats + status file
const stats = JSON.parse(readFileSync(join(TMP, "stats.json"), "utf-8"))
check("stats: transforms counted", stats.transforms >= 10, JSON.stringify(stats.transforms))
check("stats: per-tool buckets", Object.keys(stats.byTool || {}).length > 0, Object.keys(stats.byTool || {}).join(","))
check("stats: per-model buckets", Object.keys(stats.byModel || {}).length > 0, Object.keys(stats.byModel || {}).join(","))
const statusFile = join(OC, "chunkchomp-status.txt")
check("status file written", existsSync(statusFile), statusFile)
if (existsSync(statusFile)) {
  const s = readFileSync(statusFile, "utf-8")
  check("status file has the counters", s.includes("transforms") && s.includes("flagged"), s.split("\n")[0])
}

// 12 system policy mentions both tiers
const out = { system: ["base"] }
await sys({}, out)
const pol = out.system.join("\n")
check("policy explains !COMPACT and ?COMPACT", pol.includes("!COMPACT") && pol.includes("?COMPACT"), pol.slice(0, 120))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
```

Run it:

```powershell
cd "$env:USERPROFILE\.config\opencode\plugins"
node verify.mjs
```

**Expected**: every line `PASS`, final `N passed, 0 failed`, exit code 0.

| failure | meaning |
|---|---|
| `FAIL flags oversized output` | threshold/tokenizer path broken, or the entry did not load |
| `FAIL ignorePathPrefixes` or `ignoreMcpServers` | ignore parsing broken (`[ \t]` regex or list split) |
| `FAIL flag stays on later requests` | `flagged` is not sticky — re-flagging logic broken |
| `FAIL compacts from a later request` | the age check came back; flags must never expire |
| `FAIL accepts a N-char summary` | a summary cap was reintroduced |
| `FAIL mandatory tier` | `mandatoryAfterTokens` ignored |
| `FAIL stats: …` | `dirname` import missing, or the try/catch swallowed an error |
| `FAIL status file written` | `writeStatus` never ran |

---

## Phase D — live checks inside the running session

The harness proves the engine. These prove the wiring in a real request.

1. Ask the model for one normal answer on any model, then:

```powershell
$O = "$env:USERPROFILE\.config\opencode"
Get-Content "$O\chunkchomp-status.txt" -TotalCount 12
Get-Content "$O\chunkchomp\live.log" -Tail 2
```

**Expected in `live.log`**, one JSON object per request:

```json
{"sid":"ses_…","model":"opencode/glm-5.3-flash-free","tok":"exact","fam":"g:glm",
 "enc":397,"ctx":4821,"mode":"optional","d":3,"chunks":88,"fresh":1,
 "flagged":0,"applied":0,"stripped":0}
```

| field | PASS when |
|---|---|
| `tok` | `exact` for a family with a tokenizer file, `proxy` for gemini/claude/llama/gemma, `heuristic` only when no file exists |
| `fam` | `s:deepseek-v41` on DeepSeek V4.1 Flash, `g:<family>` otherwise, `generic` never for a known family |
| `enc` | 150–400 ms on the first request of a model, `0` afterwards |
| `ctx` | roughly matches the conversation size; drives `mode` |
| `mode` | `optional` normally, `mandatory` once `ctx >= mandatoryAfterTokens` |

2. Force the mandatory tier live: set `mandatoryAfterTokens = 2000` in `chunkchomp.txt`, send one more
   message, confirm `"mode":"mandatory"` and that any new oversized output is tagged `!COMPACT`.
   **Restore the original value afterwards.**

3. Confirm the status file keeps up: after activity stops, its timestamp should be within ~3 s of the last
   request (trailing flush), and `transforms` must never go backwards.

---

## Phase E — installer flags

```powershell
$T = Join-Path $env:TEMP "cc-verify"
Remove-Item $T -Recurse -Force -ErrorAction SilentlyContinue
& "<path to chunkchomp-install.exe>" --non-interactive --target $T --build 2 --tokenizer 0 --shortcut none
Get-ChildItem $T -Recurse -File | Select-Object FullName,Length
```

**Expected**: `index.js`, `chunkchomp.txt`, `chunkchomp.example.txt`, `tools\ctl.mjs`, `tools\logs.mjs`.
`index.js` must start with `export default Plugin.define` when `--build 2`.
The real config directory must be unchanged (compare `Get-ChildItem "$env:USERPROFILE\.config\opencode\plugins"` before/after).

---

## Phase F — OpenCode 2, fully isolated (never touches the real install)

V2 must not be tested in place. Everything below lives under `$env:TEMP` and only child processes see it.

```powershell
$V = "$env:TEMP\oc-v2"; New-Item -ItemType Directory -Force $V | Out-Null
npm install --prefix $V "@opencode/cli-windows-x64@2.2.7"

$H = "$V\home"; $C = "$H\.config\opencode"
New-Item -ItemType Directory -Force "$C\plugins\chunkchomp" | Out-Null
Copy-Item src\chunkchomp.v2.js "$C\plugins\chunkchomp\index.js"
'{"name":"chunkchomp","type":"module","exports":{".":"./index.js"}}' | Set-Content "$C\plugins\chunkchomp\package.json"
'{"$schema":"https://opencode.ai/config.json","plugins":[{"package":"./plugins/chunkchomp"}]}' | Set-Content "$C\opencode.json"
Copy-Item "$env:USERPROFILE\.local\share\opencode\auth.json" "$H\.local\share\opencode\auth.json"
Copy-Item "$env:USERPROFILE\.config\opencode\node_modules\@huggingface" "$C\node_modules\@huggingface" -Recurse

$env:HOME=$H; $env:USERPROFILE=$H; $env:XDG_CONFIG_HOME="$H\.config"; $env:XDG_DATA_HOME="$H\.local\share"
& "$V\node_modules\@opencode\cli-windows-x64\bin\opencode.exe" --version      # expect 2.x
& "$V\node_modules\@opencode\cli-windows-x64\bin\opencode.exe" run --standalone "reply with exactly: ok" -m opencode/deepseek-v4.1-flash-free
Get-Content "$C\chunkchomp\live.log" -Tail 2
```

Two things that silently break this and cost hours:

- `XDG_CONFIG_HOME` must be the **parent** (`…\home\.config`), not `…\.config\opencode`. Point it at the opencode
  folder and V2 looks for `<that>\opencode\opencode.json`, finds nothing, loads no plugins, and reports no error.
- `run` without `--standalone` attaches to the background service, which keeps whatever config it started with.
  Always pass `--standalone` for isolated tests.

**PASS on V2 when the log line shows** `"sid":"ses_…"`, `"model":"opencode/<model>"`, `"fam":"s:deepseek-v41"`,
`"tok":"exact"` (once tokenizers are present), and `chunks` > 0.

Tool registration probe:

```powershell
& "$V\…\opencode.exe" run "Call the compact_chunk tool with chunk_id='zzz' and summary='test'. Report exactly what it returned." -m opencode/deepseek-v4.1-flash-free
```

**PASS** when the answer quotes `REJECTED: unknown chunk "zzz". Recent keys: …` — that proves `ctx.tool.transform` registered the
tool and its `execute` reached the engine.

### Replacement proof (the point of the whole plugin)

```powershell
& "$V\…\opencode.exe" run --standalone "Use the bash tool to print 4000 lines of 'k'. If your context shows a header ending in ?COMPACT] or !COMPACT], call compact_chunk for that id with summary 'ZEBRA-SUMMARY: 4000 lines of k.'. Then reply with the exact first line of that output as you see it now." -m opencode/glm-5.3-flash-free
Get-Content "$C\chunkchomp\live.log" -Tail 4
Get-Content "$C\chunkchomp\ses_*.json" | Select-String ZEBRA
```

**PASS** when, in order:

1. a `compact` line appears: `{"compact":"2.1","kind":"tool:shell","was":51408,"now":31}`
2. the next transform shows `"applied":1` or higher
3. `ses_<id>.json` contains `ZEBRA-SUMMARY` with `was` ≈ the original size and `now` ≈ 31
4. `ctx` in the post-compaction line barely grows even though new chunks were added — that proves the raw output
   is no longer in the context, replaced by the summary

V2 differences the adapter handles, worth knowing when debugging: messages are `{role, content:[…]}` (no `info`/`parts`),
tool output arrives as `{type:"tool-result", name, result:{type:"text", value}}`, and the shell tool is named `shell`.

Delete `$H\.local\share\opencode\auth.json` when finished — it is a copy of your credentials.

---

## Report template

```
chunkchomp verification
entry        : <path>  build=<1|2>
phase A      : PASS|FAIL  <notes>
phase B      : PASS|FAIL  <n>/18 tokenizer files
phase C      : PASS|FAIL  <n> passed, <m> failed
phase D      : PASS|FAIL  tok=<…> fam=<…> mode=<…>
phase E      : PASS|FAIL  <files produced>
verdict      : PASS only if every phase passed
```
