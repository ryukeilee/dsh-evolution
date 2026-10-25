/**
 * 恢复说明（2026-09-10 审计）：本文件在 28e1f82「backup: finalize consistent
 * runtime recovery point」里被削成「仅诊断、不再 deny」，但那次提交没有任何
 * 退役记录，且与在线机制清单直接冲突：
 *   - EVOLUTION.md 第 8 行仍把 dsh-composition-guard 列为「机制在线」：
 *     「仅 Cordis trust root 与不可逆风险守卫，普通 composition/promoted
 *     plugin/guard/orchestrator 可演进」；
 *   - 2026-08-26 的 P0 条目记录了对本守卫误杀的治理与复验（「LIVE 冒烟
 *     deny/allow 各一」「阴性对照仍被拦」），证明它是被维护的 deny 闸门；
 *   - 全仓库没有「composition-guard 退役」条目，也没有替代实现覆盖
 *     Cordis trust root / 不可逆风险的执行前拦截。
 * 因此按 28e1f82 之前的实现恢复，并保留其既有的事项：
 *   - 已经适配 0.1.2-rc.1 的单调守卫 API（ctx.tools.guard；无 allow 结果，
 *     后续 waterfall 监听无法把 deny 改回允许），旧宿主回退 tools/pre-execute；
 *   - 保留 2026-08-26 的误杀治理：注释剥离 stripJsComments、嵌套调用
 *     findToolCalls、静态字面量提取 extractLabeledValue、重定向精化；
 *   - 普通 composition / promoted plugin / guard / orchestrator 的演进不受影响，
 *     只有 Cordis trust root 与明确的不可逆风险操作被拒。
 */
/**
 * dsh-composition-guard — Cordis trust-root and irreversible-risk guard.
 *
 * DSH code, composition, guards, orchestrators, promoted plugins, and
 * control-plane configuration are evolvable by default.  This guard denies
 * only direct Cordis trust-root mutation or an explicitly irreversible
 * operation that bypasses Cordis lifecycle/transaction evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const ANCHORS = ['自我进化协议', 'EVOLUTION VERIFICATION', 'SESSION CLOSE'];
const CORDIS_PACKAGE_RE = /(?:^|[\\/])@deepseek-ai[\\/]cordis(?:[\\/]|$)/i;
const CORDIS_PLUGIN_RE = /(?:^|[\\/])@deepseek-ai[\\/]cordis-plugin-(?:loader|include)(?:[\\/]|$)/i;
const CORDIS_TARGET_RE = /^(?:@deepseek-ai[\\/]?)?cordis(?:$|[.:/_-](?:core|effect|coeffect|component(?:[-_]?lifecycle)?|lifecycle|loader|recovery|trust[-_]?root))(?:[.:/_-]|$)/i;
const CORDIS_AREA_RE = /(?:^|[.:/_-])cordis(?:[.:/_-](?:core|effect|coeffect|component(?:[-_]?lifecycle)?|lifecycle|loader|recovery|trust[-_]?root))(?:[.:/_-]|$)/i;
const CORDIS_CODE_TARGET_RE = /(?:^|[^a-z0-9_])(?:@deepseek-ai[\\/]cordis(?:[\\/][^\\s"\x27\x60]+)?|@deepseek-ai[\\/]cordis-plugin-(?:loader|include)(?:[\\/][^\\s"\x27\x60]+)?|cordis(?:[.:/_-](?:core|effect|coeffect|component(?:[-_]?lifecycle)?|lifecycle|loader|recovery|trust[-_]?root)|(?=["\x27])))(?:$|[^a-z0-9_])/i;
const IRREVERSIBLE_OPERATION_RE = /(?:bypass[-_ ]?cordis[-_ ]?lifecycle|cordis[-_ ]?lifecycle[-_ ]?bypass|production[-_ ]?(?:replace|promote)|(?:api[-_ ]?key|credential|keychain|secret|user[-_ ]?data)|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f|filter-(?:repo|branch)|push\s+--force)|force[-_ ]?push|\b(?:publish|deploy|upload-sensitive)\b)/i;
const IRREVERSIBLE_PATH_RE = /(?:^|[\\/])(?:\.credentials?(?:\.ya?ml)?|credentials?|keychain|api[-_.]?keys?)(?:[\\/]|$)|(?:^|[\\/])\.env(?:[.][^\\/]+)?(?:[\\/]|$)/i;

// Evolution bookkeeping is normally writable by the DSH lifecycle.  A
// verified managed transaction is needed only when a bookkeeping operation
// also carries an explicit irreversible-risk marker.
const MANAGED_TRANSACTION = "evolution-managed";
const MANAGED_TARGET_RE = /(?:^|\/)(?:\.task-ledger(?:\/|$)|evolution-memory\.json$|\.evolve-backups\/(?:metadata|manifest|index|journal)(?:[-_.][^/]*)?$|\.evolution-(?:promotion|ownership)(?:\/|$))/i;

function operationContextOf(exec) {
  // The proof must come from the host, never from the tool arguments. A caller
  // that can put `operationContext` into `exec.arguments` can also claim
  // `verified: true` for its own transaction, so accepting it there made the
  // managed exemption self-asserted and let a forged proof satisfy the
  // credential/irreversible-target rule.
  const context = exec?.operationContext || exec?.context;
  if (!context || typeof context !== "object") return null;
  return context;
}

/** Resolve a filesystem path to its real target. An existing path uses
 * `realpath`; a path that may be created later is resolved component by
 * component the way the filesystem would, following a symlink *before* the `..`
 * that follows it. A lexical `path.resolve` collapses `alias/..` first, which is
 * exactly the alias escape (writing inside the link target through `alias/..`)
 * this has to catch. Returns the input when it cannot be resolved. */
function resolvedPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return value;
  if (/[\r\n\0]/.test(value)) return value;
  try { return fs.realpathSync(value); } catch { /* the target may not exist yet */ }
  const absolute = path.isAbsolute(value) ? value : `${process.cwd()}${path.sep}${value}`;
  const root = path.parse(absolute).root;
  const queue = absolute.slice(root.length).split(path.sep).filter((part) => part !== "");
  const resolved = [];
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift();
    if (part === ".") continue;
    if (part === "..") { if (resolved.length > 0) resolved.pop(); continue; }
    const candidate = path.join(root, ...resolved, part);
    let info = null;
    try { info = fs.lstatSync(candidate); } catch { info = null; }
    if (info?.isSymbolicLink() && hops < 40) {
      hops += 1;
      let target = fs.readlinkSync(candidate);
      if (path.isAbsolute(target)) resolved.length = 0;
      else target = path.join(path.dirname(candidate), target);
      queue.unshift(...target.split(path.sep).filter((entry) => entry !== ""));
      continue;
    }
    resolved.push(part);
  }
  return path.join(root, ...resolved);
}

function protectedTargetPath(value) {
  return touchesProtectedSurface(value) || touchesProtectedSurface(resolvedPath(value));
}

function normalizedTarget(exec, context) {
  const target = context?.target ?? exec?.arguments?.file_path ?? exec?.arguments?.path;
  return typeof target === "string" ? target.replaceAll("\\", "/") : "";
}

function isCordisTrustRoot(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const candidate = value.trim().replaceAll('\\', '/');
  return CORDIS_PACKAGE_RE.test(candidate) || CORDIS_PLUGIN_RE.test(candidate)
    || CORDIS_TARGET_RE.test(candidate) || CORDIS_AREA_RE.test(candidate);
}

function isCordisTrustRootText(value) {
  return typeof value === 'string' && (isCordisTrustRoot(value) || CORDIS_CODE_TARGET_RE.test(value));
}

function boundaryRequiresProof(exec, context = operationContextOf(exec)) {
  const target = normalizedTarget(exec, context);
  const body = exec?.arguments?.command ?? exec?.arguments?.code ?? '';
  return protectedTargetPath(target)
    || IRREVERSIBLE_PATH_RE.test(target)
    || IRREVERSIBLE_PATH_RE.test(resolvedPath(target))
    || isCordisTrustRootText(body)
    || context?.irreversible === true
    || context?.bypassCordisLifecycle === true
    || (typeof body === 'string' && IRREVERSIBLE_OPERATION_RE.test(body))
    || (typeof context?.operation === 'string' && IRREVERSIBLE_OPERATION_RE.test(context.operation));
}

function operationMentionsTarget(exec, target) {
  const explicit = exec?.arguments?.file_path ?? exec?.arguments?.path;
  if (typeof explicit === "string") return explicit.replaceAll("\\", "/") === target;
  const body = exec?.arguments?.command ?? exec?.arguments?.code;
  if (typeof body !== "string") return false;
  // Do not accept a basename-only match: an unrelated file with the same
  // name must not inherit the managed transaction's authorization.
  return body.includes(target);
}

export function isVerifiedManagedTransaction(exec) {
  const context = operationContextOf(exec);
  if (!context) return false;
  const actor = typeof context.actor === "string" ? context.actor.trim() : "";
  const operation = typeof context.operation === "string" ? context.operation.trim().toLowerCase() : "";
  const transactionType = typeof context.transactionType === "string" ? context.transactionType.trim().toLowerCase() : "";
  const target = normalizedTarget(exec, context);
  const ownership = context.ownership;
  const owned = ownership === "evolution"
    || ownership === "evolution-managed"
    || ownership?.kind === "evolution"
    || ownership?.kind === "evolution-managed"
    || ownership?.owner === actor;
  const actorIsEvolution = /^(?:dsh[-:]?)?evolution(?:[-:]orchestrator)?$/i.test(actor);
  const mutation = new Set(["write", "update", "persist", "backup", "remove", "delete"]).has(operation);
  return context.verified === true
    && transactionType === MANAGED_TRANSACTION
    && actorIsEvolution
    && mutation
    && owned
    && operationMentionsTarget(exec, target)
    && MANAGED_TARGET_RE.test(target);
}

function invalidManagedContext(exec) {
  const context = operationContextOf(exec);
  if (!context) return false;
  const operation = typeof context.operation === "string" ? context.operation.trim().toLowerCase() : "";
  const mutationTool = new Set(["edit", "write", "bash", "pwsh", "run_code"]).has(exec?.name);
  const mutation = new Set(["write", "update", "persist", "backup", "remove", "delete"]).has(operation) || mutationTool;
  return mutation && boundaryRequiresProof(exec, context) && !isVerifiedManagedTransaction(exec);
}

// Cordis exposes the tool registry through explicit plugin injection.  The
// guard uses the registry's monotonic guard API when available.
export const inject = ['tools'];

function touchesProtectedSurface(value) {
  return isCordisTrustRootText(value);
}

function isPresetComposition(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  // The same syntactic identity the write itself will follow: a symlinked
  // preset path must not skip row verification just because its alias does not
  // contain `/agent-presets/`.
  for (const candidate of [filePath, resolvedPath(filePath)]) {
    const abs = path.resolve(candidate);
    const norm = abs.split(path.sep).join('/');
    if ((norm.includes('/.agent-presets/') || norm.includes('/agent-presets/')) && norm.endsWith('/agent.cordis.yml')) return true;
  }
  return false;
}

function presetDirOf(filePath) {
  // agent.cordis.yml 的父目录即预设目录(.agent-presets/<id>/)
  return path.dirname(filePath);
}

function parseRows(content) {
  const ids = new Set();
  for (const line of content.split('\n')) {
    const m = /^- id: ([a-z0-9-]+)\s*$/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function simulateResult(exec) {
  const args = exec.arguments ?? {};
  const filePath = String(args.file_path ?? '');
  if (!isPresetComposition(filePath)) return null;
  if (!fs.existsSync(filePath)) {
    return { filePath, content: String(args.content ?? '') };
  }
  const current = fs.readFileSync(filePath, 'utf8');
  if (exec.name === 'write') {
    return { filePath, content: String(args.content ?? '') };
  }
  if (exec.name === 'edit') {
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    if (oldStr === '') return { filePath, content: current };
    if (!current.includes(oldStr)) return { filePath, content: current, noop: true };
    return { filePath, content: current.replace(oldStr, newStr) };
  }
  return null;
}

// 2026-08-26 P0 refinement: strip comments before mutation matching so that
// read-only exploration mentioning protected paths (even with trigger words in
// comments) is no longer denied; nested tools.bash/write/edit calls are judged
// by their own arguments instead of mere presence. Any tokenizer anomaly falls
// back to the original text (fail-closed: behaves like the old blunt rule).
function stripJsComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let str = null; // null | "'" | '"' | '`'
  const tplStack = []; // brace depths of open ${ inside templates
  let braceDepth = 0;
  let prevSig = ""; // previous significant char for regex-literal heuristic
  while (i < n) {
    const c = src[i];
    const c2 = src.substr(i, 2);
    if (str === null) {
      if (c2 === '//') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        out += ' ';
        i = j;
        continue;
      }
      if (c2 === '/*') {
        let j = src.indexOf('*/', i + 2);
        if (j < 0) return null; // unterminated block comment: anomaly
        out += ' ';
        i = j + 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { str = c; out += c; i++; prevSig = c; continue; }
      if (c === "/" && regexAllowed(prevSig)) {
        // regex literal: copy until unescaped / (not inside character class)
        let j = i + 1, inClass = false, ok = false;
        while (j < n) {
          const r = src[j];
          if (r === '\\') { j += 2; continue; }
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) { ok = true; break; }
          else if (r === "\n") break;
          j++;
        }
        if (!ok) return null; // ambiguous: treat as anomaly
        out += src.slice(i, j + 1);
        i = j + 1;
        prevSig = "/";
        continue;
      }
      if (c === '{') { braceDepth++; out += c; i++; prevSig = c; continue; }
      if (c === "}") {
        if (tplStack.length && tplStack[tplStack.length - 1] === braceDepth) {
          tplStack.pop();
          str = "`"; // resume template scanning
          braceDepth--;
          out += c; i++; prevSig = c; continue;
        }
        braceDepth--; out += c; i++; prevSig = c; continue;
      }
      if (!/\s/.test(c)) prevSig = c;
      out += c; i++;
      continue;
    }
    // inside a string/template
    if (c === "\\") { out += src.substr(i, 2); i += 2; continue; }
    if (str === "`" && c2 === "${") {
      braceDepth++; // count the expression's own opening brace
      tplStack.push(braceDepth);
      str = null;
      out += c2; i += 2; prevSig = "{"; continue;
    }
    if ((str === "'" && c === "'") || (str === '"' && c === '"') || (str === "`" && c === "`")) {
      out += c; str = null; i++; prevSig = c; continue;
    }
    if (str !== "`" && c === "\n") { return null; // newline inside quote: anomaly
    }
    out += c; i++;
  }
  if (str !== null || tplStack.length !== 0) return null; // unbalanced: anomaly
  return out;
}
function regexAllowed(prev) {
  if (prev === '') return true;
  if (/[\w$)\]"']/.test(prev)) return false; // after ident/number/)/]/quote: division
  return true; // after operators/(/,/=/:/etc: regex allowed
}


// Verb-level mutation signals for shell commands (surface check done by caller).
// Each ordered program/sink branch stops before another eligible program.
// A later program can match the same sink, so boolean decisions are preserved
// without repeatedly scanning overlapping line tails. (?=\S) prevents the
// separator and the tail from consuming the same whitespace. The redirect
// starts at > instead of retrying optional digits/whitespace at every offset.
const MUTATION_VERBS_RE = /(?:(?<![->=])>{1,2}\s*(?!\/dev\/null\b)(?!&\d)[^\s;&|]|\b(?:tee|cp|mv|rm|install|truncate|ln|shred|sponge)\b|\b(?:sed|perl|yq)\s+(?=\S)(?:(?!\b(?:sed|perl|yq)\s+)[^\n])*-i\b|\bfind\s+(?=\S)(?:(?!\bfind\s+)[^\n])*-delete\b|\bgit\s+(?:apply|checkout|restore|mv|clean)\b|\b(?:python|python3|node|deno|ruby|perl)\b(?:(?!\b(?:python|python3|node|deno|ruby|perl)\b)[^\n])*(?:write|open\(|rmSync|renameSync|unlink|rename))/i;

// Historical blunt matcher kept verbatim as the fail-closed fallback.
const BLUNT_CODE_MUTATION_RE = /(?:tools\s*(?:\.\s*(?:write|edit|bash)|\[\s*['"](?:write|edit|bash)['"]\s*\])|(?:fs(?:\.promises)?|fsp|fileHandle)\s*(?:\.|\[\s*['"])(?:writeFile|writeFileSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|createWriteStream|symlink|symlinkSync|link|linkSync)(?:['"]\s*\])?|(?:writeFileSync|writeFile|rmSync|renameSync|unlinkSync|copyFileSync|createWriteStream|symlinkSync|linkSync|writeTextFileSync|writeTextFile)\s*\(|(?:Bun\.write|Deno\.write(?:Text)?File(?:Sync)?)\s*\()/i;

// Locator for direct host/fs write APIs. It only *finds* the call site; the
// destination is then resolved from the call's first argument. A bare
// textual mention of a protected path is never a mutation signal (2026-09-11).
// Deno 的写入家族还有 Sync 变体（Deno.writeTextFileSync / Deno.writeFileSync）：
// 名字比 writeTextFile 长，必须排在前面，否则前缀匹配后拿不到 `(` 而漏判。
const FS_WRITE_LOCATOR_RE = /(?:\b(?:fs|fsp|fileHandle)(?:\.promises)?\s*(?:\.|\[\s*['"])(?:writeFileSync|writeFile|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|createWriteStream|symlinkSync|symlink|linkSync|link)(?:['"]\s*\])?|\b(?:writeFileSync|writeFile|rmSync|renameSync|unlinkSync|copyFileSync|createWriteStream|symlinkSync|linkSync|writeTextFileSync|writeTextFile)|(?:Bun\.write|Deno\.write(?:Text)?File(?:Sync)?))/gi;

// 目标表达式是否可能指向 Cordis trust root——只用于无法静态解析的目标，
// 绝不对正文内容做判定（2026-09-11 治理）。
const TARGET_SUSPECT_RE = /cordis/i;


// Locate tools.bash / tools.write / tools.edit calls (dot and bracket forms)
// in comment-stripped source; returns their argument-span texts.
function findToolCalls(src) {
  const out = [];
  const re = /tools\s*(?:\.\s*(write|edit|bash)\b|\[\s*['"](write|edit|bash)['"]\s*\])/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const kind = m[1] || m[2];
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "(") continue;
    let depth = 0, str = null;
    const tplStack = [];
    let braceDepth = 0;
    const start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (str !== null) {
        if (c === "\\") { i++; continue; }
        if (str === "`" && c === "$" && src[i + 1] === "{") { braceDepth++; tplStack.push(braceDepth); str = null; i++; continue; }
        if ((str === "'" && c === "'") || (str === '"' && c === '"') || (str === "`" && c === "`")) { str = null; continue; }
        continue;
      }
      if (c === "'" || c === '"' || c === "`") { str = c; continue; }
      if (c === "{") { braceDepth++; continue; }
      if (c === "}") {
        if (tplStack.length && tplStack[tplStack.length - 1] === braceDepth) { tplStack.pop(); braceDepth--; str = "`"; continue; }
        braceDepth--; continue;
      }
      if (c === "(") { depth++; continue; }
      if (c === ")") {
        depth--;
        if (depth === 0) { out.push({ kind, text: src.slice(start, i + 1) }); break; }
      }
    }
  }
  return out;
}

// Extract a fully-static labeled value (string literal chain joined by +).
// Returns null when anything dynamic is involved (fail-closed upstream).
function decodeEsc(text, j) {
  const c = text[j + 1];
  if (c === 'n') return '\n';
  if (c === 't') return '\t';
  return c;
}
function extractLabeledValue(text, label) {
  const m = new RegExp(label + "\\s*:\\s*").exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let val = "";
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    const q = text[i];
    if (q === "'" || q === '"') {
      let j = i + 1, s = "";
      while (j < text.length && text[j] !== q) {
        if (text[j] === "\\") { s += decodeEsc(text, j); j += 2; }
        else { s += text[j]; j++; }
      }
      if (text[j] !== q) return null;
      val += s; i = j + 1;
    } else if (q === "`") {
      let j = i + 1, s = "";
      while (j < text.length && text[j] !== "`") {
        if (text[j] === "\\") { s += decodeEsc(text, j); j += 2; }
        else if (text[j] === "$" && text[j + 1] === "{") { return null; }
        else { s += text[j]; j++; }
      }
      if (text[j] !== "`") return null;
      val += s; i = j + 1;
    } else { return null; } // 链中混入动态 token：整体不可静态判定
    let k = i;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] === "+") {
      // `+` 之后仍必须是字符串字面量，否则该值整体是动态的。
      let p = k + 1;
      while (p < text.length && /\s/.test(text[p])) p++;
      if (text[p] !== "'" && text[p] !== '"' && text[p] !== "`") return null;
      i = p;
      continue;
    }
    break;
  }
  return val === "" ? null : val;
}

// ── 写入目标解析：判定「实际写到哪里」，而不是「参数里提到了哪里」 ──────────
//
// 2026-09-11 治理（本周同类误杀第三种；前两次见 08-26 只读误杀、08-31 箭头误判）：
// 旧实现先对**原始文本**跑 touchesProtectedSurface 做粗闸门，再对一条 fs 写入 API 的文本匹配
//「命中即拒」——于是「正文里提到受保护面」被当成「正在写受保护面」。合法任务只要
// 写入内容里出现一个 Cordis 路径字符串，整条调用就会被拒绝。
//
// 现行语义：先从结构化字段 / 调用实参解析出**真正会被写入的目标**，只对目标做判定。
// 字符串字面量只是数据；只有出现在目标位置的路径才参与判定。目标无法可靠解析时，
// 仅当**目标表达式本身**可疑（或指向同源常量里绑定的受保护路径）才 fail-closed。

/** 单个、或由 + 连接的多个字符串字面量的静态值；含任何动态部分时返回 null。 */
function staticStringValue(text) {
  const s = String(text ?? "").trim();
  if (s === "") return null;
  let i = 0;
  let val = "";
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    const q = s[i];
    if (q !== "'" && q !== '"') return null;
    let j = i + 1;
    let closed = false;
    while (j < s.length) {
      if (s[j] === "\\") {
        const e = s[j + 1];
        val += e === "n" ? "\n" : e === "t" ? "\t" : (e ?? "");
        j += 2;
        continue;
      }
      if (s[j] === q) { closed = true; break; }
      val += s[j];
      j++;
    }
    if (!closed) return null;
    i = j + 1;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === "+") { i++; continue; }
    return i >= s.length ? val : null;
  }
}

/** 取 `label:` 之后、到顶层分隔符（`,` / 调用右括号）之前的原始表达式文本。 */
function extractLabeledSpan(text, label) {
  const m = new RegExp(label + "\\s*:\\s*").exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  let i = start;
  let depth = 0;
  let str = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (str !== null) {
      if (c === "\\") { i++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { str = c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]") { if (depth === 0) break; depth--; continue; }
    if (c === "}") { if (depth === 0) break; depth--; continue; }
    if (c === "," && depth === 0) break;
  }
  const span = text.slice(start, i).trim();
  return span === "" ? null : span;
}

/** 同一份源码里常量字符串绑定（`const x = 字面量`），用于解开动态目标。 */
function staticBindings(clean) {
  const map = new Map();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    map.set(m[1], (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1"));
  }
  return map;
}

/** 动态目标表达式是否可能指向受保护面（只在目标位置判定，绝不看正文）。 */
function dynamicTargetIsSuspicious(expr, bindings) {
  if (typeof expr !== "string" || expr === "") return false;
  if (TARGET_SUSPECT_RE.test(expr)) return true;
  for (const name of expr.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    const bound = bindings.get(name);
    if (bound !== undefined && touchesProtectedSurface(bound)) return true;
  }
  return false;
}

/** 定位直接 host/fs 写入调用，返回首实参跨度（第一个实参才是写入目标）。 */
function findFsWriteCalls(src) {
  const out = [];
  const re = new RegExp(FS_WRITE_LOCATOR_RE.source, "gi");
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== "(") continue;
    i++;
    const start = i;
    let depth = 0;
    let str = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (str !== null) {
        if (c === "\\") { i++; continue; }
        if (c === str) str = null;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") { str = c; continue; }
      if (c === "(" || c === "[" || c === "{") { depth++; continue; }
      if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; continue; }
      if (c === "," && depth === 0) break;
    }
    out.push({ api: m[0], arg: src.slice(start, i).trim() });
  }
  return out;
}

/** 把 shell 命令切成词；重定向操作符单独成词（箭头/比较符不算重定向）。 */
function shellWords(command) {
  const words = [];
  let cur = "";
  let started = false;
  let quoted = null;
  const flush = () => { if (started) { words.push(cur); cur = ""; started = false; } };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quoted !== null) {
      if (c === "\\" && quoted === '"') { cur += command[i + 1] ?? ""; i++; continue; }
      if (c === quoted) { quoted = null; continue; }
      cur += c; started = true; continue;
    }
    if (c === "\\") { cur += command[i + 1] ?? ""; i++; started = true; continue; }
    if (c === "'" || c === '"') { quoted = c; started = true; continue; }
    if (c === " " || c === "\t" || c === "\n") { flush(); continue; }
    if (c === ";") { flush(); words.push(";"); continue; }
    if (c === "|") { flush(); if (command[i + 1] === "|") i++; words.push("|"); continue; }
    if (c === "&") { flush(); if (command[i + 1] === "&") i++; words.push("&"); continue; }
    if (c === ">" || c === "<") {
      const prev = command[i - 1];
      if (c === ">" && (prev === "-" || prev === "=")) { cur += c; started = true; continue; }
      let op = c;
      let j = i + 1;
      if (command[j] === c) { op += c; j++; if (c === "<" && command[j] === "<") { op += c; j++; } }
      /* fd 复制（2>&1 / 1>&2 / >&2 / >&-）：`>` 紧跟 `&` + 数字或 `-`。它复制的是
         已打开的描述符，不打开任何文件，因此不产生写入目标。若按普通 `>` 切词，会留下
         悬空操作符 → shellWriteTargets 判 inconclusive → 叠加 TARGET_SUSPECT_RE(/cordis/i)
         后把只读命令误杀（2026-09-11 实证：`cat …/cordis.patch.yml 2>&1` 被拒，而同一命令
         不加 `2>&1` 时放行）。这里把整个 fd 复制连同前置 io-number 一起消费，不产出任何词，
         与 bash 语义一致。只认单个 `>`：`>>&1` 不是 fd 复制，保持既有保守行为。 */
      if (op === ">" && command[j] === "&" && (/[0-9]/.test(command[j + 1] ?? "") || command[j + 1] === "-")) {
        let k = j + 1;
        if (command[k] === "-") k++;
        else while (/[0-9]/.test(command[k] ?? "")) k++;
        if (/^\d+$/.test(cur)) { cur = ""; started = false; }
        flush();
        i = k - 1;
        continue;
      }
      if (/^\d+$/.test(cur)) { cur = ""; started = false; }
      flush();
      words.push(op);
      i = j - 1;
      continue;
    }
    cur += c; started = true;
  }
  flush();
  return words;
}

const SHELL_WRITE_DEST_LAST = new Set(["cp", "mv", "install", "ln", "rsync", "scp"]);
const SHELL_WRITE_ALL_OPERANDS = new Set(["rm", "unlink", "shred", "truncate", "tee", "sponge"]);
const SHELL_INPLACE_EDITORS = new Set(["sed", "perl", "yq", "ruby", "gawk", "awk"]);

// ── 直接写入的额外载体（P3-1 守卫加固）────────────────────────────────────
//
// 定位不变：守卫只是启发式误操作提示，不是 shell/JavaScript 沙箱（RELEASE.md §6 第 3 条）。
// 这里只多识别几种**目标无歧义**的直接写入载体，判定依据仍然是「真正会被写到哪」：
//   - cp/mv/install/ln 的 -t/--target-directory 目标目录（rsync/scp 的 -t 不是这个含义，不参与）
//   - dd 的 of= 目标
//   - sh|bash -c 与 xargs 之后的**内层命令**（递归解析，最多 MAX_SHELL_NESTING 层）
//   - node/deno/bun 的 -e/--eval/eval/-p 内联代码（交给 codeMutatesComposition 判写入目标）
//   - git 全局选项（-C/--git-dir/--work-tree）里指向信任根的工作树与子命令操作数
//   - 子 shell 分组括号 ( … ) / { … }：括号不是命令词，也不是操作数
// 明确不覆盖（需要真正的 shell 语义求值，本守卫不做）：sudo/env/nohup 等包装命令前缀、eval、
// 作为**目标**出现的变量与命令替换（$V、$(…)）、别名与函数、base64|sh 之类重新拼接，
// 以及伪终端里的人工输入。
const SHELL_TARGET_DIRECTORY_VERBS = new Set(["cp", "mv", "install", "ln"]);
// 只由分组字符组成的词（`(`、`((`、`)`、`{}`）是语法结构，既不是命令词也不是操作数。
const SHELL_GROUP_TOKEN_RE = /^[(){}\[\]]+$/;
const SHELL_VERBS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash"]);
const SHELL_EVAL_VERBS = new Set(["node", "nodejs", "deno", "bun"]);
// xargs 中需要单独取值的选项；其余 -x 形式按无值选项跳过。
const XARGS_VALUE_OPTIONS = new Set(["-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "--process-slot-var"]);
/** 内层命令最多逐层解析的层数：到上限后改为保守的正文判定，避免深度嵌套造成二次回溯或栈溢出。 */
const MAX_SHELL_NESTING = 4;
const NESTED_FALLBACK_WRITE_RE = new RegExp(MUTATION_VERBS_RE.source + "|\\b(?:dd|xargs)\\b", "i");

/** 就地编辑选项：-i / -i.bak / --in-place，以及短选项簇里含 i 的写法（-pi、-Ei、-ni）。
    原先只认 `-i`/`-i` 前缀，`perl -pi -e …`（-p 与 -i 合并）因此漏判（2026-09-11 实测：
    `perl -pi -e s/a/b/ <trust-root>` 未被拦）。长选项不以 i 结尾判定，避免 --include 之类误判。 */
function isInPlaceOption(option) {
  if (typeof option !== "string" || option.length < 2 || option[0] !== "-") return false;
  if (option.startsWith("--")) return option.startsWith("--in-place");
  return option.slice(1).includes("i");
}

function isDynamicWord(word) {
  return /[$`*?]/.test(word);
}

/** 短选项簇（-c、-lc、-tDIR、-eCODE）中 letter 之后的字面值；簇里没有该字母返回 null，字母在末尾返回 ""。 */
function shortClusterValue(word, letter) {
  if (typeof word !== "string" || word.length < 2 || word[0] !== "-" || word[1] === "-") return null;
  const at = word.indexOf(letter, 1);
  return at < 0 ? null : word.slice(at + 1);
}

/** cp/mv/install/ln 的目标目录选项值；没有 -t/--target-directory 时返回 undefined。 */
function targetDirectoryValue(seg, start) {
  for (let i = start; i < seg.length; i++) {
    const w = seg[i];
    if (w === "--target-directory") return seg[i + 1] ?? null;
    if (w.startsWith("--target-directory=")) return w.slice("--target-directory=".length) || null;
    const attached = shortClusterValue(w, "t");
    if (attached !== null) return attached === "" ? (seg[i + 1] ?? null) : attached;
  }
  return undefined;
}

/** sh|bash -c 的内层命令；没有 -c 时返回 undefined。 */
function shellCommandValue(seg, start) {
  for (let i = start; i < seg.length; i++) {
    const w = seg[i];
    if (w === "--command") return seg[i + 1] ?? null;
    const attached = shortClusterValue(w, "c");
    if (attached !== null) return attached === "" ? (seg[i + 1] ?? null) : attached;
  }
  return undefined;
}

/** node/deno/bun 的内联代码（-e/--eval/-p 与 deno eval）；没有时返回 undefined。 */
function evalCodeValue(seg, ci) {
  const verb = seg[ci].split("/").pop();
  for (let i = ci + 1; i < seg.length; i++) {
    const w = seg[i];
    if (w === "--eval" || w === "-e" || (verb === "deno" && w === "eval")) return seg[i + 1] ?? null;
    if (w.startsWith("--eval=")) return w.slice("--eval=".length);
    if ((verb === "node" || verb === "nodejs") && (w === "--print" || w === "-p")) return seg[i + 1] ?? null;
    const attached = shortClusterValue(w, "e");
    if (attached !== null && attached !== "") return attached;
  }
  return undefined;
}

/** xargs 之后的命令词（跳过 xargs 自身的选项）；空数组表示没有内层命令。 */
function xargsCommandWords(seg, start) {
  let i = start;
  while (i < seg.length) {
    const w = seg[i];
    if (w === ">" || w === ">>" || w === "<" || w === "<<") { i += 2; continue; }
    if (w === "--") { i++; break; }
    if (XARGS_VALUE_OPTIONS.has(w)) { i += 2; continue; }
    if (w.startsWith("-") && w !== "-") { i++; continue; }
    break;
  }
  return seg.slice(i);
}

/** git 的全局选项与子命令：跳过取值选项后定位子命令，并记录 -C/--work-tree/--git-dir 的目标。 */
function gitInvocation(seg, start) {
  let workdir = null;
  let i = start;
  while (i < seg.length) {
    const w = seg[i];
    if (w === "-C" || w === "--git-dir" || w === "--work-tree" || w === "-c" || w === "--config-env") {
      const value = seg[i + 1] ?? null;
      if (w === "-C" || w === "--work-tree" || w === "--git-dir") workdir = value;
      if (value === null) return { subIndex: -1, workdir };
      i += 2;
      continue;
    }
    if (w.startsWith("--git-dir=") || w.startsWith("--work-tree=")) {
      workdir = w.slice(w.indexOf("=") + 1);
      i++;
      continue;
    }
    const attached = shortClusterValue(w, "C");
    if (attached !== null && attached !== "") { workdir = attached; i++; continue; }
    if (w.startsWith("-")) { i++; continue; }
    return { subIndex: i, workdir };
  }
  return { subIndex: -1, workdir };
}

/** 从 shell 命令解析真正会被写入的目标；无法可靠解析时置 inconclusive。
    nested 收集需要递归解析的内层命令（sh -c / xargs），由 commandMutatesComposition 下钻。 */
function shellWriteTargets(command) {
  const words = shellWords(command);
  const targets = [];
  const nested = [];
  let inconclusive = false;
  const addTarget = (word) => {
    if (typeof word !== "string" || word === "") { inconclusive = true; return; }
    if (isDynamicWord(word)) { inconclusive = true; return; }
    targets.push(word);
  };
  const segments = [[]];
  for (const w of words) {
    if (w === ";" || w === "|" || w === "&") segments.push([]);
    else segments[segments.length - 1].push(w);
  }
  for (const raw of segments) {
    // 分组括号只是语法结构，既不是命令词也不是操作数。
    const seg = raw.filter((w) => !SHELL_GROUP_TOKEN_RE.test(w));
    if (seg.length === 0) continue;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] !== ">" && seg[i] !== ">>") continue;
      const next = seg[i + 1];
      if (next === undefined) inconclusive = true;
      else if (next !== "/dev/null" && !next.startsWith("&")) addTarget(next);
      i++;
    }
    let ci = 0;
    while (ci < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[ci])) ci++;
    const cmdWord = seg[ci];
    if (!cmdWord) continue;
    // 无空格写法 `(cp …)` 让括号粘在命令词上，这里只剥离开头的分组字符。
    const verb = cmdWord.replace(/^[({\[]+/, "").split("/").pop();
    const operands = [];
    const options = [];
    for (let i = ci + 1; i < seg.length; i++) {
      const w = seg[i];
      if (w === ">" || w === ">>" || w === "<" || w === "<<") { i++; continue; }
      if (w.startsWith("-") && w !== "-") { options.push(w); continue; }
      operands.push(w);
    }
    if (SHELL_WRITE_DEST_LAST.has(verb)) {
      const dir = SHELL_TARGET_DIRECTORY_VERBS.has(verb) ? targetDirectoryValue(seg, ci + 1) : undefined;
      if (dir !== undefined) {
        // -t/--target-directory 已经指出了目标目录，最后的操作数只是源。
        if (dir === null) inconclusive = true;
        else addTarget(dir);
      } else if (operands.length === 0) inconclusive = true;
      else addTarget(operands[operands.length - 1]);
    } else if (verb === "dd") {
      const sink = operands.find((o) => o.startsWith("of="));
      if (sink !== undefined) addTarget(sink.slice("of=".length));
    } else if (SHELL_WRITE_ALL_OPERANDS.has(verb)) {
      if (operands.length === 0) inconclusive = true;
      else for (const o of operands) addTarget(o);
    } else if (SHELL_INPLACE_EDITORS.has(verb)) {
      if (options.some(isInPlaceOption)) {
        if (operands.length === 0) inconclusive = true;
        else addTarget(operands[operands.length - 1]);
      }
    } else if (verb === "find") {
      if (seg.includes("-delete")) {
        if (operands.length === 0) inconclusive = true;
        else for (const o of operands) addTarget(o);
      }
    } else if (verb === "git") {
      // 子命令在全局选项之后：git -C <dir> checkout … / git --git-dir=<dir> clean …
      const { subIndex, workdir } = gitInvocation(seg, ci + 1);
      const sub = subIndex < 0 ? undefined : seg[subIndex];
      if (sub && /^(apply|checkout|restore|mv|clean)$/.test(sub)) {
        // git 目录/工作树指向信任根时，被改写的正是信任根里的内容。
        if (workdir !== null) addTarget(workdir);
        const outs = operands.slice(operands.indexOf(sub) + 1);
        if (outs.length === 0) inconclusive = true;
        else for (const o of outs) addTarget(o);
      }
    } else if (SHELL_VERBS.has(verb)) {
      const inner = shellCommandValue(seg, ci + 1);
      if (typeof inner === "string" && inner !== "") nested.push({ kind: "shell", text: inner });
    } else if (verb === "xargs") {
      const inner = xargsCommandWords(seg, ci + 1).join(" ");
      if (inner !== "") nested.push({ kind: "shell", text: inner });
    } else if (SHELL_EVAL_VERBS.has(verb)) {
      const code = evalCodeValue(seg, ci);
      if (typeof code === "string" && code !== "") nested.push({ kind: "code", text: code });
    }
  }
  return { targets, inconclusive, nested };
}

function commandMutatesComposition(command, depth = 0) {
  if (typeof command !== "string") return false;
  // 先看真正的写入目标；只有目标命中 Cordis trust root 才拦。
  const { targets, inconclusive, nested } = shellWriteTargets(command);
  if (targets.some((t) => protectedTargetPath(t))) return true;
  // 目标解析不出来、且目标表达式可疑时保守拦截（只看目标，不看正文）。
  if (inconclusive && TARGET_SUSPECT_RE.test(command)) return true;
  // 保持既有语义：显式不可逆操作叠加写动词仍然拒绝。
  if (IRREVERSIBLE_OPERATION_RE.test(command) && MUTATION_VERBS_RE.test(command)) return true;
  // 内层命令（sh -c / xargs / node -e）：命令文本不含受保护字样时不可能写出信任根，无需下钻。
  if (nested.length === 0 || !TARGET_SUSPECT_RE.test(command)) return false;
  if (depth >= MAX_SHELL_NESTING) {
    // 到达嵌套上限后不再逐层解析；但内层同时出现写动词与受保护字样时保守拒绝，
    // 纯只读内层（cat/git status 之类）仍然放行。
    return nested.some((n) => TARGET_SUSPECT_RE.test(n.text) && NESTED_FALLBACK_WRITE_RE.test(n.text));
  }
  return nested.some((n) => (n.kind === "shell"
    ? commandMutatesComposition(n.text, depth + 1)
    : codeMutatesComposition(n.text, depth + 1)));
}

function codeMutatesComposition(code, depth = 0) {
  if (typeof code !== "string") return false;
  const clean = stripJsComments(code);
  if (clean === null) {
    // Tokenizer anomaly: fail closed with the historical blunt rule.
    return BLUNT_CODE_MUTATION_RE.test(code) && touchesProtectedSurface(code);
  }
  const bindings = staticBindings(clean);
  // (1) tools.write / tools.edit / tools.bash —— 目标取自结构化字段。
  for (const call of findToolCalls(clean)) {
    if (call.kind === "bash") {
      const cmd = extractLabeledValue(call.text, "command");
      if (cmd === null) {
        if (dynamicTargetIsSuspicious(extractLabeledSpan(call.text, "command"), bindings)) return true;
        continue;
      }
      if (commandMutatesComposition(cmd, depth + 1)) return true;
    } else {
      let target = extractLabeledValue(call.text, "file_path");
      let span = extractLabeledSpan(call.text, "file_path");
      if (target === null) {
        target = extractLabeledValue(call.text, "path");
        span = extractLabeledSpan(call.text, "path");
      }
      if (target === null) {
        if (dynamicTargetIsSuspicious(span, bindings)) return true;
        continue;
      }
      if (protectedTargetPath(target)) return true;
    }
  }
  // (2) 直接 host/fs 写入 API —— 只有第一个实参是写入目标。
  for (const call of findFsWriteCalls(clean)) {
    const literal = staticStringValue(call.arg);
    if (literal !== null) {
      if (protectedTargetPath(literal)) return true;
      continue;
    }
    if (dynamicTargetIsSuspicious(call.arg, bindings)) return true;
  }
  return false;
}

function mutationDeny(exec) {
  const directCordisMutation = (exec.name === 'edit' || exec.name === 'write')
    && (protectedTargetPath(exec.arguments?.file_path) || protectedTargetPath(exec.arguments?.path))
    || (exec.name === 'bash' || exec.name === 'pwsh')
      && commandMutatesComposition(exec.arguments?.command)
    || exec.name === 'run_code' && codeMutatesComposition(exec.arguments?.code);
  if (directCordisMutation) return '[dsh-composition-guard] 直接修改 Cordis trust root 已被拒绝；必须通过受验证的 Cordis 生命周期事务。';
  const mutationTarget = normalizedTarget(exec, operationContextOf(exec));
  const directIrreversibleMutation = (exec.name === 'edit' || exec.name === 'write')
    && (IRREVERSIBLE_PATH_RE.test(mutationTarget) || IRREVERSIBLE_PATH_RE.test(resolvedPath(mutationTarget)));
  if (directIrreversibleMutation && !isVerifiedManagedTransaction(exec)) {
    return '[dsh-composition-guard] 凭证/API key/Keychain/.env 等不可逆风险目标必须通过经验证的可回滚事务。';
  }
  if (isVerifiedManagedTransaction(exec)) return null;
  if (invalidManagedContext(exec)) return '[dsh-composition-guard] 该操作触及 Cordis trust root 或不可逆风险，但未提供经验证的 Cordis 生命周期/事务证明；已在执行前拒绝。';
  // bash/pwsh 已在上面的 directCordisMutation 中用同一个 commandMutatesComposition
  // （目标语义）判定，这里不再重复——重复分支只会多出一条同义消息。
  return null;
}

function missingRequirements(filePath, content) {
  const ids = parseRows(content);
  const missing = [];
  if (!ids.has('persona')) missing.push('persona(承载 persona 文本)');
  const presetDir = presetDirOf(filePath);
  const isSelfEvolving = fs.existsSync(path.join(presetDir, 'EVOLUTION.md'));
  if (isSelfEvolving && !ids.has('agent-instructions')) {
    missing.push('agent-instructions(自进化预设必备)');
  }
  if (isSelfEvolving && ids.has('persona')) {
    const m = /^- id: persona\s*$[\s\S]*?^- id: [a-z0-9-]+\s*$/m.exec(content);
    const personaText = m ? content.slice(m.index, m.index + m[0].length) : '';
    const emptyAnchors = ANCHORS.filter(a => !personaText.includes(a));
    if (emptyAnchors.length > 0) {
      missing.push('persona 文本锚点(' + emptyAnchors.join('/') + ')');
    }
  }
  return missing;
}

/**
 * 非阻断诊断出口：只留证据，从不改变执行结果。
 * @param ctx - 插件上下文。
 * @param diagnostic - 组合锚点诊断载荷。
 */
function report(ctx, diagnostic) {
  try {
    if (typeof ctx?.emit === 'function') {
      const emitted = ctx.emit('composition/diagnostic', diagnostic);
      if (emitted && typeof emitted.catch === 'function') emitted.catch(() => {});
      return;
    }
    ctx?.logger?.warn?.('composition diagnostic', diagnostic);
  } catch {
    // Diagnostics must never become an execution failure.
  }
}

export function apply(ctx) {
  const reason = (exec) => {
    const mutationReason = mutationDeny(exec);
    if (mutationReason) return mutationReason;
    return undefined;
  };
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard(reason);
  } else {
    // Compatibility fallback for isolated tests/older hosts. Production uses the
    // monotonic guard, so later waterfall listeners cannot re-allow.
    ctx.on('tools/pre-execute', (exec, next) => {
      const denied = reason(exec);
      return denied ? { kind: 'deny', reason: denied } : next();
    });
  }

  // 与 deny 闸门并存的非阻断观察：预设组合的锚点完整性只报告、不拦截，
  // 普通 composition / promoted plugin / guard / orchestrator 的演进不受影响。
  if (typeof ctx.on === 'function') {
    ctx.on('tools/post-execute', (exec, result, next) => {
      try {
        const simulated = simulateResult(exec);
        if (simulated && !simulated.noop) {
          const missing = missingRequirements(simulated.filePath, simulated.content);
          if (missing.length > 0) report(ctx, { filePath: simulated.filePath, missing });
        }
      } catch (error) {
        report(ctx, { filePath: exec?.arguments?.file_path ?? null, error: String(error?.message ?? error) });
      }
      return next();
    });
  }
}

export {
  commandMutatesComposition,
  codeMutatesComposition,
  MANAGED_TRANSACTION,
  stripJsComments,
  findToolCalls,
  extractLabeledValue,
  MUTATION_VERBS_RE,
  FS_WRITE_LOCATOR_RE,
  TARGET_SUSPECT_RE,
  staticStringValue,
  extractLabeledSpan,
  dynamicTargetIsSuspicious,
  findFsWriteCalls,
  shellWords,
  shellWriteTargets,
  isCordisTrustRoot,
  IRREVERSIBLE_PATH_RE,
  boundaryRequiresProof,
  // 保留既有公开面：组合结构工具与诊断模拟仍对外可用（tests/evolution.test.mjs 依赖）。
  isPresetComposition,
  parseRows,
  simulateResult,
  missingRequirements,
};
