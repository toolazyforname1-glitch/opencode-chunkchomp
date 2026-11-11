#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, rmSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const SELF = dirname(fileURLToPath(import.meta.url))
const DIR = existsSync(join(SELF, "chunkchomp.txt")) ? SELF : dirname(SELF)
const CFG = join(DIR, "chunkchomp.txt")
const STATS = join(DIR, "stats.json")

const [cmd, ...rest] = process.argv.slice(2)

function readCfg() {
  if (!existsSync(CFG)) {
    console.error(`chunkchomp: config not found at ${CFG}`)
    process.exit(1)
  }
  return readFileSync(CFG, "utf-8")
}

function setKey(key, value) {
  const text = readCfg()
  const re = new RegExp(`^${key}[ \\t]*=.*$`, "m")
  const line = `${key} = ${value}`
  const next = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`
  writeFileSync(CFG, next)
  console.log(`chunkchomp: ${key} = ${value}`)
}

function getKey(key) {
  const text = readCfg()
  const m = text.match(new RegExp(`^${key}[ \\t]*=[ \\t]*(.*)$`, "m"))
  return m ? m[1].trim() : ""
}

switch (cmd) {
  case "on":
  case "off":
    setKey("enabled", cmd === "on" ? "true" : "false")
    console.log(`chunkchomp is now ${cmd === "on" ? "ACTIVE" : "DISABLED"} (next request).`)
    break
  case "status": {
    const keys = ["enabled", "thresholdTokens", "mandatoryAfterTokens", "useTokenizer", "activeModels", "protectedTools", "ignorePathPrefixes", "ignoreMcpServers"]
    console.log("chunkchomp status")
    console.log("-".repeat(40))
    for (const k of keys)
      console.log(`${k.padEnd(22)}${getKey(k) || "(empty)"}`)
    console.log(`\nconfig: ${CFG}`)
    console.log(`stats : ${STATS}`)
    break
  }
  case "set":
    if (rest.length < 2) {
      console.error("usage: ctl.mjs set <key> <value>")
      process.exit(1)
    }
    setKey(rest[0], rest.slice(1).join(" "))
    break
  case "get":
    if (!rest[0]) {
      console.error("usage: ctl.mjs get <key>")
      process.exit(1)
    }
    console.log(getKey(rest[0]))
    break
  case "stats-reset":
    try {
      rmSync(STATS, { force: true })
      console.log("chunkchomp: stats.json removed, counters restart at zero.")
    } catch (e) {
      console.error(`chunkchomp: ${e.message}`)
      process.exit(1)
    }
    break
  default:
    console.log(`chunkchomp control

  on                    enable the plugin
  off                   disable the plugin
  status                show the active parameters
  get <key>             read one parameter
  set <key> <value>     change one parameter
  stats-reset           wipe stats.json

config: ${CFG}`)
}
