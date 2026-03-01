#!/usr/bin/env bun

import { resolve } from "path";
import { AuthRequiredError } from "./types";
import type { Config, XReaderOutput } from "./types";
import { ensureDataDir, save, notifyWrench } from "./storage";
import { configure } from "./browser";
import { extract } from "./extractor";
import { classify } from "./classifier";

const DEFAULTS: Config = {
  browser: "chromium",
  cdp_port: null,
  max_depth: 2,
  max_replies: 50,
  data_dir: "./data",
};

async function loadConfig(): Promise<Config> {
  const configPath = resolve(process.cwd(), "config.json");
  let config: Config = { ...DEFAULTS };

  try {
    const raw = await Bun.file(configPath).text();
    config = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // No config.json — use defaults + CLI args
  }

  return config;
}

function parseArgs(config: Config): { url: string; config: Config } {
  const args = process.argv.slice(2);
  let url = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--cdp":
        config.cdp_port = parseInt(args[++i], 10);
        break;
      case "--browser":
        config.browser = args[++i] as Config["browser"];
        break;
      case "--max-replies":
        config.max_replies = parseInt(args[++i], 10);
        break;
      case "--max-depth":
        config.max_depth = parseInt(args[++i], 10);
        break;
      case "--data-dir":
        config.data_dir = args[++i];
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (!arg.startsWith("--")) {
          url = arg;
        } else {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  if (process.env.X_READER_DATA_DIR) {
    config.data_dir = process.env.X_READER_DATA_DIR;
  }

  if (!config.data_dir.startsWith("/")) {
    config.data_dir = resolve(process.cwd(), config.data_dir);
  }

  return { url, config };
}

function printHelp(): void {
  console.log(`Usage: x-reader <url> [options]

Extract actionable content from X posts and reply threads.

Options:
  --cdp <port>         Connect to Chrome via CDP port
  --browser <engine>   Browser engine: chromium, firefox, webkit
  --max-replies <n>    Max replies to collect (default: 50)
  --max-depth <n>      Reply thread depth (default: 2)
  --data-dir <path>    Output directory (default: ./data)
  -h, --help           Show this help

Example:
  x-reader https://x.com/user/status/1234567890
  x-reader https://x.com/user/status/1234567890 --cdp 9222
  x-reader https://x.com/user/status/1234567890 --max-replies 10`);
}

function parseStatusId(url: string): string {
  const match = url.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (!match) {
    throw new Error(
      `Invalid X/Twitter URL: ${url}\nExpected format: https://x.com/<user>/status/<id>`,
    );
  }
  return match[1];
}

function validateUrl(url: string): string {
  let normalized = url.replace("twitter.com", "x.com");
  if (!normalized.startsWith("https://")) {
    normalized = `https://${normalized.replace(/^http:\/\//, "")}`;
  }
  return normalized.split("?")[0].split("#")[0];
}

async function main(): Promise<void> {
  if (process.argv.length < 3) {
    printHelp();
    process.exit(1);
  }

  const fileConfig = await loadConfig();
  const { url, config } = parseArgs(fileConfig);

  if (!url) {
    printHelp();
    process.exit(1);
  }

  configure(config);

  const normalized = validateUrl(url);
  const statusId = parseStatusId(normalized);

  await ensureDataDir(config);

  console.log(`Extracting: ${normalized}`);
  console.log(`Status ID:  ${statusId}`);

  const { mainPost, replies } = await extract(normalized, config);

  const allTweets = [mainPost, ...replies];
  const actionableItems = classify(allTweets);

  const externalLinks = [
    ...new Set(
      allTweets
        .flatMap((t) => t.urls)
        .filter((u) => !u.includes("x.com") && !u.includes("twitter.com")),
    ),
  ];

  const output: XReaderOutput = {
    schema_version: "1.0",
    url: normalized,
    status_id: statusId,
    extracted_at: new Date().toISOString(),
    main_post: mainPost,
    replies,
    actionable_items: actionableItems,
    external_links: externalLinks,
  };

  const filePath = await save(statusId, output, config);

  console.log("");
  console.log(`Main post:   ${mainPost.author}`);
  console.log(`Replies:     ${replies.length}`);
  console.log(`Actionables: ${actionableItems.length}`);
  console.log(`Ext links:   ${externalLinks.length}`);
  console.log(`Output:      ${filePath}`);
}

main().catch((err) => {
  if (err instanceof AuthRequiredError) {
    notifyWrench(err.message);
    console.error(`Error: ${err.message}`);
    console.error("Pre-authenticate agent-browser session and retry.");
    process.exit(1);
  }
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
