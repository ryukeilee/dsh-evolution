// Correlate verification results with the official execution's root call ID.
// A PTC dispatch has its own call ID, and unrelated work may use the same agent
// while a verification call is in progress.
const activeByAgent = new WeakMap();

export async function withVerificationCall(agent, callId, execute) {
  if (!agent || typeof callId !== 'string' || callId === '') return execute();
  let active = activeByAgent.get(agent);
  if (!active) {
    active = new Map();
    activeByAgent.set(agent, active);
  }
  active.set(callId, (active.get(callId) ?? 0) + 1);
  try {
    return await execute();
  } finally {
    // The host emits final results before settling the batch. PTC drains its
    // nested dispatches before the enclosing run_code completes.
    const remaining = active.get(callId) - 1;
    if (remaining === 0) active.delete(callId);
    else active.set(callId, remaining);
    if (active.size === 0) activeByAgent.delete(agent);
  }
}

export function isVerificationCall(exec) {
  const active = activeByAgent.get(exec?.agent);
  return active?.has(exec.rootCallId ?? exec.callId) === true;
}
