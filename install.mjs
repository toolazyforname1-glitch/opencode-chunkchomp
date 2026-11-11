import { createInterface } from "readline/promises"
import { stdin, stdout, argv } from "process"
import { mkdirSync, copyFileSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs"
import { join, dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { homedir } from "os"
import { execSync, execFileSync } from "child_process"

const ROOT = dirname(fileURLToPath(import.meta.url))
const EMBEDDED = globalThis.__CHUNKCHOMP_FILES__ || null
const readText = (rel) => (EMBEDDED ? EMBEDDED[rel] : readFileSync(join(ROOT, rel), "utf-8"))
const writeRel = (dest, rel) => writeFileSync(dest, readText(rel))
const rl = createInterface({ input: stdin, output: stdout })
const ask = async (q, dflt = "") => {
  const a = (await rl.question(dflt ? `${q} [${dflt}]: ` : `${q}: `)).trim()
  return a || dflt
}
const yes = async (q, dflt = "n") => {
  const a = (await ask(q, dflt)).toLowerCase()
  return a === "y" || a === "yes"
}
const flag = (name) => argv.includes(name)
const opt = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}

const TOKENIZERS = [
  ["deepseek-v41", "deepseek-ai/DeepSeek-V4.1-Flash"],
  ["deepseek-v4", "deepseek-ai/DeepSeek-V4-Flash"],
  ["glm", "zai-org/GLM-5.3-Flash"],
  ["ling", "inclusionAI/Ling-3.1-flash"],
  ["ring", "inclusionAI/Ring-1T"],
  ["mimo", "XiaomiMiMo/MiMo-V2.6-Flash-RL"],
  ["minimax", "MiniMaxAI/MiniMax-M3.1-Flash"],
  ["qwen", "Qwen/Qwen3.8-Flash-Next"],
  ["longcat", "meituan-longcat/LongCat-2.0"],
  ["hunyuan", "tencent/Hunyuan-A13B-Instruct"],
  ["seed", "ByteDance-Seed/Seed-OSS-36B-Instruct"],
  ["step", "stepfun-ai/Step-3.5-Flash"],
  ["nemotron", "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF"],
  ["trinity", "arcee-ai/Trinity-Large-Preview"],
  ["inkling", "thinkingmachines/Inkling"],
  ["laguna", "poolside/laguna-s-2.1"],
  ["beam", "reflection/Beam-1.0-501B-A23B"],
  ["gpt", "Xenova/gpt-4o"]
]

let version = ""
try {
  version = execSync("opencode --version", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
} catch {}

function desktopPath() {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"], { encoding: "utf8" }).trim()
  } catch {
    return join(homedir(), "Desktop")
  }
}

function makeShortcut(linkPath, targetPath, workdir) {
  if (process.platform !== "win32" || !existsSync(targetPath))
    return false
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$s = $ws.CreateShortcut('${linkPath}')`,
    `$s.TargetPath = '${targetPath}'`,
    `$s.WorkingDirectory = '${workdir}'`,
    "$s.Description = 'chunkchomp parameters'",
    "$s.Save()"
  ].join("; ")
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const nonInteractive = flag("--non-interactive")
const major = Number(version.split(".")[0]) || 0
const build = opt("--build", major >= 2 ? "2" : "1")
const opencodeRoot = join(homedir(), ".config", "opencode")

let mode = opt("--mode", "")
let shortcutWhere = opt("--shortcut", "")
let threshold = opt("--threshold", "2000")
let mandatory = opt("--mandatory", "150000")
let useTokenizer = opt("--tokenizer", "1")
let models = opt("--models", "")
let customDir = opt("--dir", "")
let tokenizers = flag("--download") ? "all" : opt("--tokenizers", "")

console.log("chunkchomp installer")
console.log("-".repeat(52))
console.log(version ? `opencode ${version} detected, build ${build}` : `opencode not found, build ${build}`)

if (!nonInteractive) {
  console.log("\nWhere should the plugin go?")
  console.log("  [1] opencode config  - ~/.config/opencode/plugins/chunkchomp (auto-loaded)")
  console.log("  [2] custom folder    - raw files into ./chunkchomp, place it anywhere yourself")
  mode = (await ask("Choose", "1")) === "2" ? "custom" : "config"
  if (mode === "custom")
    customDir = await ask("Custom folder", join(process.cwd(), "chunkchomp"))

  console.log("\nWhere should the settings shortcut go?")
  console.log("  [1] Desktop")
  console.log("  [2] next to the plugin")
  console.log("  [3] none")
  const s = await ask("Choose", "2")
  shortcutWhere = s === "1" ? "desktop" : s === "3" ? "none" : "local"

  threshold = await ask("Flag chunks over N tokens", "2000")
  mandatory = await ask("Context size where ?COMPACT becomes !COMPACT", "150000")
  useTokenizer = (await yes("Use real tokenizers?", "y")) ? "1" : "0"
  models = await ask("Restrict to models (comma list, empty = all)", "")
  if (useTokenizer === "1") {
    console.log("\nTokenizers")
    console.log("  [1] all 18 families     ~205 MB, exact counts for every supported model")
    console.log("  [2] DeepSeek V4.1 only  ~6.4 MB, the pinned build, everything else estimates")
    console.log("  [3] none                global calibrated estimates only, no download")
    const t = await ask("Choose", "1")
    tokenizers = t === "2" ? "deepseek" : t === "3" ? "none" : "all"
  } else {
    tokenizers = "none"
  }
} else {
  mode = mode || "config"
  shortcutWhere = shortcutWhere || "local"
  tokenizers = tokenizers || "none"
}

const explicitTarget = opt("--target", "")
const target = explicitTarget
  ? resolve(explicitTarget)
  : mode === "custom"
    ? resolve(customDir || join(process.cwd(), "chunkchomp"))
    : join(opencodeRoot, "plugins", "chunkchomp")

const legacyFile = join(opencodeRoot, "plugins", "chunkchomp.js")
if (!explicitTarget && existsSync(legacyFile))
  console.log(`note: ${legacyFile} already exists; a second copy would double-load. Keep only one.`)

const cfg = [
  "# chunkchomp settings",
  "# Edit, save, done. Re-read on the next request.",
  "",
  "enabled = true",
  `thresholdTokens = ${threshold}`,
  "toolThresholds =",
  "",
  `mandatoryAfterTokens = ${mandatory}`,
  `useTokenizer = ${useTokenizer}`,
  "charsPerToken = 4.24",
  `activeModels = ${models}`,
  "",
  "protectedTools =",
  "ignoreTools =",
  "ignoreToolPrefixes =",
  "ignoreMcpServers =",
  "ignorePathPrefixes =",
  "ignoreCommandPrefixes =",
  ""
].join("\n")

mkdirSync(target, { recursive: true })
writeRel(join(target, "index.js"), build === "2" ? "src/chunkchomp.v2.js" : "src/chunkchomp.v1.js")
writeFileSync(join(target, "chunkchomp.txt"), cfg)
writeRel(join(target, "chunkchomp.example.txt"), "chunkchomp.txt")

mkdirSync(join(target, "tools"), { recursive: true })
for (const f of ["logs.mjs", "ctl.mjs"])
  writeRel(join(target, "tools", f), "tools/" + f)

console.log(`\nplugin: ${target}`)

async function grab(url, dest) {
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(String(res.status))
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

if (tokenizers === "all") {
  const dir = join(opencodeRoot, "chunkchomp", "tok")
  mkdirSync(dir, { recursive: true })
  console.log(`tokenizers -> ${dir}`)
  for (const [id, repo] of TOKENIZERS) {
    try {
      await grab(`https://huggingface.co/${repo}/resolve/main/tokenizer.json`, join(dir, id + ".json"))
      try {
        await grab(`https://huggingface.co/${repo}/resolve/main/tokenizer_config.json`, join(dir, id + ".config.json"))
      } catch {}
      console.log(`  tok/${id}.json`)
    } catch (e) {
      console.log(`  tok/${id}.json FAILED (${e.message})`)
    }
  }
} else if (tokenizers === "deepseek") {
  const dir = join(opencodeRoot, "chunkchomp")
  mkdirSync(dir, { recursive: true })
  console.log(`pinned DeepSeek build -> ${dir}`)
  try {
    await grab("https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/tokenizer.json", join(dir, "tokenizer.json"))
    try {
      await grab("https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/tokenizer_config.json", join(dir, "tokenizer_config.json"))
    } catch {}
    console.log("  tokenizer.json")
  } catch (e) {
    console.log(`  FAILED (${e.message})`)
  }
} else {
  console.log("tokenizers: skipped, counting uses the calibrated estimate")
}

const engineDest = join(target, "engine.exe")
if (EMBEDDED && EMBEDDED["engine.exe"]) {
  writeFileSync(engineDest, Buffer.from(EMBEDDED["engine.exe"], "base64"))
  console.log(`engine: ${engineDest}`)
} else {
  const built = join(ROOT, "engine", "target", "release", "chunkchomp-engine.exe")
  if (existsSync(built)) {
    copyFileSync(built, engineDest)
    console.log(`engine: ${engineDest}`)
  }
}

const instr = join(target, "INSTRUCTIONS_FOR_INSTALLATION.md")
writeRel(instr, "INSTRUCTIONS.template.md")
console.log(`instructions: ${instr}`)

if (shortcutWhere !== "none") {
  const linkDir = shortcutWhere === "desktop" ? desktopPath() : target
  const ok = makeShortcut(join(linkDir, "chunkchomp settings.lnk"), join(target, "chunkchomp.txt"), target)
  console.log(ok ? `shortcut: ${join(linkDir, "chunkchomp settings.lnk")}` : "shortcut: skipped")
}

if (mode === "custom") {
  console.log("\nCustom install. Point OpenCode at it by adding this to opencode.json:")
  console.log(`  "plugins": ["${target.replace(/\\/g, "/")}"]`)
  console.log("Configured local paths must be directories. Restart afterwards.")
} else {
  console.log("\nInstalled into the plugins folder, which OpenCode auto-loads.")
}

console.log("Restart OpenCode to load it. Counts fall back to estimates without tokenizers.")
console.log(`Usage report: ${join(opencodeRoot, "chunkchomp-status.txt")} (written next to opencode.json).`)
rl.close()
