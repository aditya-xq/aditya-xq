#!/usr/bin/env node
/**
 * fetch-and-commit.js
 *
 * Usage:
 *  - Place at repo root or .github/scripts/
 *  - Ensure you have node >= 18 (global fetch available) OR run with node 18+
 *  - Create assets-to-fetch.json in repo root (script will create a sample and exit once)
 *  - Run: node fetch-and-commit.js
 *
 * In GitHub Actions:
 *  - actions/checkout@v4 (persist-credentials: true) + node setup -> run this script
 *  - The runner provides GITHUB_TOKEN for pushing back changes with default checkout settings.
 *
 * The script:
 *  - fetches each mapping entry { url, out }
 *  - detects extension from Content-Type or file bytes
 *  - writes files only when changed, and commits & pushes if any change
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAPPING_FILE = path.join(process.cwd(), "assets-to-fetch.json");
const FETCH_TIMEOUT_MS = 30_000; // 30s

function log(...args) {
  console.log("[fetch-assets]", ...args);
}

function mapCTypeToExt(ctypeRaw) {
  if (!ctypeRaw) return "";
  const ctype = ctypeRaw.split(";")[0].trim().toLowerCase();
  switch (ctype) {
    case "image/svg+xml":
      return "svg";
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return "ico";
    case "text/plain":
      return "txt";
    case "application/json":
      return "json";
    default:
      return "";
  }
}

async function detectExtFromBuffer(buffer) {
  // Check for SVG (text starts with <svg or contains <svg within first chunk)
  const head = buffer.subarray(0, Math.min(buffer.length, 2048));
  const headStr = head.toString("utf8").toLowerCase();

  if (headStr.includes("<svg")) return "svg";
  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return "png";
  // JPEG magic: FF D8
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  // GIF magic: "GIF87a" or "GIF89a"
  if (headStr.startsWith("gif87a") || headStr.startsWith("gif89a")) return "gif";
  // WEBP - "RIFF....WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  // ICO: 00 00 01 00
  if (buffer.length >= 4 && buffer.readUInt16LE(0) === 0x0000 && buffer.readUInt16LE(2) === 0x0100) {
    return "ico";
  }
  return "";
}

function ensureDirSync(filePath) {
  const dir = path.dirname(filePath);
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
}

async function readMappingOrCreateSample() {
  try {
    const raw = await fs.readFile(MAPPING_FILE, "utf8");
    const json = JSON.parse(raw);
    if (!Array.isArray(json)) throw new Error("assets-to-fetch.json must be an array");
    return json;
  } catch (err) {
    if (err.code === "ENOENT") {
      // create sample and exit
      const sample = [
        {
          url:
            "https://visitor-badge.laobi.icu/badge?page_id=aditya-xq&left_color=maroon&right_color=darkgreen",
          out: "assets/visitor-badge"
        },
        {
          url:
            "https://github-readme-streak-stats.herokuapp.com/?user=aditya-xq&theme=highcontrast&hide_border=true",
          out: "assets/streak-stats"
        },
        {
          url:
            "https://github-readme-stats.vercel.app/api?username=aditya-xq&show_icons=true&theme=highcontrast&hide_border=true&rank_icon=github",
          out: "assets/github-stats"
        }
      ];
      await fs.writeFile(MAPPING_FILE, JSON.stringify(sample, null, 2), "utf8");
      log(`Created sample ${path.basename(MAPPING_FILE)} — edit it with your URLs and re-run.`);
      process.exit(0);
    } else {
      log("Error reading mapping file:", err.message);
      throw err;
    }
  }
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const ctype = res.headers.get("content-type") || "";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, ctype };
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

function hasExtension(filename) {
  return /\.[a-zA-Z0-9]+$/.test(filename);
}

async function compareBuffersEqual(aPath, buf) {
  try {
    const existing = await fs.readFile(aPath);
    if (Buffer.byteLength(existing) !== buf.length) return false;
    return existing.equals(buf);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

function gitCommitAndPush(changedFiles) {
  try {
    // Configure git user if not set (safe defaults for actions)
    try {
      execSync('git config user.name', { stdio: "ignore" });
    } catch {
      execSync('git config user.name "github-actions[bot]"');
    }
    try {
      execSync('git config user.email', { stdio: "ignore" });
    } catch {
      execSync('git config user.email "github-actions[bot]@users.noreply.github.com"');
    }

    // Stage changed files
    const filesArg = changedFiles.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(" ");
    execSync(`git add ${filesArg}`, { stdio: "inherit" });

    // Commit
    const message = "chore: update cached README assets (automated)";
    // If no changes to commit, git exits non-zero; we catch that gracefully
    try {
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
    } catch (err) {
      log("No commit created (maybe nothing to commit).");
      return;
    }

    // Push (uses origin HEAD)
    execSync(`git push`, { stdio: "inherit" });
    log("Changes pushed.");
  } catch (err) {
    log("Failed to commit & push changes:", err.message);
    throw err;
  }
}

async function main() {
  log("Starting fetch-and-commit script.");

  const mapping = await readMappingOrCreateSample();
  if (!Array.isArray(mapping) || mapping.length === 0) {
    log("No mapping entries to process. Exiting.");
    return;
  }

  const changedFiles = [];

  for (let i = 0; i < mapping.length; i++) {
    const item = mapping[i];
    if (!item || !item.url || !item.out) {
      log(`Skipping invalid mapping at index ${i}`);
      continue;
    }

    const url = item.url;
    const outBase = item.out;
    log(`Processing [${i + 1}/${mapping.length}]: ${url}`);

    try {
      const { buffer, ctype } = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);

      let ext = mapCTypeToExt(ctype || "");
      if (!ext) {
        ext = await detectExtFromBuffer(buffer);
      }

      let finalOut;
      if (hasExtension(outBase)) {
        // user provided an extension, respect it
        finalOut = outBase;
      } else {
        if (!ext) {
          ext = "bin";
        }
        finalOut = `${outBase}.${ext}`;
      }

      ensureDirSync(finalOut);

      const equal = await compareBuffersEqual(finalOut, buffer);
      if (equal) {
        log(`No change for ${finalOut}`);
      } else {
        await fs.writeFile(finalOut, buffer);
        log(`Saved ${finalOut} (detected: ${ctype || "unknown"} -> .${ext})`);
        changedFiles.push(finalOut);
      }
    } catch (err) {
      log(`WARNING: failed to fetch ${url} — ${err.message}`);
      continue;
    }
  }

  if (changedFiles.length === 0) {
    log("No files changed. Nothing to commit.");
    return;
  }

  log("Files changed:", changedFiles);

  // commit & push if git available
  try {
    // check if we're in a git repo
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    gitCommitAndPush(changedFiles);
  } catch (err) {
    log("Git not available or not a repo — skipping commit & push. Changes are saved locally.");
    log(err.message);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
