// Reverse only the inherited-autonomous-decision round before older pinned
// baselines.
//
// This round adds a read-only `autonomousDecisions()` port method and the
// open-time snapshot it serves: `lib/domain-storage.js` observes the decision
// reservations the root already held, so the observer can tell a reservation no
// process can resolve any more from one a live record still answers for. The
// three hunks below are exactly the added lines, so reversing them reconstructs
// the bytes the older rounds were written against and their own pins still hold.
import assert from 'node:assert/strict';
import { reverseMarkerWindowRound } from './marker-window-baseline.js';

const FILE = 'lib/domain-storage.js';

const HUNKS = [
  {
    post: "  let memory, observations;\n" +
      "  // The decision reservations this root already held when this port opened it.\n" +
      "  // Captured because opening is the only moment that is provably before this\n" +
      "  // process can take a reservation of its own; `autonomousDecisions()` serves it.\n" +
      "  let inheritedDecisions = [];\n",
    pre: "  let memory, observations;\n",
  },
  {
    post: "      await replay();\n" +
      "      // Read after replay, so a decision the event log restored is part of the\n" +
      "      // snapshot, and before anything here can reserve one itself. Only the\n" +
      "      // identities are kept: this is a read of committed state, not evidence.\n" +
      "      const inherited = domain.global.get()?.aggregate?.evolution?.autonomous?.observerDecisions;\n" +
      "      inheritedDecisions = Array.isArray(inherited) ? inherited.filter(identity => typeof identity === 'string') : [];\n",
    pre: "      await replay();\n",
  },
  {
    post: "  return Object.freeze({\n" +
      "    // The decision reservations this root exported before this port opened it.\n" +
      "    //\n" +
      "    // `reserveAutonomousDecision` is taken before a Trial touches the runner and\n" +
      "    // released by every outcome the session can still prove, so a process that\n" +
      "    // ends between the two leaves a reservation no process can resolve any more:\n" +
      "    // the Trial it described did not survive, which means there is no record to\n" +
      "    // promote and no cleanup to retry. This read is what lets the observer tell\n" +
      "    // such an inherited reservation from one a live record still answers for. It\n" +
      "    // is bounded to the identities the reservation itself keeps (200) and it is\n" +
      "    // read-only: nothing here releases, writes or decides.\n" +
      "    autonomousDecisions: () => enqueue(() => [...inheritedDecisions]),\n",
    pre: "  return Object.freeze({\n",
  },
];

/**
 * Reverse the inherited-decision round, then hand the result to the older chain.
 *
 * The order is newest round first: this round sits on top of everything
 * `reverseMarkerWindowRound` reverses, and that call ends by asserting the
 * historical digest of the tree below it. A partial reversal therefore cannot
 * pass quietly - each anchor must occur exactly once, or the reconstruction stops
 * here - and there is no digest of its own to fake, because the older pin already
 * covers the bytes this round has to restore.
 */
export function reverseInheritedDecisionRound(file, source) {
  if (file === FILE) {
    for (const { post, pre } of HUNKS) {
      assert.equal(source.split(post).length - 1, 1, `${file}: inherited-decision reversal anchor must occur exactly once`);
      source = source.replace(post, pre);
    }
  }
  return reverseMarkerWindowRound(file, source);
}
