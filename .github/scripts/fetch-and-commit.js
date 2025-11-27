#!/usr/bin/env node
/**
 * fetch-and-commit.js
 *
 * - Expects assets-to-fetch.json (array of { url, out }) in repo root.
 * - Fetches each URL, detects extension (Content-Type or magic bytes),
 *   writes file only if content changed, and commits & pushes changed files.
 * - Meant for GitHub Actions / local use. Assumes mapping exists (no sample created).
 *
 * Requirements:
 * - node >= 18 (global fetch available)
 *
 * Behavior:
 * - Concurrency: up to CONCURRENCY parallel fetches to speed up large mappings.
 * - Safe write: creates folders as needed; writes only when buffer differs.
 * - Git: config user.* if not set, `git add` changed files, commit, push.
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
const CONCURRENCY = 6; // modest parallelism

/* ---------- small helpers ---------- */

const log = (...args) => console.log("[fetch-assets]", ...args);
const warn = (...args) => console.warn("[fetch-assets][WARN]", ...args);
const errlog = (...args) => console.error("[fetch-assets][ERROR]", ...args);

const ensureDirSync = (filePath) => {
  const dir = path.dirname(filePath);
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
};

const hasExtension = (filename) => /\.[a-zA-Z0-9]+$/.test(filename);

/* ---------- content-type -> ext map ---------- */

const CTYPE_MAP = new Map([
  ["image/svg+xml", "svg"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
  ["text/plain", "txt"],
  ["application/json", "json"],
]);

const mapCTypeToExt = (ctypeRaw = "") => {
  const key = ctypeRaw.split(";")[0].trim().toLowerCase();
  return CTYPE_MAP.get(key) || "";
};

/* ---------- magic bytes / buffer detection ---------- */

async function detectExtFromBuffer(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 2048));
  const headStr = head.toString("utf8").toLowerCase();

  if (headStr.includes("<svg")) return "svg";
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return "png"; // PNG
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg"; // JPEG
  if (headStr.startsWith("gif87a") || headStr.startsWith("gif89a")) return "gif";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  if (buffer.length >= 4 && buffer.readUInt16LE(0) === 0x0000 && buffer.readUInt16LE(2) === 0x0100)
    return "ico"; // ICO
  return "";
}

/* ---------- filesystem compare ---------- */

async function isBufferEqualToFile(filePath, buf) {
  try {
    const existing = await fs.readFile(filePath);
    if (existing.length !== buf.length) return false;
    return existing.equals(buf);
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/* ---------- network fetch with abort ---------- */

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const ctype = res.headers.get("content-type") || "";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, ctype };
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/* ---------- read mapping (must exist) ---------- */

async function readMappingOrFail() {
  const raw = await fs.readFile(MAPPING_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("assets-to-fetch.json must be an array of {url,out}");
  return parsed;
}

/* ---------- git helpers ---------- */

function safeQuoteForShell(s) {
  // wrap in double quotes and escape inner double quotes
  return `"${s.replace(/"/g, '\\"')}"`;
}

function ensureGitUserConfig() {
  // set defaults only if unset
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
}

function gitCommitAndPush(changedFiles) {
  try {
    ensureGitUserConfig();

    // Stage files safely
    const filesArg = changedFiles.map((f) => safeQuoteForShell(f)).join(" ");
    execSync(`git add -- ${filesArg}`, { stdio: "inherit" });

    // Commit — will throw if no changes
    const message = "chore: update cached README assets (automated)";
    try {
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: "inherit" });
    } catch {
      log("No commit created (nothing to commit).");
      return;
    }

    // Push using default remote/branch setup in Actions
    execSync(`git push`, { stdio: "inherit" });
    log("Changes pushed.");
  } catch (err) {
    throw new Error(`git operation failed: ${err.message}`);
  }
}

/* ---------- main flow with limited concurrency ---------- */

async function run() {
  log("Starting fetch-and-commit");

  const mapping = await readMappingOrFail();
  if (mapping.length === 0) {
    log("Mapping is empty — nothing to do.");
    return;
  }

  const changedFiles = [];
  const tasks = mapping.map((entry, idx) => ({ entry, idx }));

  // Simple concurrency runner
  async function worker(job) {
    const { entry, idx } = job;
    if (!entry || !entry.url || !entry.out) {
      warn(`Skipping invalid mapping at index ${idx}`);
      return;
    }

    const url = entry.url;
    const outBase = entry.out;
    log(`Processing [${idx + 1}/${mapping.length}] ${url}`);

    try {
      const { buffer, ctype } = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      let ext = mapCTypeToExt(ctype || "");
      if (!ext) ext = await detectExtFromBuffer(buffer);

      let finalOut;
      if (hasExtension(outBase)) {
        finalOut = outBase;
      } else {
        finalOut = `${outBase}.${ext || "bin"}`;
      }

      ensureDirSync(finalOut);

      const equal = await isBufferEqualToFile(finalOut, buffer);
      if (equal) {
        log(`No change: ${finalOut}`);
      } else {
        await fs.writeFile(finalOut, buffer);
        log(`Saved: ${finalOut} (detected: ${ctype || "unknown"} -> .${path.extname(finalOut) || ""})`);
        changedFiles.push(finalOut);
      }
    } catch (err) {
      warn(`Failed to fetch ${url}: ${err.message}`);
    }
  }

  // run up to CONCURRENCY in parallel
  const pool = new Array(CONCURRENCY).fill(null).map(async () => {
    while (tasks.length) {
      const job = tasks.shift();
      // tasks.shift may return undefined if concurrently emptied
      if (!job) break;
      // eslint-disable-next-line no-await-in-loop
      await worker(job);
    }
  });

  await Promise.all(pool);

  if (changedFiles.length === 0) {
    log("No files changed. Exiting.");
    return;
  }

  log("Changed files:", changedFiles);

  // If repo/git available, commit & push
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
    gitCommitAndPush(changedFiles);
  } catch (err) {
    warn("Git not available or not a repository; changes saved locally.", err.message);
  }
}

/* ---------- run ---------- */

run().catch((e) => {
  errlog("Fatal:", e && e.message ? e.message : e);
  process.exit(1);
});
