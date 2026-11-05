// Reverse the knowledge-hot-window round before older pinned baselines
// reconstruct their trees.
//
// That round bounds the hot canonical-knowledge window of a file-backed store
// with its own constant instead of `maxEntries`. The differential baselines below
// rebuild older trees by reversing rounds newest-first, so this round's two
// hunks have to be undone before the first of them, or their anchors and pins no
// longer describe history. There is no digest pin of its own for the same reason
// the quality round has none: the older chain's own pin covers the bytes this
// reversal has to restore.
import assert from 'node:assert/strict';
import { reverseInheritedDecisionRound } from './autonomous-decision-baseline.js';

const FILE = 'lib/dockyard-domain/memory.js';

const HUNKS = [
  {
    post: "const DEFAULT_ARCHIVE_TARGET_BYTES = 8 * 1024 * 1024;\n" +
      "const DEFAULT_ARCHIVE_HARD_CEILING_BYTES = 16 * 1024 * 1024;\n" +
      "// Rows of canonical knowledge that stay in the hot window of a file-backed\n" +
      "// store. This is deliberately smaller than `maxEntries` (the non-archive bound):\n" +
      "// every durable commit writes the whole aggregate - and an archive-changing\n" +
      "// transaction writes it twice, once in the pending record and once as the\n" +
      "// committed document - so a 1,000-row knowledge window is most of a multi-MB\n" +
      "// payload per observation, while the cold archive already holds the complete\n" +
      "// history and every read merges through it. `maxEntries` still caps the window\n" +
      "// when it is configured smaller than this bound, and the non-archive bound is\n" +
      "// unchanged for stores without a durable archive.\n" +
      "const KNOWLEDGE_HOT_ENTRIES = 200;\n",
    pre: "const DEFAULT_ARCHIVE_TARGET_BYTES = 8 * 1024 * 1024;\n" +
      "const DEFAULT_ARCHIVE_HARD_CEILING_BYTES = 16 * 1024 * 1024;\n",
  },
  {
    post: "  #hotLimit(collection) { return collection === \"cycles\" ? this.hotCycles : collection === \"knowledge\" ? Math.min(this.maxEntries, KNOWLEDGE_HOT_ENTRIES) : this.hotEntries; }",
    pre: "  #hotLimit(collection) { return collection === \"cycles\" ? this.hotCycles : collection === \"knowledge\" ? this.maxEntries : this.hotEntries; }",
  },
];

/**
 * Reverse the knowledge-hot-window round, then hand the result to the older
 * chain. Each anchor must occur exactly once, so a stale hunk cannot silently
 * reconstruct something else.
 */
export function reverseKnowledgeHotWindowRound(file, source) {
  if (file === FILE) {
    for (const { post, pre } of HUNKS) {
      assert.equal(source.split(post).length - 1, 1, `${file}: knowledge-hot-window reversal anchor must occur exactly once`);
      source = source.replace(post, pre);
    }
  }
  return reverseInheritedDecisionRound(file, source);
}
