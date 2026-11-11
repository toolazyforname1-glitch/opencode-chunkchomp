#!/usr/bin/env node
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { homedir } from "os"

const SELF = dirname(fileURLToPath(import.meta.url))
const ROOT = existsSync(join(SELF, "chunkchomp.txt")) ? SELF : dirname(SELF)
const STATS = join(ROOT, "stats.json")
const LOG = [join(ROOT, "live.log"), join(homedir(), ".config", "opencode", "chunkchomp", "live.log")].find((p) => existsSync(p))

const pad = (s, n) => String(s).padEnd(n).slice(0, n)
const num = (n) => Number(n || 0).toLocaleString("en-US")
const mb = (n) => {
  const b = Number(n || 0)
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

if (!existsSync(STATS)) {
  console.log("chunkchomp: no stats yet (stats.json missing).")
  console.log(`looked in: ${STATS}`)
  process.exit(0)
}

let s
try {
  s = JSON.parse(readFileSync(STATS, "utf-8"))
} catch (e) {
  console.log(`chunkchomp: stats.json is unreadable (${e.message})`)
  process.exit(1)
}

const line = "=".repeat(64)
console.log(`chunkchomp stats   since ${s.since ?? "?"}`)
console.log(line)
console.log(`${pad("transforms", 18)}${num(s.transforms).padStart(9)}    mandatory ${num(s.mandatory)}   optional ${num(s.optional)}`)
console.log(`${pad("chunks seen", 18)}${num(s.chunksSeen).padStart(9)}`)
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-")
console.log(`${pad("flagged", 18)}${num(s.flagged).padStart(9)}    ${pct(s.flagged, s.chunksSeen)} of chunks`)
console.log(`${pad("compacted", 18)}${num(s.compacted).padStart(9)}    ${pct(s.compacted, s.flagged)} of flagged`)
console.log(`${pad("bytes saved", 18)}${mb(s.bytesSaved).padStart(9)}`)
console.log(`${pad("tokens saved", 18)}${("~" + num(s.tokensSaved)).padStart(9)}`)
console.log(`${pad("rejections", 18)}${num(s.rejections).padStart(9)}`)

const models = Object.entries(s.byModel ?? {}).sort((a, b) => (b[1].transforms ?? 0) - (a[1].transforms ?? 0)).slice(0, 8)
if (models.length) {
  console.log(`\nmodels`)
  console.log(`${pad("  model", 44)}${"transforms".padStart(11)}${"flagged".padStart(9)}`)
  for (const [m, v] of models)
    console.log(`${pad("  " + m, 44)}${num(v.transforms).padStart(11)}${num(v.flagged).padStart(9)}`)
}

const tools = Object.entries(s.byTool ?? {}).sort((a, b) => (b[1].seen ?? 0) - (a[1].seen ?? 0)).slice(0, 12)
if (tools.length) {
  console.log(`\ntools`)
  console.log(`${pad("  tool", 22)}${"seen".padStart(8)}${"flagged".padStart(9)}${"compacted".padStart(11)}${"bytes".padStart(12)}`)
  for (const [t, v] of tools)
    console.log(`${pad("  " + t, 22)}${num(v.seen).padStart(8)}${num(v.flagged).padStart(9)}${num(v.compacted).padStart(11)}${mb(v.bytes).padStart(12)}`)
}

const days = Object.entries(s.byDay ?? {}).sort().slice(-7)
if (days.length) {
  console.log(`\nlast 7 days`)
  console.log(`${pad("  day", 16)}${"transforms".padStart(11)}${"flagged".padStart(9)}${"compacted".padStart(11)}`)
  for (const [d, v] of days)
    console.log(`${pad("  " + d, 16)}${num(v.transforms).padStart(11)}${num(v.flagged).padStart(9)}${num(v.compacted).padStart(11)}`)
}

if (existsSync(LOG)) {
  const lines = readFileSync(LOG, "utf-8").trim().split("\n").slice(-3)
  console.log(`\nlast activity`)
  for (const l of lines) {
    try {
      const j = JSON.parse(l)
      console.log(`  ${j.t ?? ""} ${j.model ?? j.sid ?? ""} ctx=${j.ctx ?? "?"} mode=${j.mode ?? "?"} flagged=${j.flagged ?? 0} applied=${j.applied ?? 0}`)
    } catch {}
  }
}
console.log("")
