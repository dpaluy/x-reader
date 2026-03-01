import type { Tweet, ActionableItem } from "./types";

const PATTERNS: Record<ActionableItem["type"], RegExp> = {
  code: /`[^`]+`|```|\b(function|const|import|npm|pip|git|yarn|bun|cargo|brew)\b|=>|def\s+\w+/i,
  best_practice:
    /\b(always|never|should|make sure|pro.?tip|best practice|pattern|rule of thumb)\b/i,
  recommendation:
    /\b(recommend|try|check out|switch to|better than|use|look into|suggest|prefer)\b/i,
  lesson_learned:
    /\bTIL\b|\b(learned|mistake|gotcha|turns? out|realized|the hard way|hindsight|discovered)\b/i,
};

const MAX_TEXT = 500;

export function classify(tweets: Tweet[]): ActionableItem[] {
  const items: ActionableItem[] = [];

  for (const tweet of tweets) {
    for (const [type, pattern] of Object.entries(PATTERNS) as [
      ActionableItem["type"],
      RegExp,
    ][]) {
      if (pattern.test(tweet.text)) {
        items.push({
          type,
          text: tweet.text.slice(0, MAX_TEXT),
          source_author: tweet.author,
        });
      }
    }
  }

  return items;
}
