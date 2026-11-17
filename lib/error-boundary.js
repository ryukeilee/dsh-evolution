/**
 * The error/credential projection boundary shared by the kernel and the
 * lightweight cross-entry collectors.
 *
 * Everything here is pure: it reads no host surface, opens no file and starts
 * no process. safeErrorDto() is the single error -> DTO projection, the
 * credential rules are the single scrubber, and redactedToolError() /
 * warnRedacted() are the tool-result and logger edges over it. Keeping them
 * here is what lets dsh-evolution/experience and
 * dsh-evolution/experience-history stay out of the orchestrator and doctor
 * module graphs; a copy in either place would be a second boundary.
 */
import crypto from "node:crypto";

export function safeString(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Last line of defence for free text that reaches a durable record. It is not
// the credential boundary itself: `safeErrorDto` never keeps the raw message,
// and every string copied into a durable record runs through this shape list.
// There is exactly one implementation of this rule: `safeErrorDto`'s summary,
// `compactValue`'s string branch, `safeErrorEvidence`, the event bridge payload,
// the failure memory and the archive renderer all call `redactCredentialShapes`.
// That single entry point is also the single place where the rule is *bounded
// and non-throwing*: text above `REDACTION_TEXT_BOUND` is withheld instead of
// scanned, and any rule failure yields the same marker rather than an exception
// or a fallback to the original text. Those two properties belong to the entry
// point, not to the callers, because a caller that forgets them turns a
// redaction failure into a failed cleanup path (see the bound's definition).
//
// Covered shapes. Every assignment rule accepts `:` or `=`, any spacing, an
// optionally quoted key (single or double, with or without the backslash escape
// a JSON body has when it is embedded inside another JSON string), and works
// case-insensitively, so `apiKey`, `API_KEY`, `api-key` and `db_password` all
// count:
//   password=hunter2, api_key: review-key, admin_token=x
//   "password":"x", "api_key": "x", 'token':'x', password: "x", token='x'
//   {"password":"x"} and the escaped form {\"password\":\"x\"}
//   {"credentials":{"value":"x"}} and "api_keys":["x"]  (container replaced)
//   scheme://user:secret@host (removed structurally, not per vendor)
//   sk-/ghp_/xox*- vendor tokens, AWS key ids, `Bearer <token>`
//   <credential key>[:=] followed by the whole remainder of the text, for any key
//   in `CREDENTIAL_KEY` — which includes every auth-header value (`Bearer`,
//   `Basic`, `Digest`, `AWS4-HMAC-SHA256`, an unknown vendor scheme), because the
//   assignment rule claims the whole remainder instead of the prefix a scheme's
//   own grammar would declare, and instead of any structural end
//
// NOT covered, deliberately and by construction: binary or non-UTF8 payloads;
// a secret split across fields or concatenated at runtime; a base64, hex or
// URL-encoded secret (encoding removes the shape being matched); a secret with
// no label from `CREDENTIAL_KEY` (an unlabelled high-entropy string is a
// secret-detection problem, not this boundary); and any key spelling absent from
// `CREDENTIAL_KEY`. A quote, a bracket, a comma and a quoted sibling key are all
// gone after a credential assignment, because none of them ends a value any more.
// Matching is biased to over-match: a mangled summary is acceptable,
// a leaked credential is not, so the remainder of the text goes with the value.
//
// A credential-key hit IS an unconditional whole-value redaction: no inner
// grammar ends the value early. That is the fix for the ninth review's auth
// continuation leak. The rule used to also carry a scheme-grammar layer
// (`AUTH_SCHEME`/`AUTH_PARAM`/`AUTH_OPAQUE`) that recognised `Bearer`, `Digest`,
// `AWS4-HMAC-SHA256`, … and stopped at the boundary the scheme's own grammar
// declares — one opaque token, or one `name=value` parameter list. Everything the
// peer actually sent past that boundary stayed in plaintext, and the bare-value
// branch could not re-match it because the value already read `[redacted]`:
//
//   Authorization: Bearer aa <secret>        -> Authorization: [redacted] <secret>
//   X-Auth-Token: Bearer aa <secret>         -> X-Auth-Token: [redacted] <secret>
//   Authorization: Bearer aa\"<secret>\"bb    -> Authorization: [redacted]\"<secret>\"bb
//   Authorization: AWS4-… Signature=<secret> -> Authorization: [redacted] Signature=<secret>
//
// That layer is gone rather than widened: a list of scheme names is an
// enumeration, and every such list is wrong for the next vendor. Every keyed
// value now takes the same whole-value path, which is why
// `token: X-Custom-Scheme <material>` and `Authorization: Bearer aa <material>`
// are redacted by the same rule.
//
// The accepted trade-off, asserted by the tests: prose that follows an auth
// header is redacted with it (`Authorization: Bearer abc123 and the host was
// unreachable` -> `Authorization: [redacted]`). Keeping a diagnostic detail must
// never cost a credential. What survives is the key name, the failure category
// and the digest.
//
// Two things JSON stringification does to a shape this table already matched,
// both handled here by bounded escape recognition instead of being left to
// leak. A message that reached a durable record through `JSON.stringify` (the
// bridge payload, the archive JSON, an evidence DTO) has its whitespace and
// quotes escaped, and each extra layer doubles the backslashes:
//
//  - Logical whitespace. A newline is `\n` after one layer, `\\n` after two and
//    `\\\\n` after three, so the spacing between a key and its separator, or
//    between a key and its material, is either real
//    space/tab/newline/carriage-return or 1..15 backslashes plus the escape
//    letter (1, 2, 4 and 8 for the first four layers; the extra headroom is
//    free). `ESCAPED_WS` is that escape form and `WS_RUN` is the logical
//    whitespace run.
//  - Logical quotes. The same doubling applies to `"`/`'`: 1, 3, 7 and 15
//    backslashes for the first four layers, so `\\{0,15}` covers a bare quote
//    and its first four escaped forms. `QUOTED` is only the quoted *key* prefix
//    now: the value rule re-emits nothing but the assignment prefix, so a value's
//    own quotes (escaped or not) are discarded with the rest of the remainder
//    instead of being closed again.
//
// The bound is four layers, not three: a payload can carry an escape sequence of
// its own *and* be stringified again, so two escaped newlines inside one layer of
// wrapper is a four-layer form of the same shape. Neither bound is a general
// JSON parser: more than four layers, and escapes other than
// `\n`/`\r`/`\t`/`\v`/`\f`, are outside what this recognises.
const ESCAPED_WS = String.raw`\\{1,15}[nrtvf]`;
const WS_RUN = String.raw`(?:[ \t\n\r\v\f]|${ESCAPED_WS})*`;
const QUOTED = String.raw`\\{0,15}["']`;
// One list of key spellings, used by two boundaries: the assignment rule below
// (a key and its value inside one string) and `isCredentialKeyName` (a key and
// its value already separated as an object property). The separator class is
// `[._-]`, so `api_key`, `api-key` and `api.key` are the same spelling.
const CREDENTIAL_KEY = [
  String.raw`password`, String.raw`passwd`, String.raw`passphrase`, String.raw`pwd`,
  String.raw`secret`, String.raw`client[._-]?secret`,
  String.raw`secret[._-]?(?:access[._-]?)?key`,
  String.raw`token`, String.raw`access[._-]?(?:key|token)`, String.raw`refresh[._-]?token`, String.raw`id[._-]?token`,
  String.raw`auth(?:orization)?[._-]?token`, String.raw`authorization`,
  String.raw`api[._-]?key`, String.raw`x[._-]?api[._-]?key`, String.raw`private[._-]?key`,
  String.raw`credential(?:s|[._-]?ref)?`,
  String.raw`session[._-]?(?:id|key|token)`, String.raw`cookie`,
].join("|");
// The lookbehind replaces `\b` so `db_password`/`X_API_KEY` are recognised while
// `mytoken` is not; the trailing guard accepts `tokens` but not `tokenizer`.
const CREDENTIAL_ASSIGNMENT = String.raw`(?<![A-Za-z0-9])((?:${QUOTED})?(?:${CREDENTIAL_KEY})s?(?![A-Za-z0-9])(?:${QUOTED})?${WS_RUN}[:=]${WS_RUN})`;
// The same family as a *whole-key* predicate, derived from the one list above so
// no spelling is maintained twice. `compactValue` needs it because a structured
// record has already separated the key from the value: `{access_token: "…"}` is
// one property, and no text rule can match across that boundary. Normalizing the
// key (lowercase, non-alphanumerics removed) is what makes the predicate
// spelling-independent; the whole name and every word inside it are tested,
// because normalization removes the separators the text rule's lookbehind used to
// allow, so `db_password`, `X_API_KEY` and `apiKey` must all be recognised.
const CREDENTIAL_KEY_FAMILY = String.raw`(?:${CREDENTIAL_KEY})s?$`;
// The whole-key form: the family fragment anchored at both ends.
const CREDENTIAL_KEY_NAME = new RegExp(`^${CREDENTIAL_KEY_FAMILY}`);
// The same list as a *suffix* predicate, and the reason it exists: whole-name
// matching normalized `db_api_key` to `dbapikey`, which is neither the whole name
// nor one of its words, so the structured boundary was weaker than the text one
// while the text rule matched `api[-_]?key` *inside* `db_api_key`. A normalized
// key that ends with a credential spelling is therefore a credential key whatever
// precedes it — the same prefix tolerance the text rule's lookbehind already has
// (`db_password`, `X_API_KEY`) — so `dbapikey`, `serviceaccesskey`,
// `xgoogapikey` and `vendorprivatekey` are redacted by both boundaries instead of
// only by the text one. The keys that must stay readable still do: `note`,
// `value`, `reason`, `status`, `latency`, `errors`, `successRate` and `tokenizer`
// end in none of these spellings (`tokenizer` does not end in `token`).
const CREDENTIAL_KEY_SUFFIX = new RegExp(CREDENTIAL_KEY_FAMILY);

export function isCredentialKeyName(key) {
  // Fail closed: a key this cannot decide is redacted, not passed through.
  if (typeof key !== "string") return true;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  // A key with no alphanumeric character at all (`"___"`) decides nothing.
  if (normalized === "") return true;
  if (CREDENTIAL_KEY_NAME.test(normalized)) return true;
  if (CREDENTIAL_KEY_SUFFIX.test(normalized)) return true;
  return key
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .some((part) => part !== "" && CREDENTIAL_KEY_NAME.test(part.toLowerCase()));
}
// The value rule, and the whole of it: once a credential key and its separator
// have matched, the value is the remainder of the text. There is no structural
// end, no quote pairing, no container balancing and no first-character
// restriction, because each of those was a separate way to stop early and leave
// material behind. Three review rounds found three of them in a row:
//
//   password=x]Q7v9...      -> password=[redacted]]Q7v9...      (bracket end)
//   password=x}"Q7v9..."    -> password=[redacted]}"Q7v9..."    (container + quote)
//   password=x];"Q7v9..."   -> password=[redacted]];"Q7v9..."   (both)
//
// The concept behind all three — "find the structural end of the value so sibling
// JSON fields survive" — is the defect, not any one boundary. It is removed
// rather than widened, which also removes the branches and constants that existed
// only to serve it (`QUOTED_RUN`, `STRUCTURAL_VALUE_END`, `VALUE_TAIL`,
// `BARE_VALUE`, `DOUBLE_QUOTED_VALUE`, `SINGLE_QUOTED_VALUE`,
// `UNTERMINATED_QUOTED_VALUE`, `CONTAINER_VALUE`). The pattern surface is smaller
// than before, and nothing of a value can leak because nothing of it is kept: the
// replacement is the assignment prefix plus the marker.
//
// The accepted costs, asserted by the tests. They are diagnostic losses,
// deliberately traded for a boundary that cannot truncate:
//   - `{"password":"x","retry":3}` renders as `{"password":[redacted]`: the
//     closing quote, the comma and every sibling field after a credential key are
//     gone, and the fragment is not valid JSON on its own (it stays safe as an
//     embedded string);
//   - any text after a credential assignment on any later line is gone too, which
//     was already true for multi-line messages.
// What survives is what a record needs to be diagnosable: the key name, the
// failure category and the digest.
const CREDENTIAL_VALUE_PATTERN = new RegExp(String.raw`${CREDENTIAL_ASSIGNMENT}[\s\S]*`, "gi");

const CREDENTIAL_TEXT_PATTERNS = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@"],
  // Group 1 is the assignment prefix — the credential key, its separator and the
  // logical whitespace around either. The replacement keeps exactly that and
  // appends the marker, so no byte of the value can survive: there is no capture
  // group for an opening quote, because the value is not parsed at all.
  [CREDENTIAL_VALUE_PATTERN, "$1[redacted]"],
  [/\b(?:sk-|gh[pousr]_|xox[abprs]-)[A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
  [/\b(?:AKIA|ASIA|AIDA|ABIA|ACCA|AGPA|ANPA|ANVA|AIPA)[A-Z0-9]{8,}\b/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [redacted]"],
];

// The bound on the free text this boundary will scan, and the marker that
// replaces text above it. Both are part of the same rule, not two knobs:
//
// Why a bound at all. The rule table above is a set of regular expressions over
// user-controlled text, and `redactCredentialShapes` below is the single place
// that runs all of them. A pathological input (the sixth review used an 8 MiB run
// of `\\x` inside an unterminated quoted parameter, 8,388,608 characters) makes
// V8's backtracking matcher exhaust the stack and throw `RangeError: Maximum
// call stack size exceeded`. A scrubber that throws is worse than one that
// withholds: the throw left `failureLearning()` before the `try/finally` that
// releases the Trial's target lock, so a redaction failure became a leaked lock
// and a retained experiment record.
//
// Why 64 KiB, and what it costs. The bound is not free, and it is not a no-op for
// durable text: it changes what a durable field *keeps* at the boundary. At or
// below the bound, `redactCredentialShapes` returns redacted text and the caller's
// own truncation still applies, so a 65,536-character message still yields its
// first `ERROR_SUMMARY_MAX` (240) or `maxText` (1200) characters — after
// redaction — in a failure DTO, an archive field or a journal proposal. At 65,537
// characters and above the same field becomes `withheldTextMarker(length)`
// instead: the marker is shorter than any caller truncation, so those first 240 /
// 1200 characters are simply gone. That is a real loss of persistent information
// for text above the bound, accepted in exchange for the property below, not an
// absence of cost.
//
// Why exactly this value. 64 KiB is two orders of magnitude above what any
// durable field keeps and far above the error, journal and proof strings this
// boundary sees, so the loss above lands on text that would have been truncated
// to 240 / 1200 characters anyway. It is also the bound
// that keeps the *worst measured* rule cost small: the backslash-run shape is
// quadratic in the scan length (measured 11.5 ms at 65 KiB, 401 ms at 2 MiB), so
// 64 KiB caps it near 12 ms while 256 KiB would already be ~180 ms. Anything
// longer is a payload, not a message, and the marker says so without carrying a
// byte of it.
const REDACTION_TEXT_BOUND = 64 * 1024;
// Bounded, fail-closed placeholder. It carries the original length, so a record
// still shows how much was withheld, and nothing else. It is deliberately *not*
// a truncation of the original: cutting the text keeps the first characters of
// the credential it starts with (`token: VendorV3 a="<cut here>`), which is the
// leak this design rules out in both directions. It keeps the `[redacted]`
// marker a reader and the tests already look for, so "the text was redacted" and
// "the text was withheld unscanned" are both visible instead of the latter
// looking like an untouched field.
const withheldTextMarker = (length) => `[redacted] [message withheld: ${length} characters]`;

export function redactCredentialShapes(value) {
  let text;
  // Even the coercion is fail-closed: a hostile `toString` must not turn a
  // scrubber into a thrower.
  try { text = typeof value === "string" ? value : String(value); } catch { return withheldTextMarker(0); }
  const length = text.length;
  if (length > REDACTION_TEXT_BOUND) return withheldTextMarker(length);
  // A rule's replacement is either a string or a function; both are handled the
  // same way by `String.prototype.replace`, so this stays one rule list.
  try {
    for (const [pattern, replacement] of CREDENTIAL_TEXT_PATTERNS) text = text.replace(pattern, replacement);
  } catch {
    // Fail closed on any rule failure: the marker replaces the text, never the
    // text itself and never a truncation of it, and a partially redacted buffer
    // does not survive either.
    return withheldTextMarker(length);
  }
  return text;
}

export function failureCategory(error, phase) {
  const message = safeString(error?.message || error).toLowerCase();
  if (phase.includes("cleanup") || phase === "revert" || /dispose|rollback|undefine|stop|orphan/.test(message)) return "cleanup-or-rollback";
  if (/regression/.test(message)) return "regression";
  if (/repeat/.test(message)) return "repeatability";
  if (/permission|approval|unauthor/.test(message)) return "approval-or-permission";
  if (/syntax|compile|parse/.test(message)) return "invalid-code";
  if (/journal|atomic|promotion|mount|reload/.test(message)) return "durable-promotion";
  return "runtime-trial";
}

// The single error -> safe DTO boundary. What leaves this function is the
// error code, the failure category, an irreversible digest and a bounded,
// credential-redacted summary; the raw message never leaves it. Everything that
// persists an error (failure learning, the archive, the event bridge, the
// observation stream feeding inspect) reads its fields from here instead of
// copying `error.message`.
//
// It never throws and never returns unbounded text, for any input. `errorDigest`
// and `errorLength` are still computed on the whole raw message, so a withheld
// summary is identifiable and comparable; only the summary is replaced.
//
// Total, not merely guarded. Reading a property is as able to throw as converting
// one (`error.message` may be a getter; `String(value)` runs a hostile
// `toString`/`Symbol.toPrimitive`), so `readErrorField`/`coerceErrorText` wrap the
// read *and* the conversion, and the reads the DTO needs are the only reads it
// performs — `name` and `stack` are never touched, so a throwing getter on either
// cannot reach it. When a read or a conversion does throw, the DTO does not
// degrade field by field and it does not throw: it becomes `degradedErrorDto()`,
// which carries no text of the error at all. A half-read message would be a claim
// about text the boundary only partly attributed, which is worse than saying so.
export const ERROR_SUMMARY_MAX = 240;
// The fixed DTO for an error that could not be read. Every field is a literal,
// and the key set is the same five keys the readable path returns, because
// callers (`safeErrorEvidence`, the archive renderer, `registration.js`) rely on
// those keys existing. `errorCategory` is `DEGRADED_ERROR_CATEGORY` rather than a
// phase-derived guess — a category is a claim about a message nobody read.
// `errorDigest` is deliberately *not* digest-shaped (`sha256:` plus exactly 16
// hex characters is the readable form), so no reader can confuse the placeholder
// with the digest of a real message, while the value stays stable and
// deterministic. `errorLength: 0` says no text was measured.
const DEGRADED_ERROR_CATEGORY = "unclassified";
const DEGRADED_ERROR_DIGEST = "sha256:unavailable";
const DEGRADED_ERROR_SUMMARY = "[error details unavailable: the error object could not be read]";
const degradedErrorDto = () => ({
  errorCode: null,
  errorCategory: DEGRADED_ERROR_CATEGORY,
  errorDigest: DEGRADED_ERROR_DIGEST,
  errorSummary: DEGRADED_ERROR_SUMMARY,
  errorLength: 0,
});

// The unreadable signal. A sentinel instead of `undefined`/`null`, so "the read
// threw" cannot be confused with "the property is absent" (which has a defined,
// non-degraded meaning for `message`).
const ERROR_FIELD_UNREADABLE = Symbol("evolution.error-field-unreadable");

function readErrorField(error, key) {
  try { return error?.[key]; } catch { return ERROR_FIELD_UNREADABLE; }
}

function coerceErrorText(value) {
  try {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    return String(value);
  } catch { return ERROR_FIELD_UNREADABLE; }
}

// The classification is a keyword scan over at most the first 4 KiB, and that
// bound is a loss of *precision*, not a semantic no-op: a message whose only
// `regression`, `repeat`, `permission`, `syntax`, `journal` or `cleanup` keyword
// appears after character 4,095 is classified by its phase and by whatever
// keywords do precede the bound, so it can land on `runtime-trial` while an
// unbounded scan would have said `regression`. The bound is kept because the
// scan must not become one more unbounded rule family over untrusted text, and
// because the messages this boundary sees state their nature far inside 4 KiB:
// a keyword behind a payload that large is already an unusual shape (the
// tests pin both sides of the cut, not a claim that no such message exists).
const ERROR_CATEGORY_TEXT_BOUND = 4 * 1024;

// `JSON.parse` failures are user-facing diagnostics, and V8 embeds a quoted
// excerpt of the input in the message for token-level failures:
//
//   Unexpected token 'U', "{"a":USER_PRIVATE}" is not valid JSON
//
// That excerpt is the content of a durable file - memory, journal, event bridge,
// domain aggregate - so it may contain credentials or user data. Every site that
// turns a parse failure into a log line, warning or evidence field crosses this
// boundary first: the excerpt is replaced, the structural part of the message
// (and its position) is kept so the failure stays diagnosable.
const JSON_PARSE_FAILURE_SUFFIX = "is not valid JSON";

/** Project a parse-failure message so it never carries the parsed bytes. */
export function redactJsonParseMessage(message) {
  const text = typeof message === "string" ? message : String(message ?? "");
  // V8 appends `, "<excerpt>"... is not valid JSON` to token-level failures.
  // This walks the message once instead of matching it with a regular expression
  // whose repetition could be made quadratic by a long input; the excerpt (and
  // the ellipsis V8 adds when it truncated it) is dropped, the structure kept.
  const suffixAt = text.lastIndexOf(JSON_PARSE_FAILURE_SUFFIX);
  if (suffixAt >= 0) {
    const quoteAt = text.indexOf('"');
    if (quoteAt >= 0 && quoteAt < suffixAt) {
      let end = quoteAt;
      while (end > 0) {
        const code = text.charCodeAt(end - 1);
        if (code === 0x2c || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) end -= 1;
        else break;
      }
      const projected = `${text.slice(0, end)} ${JSON_PARSE_FAILURE_SUFFIX}`;
      return projected.trim() === "" ? "invalid JSON" : projected;
    }
  }
  return text.trim() === "" ? "invalid JSON" : text;
}

// Only a labelled elapsed duration is known to be volatile. Status codes,
// counts and identifiers remain part of the failure identity.
function normalizePatternDuration(text) {
  return text.replace(/\b(after )\d+( ms)\b/g, "$1#$2");
}

// ---------------------------------------------------------------------------
// The pattern identity of a `tools/result` failure
// ---------------------------------------------------------------------------
//
// A tool failure's identity is the *shape* of the failure the host published,
// never the bytes it returned. The official registry publishes an `isError`
// result as
//
//   { isError: true, error: { message, info? }, content: [{ type: 'text', text }] }
//
// (`dsh-tools` `toolErrorResult()` / `normalizeDispatchResult()` /
// `materializeFinalResult()`), so the failure text appears twice and the result
// can also carry a tool-authored `content`, `meta` and `additionalContexts`.
// Hashing `JSON.stringify(result)` therefore made every instance a new failure
// pattern: three `read` failures caused by one missing build directory, differing
// only in the file name each attempt asked for, produced three pattern keys with
// `occurrences: 1` each, so the pattern never reached `patternThreshold` and the
// loop never selected a strategy for it. Exact reproducibility of the result
// bytes is what the digest was *not* for - `errorDigest`, which the observation
// still carries, keeps that.
//
// What is volatile is a *value*: a filesystem subject, a number, a labelled
// elapsed duration. What is not is the shape around it, which is why the
// projection below replaces only those three, and only in the failure text - not
// in the rendered content, `meta` or `additionalContexts`. Two consequences are
// deliberate:
//   * failures that differ only in a path or a count are one pattern. That is the
//     same "a value is not an identity" rule `patternKey` already applies to
//     every digit of the message, applied to the tool path.
//   * failures that differ in any other word stay distinct. `ENOENT ... open` and
//     `EACCES ... open`, or two `invalid arguments: "value.a"` / `"value.b"`
//     rejections from one tool, do not share a pattern just because they share a
//     tool name and code - the quoted schema path is structure, not a value, and
//     a path is only recognised where a filesystem subject can start.
//
// A filesystem subject starts at a token boundary with a POSIX-rooted `/`, a
// `~/`, or a Windows drive, and a URL keeps the host it names: `//` is not a path
// start, so `https://host/a` is untouched.
const PATH_ROOT = String.raw`(?:[A-Za-z]:[\\/]|~?\/(?![/\\]))`;
// A *delimited* subject runs to its closing quote, so a directory whose name
// contains a space or a bracket is one value rather than a prefix:
// `open '/repo/build cache/a.json'` and `open '/repo/[cache]/b.json'` are the
// same failure shape. Each branch begins with a different quote, and its body
// excludes only that quote, so no branch can be entered twice and nothing
// backtracks (AGENTS.md invariant 15).
const TOOL_FAILURE_QUOTED_PATH = new RegExp(String.raw`'(${PATH_ROOT}[^'\n]*)'|"(${PATH_ROOT}[^"\n]*)"|\`(${PATH_ROOT}[^\`\n]*)\``, "g");
// An undelimited subject ends at the first character that can follow one in
// prose. A path that itself needs a delimiter is only recognised when quoted: an
// unquoted `/a b/c` is indistinguishable from a path followed by two words, and
// guessing there would merge failures this boundary exists to keep apart.
const TOOL_FAILURE_PATH = new RegExp(String.raw`(^|[\s'"\`([{<,:;=])${PATH_ROOT}[^\s'"\`)\]}>]*`, "g");

/**
 * Project one host-published failure text onto its pattern shape.
 *
 * Runs after `redactCredentialShapes`, so a credential can neither leak into the
 * digest nor keep two occurrences apart by rotating, and inherits that entry
 * point's bound: a caller that reaches this with text above
 * `REDACTION_TEXT_BOUND` would only see the withheld marker, which
 * `toolFailurePatternDigest` refuses before calling here.
 */
function normalizeToolFailureText(text) {
  return redactCredentialShapes(text)
    // The official timeout failure is `tool call timed out after 120000ms`; the
    // `agent/error` rule requires a space, so both spellings are collapsed here.
    .replace(/\b(after )\d+\s?ms\b/g, "$1#ms")
    // Delimited subjects first, keeping the quotes that delimited them.
    .replace(TOOL_FAILURE_QUOTED_PATH, (match) => `${match[0]}<path>${match[match.length - 1]}`)
    .replace(TOOL_FAILURE_PATH, "$1<path>")
    .replace(/\b\d+\b/g, "#");
}

/**
 * The failure text one official `tools/result` failure published, or `""`.
 *
 * `error` is the host's own failure channel (`{ message, info? }`, or the bare
 * string a third-party wrapper may hand back), and `content` is where a
 * post-execute policy block publishes its feedback. Every read is on a
 * detached, frozen JSON snapshot in the official pipeline; a shape that cannot
 * be read at all answers `""` rather than throwing on the failure path.
 */
function toolFailureText(result) {
  const error = result?.error;
  if (typeof error === "string" && error !== "") return error;
  const message = error?.message;
  if (typeof message === "string" && message !== "") return message;
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return "";
  const text = blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return text;
}

/**
 * The pattern identity of one `tools/result` failure: the digest of its projected
 * failure shape (see `normalizeToolFailureText`).
 *
 * `null` when the host published no failure text, because an empty projection
 * would collapse every text-less failure of one tool into a single pattern - the
 * caller then keeps the exact-result identity instead of inventing a merge.
 *
 * `null` above `REDACTION_TEXT_BOUND` for the same reason: the credential entry
 * point withholds a larger text as one marker, so every over-long failure of one
 * tool would project to the same shape and unrelated causes would accumulate into
 * a single pattern and reach `patternThreshold` together. Refusing the projection
 * keeps the exact-result identity there, which merges nothing.
 */
export function toolFailurePatternDigest(result) {
  try {
    const text = toolFailureText(result);
    if (text === "" || text.length > REDACTION_TEXT_BOUND) return null;
    return `sha256:${sha256(normalizeToolFailureText(text)).slice(0, 16)}`;
  } catch {
    // A result whose fields cannot be read is not evidence about a pattern; the
    // caller's own containment reports the observation, not this projection.
    return null;
  }
}

export function safeErrorDto(error, phase = "runtime", { patternDigest = false } = {}) {
  // `phase` is compared with `String.prototype.includes`, so a non-string phase
  // (a hand-written durable record can carry one) would be a `TypeError` inside
  // the boundary rather than a classification.
  const phaseText = typeof phase === "string" ? phase : "runtime";
  const fromString = typeof error === "string";
  // `error?.message ?? error ?? ""`: a message of `null`/`undefined` falls back to
  // the thrown value itself, exactly as before; only the reads and the coercions
  // are new.
  const message = fromString ? error : readErrorField(error, "message");
  if (message === ERROR_FIELD_UNREADABLE) return degradedErrorDto();
  const subject = fromString || (message !== undefined && message !== null) ? message : error;
  const raw = coerceErrorText(subject);
  if (raw === ERROR_FIELD_UNREADABLE) return degradedErrorDto();
  const codeValue = fromString ? "" : readErrorField(error, "code");
  if (codeValue === ERROR_FIELD_UNREADABLE) return degradedErrorDto();
  const code = coerceErrorText(codeValue ?? "");
  if (code === ERROR_FIELD_UNREADABLE) return degradedErrorDto();
  const categoryText = raw.length > ERROR_CATEGORY_TEXT_BOUND ? raw.slice(0, ERROR_CATEGORY_TEXT_BOUND) : raw;
  return {
    errorCode: code ? redactCredentialShapes(code).slice(0, 64) : null,
    errorCategory: failureCategory({ message: categoryText }, phaseText),
    errorDigest: `sha256:${sha256(raw).slice(0, 16)}`,
    // Normalize the labelled duration before redaction collapses
    // distinct causes. Keep the raw digest above as exact failure evidence.
    ...(patternDigest ? { errorPatternDigest: `sha256:${sha256(normalizePatternDuration(raw)).slice(0, 16)}` } : {}),
    errorSummary: redactCredentialShapes(raw).slice(0, ERROR_SUMMARY_MAX) || "unknown error",
    errorLength: raw.length,
  };
}

export const ERROR_TEXT_KEY = /^(?:error|errors|message|reason|detail)$/i;

/**
 * The tool-error boundary.
 *
 * A thrown tool error is rendered by the host from `error.message`, into the
 * session record the model re-reads on every later request. Several lifecycle
 * errors carry text that did not originate here - a Cordis run receipt message,
 * a disposer rejection, a domain-storage flush failure - so rethrowing them
 * unchanged put provider text (and whatever it quoted) on the model's side of
 * the boundary. The DTO keeps the classification, digest and a bounded, redacted
 * summary, and the original `code`/`name` so callers that branch on them still
 * see the same values.
 */
export function redactedToolError(error, phase = "tool") {
  // Every read of the original object happens inside the guard. The projection
  // replaced the raw message precisely because an error can be arbitrary foreign
  // code: a `code` getter that throws would otherwise escape this boundary with
  // its own text and hand the host exactly what the boundary exists to withhold.
  const detail = safeErrorDto(error, phase);
  const projected = new Error(detail.errorSummary);
  projected.errorCategory = detail.errorCategory;
  projected.errorDigest = detail.errorDigest;
  projected.errorLength = detail.errorLength;
  // `code` comes from the DTO's own guarded read, not from a second read here.
  if (detail.errorCode !== null && detail.errorCode !== undefined) projected.code = detail.errorCode;
  try {
    if (error instanceof Error) projected.name = error.name;
  } catch {
    // Metadata is a convenience: an unreadable `name` (or a proxy whose
    // `getPrototypeOf` throws) must not replace the classified failure.
  }
  return projected;
}

/**
 * Write one redacted observer diagnostic.
 *
 * The message is the safe DTO, so no observer failure can print the text it
 * carried. The write itself is contained as well: a logger that throws must not
 * turn a diagnostic into an exception on the observation path, and a logger
 * that returns a promise (or a hostile thenable) must not turn it into an
 * unhandled rejection. Both properties belong to this entry point, so every
 * observer diagnostic gets them without each call site repeating the guards.
 *
 * A logger that never returns a thenable `.catch` still settles: `Promise.resolve`
 * of the returned value is what is observed, so `undefined` and plain values are
 * a no-op.
 *
 * `phase` is passed to the DTO so the log line says which stage failed; the
 * default keeps every existing call site's classification unchanged.
 */
export function warnRedacted(ctx, label, error, phase = "observation") {
  try {
    const detail = safeErrorDto(error, phase);
    const message = `[evolution] ${label}: ${detail.errorSummary} (${detail.errorCategory}, ${detail.errorDigest})`;
    Promise.resolve(ctx.logger?.warn?.(message)).catch(() => {});
  } catch {
    // A logger that cannot be reached, or one that throws, is not a reason to
    // raise from the observer path; the observation attempt is already over.
  }
}
