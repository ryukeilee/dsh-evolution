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
  const context = exec?.operationContext || exec?.context || exec?.arguments?.operationContext;
  if (!context || typeof context !== "object") return null;
  return context;
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
  return isCordisTrustRoot(target)
    || IRREVERSIBLE_PATH_RE.test(target)
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
  const abs = path.resolve(filePath);
  const norm = abs.split(path.sep).join('/');
  return (norm.includes('/.agent-presets/') || norm.includes('/agent-presets/')) && norm.endsWith('/agent.cordis.yml');
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
const MUTATION_VERBS_RE = /(?:&?\d*(?<![->=])\s*>{1,2}\s*(?!\/dev\/null\b)(?!&\d)[^\s;&|]|\btee\b|\bsed\s+[^\n]*-i\b|\bperl\s+[^\n]*-i\b|\b(?:cp|mv|rm|install|truncate|ln|shred|sponge)\b|\bfind\s+[^\n]*-delete\b|\byq\s+[^\n]*-i\b|\bgit\s+(?:apply|checkout|restore|mv|clean)\b|\b(?:python|python3|node|deno|ruby|perl)\b[^\n]*(?:write|open\(|writeFile|rmSync|renameSync|unlink|rename|writeTextFile))/i;

// Historical blunt matcher kept verbatim as the fail-closed fallback.
const BLUNT_CODE_MUTATION_RE = /(?:tools\s*(?:\.\s*(?:write|edit|bash)|\[\s*['"](?:write|edit|bash)['"]\s*\])|(?:fs(?:\.promises)?|fsp|fileHandle)\s*(?:\.|\[\s*['"])(?:writeFile|writeFileSync|rm|rmSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|createWriteStream|symlink|symlinkSync|link|linkSync)(?:['"]\s*\])?|(?:writeFile|writeFileSync|rmSync|renameSync|unlinkSync|copyFileSync|createWriteStream|symlinkSync|linkSync|writeTextFile)\s*\(|(?:Bun\.write|Deno\.writeTextFile)\s*\()/i;

// Locator for direct host/fs write APIs. It only *finds* the call site; the
// destination is then resolved from the call's first argument. A bare
// textual mention of a protected path is never a mutation signal (2026-09-11).
const FS_WRITE_LOCATOR_RE = /(?:\b(?:fs|fsp|fileHandle)(?:\.promises)?\s*(?:\.|\[\s*['"])(?:writeFileSync|writeFile|rmSync|rm|unlinkSync|unlink|renameSync|rename|copyFileSync|copyFile|createWriteStream|symlinkSync|symlink|linkSync|link)(?:['"]\s*\])?|\b(?:writeFileSync|writeFile|rmSync|renameSync|unlinkSync|copyFileSync|createWriteStream|symlinkSync|linkSync|writeTextFile)|(?:Bun\.write|Deno\.writeTextFile))/gi;

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

/** 从 shell 命令解析真正会被写入的目标；无法可靠解析时置 inconclusive。 */
function shellWriteTargets(command) {
  const words = shellWords(command);
  const targets = [];
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
  for (const seg of segments) {
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
    const verb = cmdWord.split("/").pop();
    const operands = [];
    const options = [];
    for (let i = ci + 1; i < seg.length; i++) {
      const w = seg[i];
      if (w === ">" || w === ">>" || w === "<" || w === "<<") { i++; continue; }
      if (w.startsWith("-") && w !== "-") { options.push(w); continue; }
      operands.push(w);
    }
    if (SHELL_WRITE_DEST_LAST.has(verb)) {
      if (operands.length === 0) inconclusive = true;
      else addTarget(operands[operands.length - 1]);
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
      const sub = seg[ci + 1];
      if (sub && /^(apply|checkout|restore|mv|clean)$/.test(sub)) {
        const outs = operands.slice(1);
        if (outs.length === 0) inconclusive = true;
        else for (const o of outs) addTarget(o);
      }
    }
  }
  return { targets, inconclusive };
}

function commandMutatesComposition(command) {
  if (typeof command !== "string") return false;
  // 先看真正的写入目标；只有目标命中 Cordis trust root 才拦。
  const { targets, inconclusive } = shellWriteTargets(command);
  if (targets.some((t) => isCordisTrustRoot(t))) return true;
  // 目标解析不出来、且目标表达式可疑时保守拦截（只看目标，不看正文）。
  if (inconclusive && TARGET_SUSPECT_RE.test(command)) return true;
  // 保持既有语义：显式不可逆操作叠加写动词仍然拒绝。
  return IRREVERSIBLE_OPERATION_RE.test(command) && MUTATION_VERBS_RE.test(command);
}

function codeMutatesComposition(code) {
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
      if (commandMutatesComposition(cmd)) return true;
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
      if (touchesProtectedSurface(target)) return true;
    }
  }
  // (2) 直接 host/fs 写入 API —— 只有第一个实参是写入目标。
  for (const call of findFsWriteCalls(clean)) {
    const literal = staticStringValue(call.arg);
    if (literal !== null) {
      if (touchesProtectedSurface(literal)) return true;
      continue;
    }
    if (dynamicTargetIsSuspicious(call.arg, bindings)) return true;
  }
  return false;
}

function mutationDeny(exec) {
  const directCordisMutation = (exec.name === 'edit' || exec.name === 'write')
    && (touchesProtectedSurface(exec.arguments?.file_path) || touchesProtectedSurface(exec.arguments?.path))
    || (exec.name === 'bash' || exec.name === 'pwsh')
      && commandMutatesComposition(exec.arguments?.command)
    || exec.name === 'run_code' && codeMutatesComposition(exec.arguments?.code);
  if (directCordisMutation) return '[dsh-composition-guard] 直接修改 Cordis trust root 已被拒绝；必须通过受验证的 Cordis 生命周期事务。';
  const directIrreversibleMutation = (exec.name === 'edit' || exec.name === 'write')
    && IRREVERSIBLE_PATH_RE.test(normalizedTarget(exec, operationContextOf(exec)));
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
