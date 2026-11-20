/**
 * Shared bridge to the official Programmatic Tool Calling (PTC) executor.
 *
 * A PTC preset mounts `@deepseek-ai/dsh-tool-executor-ptc`, which announces
 * `run_code` as the only directly callable tool. A host component that needs a
 * tool outside a model step therefore receives a refusal from the executor
 * (`only \`run_code\` is callable directly`) instead of a tool result. The
 * refusal is produced before policy and before the tool body runs, so the same
 * call can be re-issued inside a `run_code` program without duplicating an
 * effect.
 *
 * Both kernel call sites (the Desktop task host and the probe's workload
 * steps) must recognize that refusal with the same rule and read the wrapper
 * envelope the same way. The programs themselves stay deliberately different:
 * the task host lets a nested failure fail the kernel call, while a probe must
 * record a failed measurement instead of losing it behind `CODE_RUN_FAILED`.
 */

/**
 * The executor's model-direct refusal. The message carries a backticked tool
 * name in the current host, but older spellings without backticks are matched
 * too so the transport does not depend on presentation punctuation.
 */
export const PTC_DIRECT_CALL_REFUSAL = /only `?run_code`? is callable directly/i;

/**
 * The single property a wrapper program uses to carry the inner tool value.
 * One sentinel property keeps a tool value that happens to contain `logs` or
 * `result` from being mistaken for the run_code envelope.
 */
export const PTC_WRAPPED_VALUE = '__dshEvolutionKernelValue';

/**
 * Return the refusal message when one settled pipeline call is the PTC
 * executor refusing a model-direct call, or null otherwise. The result shape
 * is the official `{ isError, error: { message } }` projection.
 */
export function ptcDirectCallRefusal(result) {
  if (!result || typeof result !== 'object' || result.isError !== true) return null;
  const error = result.error;
  if (!error || typeof error !== 'object') return null;
  // The pipeline projects the message on `error.message`; hosts that wrap the
  // refusal again put it on the structured info object. Both are the same
  // executor-owned text, so either spelling identifies the refusal.
  const message = typeof error.message === 'string' ? error.message
    : error.info && typeof error.info === 'object' && typeof error.info.message === 'string' ? error.info.message
    : undefined;
  return typeof message === 'string' && PTC_DIRECT_CALL_REFUSAL.test(message) ? message : null;
}

/**
 * Unwrap the `{ logs, result? }` envelope a successful `run_code` call
 * returns. Returns the wrapper object (which must own the sentinel property),
 * or null when the envelope is missing or malformed. Callers keep their own
 * error code for a malformed envelope.
 */
export function ptcWrappedEnvelope(envelope) {
  const wrapped = envelope && typeof envelope === 'object' ? envelope.result : undefined;
  if (!wrapped || typeof wrapped !== 'object' || !Object.hasOwn(wrapped, PTC_WRAPPED_VALUE)) return null;
  return wrapped;
}
