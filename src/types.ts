export interface XReaderOutput {
  schema_version: "1.0";
  url: string;
  status_id: string;
  extracted_at: string;
  main_post: Tweet;
  replies: Tweet[];
  actionable_items: ActionableItem[];
  external_links: string[];
}

export interface Tweet {
  author: string;
  display_name: string;
  text: string;
  timestamp: string;
  depth: number;
  urls: string[];
}

export interface ActionableItem {
  type: "code" | "best_practice" | "recommendation" | "lesson_learned";
  text: string;
  source_author: string;
}

export interface Config {
  browser: "chromium" | "firefox" | "webkit";
  cdp_port: number | null;
  max_depth: number;
  max_replies: number;
  data_dir: string;
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required — X login wall detected");
    this.name = "AuthRequiredError";
  }
}
