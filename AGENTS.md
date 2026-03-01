# x-reader

CLI tool that extracts actionable information from X (Twitter) posts and reply threads.

## Architecture

Single-pass pipeline: `CLI → Browser → Extractor → Classifier → Storage`

```
src/cli.ts          Entry point, arg parsing, orchestration
src/browser.ts      agent-browser CLI wrapper (Bun.spawn, auto-connect or CDP)
src/extractor.ts    Navigate, scroll, parse accessibility snapshots into Tweet objects
src/classifier.ts   Regex-based keyword heuristics for actionable content
src/storage.ts      File I/O, wrench stub
src/types.ts        All interfaces and error types
```

## Runtime

- TypeScript on Bun
- Browser automation via `agent-browser` CLI (`--auto-connect` to user's Chrome)
- No frameworks, no HTTP server — pure CLI
- Build standalone binary: `bun run build`

## Data Flow

1. User passes an X post URL
2. `browser.ts` opens the URL via `agent-browser --auto-connect` (or `--cdp <port>`)
3. `extractor.ts` takes accessibility snapshots, scrolls to collect replies (max 50, depth 2)
4. Quoted tweets extracted via 3-phase state machine (detects `text: Quote` → link container → children)
5. Recommended/trending posts filtered by view count comparison against main post
6. `classifier.ts` tags tweets matching keyword patterns (code, best_practice, recommendation, lesson_learned)
7. `storage.ts` writes `data/{status_id}.json`

## Key Conventions

- Config loaded from `config.json` at project root (optional). CLI args override config values. Hardcoded defaults as fallback.
- CLI args: `--cdp`, `--browser`, `--max-replies`, `--max-depth`, `--data-dir`. `X_READER_DATA_DIR` env var overrides `data_dir`.
- Auth detection: if snapshot has no article elements and no Conversation region but contains login prompts, throws `AuthRequiredError` and exits 1.
- `notifyWrench()` in storage.ts is a stub (`console.error`) — transport TBD.
- Snapshot parsing is heuristic-based against agent-browser's accessibility tree format. If X DOM changes break extraction, `extractor.ts` is the single file to update.
- Scroll errors (navigation context destroyed) are caught and retried — X triggers internal navigations during scrolling.

## Output Schema

Output files follow `XReaderOutput` (schema_version "1.0") defined in `src/types.ts`. Key fields: `main_post`, `replies`, `actionable_items`, `external_links`.

## x-bookmarks

Companion CLI that iterates over X bookmarks, extracts each via x-reader's pipeline, and removes the bookmark after processing.

### Entry Point

`src/bookmarks.ts` — standalone CLI, same pattern as `cli.ts`.

### Flow

1. Open `https://x.com/i/bookmarks`, take accessibility snapshot
2. Auth wall check (same heuristic as extractor)
3. Parse first bookmark URL from article elements (`/username/status/ID`)
4. If `data/{statusId}.json` exists → skip extraction, still remove bookmark
5. Otherwise → `extract()` + `classify()` + `save()`
6. Scroll to top of post, find bookmark toggle button, click to remove
7. Track seen IDs — same bookmark appearing twice = removal failed, break
8. Loop back to step 1

### CLI Args

Same flags as x-reader minus positional URL, plus `--limit <n>`.

### Run

```
bun run bookmarks -- --limit 5
bun run build:bookmarks && ./x-bookmarks --limit 5
```

## Testing

No test framework configured. Manual verification:
```
bun run src/cli.ts https://x.com/<user>/status/<id>
cat data/<id>.json
```
