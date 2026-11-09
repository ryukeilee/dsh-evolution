// Reverse the valid-UTF-8 archive-digest round before the older pinned
// baselines reconstruct their trees.
//
// That round lets the digest-only walk hash a block's raw bytes when the block
// is valid UTF-8: decoding and re-encoding reproduces exactly those bytes, so
// the historical digest is unchanged. Invalid UTF-8 still takes the decoded
// form. The reverse restores the unconditional decode, then hands the result to
// the archive-digest-walk round's own reversal.
//
// The hunks are the exact inverse of this round's `lib/dockyard-domain/memory.js`
// diff, applied newest-change-first. The single-occurrence assertion makes a
// stale anchor fail loudly instead of reconstructing a third tree.
import assert from "node:assert/strict";
import { reverseArchiveDigestWalkRound } from "./archive-digest-walk-baseline.js";

const FILE = "lib/dockyard-domain/memory.js";

const HUNKS = [
  {
    post: "import { createHash, randomUUID } from \"node:crypto\";\nimport { isUtf8 } from \"node:buffer\";\n",
    pre: "import { createHash, randomUUID } from \"node:crypto\";\n",
  },
  {
    post: "        const bytes = buffer.subarray(0, lastBreak + 1);\n        // A valid UTF-8 block hashes to the same bytes whether it is passed as\n        // the buffer or decoded and re-encoded, so the digest-only caller can\n        // hash the bytes directly. Invalid UTF-8 still takes the decoded form:\n        // its replacement characters are part of the historical digest.\n        const text = onLine || !hash || !isUtf8(bytes) ? bytes.toString(\"utf8\") : null;\n        if (hash) {\n          if (text === null) hash.update(bytes);\n          else hash.update(text, \"utf8\");\n        }\n",
    pre: "        const text = buffer.toString(\"utf8\", 0, lastBreak + 1);\n        hash?.update(text, \"utf8\");\n",
  },
];

/**
 * Reverse the valid-UTF-8 digest round, then hand the result to the older
 * chain. Each anchor must occur exactly once, so a stale hunk cannot silently
 * reconstruct something else.
 */
export function reverseArchiveDigestUtf8Round(file, source) {
  if (file === FILE) {
    for (const { post: shape, pre: original } of HUNKS) {
      assert.equal(source.split(shape).length - 1, 1,
        `${file}: archive-digest-utf8 reversal anchor must occur exactly once`);
      source = source.replace(shape, original);
    }
  }
  return reverseArchiveDigestWalkRound(file, source);
}
