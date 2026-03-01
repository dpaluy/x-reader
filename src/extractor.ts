import { open, waitForLoad, snapshot, scroll, click, wait, evaluate } from "./browser";
import { AuthRequiredError } from "./types";
import type { Tweet, Config, MediaItem } from "./types";

interface ExtractionResult {
  mainPost: Tweet;
  replies: Tweet[];
}

interface ParsedArticle extends Tweet {
  _views: number;
  _imageCount: number;
}

export async function extract(
  url: string,
  config: Config,
): Promise<ExtractionResult> {
  await open(url);
  await waitForLoad();

  const initialSnap = await snapshot();
  detectAuthWall(initialSnap);

  const { mainPost, mainPostViews, mainPostImageCount } = parseMainPost(initialSnap);
  const mainPostKey = `${mainPost.author}:${mainPost.text.slice(0, 80)}`;

  // Resolve media URLs for main post before scrolling away from it
  if (mainPostImageCount > 0) {
    const allMedia = await extractMediaUrls();
    if (allMedia.length > 0) {
      mainPost.media = buildMediaItems(mainPostImageCount, allMedia[0]);
    }
  }

  // Click "Read N replies" button if present (logged-out view)
  await expandReplies(initialSnap);

  // Scroll past the main post to reach replies
  // Long-form articles can be 5000+ px, so do big initial scrolls
  for (let i = 0; i < 5; i++) {
    try {
      await scroll("down", 3000);
      await wait(800);
    } catch {
      // Navigation context may be destroyed if X redirects; wait and continue
      await wait(2000);
    }
  }

  const replies: Tweet[] = [];
  const seenKeys = new Set<string>();
  seenKeys.add(mainPostKey);
  let emptyScrolls = 0;
  const MAX_EMPTY_SCROLLS = 5;

  // Collect replies by scrolling
  while (replies.length < config.max_replies && emptyScrolls < MAX_EMPTY_SCROLLS) {
    const snap = await snapshot();
    const articles = parseArticles(snap);
    let newCount = 0;
    let needsMediaResolve = false;

    const newReplies: { tweet: Tweet; imageCount: number }[] = [];
    for (const article of articles) {
      // Skip recommended/trending posts injected by X into the thread.
      // Real replies never have more views than the parent post.
      if (mainPostViews > 0 && article._views > mainPostViews) continue;

      const key = `${article.author}:${article.text.slice(0, 80)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const { _views, _imageCount, ...tweet } = article;
      newReplies.push({ tweet: { ...tweet, depth: 1 }, imageCount: _imageCount });
      if (_imageCount > 0) needsMediaResolve = true;
      newCount++;
      if (replies.length + newCount >= config.max_replies) break;
    }

    // Resolve media for new replies that have images
    if (needsMediaResolve) {
      const allMedia = await extractMediaUrls();
      // Map articles from snapshot to media by position
      for (let ai = 0; ai < newReplies.length; ai++) {
        const r = newReplies[ai];
        if (r.imageCount > 0) {
          // Find matching article media — articles includes main post + replies visible on screen
          // We search allMedia for one with the right image count
          for (let mi = 0; mi < allMedia.length; mi++) {
            if (allMedia[mi].length === r.imageCount) {
              r.tweet.media = buildMediaItems(r.imageCount, allMedia[mi]);
              allMedia.splice(mi, 1); // consume it
              break;
            }
          }
        }
      }
    }

    for (const r of newReplies) {
      replies.push(r.tweet);
    }

    emptyScrolls = newCount > 0 ? 0 : emptyScrolls + 1;
    if (replies.length < config.max_replies) {
      try {
        await scroll("down", 1500);
        await wait(1000);
      } catch {
        await wait(2000);
      }
    }
  }

  return { mainPost, replies };
}

async function expandReplies(snap: string): Promise<void> {
  // Look for "Read N replies" button ref
  const match = snap.match(/button "Read \d+ repl(?:y|ies)[^"]*" \[ref=(e\d+)\]/);
  if (match) {
    try {
      await click(`@${match[1]}`);
      await wait(2000);
    } catch {
      // Button may have disappeared, continue
    }
  }
}

/**
 * Auth wall: if there's NO article element and the page is a login prompt.
 * The sidebar always has "Log in" / "Sign up" links — that's NOT an auth wall.
 * An auth wall means the main content is blocked.
 */
function detectAuthWall(snap: string): void {
  const hasArticle = /^\s*article /m.test(snap);
  const hasConversation = snap.includes('region "Conversation"');
  if (!hasArticle && !hasConversation) {
    const lower = snap.toLowerCase();
    if (lower.includes("sign in") || lower.includes("log in") || lower.includes("create your account")) {
      throw new AuthRequiredError();
    }
  }
}

function parseMainPost(snap: string): { mainPost: Tweet; mainPostViews: number; mainPostImageCount: number } {
  const articles = parseArticles(snap);
  if (articles.length > 0) {
    const { _views, _imageCount, ...tweet } = articles[0];
    return { mainPost: { ...tweet, depth: 0 }, mainPostViews: _views, mainPostImageCount: _imageCount };
  }
  return {
    mainPost: {
      author: "unknown",
      display_name: "Unknown",
      text: collectAllText(snap),
      timestamp: new Date().toISOString(),
      depth: 0,
      urls: collectAllUrls(snap),
      media: [],
    },
    mainPostViews: 0,
    mainPostImageCount: 0,
  };
}

/**
 * Parse the agent-browser accessibility tree into Tweet objects.
 *
 * Real format (indentation-based tree):
 *   article "author Verified account @handle ..." [ref=eN]:
 *     link "author Verified account" [ref=eN]:
 *       /url: /handle
 *       text: author
 *     link "@handle" [ref=eN]:
 *       /url: /handle
 *     text: Tweet content here
 *     text: "More content in quotes"
 *     heading "Section title" [ref=eN] [level=2]
 *     code: some code block
 *     link "display text" [ref=eN]:
 *       /url: https://example.com
 *     link "Jan 15, 2026" [ref=eN]:
 *       time: Jan 15, 2026
 */
function parseArticles(snap: string): ParsedArticle[] {
  const articles: ParsedArticle[] = [];
  const lines = snap.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Find article elements — these are tweet boundaries
    // Lines look like: "- article ..." or "article:" (bare, for main posts)
    const stripped = trimmed.replace(/^-\s+/, "");
    if (!/^article[\s:]/.test(stripped)) continue;

    // Determine the indentation of this article
    const articleIndent = line.length - trimmed.length;

    // Extract handle from article description: @handle
    const handleMatch = stripped.match(/@(\w{1,15})\b/);
    let author = handleMatch ? `@${handleMatch[1]}` : "unknown";

    // Extract view count from article description: "N views"
    const viewsMatch = stripped.match(/(\d+)\s+views/);
    const views = viewsMatch ? parseInt(viewsMatch[1], 10) : 0;

    // Collect all lines belonging to this article (deeper indentation)
    // Preserve original lines so parseArticleContent can use indentation
    const articleLines: string[] = [];
    const childIndent = articleIndent + 2; // direct children indent level
    let j = i + 1;
    while (j < lines.length) {
      const nextLine = lines[j];
      if (nextLine.trim() === "") { j++; continue; }
      const nextIndent = nextLine.length - nextLine.trimStart().length;
      if (nextIndent <= articleIndent) break;
      articleLines.push(nextLine);
      j++;
    }

    // For bare articles (main post), extract handle from child links
    if (author === "unknown") {
      for (const childLine of articleLines.slice(0, 10)) {
        const childHandle = childLine.trimStart().replace(/^-\s+/, "").match(/^link "@(\w{1,15})"/);
        if (childHandle) {
          author = `@${childHandle[1]}`;
          break;
        }
      }
    }

    const tweet = parseArticleContent(author, articleLines, childIndent);
    if (tweet.text.length > 0) {
      articles.push({ ...tweet, _views: views, _imageCount: tweet._imageCount });
    }

    i = j - 1; // advance past this article
  }

  return articles;
}

function parseArticleContent(
  author: string,
  rawLines: string[],
  childIndent: number,
): Tweet & { _imageCount: number } {
  let displayName = author.replace("@", "");
  let displayNameFound = false;
  let timestamp = "";
  let imageCount = 0;
  const textParts: string[] = [];
  const urls: string[] = [];

  // State for quoted tweet extraction
  // Phase 0 = not in quote, 1 = saw "text: Quote", 2 = inside quote link's children
  let quotePhase: 0 | 1 | 2 = 0;
  let quoteAuthor = "";
  let quoteTextCount = 0;
  const quoteParts: string[] = [];

  for (let li = 0; li < rawLines.length; li++) {
    const rawLine = rawLines[li];
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.replace(/^[\s-]+/, "");
    const isDirectChild = indent <= childIndent;

    // Display name: only from author link, stop after first match
    if (!displayNameFound) {
      const displayMatch = line.match(/link "([^"]+?)(?:\s+Verified account)?" \[ref=/);
      if (displayMatch && !displayMatch[1].startsWith("@") && !displayMatch[1].match(/\d+ views/)) {
        displayName = displayMatch[1].trim();
        displayNameFound = true;
      }
    }

    // Extract timestamps and URLs from any depth (but not from inside quotes)
    if (quotePhase === 0) {
      const timeMatch = line.match(/^time:\s+(.+)$/);
      if (timeMatch) { timestamp = timeMatch[1].trim(); continue; }
    }

    const urlMatch = line.match(/^\/url:\s+(https?:\/\/.+)$/);
    if (urlMatch) {
      const u = urlMatch[1].trim();
      if (!u.match(/(?:x\.com|twitter\.com)\//)) {
        urls.push(u);
      }
      continue;
    }

    // Quoted tweet detection (3-phase state machine):
    // Phase 0: normal — look for "text: Quote" at direct child level
    // Phase 1: saw "text: Quote" — next direct child link is the quote container
    // Phase 2: inside quote link's children — collect text until back to direct child
    if (quotePhase === 0 && isDirectChild && line === "text: Quote") {
      quotePhase = 1;
      continue;
    }

    if (quotePhase === 1 && isDirectChild && line.startsWith("link ")) {
      quotePhase = 2;
      continue; // skip the link line itself, its children are the content
    }

    if (quotePhase === 2) {
      if (isDirectChild) {
        // Back to direct child level — quote section is over
        quotePhase = 0;
        // Fall through to normal handling
      } else {
        // Inside the quote link's children — collect text
        const qtText = line.match(/^text:\s+(.+)$/);
        if (qtText) {
          quoteTextCount++;
          const val = stripQuotes(qtText[1].trim());
          // First text node is display name, second is @handle — capture as author
          if (quoteTextCount === 1) {
            quoteAuthor = val;
            continue;
          }
          if (quoteTextCount === 2 && val.startsWith("@")) {
            quoteAuthor = val;
            continue;
          }
          // Skip "Show more", media errors, short fragments
          if (
            val.length > 3 &&
            !val.startsWith("Show more") &&
            !val.includes("media could not be played")
          ) {
            quoteParts.push(val);
          }
        }
        continue;
      }
    }

    // Only collect content from direct children
    if (!isDirectChild) continue;

    // Detect link "Image" — media placeholder
    if (/^link "Image"/.test(line)) {
      imageCount++;
      textParts.push(`[image:${imageCount}]`);
      continue;
    }

    // Text content
    const textMatch = line.match(/^text:\s+(.+)$/);
    if (textMatch) {
      const val = stripQuotes(textMatch[1].trim());
      if (val.length > 2 && !val.match(/^\d+[KM]?$/) && !val.startsWith("Want to publish")) {
        textParts.push(val);
      }
      continue;
    }

    // Headings
    const headingMatch = line.match(/^heading "([^"]+)" \[ref=/);
    if (headingMatch) {
      textParts.push(headingMatch[1]);
      continue;
    }

    // Code blocks
    const codeMatch = line.match(/^code:\s+(.+)$/);
    if (codeMatch) {
      textParts.push("```\n" + stripQuotes(codeMatch[1]) + "\n```");
      continue;
    }
  }

  // Append quoted tweet if found
  if (quoteParts.length > 0) {
    const header = quoteAuthor ? `\n\n> Quoted ${quoteAuthor}:` : "\n\n> Quoted:";
    textParts.push(header + "\n> " + quoteParts.join("\n> "));
  }

  return {
    author,
    display_name: displayName,
    text: textParts.join("\n").slice(0, 5000),
    timestamp: timestamp || new Date().toISOString(),
    depth: 0,
    urls: [...new Set(urls)],
    media: [],
    _imageCount: imageCount,
  };
}

async function extractMediaUrls(): Promise<{ src: string; alt: string }[][]> {
  const js = `Array.from(document.querySelectorAll('article')).map(a =>
    Array.from(a.querySelectorAll('img'))
      .filter(i => i.src.includes('pbs.twimg.com/media/'))
      .map(i => ({ src: i.src.replace('name=medium', 'name=large'), alt: i.alt || '' }))
  )`;
  try {
    const raw = await evaluate(js);
    return JSON.parse(raw.trim());
  } catch {
    return [];
  }
}

function buildMediaItems(
  imageCount: number,
  urls: { src: string; alt: string }[],
): MediaItem[] {
  const items: MediaItem[] = [];
  for (let i = 0; i < imageCount; i++) {
    const url = urls[i];
    if (url) {
      items.push({ index: i + 1, url: url.src, alt: url.alt || undefined });
    }
  }
  return items;
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function collectAllText(snap: string): string {
  const parts: string[] = [];
  for (const rawLine of snap.split("\n")) {
    const line = rawLine.replace(/^[\s-]+/, "");
    const m = line.match(/^text:\s+(.+)$/);
    if (m) parts.push(stripQuotes(m[1].trim()));
  }
  return parts.join(" ").slice(0, 5000);
}

function collectAllUrls(snap: string): string[] {
  const urls: string[] = [];
  for (const rawLine of snap.split("\n")) {
    const line = rawLine.replace(/^[\s-]+/, "");
    const m = line.match(/^\/url:\s+(https?:\/\/.+)$/);
    if (m) urls.push(m[1].trim());
  }
  return [...new Set(urls)];
}
