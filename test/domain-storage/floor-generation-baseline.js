// Reverse the retention floor file-generation round before older pinned
// baselines. That round records the originating dev/ino on an ambiguous floor
// and asks the shared classifier before the byte-prefix shortcut; each anchor
// must occur exactly once, and the reversed source is pinned to the commit this
// round started from.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const PINS = {
  "lib/domain-storage.js": "e545ec0be33750cf6de50e40ee13e8ff84ac282e6a87afb2178e323023f8755d",
};

const HUNKS = [
  {
    file: "lib/domain-storage.js",
    post: "    // `ambiguousPrefix` and `identity` are optional: a floor written before the\n" +
      "    // generation fix has neither, and must keep loading unchanged. When both are\n" +
      "    // present the classifier uses dev/ino to tell a pending truncation from a\n" +
      "    // later generation whose bytes happen to be identical.\n" +
      "    prior: z.object({\n" +
      "      bytes: z.number().int().positive(), digest: z.string().regex(/^[0-9a-f]{64}$/),\n" +
      "      ambiguousPrefix: z.literal(true).optional(),\n" +
      "      identity: z.object({ dev: z.string().min(1), ino: z.string().min(1) }).strict().optional(),\n" +
      "    }).strict().superRefine((value, ctx) => {\n" +
      "      if ((value.ambiguousPrefix === true) !== Boolean(value.identity)) {\n" +
      "        ctx.addIssue({ code: 'custom', path: ['identity'], message: 'an ambiguous floor must carry exactly one file identity' });\n" +
      "      }\n" +
      "    }),\n",
    pre: "    prior: z.object({ bytes: z.number().int().positive(), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),\n",
  },
  {
    file: "lib/domain-storage.js",
    post: "    // Ask the shared classifier first on a dry run. An ambiguous prior file can\n" +
      "    // also match the retained tail by bytes, so checking the tail first reported\n" +
      "    // `ready` and hid a committed-but-unfinished truncation.\n" +
      "    if (dryRun && source.status === 'readable'\n" +
      "      && inspectEventLogFloor({ file: source.file, key: config.eventBridgeKey, floor: retention }).status === 'deferred') return 'pending-truncation';\n" +
      "    if (source.status === 'readable' && verifyLogFloorTail({ buffer: source.bytes, floor, key: config.eventBridgeKey })) return 'ready';\n",
    pre: "    if (source.status === 'readable' && verifyLogFloorTail({ buffer: source.bytes, floor, key: config.eventBridgeKey })) return 'ready';\n" +
      "    if (dryRun && source.status === 'readable'\n" +
      "      && inspectEventLogFloor({ file: source.file, key: config.eventBridgeKey, floor: retention }).status === 'deferred') return 'pending-truncation';\n",
  },
  {
    file: "lib/domain-storage.js",
    post: "    // The floor needs the file's generation, not only its bytes: a duplicate\n" +
      "    // record can make the retained tail equal the prior file's prefix, and the\n" +
      "    // same bytes reappear after a completed truncation plus later appends.\n" +
      "    const logStat = fs.statSync(source.file, { bigint: true });\n" +
      "    const plan = planLogPrune({ buffer: source.bytes, key, writer, applied: recovered, retainRecords,\n" +
      "      identity: { dev: logStat.dev, ino: logStat.ino } });\n",
    pre: "    const plan = planLogPrune({ buffer: source.bytes, key, writer, applied: recovered, retainRecords });\n",
  },
  {
    file: "lib/domain-storage.js",
    post: "            const logStat = fs.statSync(source.file, { bigint: true });\n" +
      "            const plan = planLogPrune({ buffer: source.bytes, key: config.eventBridgeKey, writer: eventBridgeWriterName(),\n" +
      "              applied: domain.global.get().applied, retainRecords,\n" +
      "              identity: { dev: logStat.dev, ino: logStat.ino } });\n",
    pre: "            const plan = planLogPrune({ buffer: source.bytes, key: config.eventBridgeKey, writer: eventBridgeWriterName(), applied: domain.global.get().applied, retainRecords });\n",
  },
];

export function reverseFloorGenerationRound(file, source) {
  if (PINS[file] === undefined) return source;
  for (const { file: target, post, pre } of HUNKS) {
    if (target !== file) continue;
    assert.equal(source.split(post).length - 1, 1, `${file}: floor generation reversal anchor must occur exactly once`);
    source = source.replace(post, pre);
  }
  assert.equal(createHash("sha256").update(source).digest("hex"), PINS[file], `${file}: reversed source must equal e545ec0`);
  return source;
}
