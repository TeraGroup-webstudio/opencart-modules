#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import dotenv from "dotenv";

const ROOT_DIR = process.cwd();
const LOCAL_ENV_PATH = path.join(ROOT_DIR, ".env.ftp");
const SHARED_ENV_PATH = path.join(ROOT_DIR, ".env.ftp.shared");
const EXAMPLE_ENV_PATH = path.join(ROOT_DIR, ".env.ftp.example");
const REQUIRED_LOCAL_OVERRIDES = {
  REMOTE_PULL_ENABLED: "true"
};

function readIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  return fs.readFileSync(filePath, "utf8");
}

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (hasValue(value)) {
      return value.trim();
    }
  }
  return "";
}

function parseEnv(text) {
  if (!text) {
    return {};
  }

  try {
    return dotenv.parse(text);
  } catch {
    return {};
  }
}

function escapeEnvValue(value) {
  if (!/[\s#"']/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function upsertEnvValue(sourceText, key, value) {
  const lines = sourceText.split(/\r?\n/u);
  const normalizedValue = escapeEnvValue(value);
  const matcher = new RegExp(`^\\s*${key}\\s*=`, "u");
  let replaced = false;

  const output = lines.map((line) => {
    if (!matcher.test(line)) {
      return line;
    }
    replaced = true;
    return `${key}=${normalizedValue}`;
  });

  if (!replaced) {
    output.push(`${key}=${normalizedValue}`);
  }

  return output.join("\n").replace(/\n?$/u, "\n");
}

function mergeMissingSharedSettings(localText, sharedText) {
  const localEnv = parseEnv(localText);
  const sharedEnv = parseEnv(sharedText);
  let mergedText = localText;
  let insertedCount = 0;

  for (const [key, value] of Object.entries(sharedEnv)) {
    if (Object.prototype.hasOwnProperty.call(localEnv, key)) {
      continue;
    }

    mergedText = upsertEnvValue(mergedText, key, value ?? "");
    localEnv[key] = value ?? "";
    insertedCount += 1;
  }

  if (insertedCount > 0) {
    process.stdout.write(
      `Added ${insertedCount} missing setting(s) to local .env.ftp from .env.ftp.shared\n`
    );
  }

  return mergedText;
}

function enforceLocalOverrides(sourceText) {
  const localEnv = parseEnv(sourceText);
  let outputText = sourceText;
  const changedKeys = [];

  for (const [key, requiredValue] of Object.entries(REQUIRED_LOCAL_OVERRIDES)) {
    const currentValue = hasValue(localEnv[key]) ? localEnv[key].trim() : "";
    if (currentValue === requiredValue) {
      continue;
    }

    outputText = upsertEnvValue(outputText, key, requiredValue);
    localEnv[key] = requiredValue;
    changedKeys.push(`${key}=${requiredValue}`);
  }

  if (changedKeys.length > 0) {
    process.stdout.write(`Enforced local setting(s): ${changedKeys.join(", ")}\n`);
  }

  return outputText;
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function ensureLocalEnvFile() {
  if (fs.existsSync(LOCAL_ENV_PATH)) {
    return;
  }

  const sharedText = readIfExists(SHARED_ENV_PATH);
  if (sharedText) {
    fs.writeFileSync(LOCAL_ENV_PATH, sharedText, "utf8");
    process.stdout.write("Created .env.ftp from .env.ftp.shared\n");
    return;
  }

  const exampleText = readIfExists(EXAMPLE_ENV_PATH);
  if (exampleText) {
    fs.writeFileSync(LOCAL_ENV_PATH, exampleText, "utf8");
    process.stdout.write("Created .env.ftp from .env.ftp.example\n");
    return;
  }

  throw new Error("Cannot create .env.ftp. Add .env.ftp.shared or .env.ftp.example.");
}

async function ensurePassword(localText, sharedText) {
  const localEnv = parseEnv(localText);
  if (hasValue(localEnv.FTP_PASSWORD)) {
    return localText;
  }

  const sharedEnv = parseEnv(sharedText);
  let password = firstNonEmpty(
    process.env.FTP_PASSWORD,
    process.env.FTP_PASSWORD_GLOBAL,
    process.env.DEV_FTP_PASSWORD,
    sharedEnv.FTP_PASSWORD
  );

  if (!password && process.stdin.isTTY && process.stdout.isTTY) {
    password = await promptLine("Enter FTP_PASSWORD (saved only in local .env.ftp): ");
  }

  if (!password) {
    throw new Error(
      "FTP_PASSWORD is missing. Set global env FTP_PASSWORD or fill .env.ftp once."
    );
  }

  process.stdout.write("Saved FTP_PASSWORD to local .env.ftp\n");
  return upsertEnvValue(localText, "FTP_PASSWORD", password);
}

async function main() {
  await ensureLocalEnvFile();

  const localText = readIfExists(LOCAL_ENV_PATH);
  const sharedText = readIfExists(SHARED_ENV_PATH);
  const withMissingSharedSettings = mergeMissingSharedSettings(localText, sharedText);
  const withPassword = await ensurePassword(withMissingSharedSettings, sharedText);
  const updatedText = enforceLocalOverrides(withPassword);

  if (updatedText !== localText) {
    fs.writeFileSync(LOCAL_ENV_PATH, updatedText, "utf8");
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
