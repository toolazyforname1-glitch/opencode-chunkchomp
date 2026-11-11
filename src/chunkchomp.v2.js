// @bun
// src/chunkchomp.v2.js - OpenCode 2.x entry point.
// The counting/flagging logic below is shared verbatim with the 1.x build;
// only the plugin boundary differs: Plugin.define + ctx.session.hook + ctx.tool.
import { Plugin } from "@opencode/plugin";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { spawn } from "child_process";
import { homedir } from "os";
import { pathToFileURL } from "url";

// OpenCode 2 has no @opencode-ai/plugin, and this file only needs the tiny
// builder surface the compact_chunk definition uses, so shim it locally.
function schemaNode(type) {
  const node = { type };
  node.describe = () => node;
  node.optional = () => node;
  return node;
}
var tool = Object.assign((def) => def, {
  schema: {
    string: () => schemaNode("string")
  }
});

// --- tokenizers (per model family) -------------------------------------------
var TOKDIR = join(homedir(), ".config", "opencode", "chunkchomp", "tok");
var FAMILIES = [
  { id: "deepseek-v41", file: "deepseek-v41.json", re: /deepseek[^a-z0-9]*v?4[._-]?1/i, proxy: false },
  { id: "deepseek-v4", file: "deepseek-v4.json", re: /deepseek/i, proxy: false },
  { id: "glm", file: "glm.json", re: /(^|[^a-z])glm/i, proxy: false },
  { id: "inkling", file: "inkling.json", re: /inkling/i, proxy: false },
  { id: "laguna", file: "laguna.json", re: /laguna/i, proxy: false },
  { id: "beam", file: "beam.json", re: /(^|[^a-z0-9])beam/i, proxy: false },
  { id: "ling", file: "ling.json", re: /(^|[^a-z])ling/i, proxy: false },
  { id: "ring", file: "ring.json", re: /(^|[^a-z0-9])ring([._/-]|$)/i, proxy: false },
  { id: "mimo", file: "mimo.json", re: /(^|[^a-z])mimo/i, proxy: false },
  { id: "minimax", file: "minimax.json", re: /minimax/i, proxy: false },
  { id: "qwen", file: "qwen.json", re: /qwen|qwq|qvq/i, proxy: false },
  { id: "longcat", file: "longcat.json", re: /longcat|long-cat/i, proxy: false },
  { id: "hunyuan", file: "hunyuan.json", re: /hunyuan|(^|[^a-z0-9])hy[0-9]/i, proxy: false },
  { id: "seed", file: "seed.json", re: /seed-oss|bytedance-seed|doubao|(^|[^a-z0-9])seed[._-]/i, proxy: false },
  { id: "step", file: "step.json", re: /stepfun|(^|[^a-z0-9])step[._/-]?[0-9]/i, proxy: false },
  { id: "nemotron", file: "nemotron.json", re: /nemotron/i, proxy: false },
  { id: "trinity", file: "trinity.json", re: /trinity/i, proxy: false },
  { id: "gpt", file: "gpt.json", re: /(^|[^a-z])gpt|chatgpt|codex|(^|[^a-z])o[1-9]/i, proxy: false },
  { id: "gemini", file: "gpt.json", re: /gemini|bard/i, proxy: true },
  { id: "claude", file: "gpt.json", re: /claude|anthropic/i, proxy: true },
  { id: "llama", file: "gpt.json", re: /llama|mistral|mixtral|ministral|codestral|devstral|pixtral/i, proxy: true },
  { id: "gemma", file: "gpt.json", re: /gemma|palm/i, proxy: true }
];
var SPECIFIC = [
  { id: "deepseek-v41", re: /deepseek[^a-z0-9]*v?4[._-]?1/i, file: "tokenizer.json", dir: join(homedir(), ".config", "opencode", "chunkchomp"), proxy: false }
];
function resolveFor(modelID) {
  const id = String(modelID ?? "");
  for (const s of SPECIFIC)
    if (s.re.test(id))
      return { id: s.id, file: s.file, dir: s.dir, proxy: s.proxy, specific: true };
  const fam = familyFor(id);
  return fam ? { id: fam.id, file: fam.file, dir: TOKDIR, proxy: fam.proxy, specific: false } : null;
}
var CAL = {
  // chars per token by content class: prose, code, json, cjk, minor, words
  "deepseek-v41": [4.27, 2.98, 2.17, 1.78, 8, 6.22],
  "deepseek-v4": [4.27, 2.98, 2.17, 1.78, 8, 6.22],
  glm: [4.27, 3.17, 2.04, 1.68, 8, 6.22],
  ling: [4.33, 2.92, 1.65, 1.68, 16, 6.22],
  ring: [4.33, 2.92, 1.65, 1.68, 16, 6.22],
  mimo: [4.27, 3.17, 1.65, 1.45, 8, 6.22],
  minimax: [4.33, 3.17, 2.17, 1.78, 16, 6.22],
  qwen: [4.33, 2.98, 1.65, 1.6, 8, 6.22],
  longcat: [4.27, 3.17, 1.65, 1.6, 8, 6.22],
  hunyuan: [4.27, 3.17, 1.65, 1.45, 8, 6.22],
  seed: [4.27, 2.86, 1.62, 1.45, 8, 6.22],
  inkling: [4.27, 3.17, 2.27, 1.45, 8, 6.22],
  laguna: [4.22, 2.98, 1.67, 1.33, 16, 6.22],
  beam: [4.27, 3.17, 1.65, 1.45, 8, 6.22],
  step: [4.27, 2.98, 2.17, 1.78, 8, 6.22],
  nemotron: [4.27, 3.17, 2.17, 1.45, 8, 6.22],
  trinity: [4.44, 3.17, 2.27, 1.68, 32, 6.59],
  gpt: [4.27, 3.17, 2.27, 1.45, 8, 6.22],
  gemini: [4.27, 3.17, 2.27, 1.45, 8, 6.22],
  claude: [4.27, 3.17, 2.27, 1.45, 8, 6.22],
  llama: [4.27, 3.17, 2.27, 1.45, 8, 6.22],
  gemma: [4.27, 3.17, 2.27, 1.45, 8, 6.22]
};
var CAL_GENERIC = [4.29, 3.07, 1.97, 1.65, 7, 6.22];
var ENC = null;
var ENC_FAMILY = null;
var ENC_KIND = "heuristic";
var ENC_ERR = "";
var ENC_MS = 0;
var LIB = null;
var STATS = null;
function statObj(parent, key) {
  if (!parent[key])
    parent[key] = { seen: 0, flagged: 0, compacted: 0, bytes: 0, tokens: 0 };
  return parent[key];
}
function stats() {
  if (STATS)
    return STATS;
  const p = join(dirname(CONFIG_PATH), "stats.json");
  try {
    STATS = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    STATS = null;
  }
  if (!STATS)
    STATS = { since: new Date().toISOString(), transforms: 0, chunksSeen: 0, flagged: 0, compacted: 0, bytesSaved: 0, tokensSaved: 0, mandatory: 0, optional: 0, rejections: 0, byModel: {}, byTool: {}, byDay: {} };
  if (!STATS.byModel) STATS.byModel = {};
  if (!STATS.byTool) STATS.byTool = {};
  if (!STATS.byDay) STATS.byDay = {};
  return STATS;
}
function statsFlush() {
  try {
    writeFileSync(join(dirname(CONFIG_PATH), "stats.json"), JSON.stringify(STATS));
  } catch {}
}
var STATUS_PATH = join(homedir(), ".config", "opencode", "chunkchomp-status.txt");
var LAST_STATUS = 0;
var STATUS_TIMER = null;
function writeStatus(cfg, force) {
  const now = Date.now();
  const wait = 3000 - (now - LAST_STATUS);
  if (!force && wait > 0) {
    if (!STATUS_TIMER) {
      STATUS_TIMER = setTimeout(() => {
        STATUS_TIMER = null;
        writeStatus(cfg, true);
      }, wait);
      if (typeof STATUS_TIMER?.unref === "function")
        STATUS_TIMER.unref();
    }
    return;
  }
  LAST_STATUS = now;
  try {
    const s = stats();
    const kb = (n) => {
      const b = Number(n || 0);
      if (b < 1024) return b + " B";
      if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
      return (b / 1048576).toFixed(1) + " MB";
    };
    const pad = (v, n) => String(v).padEnd(n);
    const pct = (a, b2) => (b2 ? ((a / b2) * 100).toFixed(1) + "%" : "-");
    const l = [];
    l.push("chunkchomp - " + new Date().toISOString());
    l.push("=".repeat(58));
    l.push(pad("enabled", 18) + cfg.enabled);
    l.push(pad("thresholdTokens", 18) + cfg.thresholdTokens);
    l.push(pad("mandatoryAfter", 18) + cfg.mandatoryAfterTokens);
    l.push(pad("counting", 18) + (cfg.useTokenizer ? (ENC_KIND + " (" + (ENC_FAMILY ?? "generic") + ")") : "estimate"));
    l.push("");
    l.push(pad("transforms", 18) + s.transforms + "   mandatory " + s.mandatory + " / optional " + s.optional);
    l.push(pad("chunks seen", 18) + s.chunksSeen);
    l.push(pad("flagged", 18) + s.flagged + "   " + pct(s.flagged, s.chunksSeen) + " of chunks");
    l.push(pad("compacted", 18) + s.compacted + "   " + pct(s.compacted, s.flagged) + " of flagged");
    l.push(pad("bytes saved", 18) + kb(s.bytesSaved));
    l.push(pad("tokens saved", 18) + "~" + s.tokensSaved);
    l.push(pad("rejections", 18) + s.rejections);
    const models = Object.entries(s.byModel || {}).sort((a, b2) => (b2[1].transforms || 0) - (a[1].transforms || 0)).slice(0, 8);
    if (models.length) {
      l.push("");
      l.push("models");
      for (const [m, v] of models)
        l.push("  " + pad(m, 40) + String(v.transforms || 0).padStart(7) + " tx  " + String(v.flagged || 0).padStart(6) + " flagged");
    }
    const tools = Object.entries(s.byTool || {}).sort((a, b2) => (b2[1].seen || 0) - (a[1].seen || 0)).slice(0, 12);
    if (tools.length) {
      l.push("");
      l.push("tools");
      l.push("  " + pad("tool", 22) + pad("seen", 9) + pad("flagged", 9) + pad("compacted", 11) + "bytes");
      for (const [t, v] of tools)
        l.push("  " + pad(t, 22) + pad(v.seen || 0, 9) + pad(v.flagged || 0, 9) + pad(v.compacted || 0, 11) + kb(v.bytes));
    }
    writeFileSync(STATUS_PATH, l.join("\n") + "\n");
  } catch {}
}
function reject(msg) {
  const S = stats();
  S.rejections++;
  statsFlush();
  return msg;
}
var TOKCACHE = new Map;
var RUST = null, RUST_DEAD = false, RUST_BUF = "", RUST_PENDING = null;
var RUST_Q = Promise.resolve();
function engineFile(cfg) {
  if (cfg.enginePath)
    return cfg.enginePath;
  const a = join(dirname(CONFIG_PATH), "engine.exe");
  const b = join(homedir(), ".config", "opencode", "chunkchomp", "engine.exe");
  return existsSync(a) ? a : b;
}
function rustSpawn(cfg) {
  if (RUST || RUST_DEAD)
    return RUST;
  const file = engineFile(cfg);
  if (!existsSync(file)) {
    RUST_DEAD = true;
    return null;
  }
  try {
    RUST = spawn(file, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    try {
      RUST.unref();
      RUST.stdin.unref?.();
      RUST.stdout.unref?.();
    } catch {}
    RUST.on("error", () => {
      RUST = null;
      RUST_DEAD = true;
    });
    RUST.on("exit", () => {
      RUST = null;
    });
    RUST.stdout.setEncoding("utf8");
    RUST.stdout.on("data", (chunk) => {
      RUST_BUF += chunk;
      let i = RUST_BUF.indexOf("\n");
      while (i >= 0) {
        const line = RUST_BUF.slice(0, i);
        RUST_BUF = RUST_BUF.slice(i + 1);
        const p = RUST_PENDING;
        RUST_PENDING = null;
        if (p) {
          try {
            p(JSON.parse(line));
          } catch {
            p(null);
          }
        }
        i = RUST_BUF.indexOf("\n");
      }
    });
  } catch {
    RUST = null;
    RUST_DEAD = true;
  }
  return RUST;
}
function rustCall(cfg, payload) {
  return new Promise((resolve) => {
    if (cfg.engine === "js" || !rustSpawn(cfg))
      return resolve(null);
    try {
      RUST_PENDING = resolve;
      RUST.stdin.write(JSON.stringify(payload) + "\n");
      const t = setTimeout(() => {
        if (RUST_PENDING === resolve) {
          RUST_PENDING = null;
          RUST_DEAD = true;
          try {
            RUST?.kill();
          } catch {}
          RUST = null;
          resolve(null);
        }
      }, 4000);
      if (typeof t?.unref === "function")
        t.unref();
    } catch {
      RUST_DEAD = true;
      resolve(null);
    }
  });
}
function rustCount(cfg, family, file, texts) {
  const run = () => rustCall(cfg, { op: "count", family, file, texts });
  const p = RUST_Q.then(run, run);
  RUST_Q = p.then(() => null, () => null);
  return p;
}
async function lib() {
  if (LIB)
    return LIB;
  try {
    LIB = await import("@huggingface/tokenizers");
  } catch {
    const p = join(homedir(), ".config", "opencode", "node_modules", "@huggingface", "tokenizers", "dist", "tokenizers.mjs");
    LIB = await import(pathToFileURL(p).href);
  }
  return LIB;
}
function familyFor(modelID) {
  const id = String(modelID ?? "");
  for (const f of FAMILIES)
    if (f.re.test(id))
      return f;
  return null;
}
async function ensureEncoder(modelID) {
  const fam = resolveFor(modelID);
  if (!fam) {
    ENC = null;
    ENC_FAMILY = null;
    ENC_KIND = "heuristic";
    return null;
  }
  const slot = (fam.specific ? "s:" : "g:") + fam.id;
  if (ENC_FAMILY === slot)
    return ENC;
  const file = join(fam.dir, fam.file);
  ENC_FAMILY = slot;
  if (!existsSync(file)) {
    ENC = null;
    ENC_KIND = "heuristic";
    ENC_ERR = "missing:" + slot;
    return null;
  }
  try {
    const mod = await lib();
    const Tokenizer = mod?.Tokenizer ?? mod?.default?.Tokenizer ?? mod?.default;
    if (typeof Tokenizer !== "function")
      throw new Error("Tokenizer export not found");
    const t0 = Date.now();
    const json = JSON.parse(readFileSync(file, "utf-8"));
    let tcfg = {};
    try {
      const cfgFile = fam.specific ? join(fam.dir, "tokenizer_config.json") : join(fam.dir, fam.id + ".config.json");
      tcfg = JSON.parse(readFileSync(cfgFile, "utf-8"));
    } catch {}
    const enc = new Tokenizer(json, tcfg);
    enc.encode("warmup", { add_special_tokens: false });
    ENC = enc;
    ENC_KIND = fam.proxy ? "proxy" : "exact";
    ENC_ERR = "";
    ENC_MS = Date.now() - t0;
  } catch (e) {
    ENC = null;
    ENC_KIND = "heuristic";
    ENC_ERR = String(e && e.message ? e.message : e);
  }
  return ENC;
}
function longestRun(s) {
  let best = 0, run = 1;
  for (let i = 1;i < s.length; i++) {
    if (s.charCodeAt(i) === s.charCodeAt(i - 1)) {
      run++;
      if (run > best)
        best = run;
    } else
      run = 1;
  }
  return best;
}
function contentClass(s) {
  const n = s.length || 1;
  const cjk = (s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) || []).length;
  if (cjk / n >= 0.15)
    return 3;
  const structured = (s.match(/[{}[\]":,]/g) || []).length;
  if (structured / n >= 0.12)
    return 2;
  const spaces = (s.match(/[ \t]/g) || []).length;
  if (spaces / n <= 0.02 || longestRun(s) >= 64)
    return 4;
  const punct = (s.match(/[^A-Za-z0-9\s]/g) || []).length;
  if (punct / n >= 0.1)
    return 1;
  const gaps = (s.match(/[ \t]+/g) || []).length + 1;
  if (punct / n < 0.02 && (n - spaces) / gaps >= 6)
    return 5;
  return 0;
}
function estimateTokens(s, famId, baseCharsPerToken) {
  const row = CAL[famId] ?? CAL_GENERIC;
  const scale = baseCharsPerToken ? baseCharsPerToken / 4.24 : 1;
  const cls = contentClass(s);
  if (cls === 4) {
    const lines = (s.match(/\n/g) || []).length + 1;
    return Math.max(1, Math.round(s.length / 8 + lines * 1.5));
  }
  return Math.max(1, Math.round(s.length / (row[cls] * scale)));
}
async function countTokens(text, modelID, cacheKey, baseCharsPerToken, cfg) {
  const s = text ?? "";
  if (!s)
    return 0;
  const fam = resolveFor(modelID);
  const slot = fam ? (fam.specific ? "s:" : "g:") + fam.id : "generic";
  const famId = fam ? fam.id : "generic";
  const key = cacheKey ? slot + "|" + cacheKey : null;
  if (key) {
    const hit = TOKCACHE.get(key);
    if (hit && hit.len === s.length && hit.kind === ENC_KIND)
      return hit.tok;
  }
  let n = null;
  if (cfg && cfg.engine !== "js" && fam) {
    const r = await rustCount(cfg, fam.id, join(fam.dir, fam.file), [s]);
    if (r && Array.isArray(r.tokens) && typeof r.tokens[0] === "number" && r.tokens[0] > 0) {
      n = r.tokens[0];
      ENC_KIND = "exact";
    }
  }
  if (n == null && cfg && cfg.useTokenizer) {
    try {
      await ensureEncoder(modelID);
    } catch {}
  }
  if (n == null && ENC && ENC_FAMILY === slot) {
    try {
      n = ENC.encode(s, { add_special_tokens: false }).ids.length;
    } catch {
      n = null;
    }
  }
  if (n == null)
    n = estimateTokens(s, famId, baseCharsPerToken);
  if (key) {
    TOKCACHE.set(key, { len: s.length, tok: n, kind: ENC_KIND });
    if (TOKCACHE.size > 2000)
      TOKCACHE.delete(TOKCACHE.keys().next().value);
  }
  return n;
}
function pathStrings(input) {
  const out = [];
  if (!input || typeof input !== "object")
    return out;
  const push = (v) => {
    if (typeof v === "string" && v)
      out.push(v);
  };
  for (const k of ["filePath", "path", "file", "filename", "target", "directory", "cwd", "notebook_path"])
    push(input[k]);
  for (const k of ["files", "paths", "filePaths"]) {
    const v = input[k];
    if (Array.isArray(v))
      for (const x of v) {
        if (typeof x === "string")
          push(x);
        else if (x && typeof x === "object")
          push(x.path ?? x.filePath);
      }
  }
  return out;
}
function ignoredTool(part, opts) {
  const name = String(part?.tool ?? "");
  if (!name)
    return false;
  const low = name.toLowerCase();
  const startsAny = (list) => (list || []).some((p) => p && low.startsWith(String(p).toLowerCase()));
  if ((opts.protectedTools || []).includes(name) || (opts.ignoreTools || []).includes(name))
    return true;
  if (startsAny(opts.ignoreToolPrefixes))
    return true;
  const servers = (opts.ignoreMcpServers || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  if (servers.some((s) => low.startsWith(s + "_") || low.startsWith("mcp__" + s + "__")))
    return true;
  const prefixes = (opts.ignorePathPrefixes || []).map((p) => String(p).toLowerCase()).filter(Boolean);
  if (prefixes.length) {
    const inp = part?.state?.input ?? {};
    if (pathStrings(inp).some((p) => prefixes.some((x) => p.toLowerCase().startsWith(x))))
      return true;
  }
  const cmd = typeof part?.state?.input?.command === "string" ? part.state.input.command.trimStart().toLowerCase() : "";
  if (cmd && (opts.ignoreCommandPrefixes || []).some((p) => p && cmd.startsWith(String(p).toLowerCase())))
    return true;
  return false;
}

// --- model gate -------------------------------------------------------------
var LAST_MODEL = (() => {
  try {
    const s = readFileSync(join(homedir(), ".omo", ".last-model"), "utf-8").trim();
    const i = s.indexOf("/");
    if (i > 0)
      return { providerID: s.slice(0, i), modelID: s.slice(i + 1) };
  } catch {}
  return null;
})();
var SKIP_MODEL = "";
function modelFromInput(input) {
  if (!input || typeof input !== "object")
    return null;
  const p = input.providerID ?? input.model?.providerID ?? input.model?.provider;
  const m = input.modelID ?? input.model?.id ?? input.model?.modelID;
  return p && m ? { providerID: String(p), modelID: String(m) } : null;
}
function modelOf(msgs) {
  for (let i = msgs.length - 1;i >= 0; i--) {
    const info = msgs[i]?.info ?? {};
    const p = info.providerID ?? info.model?.providerID;
    const m = info.modelID ?? info.model?.modelID;
    if (p && m)
      return { providerID: String(p), modelID: String(m) };
  }
  return null;
}
function modelAllowed(cfg, model) {
  const pats = cfg.activeModels;
  if (!Array.isArray(pats) || pats.length === 0)
    return true;
  if (!model)
    return false;
  const id = model.providerID + "/" + model.modelID;
  for (const raw of pats) {
    const p = String(raw).trim();
    if (!p)
      continue;
    if (p === id)
      return true;
    if (p.includes("*")) {
      const rx = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      if (rx.test(id))
        return true;
    }
  }
  return false;
}

// lib/chunkify.js
var DEFAULT_OPTS = {
  thresholdTokens: 2000,
  charsPerToken: 4.24,
  dropZeroByte: true,
  injectedPrefixes: [
    "<system-reminder",
    "<skill-evaluation-required",
    "[SYSTEM DIRECTIVE",
    "[SYSTEM REMINDER",
    "<available-skills",
    "<agent-identity"
  ]
};
var tok = (bytes, opts = DEFAULT_OPTS) => Math.max(1, Math.round(bytes / (opts.charsPerToken || 4)));
var isInjected = (text, opts = DEFAULT_OPTS) => {
  const head = String(text ?? "").trimStart().slice(0, 64);
  return opts.injectedPrefixes.some((p) => head.startsWith(p));
};
var toolOutput = (part) => {
  const st = part?.state ?? {};
  if (typeof st.output === "string")
    return st.output;
  if (typeof st.metadata?.output === "string")
    return st.metadata.output;
  return "";
};
var toolInput = (part) => part?.state?.input ? JSON.stringify(part.state.input) : "";
var duration = (part) => {
  const t = part?.time ?? {};
  const a = t.start ?? t.created;
  const b = t.end ?? t.completed;
  return a && b && b > a ? ((b - a) / 1000).toFixed(1) + "s" : "";
};
function classify(part, role, opts) {
  const type = part?.type;
  if (type === "text") {
    if (role === "user")
      return isInjected(part.text, opts) ? "injected" : "user";
    return "assistant";
  }
  if (type === "reasoning")
    return "thinking";
  if (type === "tool")
    return "tool:" + (part.tool ?? "?");
  return type ?? "?";
}
async function buildChunks(msgs, opts = DEFAULT_OPTS, modelID = "") {
  const raw = [];
  let step = 0;
  let open = false;
  for (const m of msgs) {
    const role = m?.info?.role ?? "?";
    let msgStep = null;
    for (const p of m?.parts ?? []) {
      if (!p || typeof p !== "object")
        continue;
      if (p.type === "step-start") {
        step++;
        open = true;
        msgStep = step;
        continue;
      }
      if (p.type === "step-finish") {
        open = false;
        continue;
      }
      if (role === "user") {
        if (msgStep === null) {
          step++;
          msgStep = step;
        }
        raw.push({ step: msgStep, role, part: p });
        continue;
      }
      if (!open) {
        step++;
        open = true;
        msgStep = step;
      }
      raw.push({ step, role, part: p });
    }
  }
  const seenIds = new Set;
  const unique = [];
  for (let i = raw.length - 1;i >= 0; i--) {
    const r = raw[i];
    const id = r.part?.id;
    if (id) {
      if (seenIds.has(id))
        continue;
      seenIds.add(id);
    }
    unique.push(r);
  }
  unique.reverse();
  const chunks = [];
  const seen = new Set;
  for (const { step: st, role, part } of unique) {
    const type = part?.type;
    const rawOut = type === "tool" ? toolOutput(part) : part?.text ?? "";
    const out = stripTag(rawOut);
    const inp = type === "tool" ? toolInput(part) : "";
    const bytes = out.length + inp.length;
    const outBytes = type === "tool" ? out.length : type === "text" ? out.length : 0;
    const kind = classify(part, role, opts);
    const compressible = !["user", "thinking"].includes(kind) && outBytes > 0 && !(type === "tool" && ignoredTool(part, opts));
    const limit = opts.toolThresholds && part?.tool && opts.toolThresholds[part.tool] || opts.thresholdTokens;
    const tokensOut = outBytes > 0 ? await countTokens(out, modelID, part?.id ? part.id + ":" + out.length : null, opts.charsPerToken, opts) : 0;
    const c = {
      step: st,
      kind,
      role,
      tool: part?.tool ?? null,
      id: part?.id ?? null,
      input: inp,
      bytes,
      outBytes,
      tok: tokensOut || tok(bytes, opts),
      compressible,
      required: compressible && tokensOut >= limit,
      status: part?.state?.status ?? null,
      dur: duration(part),
      text: out
    };
    if (opts.dropZeroByte && c.bytes === 0 && !c.dur)
      continue;
    chunks.push(c);
    seen.add(st);
  }
  const order = [...seen].sort((a, b) => a - b);
  const num = new Map(order.map((s, i) => [s, i + 1]));
  const counters = new Map;
  for (const c of chunks) {
    const s = num.get(c.step);
    if (c.kind === "thinking") {
      c.key = String(s);
      c.sub = 0;
      continue;
    }
    const m = (counters.get(s) ?? 0) + 1;
    counters.set(s, m);
    c.key = `${s}.${m}`;
    c.sub = m;
  }
  return chunks;
}

// src/chunkchomp.js
var DIR = join(homedir(), ".config", "opencode", "chunkchomp");
var CONFIG_PATH = process.env.CHUNKCHOMP_CONFIG || join(homedir(), ".config", "opencode", "plugins", "chunkchomp.txt");
var DEFAULTS = {
  ...DEFAULT_OPTS,
  enabled: true,
  useTokenizer: true,
  engine: "auto",
  enginePath: "",
  activeModels: [],
  thresholdTokens: 2000,
  mandatoryAfterTokens: 150000,
  toolThresholds: {},
  protectedTools: [],
  ignoreTools: [],
  ignoreToolPrefixes: [],
  ignoreMcpServers: [],
  ignorePathPrefixes: [],
  ignoreCommandPrefixes: []
};
var NUMERIC = ["thresholdTokens", "freshWindow", "charsPerToken", "mandatoryAfterTokens"];
var list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);
function thresholds(v) {
  const out = {};
  for (const pair of list(v)) {
    const i = pair.lastIndexOf(":");
    if (i < 0)
      continue;
    const k = pair.slice(0, i).trim();
    const n = Number(pair.slice(i + 1).trim());
    if (k && Number.isFinite(n) && n > 0)
      out[k] = Math.round(n);
  }
  return out;
}
var cache = { mtime: -1, cfg: DEFAULTS };
function config() {
  try {
    const st = statSync(CONFIG_PATH);
    if (st.mtimeMs === cache.mtime)
      return cache.cfg;
    const cfg = { ...DEFAULTS, protectedTools: [...DEFAULTS.protectedTools], activeModels: [...DEFAULTS.activeModels], ignoreTools: [...DEFAULTS.ignoreTools], ignoreToolPrefixes: [...DEFAULTS.ignoreToolPrefixes], ignoreMcpServers: [...DEFAULTS.ignoreMcpServers], ignorePathPrefixes: [...DEFAULTS.ignorePathPrefixes], ignoreCommandPrefixes: [...DEFAULTS.ignoreCommandPrefixes], toolThresholds: {} };
    for (const line of readFileSync(CONFIG_PATH, "utf-8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#"))
        continue;
      const eq = t.indexOf("=");
      if (eq < 0)
        continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (key === "protectedTools")
        cfg.protectedTools = list(val);
      else if (key === "ignoreTools")
        cfg.ignoreTools = list(val);
      else if (key === "ignoreToolPrefixes")
        cfg.ignoreToolPrefixes = list(val);
      else if (key === "ignoreMcpServers")
        cfg.ignoreMcpServers = list(val);
      else if (key === "ignorePathPrefixes")
        cfg.ignorePathPrefixes = list(val);
      else if (key === "ignoreCommandPrefixes")
        cfg.ignoreCommandPrefixes = list(val);
      else if (key === "engine")
        cfg.engine = val;
      else if (key === "enginePath")
        cfg.enginePath = val;
      else if (key === "activeModels")
        cfg.activeModels = list(val);
      else if (key === "toolThresholds")
        cfg.toolThresholds = thresholds(val);
      else if (key === "enabled")
        cfg.enabled = /^(1|true|yes|on)$/i.test(val);
      else if (key === "useTokenizer")
        cfg.useTokenizer = /^(1|true|yes|on)$/i.test(val);
      else if (NUMERIC.includes(key)) {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0)
          cfg[key] = n;
      }
    }
    cache = { mtime: st.mtimeMs, cfg };
    return cfg;
  } catch {
    return cache.cfg ?? DEFAULTS;
  }
}
var MARKER = "## Chunk protocol (chunkchomp)";
function policy(cfg) {
  return [
    MARKER,
    "",
    "Chunks that need shrinking carry a header. Two kinds:",
    "",
    "    [3.1 | tool:read | 53.0KB | 12804tok | !COMPACT]   MANDATORY",
    "    [4.2 | tool:bash | 12.0KB | 3100tok | ?COMPACT]   optional",
    "",
    "!COMPACT means the conversation is already past " + Math.round(cfg.mandatoryAfterTokens) + " tokens: compact every one of them before continuing.",
    "?COMPACT means the chunk is big but the context is still small: compact it only if you no longer need the details.",
    "",
    '    compact_chunk(chunk_id="3.1", summary="...")',
    "",
    "- OBLIGATION: if any chunk carries !COMPACT, make those compact_chunk calls first, in this same turn, before any other tool call, without stopping decode to ask or narrate. Never end a turn leaving a !COMPACT chunk uncompacted.",
    "- Everything without a header is raw context. Do not invent IDs for untagged output.",
    "- A flag is sticky: an ID stays valid for many later requests until you compact it, and an optional one becomes mandatory by itself once the context crosses the limit.",
    "- Compressible: tool outputs and assistant text. Never: system prompt, AGENTS.md, user messages, thinking, or the command that produced a tool output.",
    `- Never flagged: chunks under ${Math.round(cfg.thresholdTokens)} tokens.`,
    "- Summary: 3-8 bullets. Paths, names, numbers, exact error strings, decisions, open questions.",
    "- The summary replaces that chunk's body from the next request onward. The original stays on disk.",
    "- Never write a chunk header in your reply or reasoning; it is stripped from your output."
  ].join(`
`);
}
var KB = (b) => b >= 1024 ? (b / 1024).toFixed(1) + "KB" : b + "B";
function stripTag(s) {
  const lines = String(s).split(`
`);
  if (!/^\[[\d.A-Za-z]+ \|[^\]\n]*\]/.test(lines[0] ?? ""))
    return s;
  lines[0] = lines[0].replace(/^\[[\d.A-Za-z]+ \|[^\]\n]*\][ \t]*/, "");
  if (lines[0] === "")
    lines.shift();
  return lines.join(`
`);
}
function stripBleed(s) {
  if (!/\[\d+(?:\.\d+)?\s*\|/.test(s))
    return s;
  return s.replace(/^[ \t]*\[\d+(?:\.\d+)?\s*\|[^\]\n]*\][ \t]*/gm, "").replace(/\n{3,}/g, `

`);
}
function envelope(c, body, rep, flagged, mandatory) {
  if (!rep && !flagged)
    return body;
  const was = rep ? rep.wasChars : c.outBytes || c.bytes;
  const meta = [c.kind];
  if (rep)
    meta.push(`${KB(was)} -> ${KB(rep.summary.length)}`, "COMPACTED");
  else {
    const mark = ENC_KIND === "exact" ? "" : ENC_KIND === "proxy" ? "\u2248" : "~";
    meta.push(KB(was), mark + `${c.tok}tok`, mandatory ? "!COMPACT" : "?COMPACT");
  }
  return `[${c.key} | ${meta.join(" | ")}]
${body}`;
}
var S = new Map;
function session(id) {
  if (!S.has(id)) {
    const st = { id, dispatch: 0, reg: new Map, replaced: new Map };
    try {
      const p = join(DIR, `${id}.json`);
      if (existsSync(p)) {
        const d = JSON.parse(readFileSync(p, "utf-8"));
        for (const [k, v] of d.replaced ?? [])
          st.replaced.set(k, v);
      }
    } catch {}
    S.set(id, st);
    if (S.size > 12)
      S.delete(S.keys().next().value);
  }
  return S.get(id);
}
function persist(st) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, `${st.id}.json`), JSON.stringify({ sid: st.id, t: Date.now(), replaced: [...st.replaced.entries()] }));
  } catch {}
}
var logBytes = 0;
function log(obj) {
  try {
    mkdirSync(DIR, { recursive: true });
    const p = join(DIR, "live.log");
    if (logBytes === 0)
      logBytes = existsSync(p) ? statSync(p).size : 0;
    if (logBytes > 512 * 1024) {
      writeFileSync(p, "");
      logBytes = 0;
    }
    const line = JSON.stringify({ t: Date.now(), ...obj });
    appendFileSync(p, line + `
`);
    logBytes += line.length + 1;
  } catch {}
}
var ChunkChomp = async () => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      const cfg = config();
      if (!cfg.enabled)
        return;
      const mi = modelFromInput(input) ?? LAST_MODEL;
      if (!modelAllowed(cfg, mi)) {
        const id = mi ? mi.providerID + "/" + mi.modelID : "unknown";
        if (SKIP_MODEL !== id) {
          SKIP_MODEL = id;
          log({ skip: "model", hook: "system", model: id });
        }
        return;
      }
      const arr = output?.system;
      if (!Array.isArray(arr) || arr.length === 0)
        return;
      if (arr.some((s) => typeof s === "string" && s.includes(MARKER)))
        return;
      const label = (s) => {
        const head = String(s).split(`
`).slice(0, 3).join(" ");
        if (/AGENTS\.md/i.test(head) || String(s).length > 3000)
          return "agents";
        return "system";
      };
      for (let i = 0;i < arr.length; i++) {
        if (typeof arr[i] !== "string" || arr[i].startsWith("[S"))
          continue;
        arr[i] = `[S${i + 1} | ${label(arr[i])} | raw]
${arr[i]}`;
      }
      arr.push(policy(cfg));
    },
    "experimental.chat.messages.transform": async (input, output) => {
      try {
        const cfg = config();
        if (!cfg.enabled)
          return;
        const msgs = output?.messages ?? [];
        if (!msgs.length)
          return;
        const mi = modelFromInput(input) ?? modelOf(msgs) ?? LAST_MODEL;
        if (mi)
          LAST_MODEL = mi;
        if (!modelAllowed(cfg, mi)) {
          const id = mi ? mi.providerID + "/" + mi.modelID : "unknown";
          if (SKIP_MODEL !== id) {
            SKIP_MODEL = id;
            log({ skip: "model", hook: "messages", model: id });
          }
          return;
        }
        SKIP_MODEL = "";
        const sid = msgs[0]?.info?.sessionID ?? "unknown";
        const st = session(sid);
        st.dispatch++;
        if (cfg.useTokenizer)
          await ensureEncoder(mi ? mi.modelID : "");
        const chunks = await buildChunks(msgs, cfg, mi ? mi.modelID : "");
        const ctxTok = chunks.reduce((a, c) => a + (c.tok || 0), 0);
        const mandatory = ctxTok >= cfg.mandatoryAfterTokens;
        const byId = new Map;
        for (const c of chunks)
          if (c.id)
            byId.set(c.id, c);
        let fresh = 0, required = 0;
        const freshIds = new Set();
        for (const c of chunks) {
          if (!c.id)
            continue;
          const rec = st.reg.get(c.id);
          const compressible = c.compressible && !cfg.protectedTools.includes(c.tool);
          if (!rec) {
            const entry = {
              key: c.key,
              first: st.dispatch,
              kind: c.kind,
              tool: c.tool,
              outBytes: c.outBytes,
              tok: c.tok,
              compressible,
              flagged: compressible && c.required
            };
            st.reg.set(c.id, entry);
            freshIds.add(c.id);
            fresh++;
            if (entry.flagged)
              required++;
          } else {
            rec.key = c.key;
            if (!st.replaced.has(c.id)) {
              rec.outBytes = c.outBytes;
              rec.tok = c.tok;
            }
            rec.compressible = compressible;
          }
        }
        let liveIdx = -1;
        for (let i = msgs.length - 1;i >= 0; i--) {
          if (msgs[i]?.info?.role === "assistant") {
            liveIdx = i;
            break;
          }
        }
        let applied = 0, stripped = 0;
        for (let mi = 0;mi < msgs.length; mi++) {
          const parts = msgs[mi]?.parts;
          if (!Array.isArray(parts))
            continue;
          const liveMessage = mi === liveIdx;
          for (const p of parts) {
            if (!p || typeof p !== "object")
              continue;
            if (p.type === "step-start" || p.type === "step-finish")
              continue;
            if (p.type === "tool" && p.tool === "compact_chunk") {
              const inp = p.state?.input;
              if (inp && typeof inp.summary === "string" && inp.summary.length > 24) {
                inp.summary = "";
                stripped++;
              }
            }
            const c = byId.get(p.id);
            if (!c)
              continue;
            const rep = st.replaced.get(p.id);
            const rec0 = st.reg.get(p.id);
            const flagged = !rep && !!rec0?.flagged;
            const isTool = p.type === "tool" && p.state && typeof p.state.output === "string";
            if (!isTool && (liveMessage || typeof p.text !== "string"))
              continue;
            const current = isTool ? p.state.output : p.text;
            const orig = stripTag(current);
            const next = envelope(c, rep ? rep.summary : orig, rep, flagged, mandatory);
            if (isTool)
              p.state.output = next;
            else
              p.text = next;
            if (rep)
              applied++;
          }
        }
        log({ sid, model: mi ? mi.providerID + "/" + mi.modelID : "?", tok: ENC_KIND, fam: ENC_FAMILY ?? "generic", enc: ENC_MS, ctx: ctxTok, mode: mandatory ? "mandatory" : "optional", d: st.dispatch, chunks: chunks.length, fresh, flagged: required, applied, stripped });
        try {
          const S = stats();
          const mkey = mi ? mi.providerID + "/" + mi.modelID : "unknown";
          const M = S.byModel[mkey] ?? (S.byModel[mkey] = { transforms: 0, flagged: 0, compacted: 0, bytesSaved: 0, tokensSaved: 0 });
          S.transforms++;
          M.transforms++;
          if (mandatory) S.mandatory++;
          else S.optional++;
          S.chunksSeen += chunks.length;
          S.flagged += required;
          M.flagged += required;
          const day = new Date().toISOString().slice(0, 10);
          const D = S.byDay[day] ?? (S.byDay[day] = { transforms: 0, flagged: 0, compacted: 0 });
          D.transforms++;
          D.flagged += required;
          for (const c of chunks) {
            if (!c.tool || !freshIds.has(c.id))
              continue;
            const T = statObj(S.byTool, c.tool);
            T.seen++;
            T.bytes += c.bytes;
            T.tokens += c.tok;
            if (c.required)
              T.flagged++;
          }
          statsFlush();
          writeStatus(cfg);
        } catch {}
      } catch (e) {
        log({ err: String(e && e.message ? e.message : e) });
      }
    },
    "experimental.text.complete": async (input, output) => {
      try {
        const cfg = config();
        if (!cfg.enabled)
          return;
        if (typeof output?.text === "string")
          output.text = stripBleed(output.text);
      } catch {}
    },
    tool: {
      compact_chunk: tool({
        description: "Replace a chunk's body with a dense summary you write. Use it on every chunk tagged !COMPACT from the current request, before continuing. Older chunks, protected tools and chunks under the size threshold are rejected.",
        args: {
          chunk_id: tool.schema.string().describe('Chunk key exactly as tagged, e.g. "3.1"'),
          summary: tool.schema.string().describe("3-8 bullets: paths, names, numbers, exact error strings, decisions, open questions"),
          reason: tool.schema.string().optional().describe("One line: why this content is no longer needed verbatim")
        },
        async execute(args, ctx) {
          const cfg = config();
          if (!cfg.enabled)
            return "chunkchomp is disabled in chunkchomp.txt.";
          if (!modelAllowed(cfg, LAST_MODEL)) {
            const id = LAST_MODEL ? LAST_MODEL.providerID + "/" + LAST_MODEL.modelID : "unknown";
            return `chunkchomp is inactive for ${id}: it only runs on ${cfg.activeModels.join(", ")}.`;
          }
          const st = session(ctx.sessionID);
          const key = String(args.chunk_id ?? "").trim().replace(/^\[/, "").replace(/\]$/, "");
          const hit = [...st.reg.entries()].find(([, r]) => r.key === key);
          if (!hit) {
            const keys = [...st.reg.values()].slice(-8).map((r) => r.key).join(", ");
            return reject(`REJECTED: unknown chunk "${key}". Recent keys: ${keys}`);
          }
          const [partId, rec] = hit;
          if (st.replaced.has(partId))
            return `REJECTED: chunk ${key} is already compacted.`;
          if (!rec.compressible)
            return `REJECTED: chunk ${key} is ${rec.kind} - not compressible (system, AGENTS.md, user text, thinking, ignored paths/servers/tools stay raw).`;
          if (!rec.flagged) {
            const limit = cfg.toolThresholds[rec.tool] ?? cfg.thresholdTokens;
            return `REJECTED: chunk ${key} is ${rec.tok}tok, under the ${Math.round(limit)}tok flag threshold${rec.tool ? " for " + rec.tool : ""}.`;
          }
          const summary = String(args.summary ?? "").trim();
          if (!summary)
            return "REJECTED: empty summary.";
          st.replaced.set(partId, { summary, wasChars: rec.outBytes, key, reason: String(args.reason ?? "").slice(0, 200) });
          rec.flagged = false;
          persist(st);
          const pct = rec.outBytes ? Math.round((1 - summary.length / rec.outBytes) * 100) : 0;
          log({ sid: st.id, compact: key, kind: rec.kind, was: rec.outBytes, now: summary.length });
          try {
            const S = stats();
            S.compacted++;
            S.bytesSaved += Math.max(0, rec.outBytes - summary.length);
            S.tokensSaved += Math.max(0, rec.tok - await countTokens(summary, LAST_MODEL ? LAST_MODEL.modelID : "", null, cfg.charsPerToken, cfg));
            statObj(S.byTool, rec.tool || "text").compacted++;
            const mk = LAST_MODEL ? LAST_MODEL.providerID + "/" + LAST_MODEL.modelID : "unknown";
            const MM = S.byModel[mk] ?? (S.byModel[mk] = { transforms: 0, flagged: 0, compacted: 0, bytesSaved: 0, tokensSaved: 0 });
            MM.compacted++;
            MM.bytesSaved += Math.max(0, rec.outBytes - summary.length);
            const day = new Date().toISOString().slice(0, 10);
            const D = S.byDay[day] ?? (S.byDay[day] = { transforms: 0, flagged: 0, compacted: 0 });
            D.compacted++;
            statsFlush();
            writeStatus(cfg, true);
          } catch {}
          return `OK chunk ${key} (${rec.kind}): ${rec.outBytes}B -> ${summary.length}B (-${pct}%). Applies from your next request.`;
        }
      })
    }
  };
};
function toV1Messages(msgs, sessionID) {
  const pairs = [];
  const out = msgs.map((m, i) => {
    const parts = (Array.isArray(m.content) ? m.content : []).map((p, j) => {
      const id = p.id ?? (m.id ?? "m" + i) + "-" + j;
      if (p.type === "text") {
        const v1 = { type: "text", id, text: p.text ?? "" };
        pairs.push([p, v1, "text"]);
        return v1;
      }
      if (p.type === "tool-result") {
        const value = typeof p.result === "string" ? p.result : (p.result?.value ?? p.result?.output ?? "");
        const v1 = { type: "tool", id, tool: p.name ?? "tool", state: { status: "completed", input: p.input ?? p.arguments ?? {}, output: value } };
        pairs.push([p, v1, "tool"]);
        return v1;
      }
      const v1 = { type: p.type, id, text: p.text ?? "" };
      pairs.push([p, v1, "text"]);
      return v1;
    });
    return { info: { id: m.id ?? "m" + i, role: m.role ?? "user", sessionID }, parts };
  });
  return { out, pairs };
}

function syncBack(pairs) {
  for (const [v2, v1, kind] of pairs) {
    if (kind === "text") {
      if (typeof v1.text === "string")
        v2.text = v1.text;
    } else if (v1.state) {
      const value = v1.state.output;
      if (typeof v2.result === "string")
        v2.result = value;
      else
        v2.result = { ...(v2.result ?? {}), value };
    }
  }
}

export default Plugin.define({
  id: "chunkchomp",
  async setup(ctx) {
    const hooks = await ChunkChomp();
    const sysHook = hooks["experimental.chat.system.transform"];
    const msgHook = hooks["experimental.chat.messages.transform"];

    if (typeof ctx?.session?.hook === "function") {
      await ctx.session.hook("context", async (event) => {
        const model = {
          providerID: event?.model?.providerID ?? event?.providerID,
          modelID: event?.model?.id ?? event?.modelID
        };
        const { out: v1Messages, pairs } = toV1Messages(Array.isArray(event?.messages) ? event.messages : [], event?.sessionID);
        const out = { system: event?.system, messages: v1Messages };
        try {
          await sysHook({ ...model }, out);
        } catch {}
        try {
          await msgHook({ ...model }, out);
        } catch {}
        syncBack(pairs);
      });
    }

    if (typeof ctx?.tool?.transform === "function") {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "compact_chunk",
          description: hooks.tool.compact_chunk.description,
          input: {
            type: "object",
            properties: {
              chunk_id: { type: "string", description: 'Chunk key exactly as tagged, e.g. "3.1"' },
              summary: { type: "string", description: "3-8 bullets: paths, names, numbers, exact error strings, decisions, open questions" },
              reason: { type: "string", description: "One line: why this content is no longer needed verbatim" }
            },
            required: ["chunk_id", "summary"],
            additionalProperties: false
          },
          execute: async (args, context) => ({
            content: await hooks.tool.compact_chunk.execute(args, {
              sessionID: context?.sessionID ?? "unknown"
            })
          })
        });
      });
    }

    return () => {};
  }
});
