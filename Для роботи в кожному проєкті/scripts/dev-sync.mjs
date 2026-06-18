#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as ftp from "basic-ftp";
import chokidar from "chokidar";
import dotenv from "dotenv";
import { minimatch } from "minimatch";
import open from "open";
import WebSocket from "ws";

const ROOT_DIR = process.cwd();
const ENV_FILE = path.join(ROOT_DIR, ".env.ftp");
const ENV_SHARED_FILE = path.join(ROOT_DIR, ".env.ftp.shared");
const SYNC_STATE_FILE = path.join(ROOT_DIR, ".ftp-deploy-sync-state.json");
const FILE_TYPE = 1;
const DIR_TYPE = 2;

dotenv.config({ path: ENV_SHARED_FILE });
dotenv.config({ path: ENV_FILE, override: true });

for (const candidate of ["FTP_PASSWORD", "FTP_PASSWORD_GLOBAL", "DEV_FTP_PASSWORD"]) {
  const value = process.env[candidate];
  if (typeof value === "string" && value.trim() !== "") {
    process.env.FTP_PASSWORD = value.trim();
    break;
  }
}

const DEFAULT_WATCH_PATHS = [
  "admin",
  "catalog",
  "system",
  "image",
  "index.php",
  "config.php",
  "admin/config.php",
  ".htaccess",
  ".htaccess.txt",
  "robots.txt",
  "sitemap.xml"
];

const DEFAULT_WATCH_EXCLUDE = [
  ".git/**",
  ".github/**",
  "node_modules/**",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "vendor/**",
  "system/storage/cache/**",
  "system/storage/logs/**",
  "system/storage/modification/**",
  "system/storage/session/**",
  "system/storage/upload/**",
  "system/storage/download/**",
  "image/cache/**",
  "admin/view/stylesheet/bootstrap.css",
  ".chrome-live-reload-profile/**",
  "npm-debug.log",
  ".ftp-deploy-sync-state.json",
  ".env*"
];

const DEFAULT_PULL_PATHS = [
  "admin",
  "catalog",
  "system",
  "image"
];

function timestamp() {
  return new Date().toLocaleTimeString("uk-UA", { hour12: false });
}

function log(message) {
  process.stdout.write(`[${timestamp()}] ${message}\n`);
}

function logError(message, error) {
  const details = error?.message ? `: ${error.message}` : "";
  process.stderr.write(`[${timestamp()}] ${message}${details}\n`);
}

function readEnv(name, fallback = "") {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === "") {
    return fallback;
  }
  return raw.trim();
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseIntValue(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(/\r?\n|,/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSlashes(value) {
  return value.replace(/\\/g, "/");
}

function normalizeLocalRelative(inputPath) {
  const normalized = normalizeSlashes(path.normalize(inputPath)).replace(/^\/+/, "");
  return normalized;
}

function normalizeRemoteBase(inputPath) {
  const raw = normalizeSlashes(inputPath.trim());
  if (!raw) {
    throw new Error("FTP_REMOTE_BASE is required");
  }

  const withoutTrailing = raw.replace(/\/+$/, "");
  return withoutTrailing.startsWith("/") ? withoutTrailing : `/${withoutTrailing}`;
}

function toRelativeFromRoot(inputPath) {
  const absolute = path.resolve(ROOT_DIR, inputPath);
  const relative = path.relative(ROOT_DIR, absolute);
  if (!relative || relative === ".") {
    return "";
  }

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  return normalizeSlashes(relative);
}

function ensureSafeRemotePath(remotePath) {
  if (/[\r\n]/.test(remotePath)) {
    throw new Error(`Unsafe path detected: ${remotePath}`);
  }
}

function joinRemote(remoteBase, relativePath) {
  const cleanRelative = normalizeLocalRelative(relativePath);
  const full = `${remoteBase}/${cleanRelative}`.replace(/\/+/g, "/");
  ensureSafeRemotePath(full);
  return full;
}

function globMatch(relativePath, patterns) {
  return patterns.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
}

function isIgnored(relativePath, excludePatterns) {
  if (!relativePath) {
    return false;
  }

  const pathWithSlash = `${relativePath}/`;
  for (const pattern of excludePatterns) {
    if (globMatch(relativePath, [pattern]) || globMatch(pathWithSlash, [pattern])) {
      return true;
    }
  }

  return false;
}

function isPathInsideAny(relativePath, includePaths) {
  if (!relativePath) {
    return false;
  }

  return includePaths.some((base) => {
    if (!base) {
      return false;
    }

    if (relativePath === base) {
      return true;
    }

    return relativePath.startsWith(`${base}/`);
  });
}

async function existsAndIsDir(absolutePath) {
  try {
    const stats = await fsp.stat(absolutePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function createConfig() {
  const required = ["FTP_HOST", "FTP_USER", "FTP_PASSWORD", "FTP_REMOTE_BASE", "LIVE_RELOAD_URL"];
  const missing = required.filter((name) => !readEnv(name));
  if (missing.length) {
    throw new Error(`Missing required .env.ftp values: ${missing.join(", ")}`);
  }

  const watchPaths = parseList(readEnv("WATCH_UPLOAD_PATHS")).map(normalizeLocalRelative);
  const include = watchPaths.length > 0 ? watchPaths : DEFAULT_WATCH_PATHS;
  const excludeExtra = parseList(readEnv("WATCH_EXCLUDE_PATHS")).map(normalizeLocalRelative);

  const pullPaths = parseList(readEnv("REMOTE_PULL_PATHS")).map(normalizeLocalRelative);
  const resolvedPull = pullPaths.length > 0 ? pullPaths : DEFAULT_PULL_PATHS;

  const syncMode = readEnv("CONTENT_SYNC_MODE", "bidirectional").toLowerCase();

  const config = {
    liveReloadUrl: readEnv("LIVE_RELOAD_URL"),
    ftp: {
      host: readEnv("FTP_HOST"),
      port: parseIntValue(readEnv("FTP_PORT", "21"), 21),
      user: readEnv("FTP_USER"),
      password: readEnv("FTP_PASSWORD"),
      secure: parseBool(readEnv("FTP_SECURE", "false")),
      remoteBase: normalizeRemoteBase(readEnv("FTP_REMOTE_BASE")),
      timeoutMs: parseIntValue(readEnv("FTP_TIMEOUT_MS", "30000"), 30000),
      verbose: parseBool(readEnv("FTP_VERBOSE", "false"))
    },
    watch: {
      include,
      exclude: [...DEFAULT_WATCH_EXCLUDE, ...excludeExtra],
      usePolling: parseBool(readEnv("WATCH_USE_POLLING", "true")),
      interval: parseIntValue(readEnv("WATCH_INTERVAL", "180"), 180),
      uploadCooldownMs: parseIntValue(readEnv("UPLOAD_COOLDOWN_MS", "600"), 600),
      startupPaths: parseList(readEnv("INITIAL_UPLOAD_PATHS")).map(normalizeLocalRelative)
    },
    pull: {
      enabled: parseBool(readEnv("REMOTE_PULL_ENABLED", syncMode !== "push-only")),
      paths: resolvedPull,
      intervalSec: parseIntValue(readEnv("REMOTE_PULL_INTERVAL_SEC", "90"), 90),
      applyDeletes: parseBool(readEnv("REMOTE_PULL_DELETE", "false")),
      downloadNewerOnly: parseBool(readEnv("REMOTE_PULL_NEWER_ONLY", "true")),
      pruneGraceSec: parseIntValue(readEnv("REMOTE_PULL_PRUNE_GRACE_SEC", "120"), 120)
    },
    syncSafety: {
      enabled: parseBool(readEnv("SYNC_SAFE_UPLOAD_ENABLED", "true")),
      toleranceMs: parseIntValue(readEnv("SYNC_SAFE_UPLOAD_TOLERANCE_MS", "2000"), 2000)
    },
    modificationRefresh: {
      enabled: parseBool(readEnv("OCMOD_AUTO_REFRESH_ENABLED", "false")),
      paths: parseList(readEnv("OCMOD_AUTO_REFRESH_PATHS")).map(normalizeLocalRelative),
      cooldownMs: parseIntValue(readEnv("OCMOD_AUTO_REFRESH_COOLDOWN_MS", "1500"), 1500),
      route: readEnv("OCMOD_REFRESH_ROUTE", "marketplace/modification/refresh")
    },
    browser: {
      enabled: parseBool(readEnv("LIVE_RELOAD_ENABLED", "true")),
      autoOpen: parseBool(readEnv("LIVE_RELOAD_AUTO_OPEN", "true")),
      debugPort: parseIntValue(readEnv("CHROME_DEBUG_PORT", "9222"), 9222),
      path: readEnv("CHROME_PATH"),
      userDataDir: readEnv("CHROME_USER_DATA_DIR")
    }
  };

  return config;
}

function guessChromePath() {
  if (process.platform === "win32") {
    const candidates = [
      process.env["PROGRAMFILES(X86)"]
        ? path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe")
        : "",
      process.env.PROGRAMFILES
        ? path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe")
        : ""
    ].filter(Boolean);

    return candidates.find((candidate) => fs.existsSync(candidate)) || "";
  }

  if (process.platform === "darwin") {
    const candidate = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return fs.existsSync(candidate) ? candidate : "";
  }

  return "";
}

function buildAdminUrl(liveReloadUrl) {
  try {
    const parsed = new URL(liveReloadUrl);
    const basePath = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = `${basePath}/admin/`.replace(/\/{2,}/g, "/");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return `${String(liveReloadUrl).replace(/\/+$/, "")}/admin/`;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createEmptySyncState() {
  return {
    version: 1,
    files: {}
  };
}

function normalizeEpochMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

function ensureSyncStateEntry(syncState, relativePath) {
  if (!syncState.files[relativePath]) {
    syncState.files[relativePath] = {};
  }
  return syncState.files[relativePath];
}

function markSyncedFileState(syncState, relativePath, localHash, remoteModifiedAtMs, source) {
  const entry = ensureSyncStateEntry(syncState, relativePath);
  entry.lastSyncedLocalHash = localHash;
  const normalizedRemote = normalizeEpochMs(remoteModifiedAtMs);
  if (normalizedRemote !== null) {
    entry.lastKnownRemoteModifiedAtMs = normalizedRemote;
  }
  entry.lastSyncedAtMs = Date.now();
  entry.lastSyncSource = source;
}

function hasRemoteChangedSinceBaseline(remoteModifiedAtMs, baselineRemoteModifiedAtMs, toleranceMs) {
  const remoteMs = normalizeEpochMs(remoteModifiedAtMs);
  const baselineMs = normalizeEpochMs(baselineRemoteModifiedAtMs);
  if (remoteMs === null || baselineMs === null) {
    return false;
  }

  return remoteMs > baselineMs + Math.max(0, toleranceMs);
}

function shouldSkipUploadDueConflict(relativePath, localHash, remoteModifiedAtMs, syncState, syncSafety) {
  if (!syncSafety.enabled) {
    return false;
  }

  const entry = syncState.files[relativePath];
  if (!entry?.lastSyncedLocalHash) {
    return false;
  }

  const localChangedSinceLastSync = localHash !== entry.lastSyncedLocalHash;
  const remoteChangedSinceLastSync = hasRemoteChangedSinceBaseline(
    remoteModifiedAtMs,
    entry.lastKnownRemoteModifiedAtMs,
    syncSafety.toleranceMs
  );

  return localChangedSinceLastSync && remoteChangedSinceLastSync;
}

function isFileMissingFtpError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes(" 550") ||
    message.includes("550 ") ||
    message.includes("not found") ||
    message.includes("no such file")
  );
}

async function hashLocalFile(localPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha1");
    const stream = fs.createReadStream(localPath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function loadSyncState() {
  try {
    const raw = await fsp.readFile(SYNC_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.files !== "object") {
      return createEmptySyncState();
    }

    return {
      version: parsed.version || 1,
      files: parsed.files
    };
  } catch (error) {
    const code = error?.code || "";
    if (code === "ENOENT") {
      return createEmptySyncState();
    }
    logError("Failed to read sync state file, using empty state", error);
    return createEmptySyncState();
  }
}

async function saveSyncState(syncState) {
  try {
    const content = `${JSON.stringify(syncState, null, 2)}\n`;
    await fsp.writeFile(SYNC_STATE_FILE, content, "utf8");
  } catch (error) {
    logError("Failed to write sync state file", error);
  }
}

async function openBrowser(config) {
  if (!config.browser.enabled || !config.browser.autoOpen) {
    return;
  }

  const adminUrl = buildAdminUrl(config.liveReloadUrl);
  const existingTargets = await getDebugTargets(config);
  if (existingTargets.length > 0) {
    let hasAdminTab = Boolean(findAdminTarget(existingTargets, adminUrl));
    let hasLiveTab = Boolean(findLiveReloadTarget(existingTargets, config.liveReloadUrl, adminUrl));

    if (!hasAdminTab && (await createDebugTarget(config, adminUrl))) {
      log("Opened admin tab in existing Chrome debug session.");
    }

    if (!hasLiveTab && (await createDebugTarget(config, config.liveReloadUrl))) {
      log("Opened live reload tab in existing Chrome debug session.");
    }

    const refreshedTargets = await getDebugTargets(config);
    hasAdminTab = Boolean(findAdminTarget(refreshedTargets, adminUrl));
    hasLiveTab = Boolean(findLiveReloadTarget(refreshedTargets, config.liveReloadUrl, adminUrl));

    if (hasAdminTab && hasLiveTab) {
      await cleanupChromeUiTabs(config, refreshedTargets, adminUrl);
      log("Admin and live reload tabs are ready.");
      return;
    }
  }

  const chromePath = config.browser.path || guessChromePath();
  const userDataDir =
    config.browser.userDataDir || path.join(ROOT_DIR, ".chrome-live-reload-profile");

  if (chromePath && fs.existsSync(chromePath)) {
    const args = [
      `--remote-debugging-port=${config.browser.debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-sync",
      adminUrl
    ];

    const proc = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore"
    });
    proc.unref();
    log(`Chrome started in debug mode on port ${config.browser.debugPort}`);

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const targets = await getDebugTargets(config);
      if (targets.length > 0) {
        break;
      }
      await sleep(250);
    }

    const targets = await getDebugTargets(config);
    const hasAdminTab = Boolean(findAdminTarget(targets, adminUrl));
    const hasLiveTab = Boolean(findLiveReloadTarget(targets, config.liveReloadUrl, adminUrl));

    if (!hasAdminTab) {
      await createDebugTarget(config, adminUrl);
    }

    if (!hasLiveTab) {
      await createDebugTarget(config, config.liveReloadUrl);
    }

    const finalizedTargets = await getDebugTargets(config);
    await cleanupChromeUiTabs(config, finalizedTargets, adminUrl);

    return;
  }

  await open(adminUrl, { wait: false });
  await open(config.liveReloadUrl, { wait: false });
  log("Browser opened without Chrome debug. Two tabs were opened, but auto reload requires Chrome debug mode.");
}

function requestJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? import("node:https") : import("node:http");
    client
      .then((module) => {
        const request = module.request(url, { method }, (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            if (response.statusCode && response.statusCode >= 400) {
              reject(new Error(`HTTP ${response.statusCode} for ${url}`));
              return;
            }

            if (!data.trim()) {
              resolve(null);
              return;
            }

            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(error);
            }
          });
        });
        request.on("error", reject);
        request.end();
      })
      .catch(reject);
  });
}

function requestText(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? import("node:https") : import("node:http");
    client
      .then((module) => {
        const request = module.request(url, { method }, (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () => {
            if (response.statusCode && response.statusCode >= 400) {
              reject(new Error(`HTTP ${response.statusCode} for ${url}`));
              return;
            }

            resolve(data);
          });
        });
        request.on("error", reject);
        request.end();
      })
      .catch(reject);
  });
}

function normalizeUrlForMatch(value) {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${pathname}`;
  } catch {
    return String(value).replace(/\/+$/, "");
  }
}

function isSameOrChildUrl(targetUrl, baseUrl) {
  const normalizedTarget = normalizeUrlForMatch(targetUrl);
  const normalizedBase = normalizeUrlForMatch(baseUrl);

  if (normalizedTarget === normalizedBase) {
    return true;
  }

  return normalizedTarget.startsWith(`${normalizedBase}/`);
}

function isAdminUrlMatch(targetUrl, adminUrl) {
  return isSameOrChildUrl(targetUrl, adminUrl);
}

function isLiveReloadUrlMatch(targetUrl, liveReloadUrl, adminUrl) {
  if (!isSameOrChildUrl(targetUrl, liveReloadUrl)) {
    return false;
  }

  if (adminUrl && isAdminUrlMatch(targetUrl, adminUrl)) {
    return false;
  }

  return true;
}

function findAdminTarget(targets, adminUrl) {
  return targets.find((item) => {
    if (!item || !item.url || !item.webSocketDebuggerUrl) {
      return false;
    }
    return isAdminUrlMatch(item.url, adminUrl);
  });
}

function findLiveReloadTarget(targets, liveReloadUrl, adminUrl) {
  return targets.find((item) => {
    if (!item || !item.url || !item.webSocketDebuggerUrl) {
      return false;
    }
    return isLiveReloadUrlMatch(item.url, liveReloadUrl, adminUrl);
  });
}

function findLiveReloadTargets(targets, liveReloadUrl, adminUrl) {
  return targets.filter((item) => {
    if (!item || !item.url || !item.webSocketDebuggerUrl) {
      return false;
    }
    return isLiveReloadUrlMatch(item.url, liveReloadUrl, adminUrl);
  });
}

function isClosableChromeUiTab(target, adminUrl, liveReloadUrl) {
  if (!target?.url) {
    return false;
  }

  if (isAdminUrlMatch(target.url, adminUrl) || isLiveReloadUrlMatch(target.url, liveReloadUrl, adminUrl)) {
    return false;
  }

  if (target.type && target.type !== "page") {
    return false;
  }

  const url = String(target.url).toLowerCase();
  if (url === "about:blank") {
    return true;
  }

  if (url.startsWith("chrome://")) {
    return true;
  }

  if (url.startsWith("https://www.google.com/chrome/")) {
    return true;
  }

  if (url.includes("signin") && url.includes("chrome")) {
    return true;
  }

  return false;
}

async function getDebugTargets(config) {
  const debugUrl = `http://127.0.0.1:${config.browser.debugPort}/json/list`;
  try {
    const targets = await requestJson(debugUrl, "GET");
    return Array.isArray(targets) ? targets : [];
  } catch {
    return [];
  }
}

async function createDebugTarget(config, targetUrl) {
  const encodedUrl = encodeURIComponent(targetUrl);
  const base = `http://127.0.0.1:${config.browser.debugPort}/json/new`;
  const attempts = [
    { url: `${base}?url=${encodedUrl}`, method: "PUT" },
    { url: `${base}?${encodedUrl}`, method: "PUT" },
    { url: `${base}?url=${encodedUrl}`, method: "GET" },
    { url: `${base}?${encodedUrl}`, method: "GET" }
  ];

  for (const attempt of attempts) {
    try {
      const rawResponse = await requestText(attempt.url, attempt.method);
      let createdTarget = null;
      try {
        createdTarget = rawResponse?.trim() ? JSON.parse(rawResponse) : null;
      } catch {
        createdTarget = null;
      }
      let createdTargetWs = createdTarget?.webSocketDebuggerUrl || "";
      let createdTargetId = createdTarget?.id || "";
      let createdTargetUrl = createdTarget?.url || "";

      if (!createdTargetWs && createdTargetId) {
        const currentTargets = await getDebugTargets(config);
        const matched = currentTargets.find((item) => item?.id === createdTargetId);
        createdTargetWs = matched?.webSocketDebuggerUrl || "";
        createdTargetUrl = matched?.url || createdTargetUrl;
      }

      if (createdTargetWs && !isSameOrChildUrl(createdTargetUrl || "", targetUrl)) {
        await navigateTargetByWebSocket(createdTargetWs, targetUrl);
      }

      if (await waitForUrlTarget(config, targetUrl, 3000)) {
        return true;
      }

      const navigatedBlank = await navigateFirstBlankTabToUrl(config, targetUrl);
      if (navigatedBlank && (await waitForUrlTarget(config, targetUrl, 2500))) {
        return true;
      }
    } catch {
      // Try next endpoint variant.
    }
  }

  return false;
}

async function closeDebugTarget(config, targetId) {
  const endpoint = `http://127.0.0.1:${config.browser.debugPort}/json/close/${encodeURIComponent(targetId)}`;
  try {
    await requestText(endpoint, "GET");
    return true;
  } catch {
    return false;
  }
}

async function cleanupChromeUiTabs(config, targets, adminUrl) {
  for (const target of targets) {
    if (!target?.id) {
      continue;
    }

    if (!isClosableChromeUiTab(target, adminUrl, config.liveReloadUrl)) {
      continue;
    }

    const closed = await closeDebugTarget(config, target.id);
    if (closed) {
      log(`Closed extra browser tab: ${target.url}`);
    }
  }
}

async function reloadInChrome(config) {
  const adminUrl = buildAdminUrl(config.liveReloadUrl);
  let targets = await getDebugTargets(config);
  let reloadTargets = findLiveReloadTargets(targets, config.liveReloadUrl, adminUrl);
  if (reloadTargets.length === 0 && config.browser.enabled) {
    const opened = await createDebugTarget(config, config.liveReloadUrl);
    if (opened) {
      targets = await getDebugTargets(config);
      reloadTargets = findLiveReloadTargets(targets, config.liveReloadUrl, adminUrl);
      if (reloadTargets.length > 0) {
        log("Live tab was missing and has been reopened.");
      }
    }
  }

  if (reloadTargets.length === 0) {
    log("Live tab not found for reload (expected LIVE_RELOAD_URL target).");
    return false;
  }

  let reloadedCount = 0;
  for (const target of reloadTargets) {
    const reloaded = await hardReloadByWebSocket(target.webSocketDebuggerUrl);
    if (reloaded) {
      reloadedCount += 1;
    }
  }

  return reloadedCount > 0;
}

function hardReloadByWebSocket(webSocketDebuggerUrl) {
  return new Promise((resolve) => {
    let didReload = false;
    const ws = new WebSocket(webSocketDebuggerUrl);
    ws.on("open", () => {
      // Equivalent to Ctrl+Shift+R: clear cache and force reload without cache.
      ws.send(JSON.stringify({ id: 1, method: "Network.enable" }));
      ws.send(JSON.stringify({ id: 2, method: "Network.clearBrowserCache" }));
      ws.send(JSON.stringify({ id: 3, method: "Page.reload", params: { ignoreCache: true } }));
      didReload = true;
      setTimeout(() => {
        ws.close();
      }, 120);
    });
    ws.on("error", () => resolve(false));
    ws.on("close", () => resolve(didReload));
  });
}

function shouldRunModificationRefresh(relativePath, modificationRefreshConfig) {
  if (!modificationRefreshConfig.enabled) {
    return false;
  }

  if (!relativePath) {
    return false;
  }

  const normalizedPath = normalizeLocalRelative(relativePath);

  if (modificationRefreshConfig.paths.length === 0) {
    return true;
  }

  const matchesConfiguredPattern = modificationRefreshConfig.paths.some((pattern) =>
    minimatch(normalizedPath, pattern, { dot: true })
  );

  if (matchesConfiguredPattern) {
    return true;
  }

  // Backward compatibility: legacy configs often specify only catalog paths.
  // In this mode, admin file edits should trigger OCMOD refresh as well.
  if (normalizedPath.startsWith("admin/")) {
    const catalogProbePath = "catalog/__ocmod_refresh_probe__.txt";
    const hasCatalogPattern = modificationRefreshConfig.paths.some((pattern) =>
      minimatch(catalogProbePath, pattern, { dot: true })
    );

    if (hasCatalogPattern) {
      return true;
    }
  }

  return false;
}

function buildModificationRefreshExpression(route) {
  return `(async () => {
    const route = ${JSON.stringify(route)};
    const findTokenFromUrl = () => {
      try {
        const currentUrl = new URL(window.location.href);
        const userToken = currentUrl.searchParams.get("user_token");
        if (userToken) {
          return { key: "user_token", value: userToken };
        }
        const legacyToken = currentUrl.searchParams.get("token");
        if (legacyToken) {
          return { key: "token", value: legacyToken };
        }
      } catch (error) {}
      return null;
    };

    const findTokenFromLinks = () => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        try {
          const parsed = new URL(anchor.getAttribute("href"), window.location.origin);
          const userToken = parsed.searchParams.get("user_token");
          if (userToken) {
            return { key: "user_token", value: userToken };
          }
          const legacyToken = parsed.searchParams.get("token");
          if (legacyToken) {
            return { key: "token", value: legacyToken };
          }
        } catch (error) {}
      }
      return null;
    };

    const token = findTokenFromUrl() || findTokenFromLinks();
    if (!token || !token.value) {
      return { ok: false, reason: "token_not_found", href: window.location.href };
    }

    const refreshUrl = "index.php?route=" + encodeURIComponent(route) +
      "&" + token.key + "=" + encodeURIComponent(token.value);

    try {
      const response = await fetch(refreshUrl, {
        method: "GET",
        credentials: "include",
        redirect: "follow"
      });

      return { ok: response.ok, status: response.status, refreshUrl };
    } catch (error) {
      return {
        ok: false,
        reason: "fetch_failed",
        message: String(error),
        refreshUrl
      };
    }
  })()`;
}

function evaluateInChromeTab(webSocketDebuggerUrl, expression, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    let evaluateMessageId = 0;
    const ws = new WebSocket(webSocketDebuggerUrl);

    const finalize = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // Ignore close errors
      }
      resolve(value);
    };

    const timeout = setTimeout(() => {
      finalize({ ok: false, reason: "timeout" });
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      evaluateMessageId = 2;
      ws.send(
        JSON.stringify({
          id: evaluateMessageId,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true
          }
        })
      );
    });

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (message.id !== evaluateMessageId) {
        return;
      }

      if (message.error) {
        finalize({
          ok: false,
          reason: "cdp_error",
          message: message.error?.message || "Unknown CDP error"
        });
        return;
      }

      if (message.result?.exceptionDetails) {
        finalize({
          ok: false,
          reason: "runtime_exception",
          message: message.result.exceptionDetails.text || "Runtime exception"
        });
        return;
      }

      finalize({
        ok: true,
        value: message.result?.result?.value ?? null
      });
    });

    ws.on("error", (error) => {
      finalize({
        ok: false,
        reason: "ws_error",
        message: error?.message || "WebSocket error"
      });
    });

    ws.on("close", () => {
      if (!settled) {
        finalize({ ok: false, reason: "closed" });
      }
    });
  });
}

async function refreshModificationInChrome(config) {
  const adminUrl = buildAdminUrl(config.liveReloadUrl);
  const targets = await getDebugTargets(config);
  const target = findAdminTarget(targets, adminUrl);

  if (!target?.webSocketDebuggerUrl) {
    log("Admin tab not found for OCMOD refresh.");
    return false;
  }

  const expression = buildModificationRefreshExpression(config.modificationRefresh.route);
  const evaluateResult = await evaluateInChromeTab(target.webSocketDebuggerUrl, expression);
  if (!evaluateResult.ok) {
    logError("Failed to execute OCMOD refresh script in admin tab", new Error(evaluateResult.reason));
    return false;
  }

  const payload = evaluateResult.value;
  if (!payload?.ok) {
    const reason = payload?.reason ? ` (${payload.reason})` : "";
    log(`OCMOD refresh was skipped${reason}.`);
    return false;
  }

  return true;
}

function navigateTargetByWebSocket(webSocketDebuggerUrl, targetUrl) {
  return new Promise((resolve) => {
    let didNavigate = false;
    const ws = new WebSocket(webSocketDebuggerUrl);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Page.enable" }));
      ws.send(JSON.stringify({ id: 2, method: "Page.navigate", params: { url: targetUrl } }));
    });
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message?.id === 2) {
          didNavigate = !message.error;
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        }
      } catch {
        // ignore parse errors
      }
    });
    ws.on("error", () => resolve(false));
    ws.on("close", () => resolve(didNavigate));

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, 2000);
  });
}

async function waitForUrlTarget(config, expectedUrl, timeoutMs = 2500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const targets = await getDebugTargets(config);
    const found = targets.some((item) => {
      if (!item?.url || !item?.webSocketDebuggerUrl) {
        return false;
      }
      return isSameOrChildUrl(item.url, expectedUrl);
    });

    if (found) {
      return true;
    }

    await sleep(180);
  }

  return false;
}

async function navigateFirstBlankTabToUrl(config, targetUrl) {
  const targets = await getDebugTargets(config);
  const blankTabs = targets.filter(
    (item) =>
      item &&
      item.type === "page" &&
      item.url &&
      String(item.url).toLowerCase() === "about:blank" &&
      item.webSocketDebuggerUrl
  );

  const candidate = blankTabs[blankTabs.length - 1];
  if (!candidate?.webSocketDebuggerUrl) {
    return false;
  }

  const navigated = await navigateTargetByWebSocket(candidate.webSocketDebuggerUrl, targetUrl);
  if (navigated) {
    log(`Navigated blank tab to ${targetUrl}`);
  }
  return navigated;
}

async function hardReloadStartupTabs(config) {
  const adminUrl = buildAdminUrl(config.liveReloadUrl);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const targets = await getDebugTargets(config);
    const adminTarget = findAdminTarget(targets, adminUrl);
    const liveTarget = findLiveReloadTarget(targets, config.liveReloadUrl, adminUrl);

    if (adminTarget?.webSocketDebuggerUrl) {
      await hardReloadByWebSocket(adminTarget.webSocketDebuggerUrl);
    }

    if (liveTarget?.webSocketDebuggerUrl) {
      await hardReloadByWebSocket(liveTarget.webSocketDebuggerUrl);
    }

    if (adminTarget && liveTarget) {
      return;
    }

    await sleep(250);
  }
}

function createFtpRunner(config) {
  let client = new ftp.Client(config.ftp.timeoutMs);
  client.ftp.verbose = config.ftp.verbose;
  let connected = false;
  let queue = Promise.resolve();

  async function connect() {
    client.close();
    client = new ftp.Client(config.ftp.timeoutMs);
    client.ftp.verbose = config.ftp.verbose;
    await client.access({
      host: config.ftp.host,
      port: config.ftp.port,
      user: config.ftp.user,
      password: config.ftp.password,
      secure: config.ftp.secure
    });
    connected = true;
    log(`FTP connected: ${config.ftp.host}:${config.ftp.port}`);
  }

  async function runTask(task, options = {}) {
    const {
      suppressRetryLog = false,
      doNotRetry = () => false
    } = options;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        if (!connected || client.closed) {
          await connect();
        }
        return await task(client);
      } catch (error) {
        if (doNotRetry(error)) {
          throw error;
        }

        connected = false;
        client.close();
        if (attempt === 2) {
          throw error;
        }
        if (!suppressRetryLog) {
          logError("FTP operation failed, retrying with reconnect", error);
        }
      }
    }
  }

  function enqueue(task) {
    queue = queue.then(task).catch((error) => {
      logError("Queued FTP task failed", error);
    });
    return queue;
  }

  async function getRemoteFileModifiedAtMs(relativePath) {
    const remotePath = joinRemote(config.ftp.remoteBase, relativePath);
    try {
      const modifiedAt = await runTask(
        (ftpClient) => ftpClient.lastMod(remotePath),
        {
          suppressRetryLog: true,
          doNotRetry: isFileMissingFtpError
        }
      );
      return normalizeEpochMs(modifiedAt?.getTime?.());
    } catch (error) {
      if (isFileMissingFtpError(error)) {
        return null;
      }
      throw error;
    }
  }

  async function upload(relativePath) {
    const localPath = path.join(ROOT_DIR, relativePath);
    const stats = await fsp.stat(localPath);
    if (!stats.isFile()) {
      return;
    }

    const remotePath = joinRemote(config.ftp.remoteBase, relativePath);
    const remoteDir = path.posix.dirname(remotePath);

    await runTask(async (ftpClient) => {
      await ftpClient.ensureDir(remoteDir);
      await ftpClient.uploadFrom(localPath, remotePath);
    });
    log(`UPLOAD ${relativePath}`);
  }

  async function removeFile(relativePath) {
    const remotePath = joinRemote(config.ftp.remoteBase, relativePath);
    await runTask((ftpClient) => ftpClient.remove(remotePath, true));
    log(`DELETE ${relativePath}`);
  }

  async function removeDirectory(relativePath) {
    const remotePath = joinRemote(config.ftp.remoteBase, relativePath);
    await runTask((ftpClient) => ftpClient.removeDir(remotePath));
    log(`DELETE DIR ${relativePath}`);
  }

  async function downloadDirectory(relativePath, pullConfig, excludePatterns = [], hooks = {}) {
    const localBase = path.join(ROOT_DIR, relativePath);
    const remoteBase = joinRemote(config.ftp.remoteBase, relativePath);
    const seen = new Set();
    await fsp.mkdir(localBase, { recursive: true });

    async function walk(remoteDir, localDir) {
      if (typeof hooks.shouldAbort === "function" && hooks.shouldAbort()) {
        return true;
      }

      await fsp.mkdir(localDir, { recursive: true });
      const entries = await runTask((ftpClient) => ftpClient.list(remoteDir));

      for (const entry of entries) {
        if (typeof hooks.shouldAbort === "function" && hooks.shouldAbort()) {
          return true;
        }

        const name = entry.name;
        if (name === "." || name === "..") {
          continue;
        }

        const remotePath = `${remoteDir}/${name}`.replace(/\/+/g, "/");
        const localPath = path.join(localDir, name);
        const relativeLocal = toRelativeFromRoot(localPath);
        if (!relativeLocal) {
          continue;
        }

        if (isIgnored(relativeLocal, excludePatterns)) {
          continue;
        }

        seen.add(relativeLocal);
        if (entry.type === DIR_TYPE) {
          const childAborted = await walk(remotePath, localPath);
          if (childAborted) {
            return true;
          }
          continue;
        }

        if (entry.type !== FILE_TYPE) {
          continue;
        }

        let shouldDownload = true;
        if (pullConfig.downloadNewerOnly) {
          try {
            const stat = await fsp.stat(localPath);
            const remoteModified = entry.modifiedAt?.getTime?.() ?? 0;
            if (remoteModified > 0 && remoteModified <= stat.mtimeMs) {
              shouldDownload = false;
            }
          } catch {
            shouldDownload = true;
          }
        }

        if (shouldDownload) {
          if (typeof hooks.shouldAbort === "function" && hooks.shouldAbort()) {
            return true;
          }

          await runTask((ftpClient) => ftpClient.downloadTo(localPath, remotePath));
          log(`PULL ${relativeLocal}`);
          if (typeof hooks.onDownloadedFile === "function") {
            await hooks.onDownloadedFile({
              relativePath: relativeLocal,
              localPath,
              remoteModifiedAtMs: normalizeEpochMs(entry.modifiedAt?.getTime?.())
            });
          }
        }
      }

      return false;
    }

    const aborted = await walk(remoteBase, localBase);
    if (aborted) {
      return true;
    }

    if (pullConfig.applyDeletes) {
      async function prune(localDir) {
        if (typeof hooks.shouldAbort === "function" && hooks.shouldAbort()) {
          return true;
        }

        const entries = await fsp.readdir(localDir, { withFileTypes: true });
        for (const entry of entries) {
          if (typeof hooks.shouldAbort === "function" && hooks.shouldAbort()) {
            return true;
          }

          const absolute = path.join(localDir, entry.name);
          const relative = toRelativeFromRoot(absolute);
          if (!relative) {
            continue;
          }

          if (entry.isDirectory()) {
            const childAborted = await prune(absolute);
            if (childAborted) {
              return true;
            }

            const remain = await fsp.readdir(absolute);
            if (isIgnored(relative, excludePatterns)) {
              continue;
            }

            if (remain.length === 0 && !seen.has(relative)) {
              if (typeof hooks.shouldSkipPrune === "function") {
                const shouldSkipDir = await hooks.shouldSkipPrune({
                  relativePath: relative,
                  localPath: absolute,
                  isDirectory: true
                });
                if (shouldSkipDir) {
                  log(`SKIP PRUNE DIR ${relative}`);
                  continue;
                }
              }

              await fsp.rmdir(absolute);
              log(`PRUNE DIR ${relative}`);
            }
            continue;
          }

          if (isIgnored(relative, excludePatterns)) {
            continue;
          }

          if (!seen.has(relative)) {
            if (typeof hooks.shouldSkipPrune === "function") {
              const shouldSkipFile = await hooks.shouldSkipPrune({
                relativePath: relative,
                localPath: absolute,
                isDirectory: false
              });
              if (shouldSkipFile) {
                log(`SKIP PRUNE ${relative}`);
                continue;
              }
            }

            await fsp.unlink(absolute);
            log(`PRUNE ${relative}`);
          }
        }

        return false;
      }

      const pruneAborted = await prune(localBase);
      if (pruneAborted) {
        return true;
      }
    }

    return false;
  }

  async function close() {
    connected = false;
    client.close();
  }

  return {
    enqueue,
    getRemoteFileModifiedAtMs,
    upload,
    removeFile,
    removeDirectory,
    downloadDirectory,
    close,
    runTask
  };
}

async function filterExistingPaths(pathsList) {
  const result = [];
  for (const value of pathsList) {
    const absolute = path.resolve(ROOT_DIR, value);
    if (await existsAndIsDir(absolute)) {
      result.push(absolute);
      continue;
    }

    if (fs.existsSync(absolute)) {
      result.push(absolute);
    }
  }
  return result;
}

function createUploadDebouncer(cooldownMs, callback) {
  const timers = new Map();
  return (relativePath) => {
    if (timers.has(relativePath)) {
      clearTimeout(timers.get(relativePath));
    }

    const timeout = setTimeout(async () => {
      timers.delete(relativePath);
      await callback(relativePath);
    }, cooldownMs);
    timers.set(relativePath, timeout);
  };
}

async function runPullCycle(ftpRunner, config, hooks = {}) {
  for (const pullPath of config.pull.paths) {
    if (typeof hooks.shouldAbort === "function" && hooks.shouldAbort()) {
      return true;
    }

    if (!pullPath) {
      continue;
    }

    if (isIgnored(pullPath, config.watch.exclude)) {
      continue;
    }

    const aborted = await ftpRunner.downloadDirectory(
      pullPath,
      config.pull,
      config.watch.exclude,
      hooks
    );

    if (aborted) {
      return true;
    }
  }

  return false;
}

async function main() {
  const config = createConfig();
  const pullOnly = process.argv.includes("--pull-only");
  const ftpRunner = createFtpRunner(config);
  const syncState = await loadSyncState();
  let syncStateSaveTimer = null;

  const scheduleSyncStateSave = () => {
    if (!config.syncSafety.enabled) {
      return;
    }

    if (syncStateSaveTimer) {
      clearTimeout(syncStateSaveTimer);
    }

    syncStateSaveTimer = setTimeout(() => {
      syncStateSaveTimer = null;
      void saveSyncState(syncState);
    }, 400);
  };

  const saveSyncStateNow = async () => {
    if (!config.syncSafety.enabled) {
      return;
    }

    if (syncStateSaveTimer) {
      clearTimeout(syncStateSaveTimer);
      syncStateSaveTimer = null;
    }

    await saveSyncState(syncState);
  };

  const includePaths = config.watch.include.map(normalizeLocalRelative);
  const startupUploadPaths = config.watch.startupPaths;
  const localWatchPaths = await filterExistingPaths(includePaths);
  let suppressWatcherEvents = false;
  let suppressWatcherEventsUntil = 0;
  let pullInProgress = false;
  let pullAbortRequested = false;
  let pullCycleStartedAtMs = 0;
  const pullPruneGraceMs = Math.max(0, config.pull.pruneGraceSec * 1000);
  const pulledPathsInCurrentCycle = new Set();
  const deferredUploads = new Set();
  let enqueueDeferredUpload = null;

  const isWatcherSuppressed = () => suppressWatcherEvents || Date.now() < suppressWatcherEventsUntil;

  const markDeferredUpload = (relativePath) => {
    if (!relativePath) {
      return;
    }
    deferredUploads.add(relativePath);
  };

  const flushDeferredUploads = () => {
    if (!enqueueDeferredUpload || deferredUploads.size === 0) {
      return;
    }

    const pending = Array.from(deferredUploads);
    deferredUploads.clear();
    for (const relativePath of pending) {
      enqueueDeferredUpload(relativePath);
      log(`DEFERRED UPLOAD ${relativePath}`);
    }
  };

  const shouldProtectLocalPathFromPrune = async (localPath, relativePath) => {
    if (deferredUploads.has(relativePath)) {
      return true;
    }

    try {
      const stat = await fsp.stat(localPath);
      if (!stat.isFile() && !stat.isDirectory()) {
        return false;
      }

      const threshold = pullCycleStartedAtMs - pullPruneGraceMs;
      return stat.mtimeMs >= threshold;
    } catch {
      return false;
    }
  };

  const runPullCycleWithWatcherSuppressed = async () => {
    pullCycleStartedAtMs = Date.now();
    pulledPathsInCurrentCycle.clear();
    pullInProgress = true;
    pullAbortRequested = false;
    suppressWatcherEvents = true;
    try {
      const wasAborted = await runPullCycle(ftpRunner, config, {
        onDownloadedFile: async ({ relativePath, localPath, remoteModifiedAtMs }) => {
          pulledPathsInCurrentCycle.add(relativePath);
          if (!config.syncSafety.enabled) {
            return;
          }

          const localHash = await hashLocalFile(localPath);
          markSyncedFileState(syncState, relativePath, localHash, remoteModifiedAtMs, "pull");
          scheduleSyncStateSave();
        },
        shouldAbort: () => pullAbortRequested,
        shouldSkipPrune: async ({ relativePath, localPath }) => {
          return shouldProtectLocalPathFromPrune(localPath, relativePath);
        }
      });

      if (wasAborted) {
        log("PULL cycle interrupted by local file changes.");
      }
    } finally {
      pullInProgress = false;
      suppressWatcherEvents = false;
      // Small grace period to ignore trailing FS events from pull writes.
      suppressWatcherEventsUntil = Date.now() + 1200;
      flushDeferredUploads();
      pulledPathsInCurrentCycle.clear();
    }
  };

  if (localWatchPaths.length === 0) {
    throw new Error("No watchable paths found. Set WATCH_UPLOAD_PATHS in .env.ftp.");
  }

  log(`Remote base: ${config.ftp.remoteBase}`);
  log(`Watch paths: ${includePaths.join(", ")}`);
  if (config.pull.enabled) {
    log(`Pull paths: ${config.pull.paths.join(", ")}`);
  }
  if (config.syncSafety.enabled) {
    log(`Safe upload mode: enabled (tolerance ${config.syncSafety.toleranceMs}ms)`);
  }
  if (config.modificationRefresh.enabled) {
    const mode = config.modificationRefresh.paths.length > 0
      ? config.modificationRefresh.paths.join(", ")
      : "ALL WATCHED FILES";
    log(`OCMOD auto refresh: enabled (${mode})`);
  }

  if (pullOnly) {
    log("Running one-time pull from hosting...");
    await runPullCycleWithWatcherSuppressed();
    log("Pull finished.");
    await saveSyncStateNow();
    await ftpRunner.close();
    return;
  }

  if (config.pull.enabled) {
    await ftpRunner.enqueue(() => runPullCycleWithWatcherSuppressed());
  }

  await openBrowser(config);
  await hardReloadStartupTabs(config);

  if (startupUploadPaths.length > 0) {
    log("Uploading INITIAL_UPLOAD_PATHS...");
    for (const relativePath of startupUploadPaths) {
      if (isIgnored(relativePath, config.watch.exclude)) {
        continue;
      }

      await ftpRunner.enqueue(async () => {
        await ftpRunner.upload(relativePath);
        if (!config.syncSafety.enabled) {
          return;
        }

        const localPath = path.join(ROOT_DIR, relativePath);
        const localHash = await hashLocalFile(localPath);
        const remoteModifiedAtMs = await ftpRunner.getRemoteFileModifiedAtMs(relativePath);
        markSyncedFileState(syncState, relativePath, localHash, remoteModifiedAtMs, "upload");
        scheduleSyncStateSave();
      });
    }
  }

  let lastModificationRefreshAt = 0;

  const uploadWithSafety = async (relativePath) => {
    const localPath = path.join(ROOT_DIR, relativePath);
    const localHash = await hashLocalFile(localPath);

    let remoteModifiedAtMsBeforeUpload = null;
    if (config.syncSafety.enabled) {
      remoteModifiedAtMsBeforeUpload = await ftpRunner.getRemoteFileModifiedAtMs(relativePath);
      const hasConflict = shouldSkipUploadDueConflict(
        relativePath,
        localHash,
        remoteModifiedAtMsBeforeUpload,
        syncState,
        config.syncSafety
      );

      if (hasConflict) {
        log(
          `CONFLICT ${relativePath} (remote changed since last sync). Upload skipped to avoid overwrite.`
        );
        return false;
      }
    }

    await ftpRunner.upload(relativePath);

    if (config.syncSafety.enabled) {
      const remoteModifiedAtMsAfterUpload =
        await ftpRunner.getRemoteFileModifiedAtMs(relativePath);
      const resolvedRemoteModifiedAtMs =
        normalizeEpochMs(remoteModifiedAtMsAfterUpload) ??
        normalizeEpochMs(remoteModifiedAtMsBeforeUpload) ??
        Date.now();

      markSyncedFileState(
        syncState,
        relativePath,
        localHash,
        resolvedRemoteModifiedAtMs,
        "upload"
      );
      scheduleSyncStateSave();
    }

    return true;
  };

  const uploadDebounced = createUploadDebouncer(config.watch.uploadCooldownMs, async (relativePath) => {
    await ftpRunner.enqueue(async () => {
      const uploaded = await uploadWithSafety(relativePath);
      if (!uploaded) {
        return;
      }

      if (shouldRunModificationRefresh(relativePath, config.modificationRefresh)) {
        const elapsed = Date.now() - lastModificationRefreshAt;
        const remainingCooldown = config.modificationRefresh.cooldownMs - elapsed;
        if (remainingCooldown > 0) {
          await sleep(remainingCooldown);
        }

        const refreshed = await refreshModificationInChrome(config);
        if (refreshed) {
          lastModificationRefreshAt = Date.now();
          log(`OCMOD refresh completed (trigger: ${relativePath}).`);
        }
      }

      const reloaded = await reloadInChrome(config);
      if (reloaded) {
        log(`RELOAD ${config.liveReloadUrl}`);
      }
    });
  });
  enqueueDeferredUpload = (relativePath) => uploadDebounced(relativePath);

  const watcher = chokidar.watch(localWatchPaths, {
    persistent: true,
    ignoreInitial: true,
    usePolling: config.watch.usePolling,
    interval: config.watch.interval,
    awaitWriteFinish: {
      stabilityThreshold: 250,
      pollInterval: 100
    }
  });

  const handleRelative = (absolutePath) => {
    const relative = toRelativeFromRoot(absolutePath);
    if (!relative) {
      return null;
    }

    if (!isPathInsideAny(relative, includePaths)) {
      return null;
    }

    if (isIgnored(relative, config.watch.exclude)) {
      return null;
    }

    return relative;
  };

  watcher.on("add", (absolutePath) => {
    const relative = handleRelative(absolutePath);
    if (!relative) {
      return;
    }

    if (isWatcherSuppressed()) {
      if (!pulledPathsInCurrentCycle.has(relative)) {
        markDeferredUpload(relative);
        if (pullInProgress) {
          pullAbortRequested = true;
        }
      }
      return;
    }

    uploadDebounced(relative);
  });

  watcher.on("change", (absolutePath) => {
    const relative = handleRelative(absolutePath);
    if (!relative) {
      return;
    }

    if (isWatcherSuppressed()) {
      if (!pulledPathsInCurrentCycle.has(relative)) {
        markDeferredUpload(relative);
        if (pullInProgress) {
          pullAbortRequested = true;
        }
      }
      return;
    }

    uploadDebounced(relative);
  });

  watcher.on("unlink", (absolutePath) => {
    if (isWatcherSuppressed()) {
      return;
    }

    const relative = handleRelative(absolutePath);
    if (!relative) {
      return;
    }

    ftpRunner.enqueue(() => ftpRunner.removeFile(relative));
  });

  watcher.on("unlinkDir", (absolutePath) => {
    if (isWatcherSuppressed()) {
      return;
    }

    const relative = handleRelative(absolutePath);
    if (!relative) {
      return;
    }

    ftpRunner.enqueue(() => ftpRunner.removeDirectory(relative));
  });

  watcher.on("error", (error) => logError("Watcher error", error));

  let pullIntervalTimer = null;
  if (config.pull.enabled && config.pull.intervalSec > 0) {
    pullIntervalTimer = setInterval(() => {
      ftpRunner.enqueue(() => runPullCycleWithWatcherSuppressed());
    }, config.pull.intervalSec * 1000);
  }

  const shutdown = async () => {
    log("Stopping dev sync...");
    if (pullIntervalTimer) {
      clearInterval(pullIntervalTimer);
    }
    await saveSyncStateNow();
    await watcher.close();
    await ftpRunner.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log("Watcher started. Waiting for file changes...");
}

main().catch((error) => {
  logError("Fatal error", error);
  process.exit(1);
});
