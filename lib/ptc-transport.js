/**
 * Shared bridge to the official Programmatic Tool Calling (PTC) executor.
 *
 * A PTC preset mounts `@deepseek-ai/dsh-tool-executor-ptc`, which announces
 * `run_code` as the only directly callable tool. A host component that needs a
 * tool outside a model step therefore receives a refusal from the executor
 * instead of a tool result. The refusal is produced before policy and before
 * the tool body runs, so the same call can be re-issued inside a `run_code`
 * program without duplicating an effect.
 *
 * Both kernel call sites (the Desktop task host and the probe's workload
 * steps) must recognize that refusal with the same rule and read the wrapper
 * envelope the same way. The programs themselves stay deliberately different:
 * the task host lets a nested failure fail the kernel call, while a probe must
 * record a failed measurement instead of losing it behind `CODE_RUN_FAILED`.
 */

/**
 * The single property a wrapper program uses to carry the inner tool value.
 * One sentinel property keeps a tool value that happens to contain `logs` or
 * `result` from being mistaken for the run_code envelope.
 */
export const PTC_WRAPPED_VALUE = '__dshEvolutionKernelValue';

/** One identifier-shaped name a refusal may carry in its structured info. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Build the official refusal shape bound to one exact tool name.
 *
 * The executor constructs a `ToolNotFoundError` whose message names the tool
 * whose direct call it denied ("unknown tool \"<name>\": only `run_code` is
 * callable directly — call `<name>` from inside a `run_code` program
 * instead"). Binding the name keeps an ordinary tool or policy error that
 * merely quotes the phrase from being mistaken for the executor's refusal.
 */
function refusalPattern(toolName) {
  const quoted = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    'unknown tool "' + quoted + '": only `run_code` is callable directly'
      + '(?: — call `' + quoted + '` from inside a `run_code` program instead)?',
  );
}

/**
 * Return the refusal message when one settled pipeline call is the PTC
 * executor refusing a model-direct call for `toolName`, or null otherwise.
 *
 * The recorded result is the official `{ isError, error: { message, info? } }`
 * projection. When the structured `{ name, code }` classification is present
 * it must be the executor's tool-not-found identity; the message must then
 * name the same tool and carry the refusal sentence. A plain tool error that
 * quotes the sentence without the matching tool name or classification keeps
 * its original path.
 */
export function ptcDirectCallRefusal(result, toolName) {
  if (!result || typeof result !== 'object' || result.isError !== true) return null;
  if (typeof toolName !== 'string' || !IDENTIFIER.test(toolName)) return null;
  const error = result.error;
  if (!error || typeof error !== 'object') return null;
  const info = error.info;
  if (info !== undefined) {
    if (!info || typeof info !== 'object') return null;
    if (info.name !== undefined && info.name !== 'ToolNotFoundError') return null;
    if (info.code !== undefined && info.code !== 'UNKNOWN_TOOL') return null;
  }
  const message = typeof error.message === 'string' ? error.message
    : info && typeof info.message === 'string' ? info.message
    : undefined;
  if (typeof message !== 'string') return null;
  return refusalPattern(toolName).test(message) ? message : null;
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
