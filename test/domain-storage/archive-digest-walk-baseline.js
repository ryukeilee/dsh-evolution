// Reverse the archive-digest-walk round before the older pinned baselines
// reconstruct their trees.
//
// That round stops `#walkArchiveLines()` from splitting a block into lines when
// the caller only wants the digest: the hash has already covered exactly the
// text those lines would be cut from, so the per-line slice and byte length had
// no consumer. The reverse restores the unconditional split; every older round
// then reverses from the source it was pinned against.
//
// The hunks are the exact inverse of this round's `lib/dockyard-domain/memory.js`
// diff, applied newest-change-first. The single-occurrence assertion makes a
// stale anchor fail loudly instead of reconstructing a third tree.
import assert from "node:assert/strict";
import { reverseRetentionPlanStreamingRound } from "./retention-plan-streaming-baseline.js";

const FILE = "lib/dockyard-domain/memory.js";

const HUNKS = [
  {
    post: "        const text = buffer.toString(\"utf8\", 0, lastBreak + 1);\n        hash?.update(text, \"utf8\");\n        // The digest-only caller (`#archiveFileDigest`) has no line consumer, and\n        // the hash above already covers exactly the text those lines would be cut\n        // from. Cutting them apart would only compute a line number, a slice and\n        // a raw length that nobody reads; skipping it leaves the bytes read, the\n        // digest input and every read error exactly as they were.\n        if (onLine) {\n          // Decoded text is not a byte-for-byte view of `buffer` when the bytes are\n          // not valid UTF-8: one replacement character is three bytes where the\n          // bytes it replaced were fewer, and a replacement never makes the text\n          // shorter. So a read whose decoded byte length equals its byte count has\n          // per-line decoded lengths that are its raw lengths; any other read takes\n          // the raw bounds from the bytes themselves.\n          const exact = Buffer.byteLength(text) === lastBreak + 1;\n          let rawFrom = 0;\n          let from = 0;\n          for (;;) {\n            const index = text.indexOf(\"\\n\", from);\n            if (index < 0) break;\n            const lineText = text.slice(from, index);\n            let rawBytes;\n            if (exact) rawBytes = Buffer.byteLength(lineText);\n            else {\n              const rawEnd = buffer.indexOf(NEWLINE_BYTE, rawFrom);\n              rawBytes = rawEnd - rawFrom;\n              rawFrom = rawEnd + 1;\n            }\n            onLine(lineText, ++line, true, rawBytes);\n            from = index + 1;\n          }\n        }\n",
    pre: "        const text = buffer.toString(\"utf8\", 0, lastBreak + 1);\n        hash?.update(text, \"utf8\");\n        // Decoded text is not a byte-for-byte view of `buffer` when the bytes are\n        // not valid UTF-8: one replacement character is three bytes where the\n        // bytes it replaced were fewer, and a replacement never makes the text\n        // shorter. So a read whose decoded byte length equals its byte count has\n        // per-line decoded lengths that are its raw lengths; any other read takes\n        // the raw bounds from the bytes themselves.\n        const exact = Buffer.byteLength(text) === lastBreak + 1;\n        let rawFrom = 0;\n        let from = 0;\n        for (;;) {\n          const index = text.indexOf(\"\\n\", from);\n          if (index < 0) break;\n          const lineText = text.slice(from, index);\n          let rawBytes;\n          if (exact) rawBytes = Buffer.byteLength(lineText);\n          else {\n            const rawEnd = buffer.indexOf(NEWLINE_BYTE, rawFrom);\n            rawBytes = rawEnd - rawFrom;\n            rawFrom = rawEnd + 1;\n          }\n          onLine?.(lineText, ++line, true, rawBytes);\n          from = index + 1;\n        }\n",
  },
];

/**
 * Reverse the archive-digest-walk round, then hand the result to the older
 * chain. Each anchor must occur exactly once, so a stale hunk cannot silently
 * reconstruct something else.
 */
export function reverseArchiveDigestWalkRound(file, source) {
  if (file === FILE) {
    for (const { post: shape, pre: original } of HUNKS) {
      assert.equal(source.split(shape).length - 1, 1,
        `${file}: archive-digest-walk reversal anchor must occur exactly once`);
      source = source.replace(shape, original);
    }
  }
  return reverseRetentionPlanStreamingRound(file, source);
}
