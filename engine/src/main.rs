use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use tokenizers::Tokenizer;

fn main() {
    let stdin = io::stdin();
    let mut out = io::stdout();
    let mut loaded: Option<(String, Tokenizer)> = None;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = writeln!(out, "{}", json!({ "error": e.to_string() }));
                let _ = out.flush();
                continue;
            }
        };

        let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
        let resp = match op {
            "ping" => json!({ "ok": true, "loaded": loaded.as_ref().map(|(f, _)| f.clone()) }),
            "count" => {
                let family = req.get("family").and_then(|v| v.as_str()).unwrap_or("");
                let file = req.get("file").and_then(|v| v.as_str()).unwrap_or("");
                let texts: Vec<&str> = req
                    .get("texts")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
                    .unwrap_or_default();

                let stale = match &loaded {
                    Some((f, _)) => f != family,
                    None => true,
                };
                let mut load_ms: u128 = 0;
                if stale && !file.is_empty() {
                    let t0 = std::time::Instant::now();
                    match Tokenizer::from_file(file) {
                        Ok(t) => {
                            loaded = Some((family.to_string(), t));
                            load_ms = t0.elapsed().as_millis();
                        }
                        Err(e) => {
                            let _ = writeln!(out, "{}", json!({ "error": e.to_string() }));
                            let _ = out.flush();
                            continue;
                        }
                    }
                }

                let t_enc = std::time::Instant::now();
                let tokens: Vec<usize> = match &loaded {
                    Some((_, t)) => texts
                        .iter()
                        .map(|s| t.encode(*s, false).map(|e| e.get_ids().len()).unwrap_or(0))
                        .collect(),
                    None => vec![],
                };
                json!({ "tokens": tokens, "load_ms": load_ms, "encode_ms": t_enc.elapsed().as_millis() })
            }
            "bench" => {
                let family = req.get("family").and_then(|v| v.as_str()).unwrap_or("");
                let file = req.get("file").and_then(|v| v.as_str()).unwrap_or("");
                let text = req.get("text").and_then(|v| v.as_str()).unwrap_or("");
                let n = req.get("n").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
                if let Err(e) = Tokenizer::from_file(file) {
                    let _ = writeln!(out, "{}", json!({ "error": e.to_string() }));
                    let _ = out.flush();
                    continue;
                }
                let t0 = std::time::Instant::now();
                let ok = Tokenizer::from_file(file).map(|t| {
                    let mut total = 0usize;
                    for _ in 0..n {
                        if let Ok(e) = t.encode(text, false) {
                            total += e.get_ids().len();
                        }
                    }
                    total / n.max(1)
                });
                json!({
                    "family": family,
                    "avg_tokens": ok.unwrap_or(0),
                    "total_ms": t0.elapsed().as_millis(),
                    "runs": n
                })
            }
            _ => json!({ "error": "unknown op" }),
        };

        let _ = writeln!(out, "{}", resp);
        let _ = out.flush();
    }
}
