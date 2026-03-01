# x-reader

Extract actionable content from X posts and reply threads.

Pulls code snippets, best practices, recommendations, and lessons learned from a post and its replies, then writes structured JSON for downstream processing.

## Prerequisites

- [Bun](https://bun.sh) (v1.0+)
- [agent-browser](https://www.npmjs.com/package/agent-browser) (`npm install -g agent-browser && agent-browser install`)
- Chrome/Chromium with remote debugging enabled

## Setup

```bash
bun install
```

## Build

```bash
bun run build
```

Produces a standalone `./x-reader` binary — no `src/` or `node_modules/` needed.

## Usage

```bash
# From source
bun run src/cli.ts <url>

# Or after building
./x-reader <url>
```

Example:

```bash
./x-reader https://x.com/karpathy/status/1234567890
./x-reader https://x.com/karpathy/status/1234567890 --max-replies 10
./x-reader https://x.com/karpathy/status/1234567890 --cdp 9222
```

Output is written to `data/{status_id}.json`.

### CLI Options

```
--cdp <port>         Connect to Chrome via CDP port
--browser <engine>   Browser engine: chromium, firefox, webkit
--max-replies <n>    Max replies to collect (default: 50)
--max-depth <n>      Reply thread depth (default: 2)
--data-dir <path>    Output directory (default: ./data)
-h, --help           Show help
```

### Authentication

x-reader connects to your existing Chrome via `--auto-connect`. Make sure Chrome has remote debugging enabled and you're logged into X.

If connecting to a specific CDP port:

```bash
./x-reader https://x.com/user/status/123 --cdp 9222
```

## Configuration

Optional `config.json` in project root. CLI args override config values.

| Key | Default | Description |
|---|---|---|
| `browser` | `chromium` | Browser engine |
| `cdp_port` | `null` | CDP port (`null` = auto-connect) |
| `max_depth` | `2` | Reply thread depth |
| `max_replies` | `50` | Max replies to collect |
| `data_dir` | `./data` | Output directory (override with `X_READER_DATA_DIR` env var) |

## Output Format

```json
{
  "schema_version": "1.0",
  "url": "https://x.com/user/status/123",
  "status_id": "123",
  "extracted_at": "2026-02-28T12:00:00.000Z",
  "main_post": { "author": "@user", "text": "...", "..." : "..." },
  "replies": [],
  "actionable_items": [
    { "type": "code", "text": "...", "source_author": "@user" }
  ],
  "external_links": ["https://example.com"]
}
```

Actionable item types: `code`, `best_practice`, `recommendation`, `lesson_learned`.
