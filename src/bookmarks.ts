#!/usr/bin/env bun

import { join, resolve } from "path";
import { AuthRequiredError } from "./types";
import type { Config, XReaderOutput } from "./types";
import { ensureDataDir, save, notifyWrench } from "./storage";
import {
  configure,
  open,
  waitForLoad,
  snapshot,
  click,
  scroll,
  wait,
} from "./browser";
import { extract } from "./extractor";
import { classify } from "./classifier";

const DEFAULTS: Config = {
  browser: "chromium",
  cdp_port: null,
  max_depth: 2,
  max_replies: 50,
  data_dir: "./data",
  ignore_ids: [],
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

function parseArgs(config: Config): { limit: number; config: Config } {
  const args = process.argv.slice(2);
  let limit = Infinity;

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
      case "--limit":
        limit = parseInt(args[++i], 10);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith("--")) {
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

  return { limit, config };
}

function printHelp(): void {
  console.log(`Usage: x-bookmarks [options]

Process X bookmarks: extract content from each bookmarked post and remove the bookmark.

Options:
  --limit <n>          Max bookmarks to process (default: all)
  --cdp <port>         Connect to Chrome via CDP port
  --browser <engine>   Browser engine: chromium, firefox, webkit
  --max-replies <n>    Max replies per post (default: 50)
  --max-depth <n>      Reply thread depth (default: 2)
  --data-dir <path>    Output directory (default: ./data)
  -h, --help           Show this help

Example:
  x-bookmarks --limit 5
  x-bookmarks --cdp 9222 --limit 10`);
}

function parseBookmarkUrls(snap: string): string[] {
  const urls: string[] = [];
  const lines = snap.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const stripped = trimmed.replace(/^-\s+/, "");

    if (!stripped.startsWith("article ")) continue;

    const articleIndent = line.length - trimmed.length;

    // Collect the LAST /status/ URL in each article.
    // For reply bookmarks, the first URL is often the parent post
    // (from "in reply to" context); the reply's own URL appears later
    // in the timestamp link.
    let lastUrl = "";
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine.trim() === "") continue;
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      if (nextIndent <= articleIndent) break;

      const urlMatch = nextLine.match(/\/url:\s+\/([\w]+)\/status\/(\d+)/);
      if (urlMatch) {
        lastUrl = `https://x.com/${urlMatch[1]}/status/${urlMatch[2]}`;
      }
    }
    if (lastUrl) {
      urls.push(lastUrl);
    }
  }

  return urls;
}

function parseStatusId(url: string): string {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : "";
}

async function removeBookmarkFromList(
  bookmarksSnap: string,
  url: string,
  articleIndex: number = 0,
): Promise<boolean> {
  const statusId = parseStatusId(url);

  // On the bookmarks page, every article has a "Bookmarked" button.
  // Click the one at articleIndex to un-bookmark the target post.
  const bookmarkMatches = [
    ...bookmarksSnap.matchAll(/button "Bookmarked" \[ref=(e\d+)\]/g),
  ];
  if (bookmarkMatches.length > articleIndex) {
    await click(`@${bookmarkMatches[articleIndex][1]}`);
    await wait(2000);

    // Verify removal: snapshot again and check target is gone
    const verifySnap = await snapshot();
    const verifyUrls = parseBookmarkUrls(verifySnap);
    const stillPresent = verifyUrls.length > 0 && parseStatusId(verifyUrls[0]) === statusId;
    if (!stillPresent) {
      console.log("  Removed from bookmarks list (verified)");
      return true;
    }
    console.warn("  Click registered but bookmark still present");
    return false;
  }

  // Fallback: three-dot menu (article elements have no [ref], so find
  // the first "More" button that appears inside an article region).
  const menuMatch = bookmarksSnap.match(
    /button "More" \[ref=(e\d+)\]/,
  );
  if (menuMatch) {
    await click(`@${menuMatch[1]}`);
    await wait(1500);
    const menuSnap = await snapshot();
    const removeMatch = menuSnap.match(
      /menuitem "(?:Remove|Delete)[^"]*(?:bookmark|Bookmark)[^"]*" \[ref=(e\d+)\]/i,
    );
    if (removeMatch) {
      await click(`@${removeMatch[1]}`);
      await wait(2000);
      console.log("  Removed via menu");
      return true;
    }
  }

  // Last resort: navigate to the tweet and try the bookmark button
  console.warn("  Could not remove from list, trying post page...");
  await open(url);
  await waitForLoad();
  return await removeBookmark();
}

async function removeBookmark(): Promise<boolean> {
  await scroll("up", 10000);
  await wait(1000);

  const snap = await snapshot();

  // Only match buttons indicating the post IS bookmarked.
  // Plain "Bookmark" means NOT bookmarked — clicking it would ADD a bookmark.
  const bookmarkRegex =
    /button "(?:Bookmarked|Remove bookmark|Unbookmark)[^"]*" \[ref=(e\d+)\]/gi;
  const matches = [...snap.matchAll(bookmarkRegex)];

  if (matches.length === 0) {
    console.warn(
      "  No active bookmark button found — bookmark may already be removed",
    );
    return false;
  }

  await click(`@${matches[0][1]}`);
  await wait(2000);

  // Verify: snapshot again and check the button changed state
  const verifySnap = await snapshot();
  const stillBookmarked =
    /button "(?:Bookmarked|Remove bookmark|Unbookmark)[^"]*"/i.test(verifySnap);
  if (stillBookmarked) {
    // Try once more
    const retryMatch = verifySnap.match(
      /button "(?:Bookmarked|Remove bookmark|Unbookmark)[^"]*" \[ref=(e\d+)\]/i,
    );
    if (retryMatch) {
      await click(`@${retryMatch[1]}`);
      await wait(2000);
    }
  }

  console.log("  Bookmark removed");
  return true;
}

async function main(): Promise<void> {
  const fileConfig = await loadConfig();
  const { limit, config } = parseArgs(fileConfig);

  configure(config);
  await ensureDataDir(config);

  let processed = 0;
  const seenIds = new Set<string>();
  const retryCounts = new Map<string, number>();
  const stuckIds = new Set<string>();
  const ignoreSet = new Set(config.ignore_ids);
  const MAX_RETRIES_PER_ID = 2;
  const MAX_STUCK_IDS = 5;

  console.log("Opening bookmarks page...");

  while (processed < limit) {
    await open("https://x.com/i/bookmarks");
    await waitForLoad();
    // Bookmarks page loads content async — wait for articles to appear
    await wait(3000);

    const snap = await snapshot();

    const hasArticle = /^\s*-?\s*article /m.test(snap);
    if (!hasArticle) {
      const lower = snap.toLowerCase();
      if (
        lower.includes("sign in") ||
        lower.includes("log in") ||
        lower.includes("create your account")
      ) {
        throw new AuthRequiredError();
      }
      console.log("No more bookmarks found. Done.");
      break;
    }

    const bookmarkUrls = parseBookmarkUrls(snap);
    if (bookmarkUrls.length === 0) {
      console.log("No bookmark URLs found. Done.");
      break;
    }

    // Find the first actionable bookmark (skip ignored and stuck)
    let articleIndex = 0;
    let url = "";
    let statusId = "";
    for (let i = 0; i < bookmarkUrls.length; i++) {
      const id = parseStatusId(bookmarkUrls[i]);
      if (!id) continue;
      if (ignoreSet.has(id) || stuckIds.has(id)) continue;
      url = bookmarkUrls[i];
      statusId = id;
      articleIndex = i;
      break;
    }

    if (!statusId) {
      console.log("No actionable bookmarks remaining. Done.");
      break;
    }

    if (seenIds.has(statusId)) {
      const retries = retryCounts.get(statusId) ?? 0;
      retryCounts.set(statusId, retries + 1);

      if (retries < MAX_RETRIES_PER_ID) {
        console.warn(
          `  Bookmark ${statusId} reappeared, retrying removal... (attempt ${retries + 1}/${MAX_RETRIES_PER_ID})`,
        );
        const removed = await removeBookmarkFromList(snap, url, articleIndex);
        if (!removed) {
          console.warn("  List removal failed, escalating to post page...");
          await open(url);
          await waitForLoad();
          await removeBookmark();
        }
        continue;
      }

      // Retries exhausted — mark as stuck
      stuckIds.add(statusId);
      console.warn(
        `  Bookmark ${statusId} stuck after ${MAX_RETRIES_PER_ID} attempts (deleted post?)`,
      );

      if (stuckIds.size >= MAX_STUCK_IDS) {
        console.error(
          `${MAX_STUCK_IDS}+ distinct stuck bookmarks. Stopping.`,
        );
        break;
      }
      continue;
    }
    seenIds.add(statusId);

    console.log(
      `\n[${processed + 1}/${limit === Infinity ? "?" : limit}] ${url}`,
    );

    // Remove bookmark from the list page FIRST (we're already here).
    // This avoids reply-page confusion where scrolling to top finds the
    // parent post's bookmark button instead of the actual bookmarked reply.
    console.log("  Removing bookmark...");
    await removeBookmarkFromList(snap, url, articleIndex);

    const outputPath = join(config.data_dir, `${statusId}.json`);
    const alreadyExtracted = await Bun.file(outputPath).exists();

    if (alreadyExtracted) {
      console.log("  Already extracted, skipping...");
    } else {
      console.log("  Extracting...");
      const { mainPost, replies } = await extract(url, config);

      const allTweets = [mainPost, ...replies];
      const actionableItems = classify(allTweets);

      const externalLinks = [
        ...new Set(
          allTweets
            .flatMap((t) => t.urls)
            .filter(
              (u) => !u.includes("x.com") && !u.includes("twitter.com"),
            ),
        ),
      ];

      const output: XReaderOutput = {
        schema_version: "1.0",
        url,
        status_id: statusId,
        extracted_at: new Date().toISOString(),
        main_post: mainPost,
        replies,
        actionable_items: actionableItems,
        external_links: externalLinks,
      };

      const filePath = await save(statusId, output, config);
      console.log(`  Saved: ${filePath}`);
      console.log(
        `  Replies: ${replies.length}, Actionables: ${actionableItems.length}`,
      );
    }

    processed++;
  }

  console.log(`\nProcessed ${processed} bookmark(s).`);

  if (stuckIds.size > 0) {
    const ids = [...stuckIds].map((id) => `    "${id}"`).join(",\n");
    console.log(
      `\n${stuckIds.size} bookmark(s) could not be removed (likely deleted posts).` +
        `\nAdd them to ignore_ids in config.json to skip on future runs:\n` +
        `\n  "ignore_ids": [\n${ids}\n  ]`,
    );
  }
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
