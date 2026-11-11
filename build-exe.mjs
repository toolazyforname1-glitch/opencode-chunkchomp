import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { execFileSync } from "child_process"

const ROOT = dirname(fileURLToPath(import.meta.url))
const DIST = join(ROOT, "dist")
const FILES = [
  "src/chunkchomp.v1.js",
  "src/chunkchomp.v2.js",
  "chunkchomp.txt",
  "tools/logs.mjs",
  "tools/ctl.mjs",
  "INSTRUCTIONS.template.md"
]

mkdirSync(DIST, { recursive: true })

const bundle = {}
for (const rel of FILES)
  bundle[rel] = readFileSync(join(ROOT, rel), "utf-8")

const engineBin = join(ROOT, "engine", "target", "release", "chunkchomp-engine.exe")
if (existsSync(engineBin))
  bundle["engine.exe"] = readFileSync(engineBin).toString("base64")

const embed = join(DIST, "_embed.mjs")
const entry = join(DIST, "_entry.mjs")
writeFileSync(embed, "globalThis.__CHUNKCHOMP_FILES__ = " + JSON.stringify(bundle) + ";\n")
writeFileSync(entry, 'import "./_embed.mjs"\nimport "../install.mjs"\n')

const out = join(DIST, "chunkchomp-install.exe")
try {
  execFileSync("bun", ["build", "--compile", "--minify", entry, "--outfile", out], {
    cwd: ROOT,
    stdio: "inherit"
  })
} finally {
  rmSync(embed, { force: true })
  rmSync(entry, { force: true })
}

if (!existsSync(out)) {
  console.error("build failed: no exe produced")
  process.exit(1)
}
console.log(`built ${out} (${(readFileSync(out).length / 1048576).toFixed(1)} MB)`)
