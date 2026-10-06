import { test, assert, summary } from './helpers.mjs';

// 锁定 canonical（runtime 实际加载的）event bridge 信封认证契约：
// linked-projects 旧副本完全没有 signEventBridgeEnvelope / verifyEventBridgeEnvelope，
// 一旦镜像再次落后于 canonical，本文件会因为导入不到函数而失败。
const mod = await import('file://' + new URL('../lib/orchestrator.js', import.meta.url).pathname);

const KEY = 'dsh-evolution-bridge-test-key-0123456789';
const SHORT_KEY = 'too-short';
const event = { kind: 'observation', payload: { sampleCount: 3 }, at: '2026-01-01T00:00:00.000Z' };

await test('canonical orchestrator 暴露 HMAC 信封签名/校验原语', async () => {
  assert(typeof mod.signEventBridgeEnvelope === 'function', 'signEventBridgeEnvelope 必须存在');
  assert(typeof mod.verifyEventBridgeEnvelope === 'function', 'verifyEventBridgeEnvelope 必须存在');
  const source = await (await import('node:fs/promises')).readFile(new URL('../lib/orchestrator.js', import.meta.url), 'utf8');
  assert(source.includes('canonicalBridgeJson'), 'canonicalBridgeJson 必须存在（排序稳定的负载序列化）');
});

await test('合法信封被接受，并回传事件与序号', async () => {
  const envelope = mod.signEventBridgeEnvelope(event, { key: KEY, sequence: 1 });
  assert(envelope.schema === 2, '信封 schema 必须是 2');
  assert(envelope.writer === 'dsh-evolution-orchestrator', '默认 writer 必须是 orchestrator');
  assert(typeof envelope.mac === 'string' && envelope.mac.length === 64, 'mac 必须是 sha256 hex');
  const verified = mod.verifyEventBridgeEnvelope(envelope, KEY);
  assert(verified !== null, '合法信封必须通过校验');
  assert(verified.sequence === 1, '序号必须回传');
  assert(verified.event.payload.sampleCount === 3, '事件体必须回传');
});

await test('篡改事件体或序号后校验失败', async () => {
  const envelope = mod.signEventBridgeEnvelope(event, { key: KEY, sequence: 4 });
  const tamperedEvent = structuredClone(envelope);
  tamperedEvent.event.payload.sampleCount = 999;
  assert(mod.verifyEventBridgeEnvelope(tamperedEvent, KEY) === null, '篡改事件体必须被拒绝');

  const tamperedSequence = structuredClone(envelope);
  tamperedSequence.sequence = 5;
  assert(mod.verifyEventBridgeEnvelope(tamperedSequence, KEY) === null, '篡改序号必须被拒绝');

  const tamperedWriter = structuredClone(envelope);
  tamperedWriter.writer = 'attacker';
  assert(mod.verifyEventBridgeEnvelope(tamperedWriter, KEY) === null, '篡改 writer 必须被拒绝');

  const tamperedMac = structuredClone(envelope);
  tamperedMac.mac = 'f'.repeat(64);
  assert(mod.verifyEventBridgeEnvelope(tamperedMac, KEY) === null, '伪造 mac 必须被拒绝');

  assert(mod.verifyEventBridgeEnvelope(envelope, KEY + '-wrong') === null, '错误密钥必须被拒绝');
  assert(mod.verifyEventBridgeEnvelope(envelope, '') === null, '空密钥必须被拒绝');
});

await test('过短密钥被拒绝（签名与校验两侧）', async () => {
  assert(mod.verifyEventBridgeEnvelope(mod.signEventBridgeEnvelope(event, { key: KEY, sequence: 1 }), SHORT_KEY) === null,
    '校验侧必须拒绝 <16 字符的密钥');
  // 签名侧允许构造，但校验侧必须拒绝，二者合起来保证短密钥无法通过认证。
  const shortSigned = mod.signEventBridgeEnvelope(event, { key: SHORT_KEY, sequence: 1 });
  assert(mod.verifyEventBridgeEnvelope(shortSigned, SHORT_KEY) === null, '短密钥自签也不能通过校验');
});

await test('结构非法或非正序号的信封直接返回 null 而不抛错', async () => {
  assert(mod.verifyEventBridgeEnvelope(null, KEY) === null, 'null 信封必须安全拒绝');
  assert(mod.verifyEventBridgeEnvelope({}, KEY) === null, '空对象必须安全拒绝');
  assert(mod.verifyEventBridgeEnvelope({ schema: 1, writer: 'x', sequence: 1, event: {}, mac: 'aa' }, KEY) === null, '错误 schema 必须拒绝');
  const base = mod.signEventBridgeEnvelope(event, { key: KEY, sequence: 1 });
  assert(mod.verifyEventBridgeEnvelope({ ...base, sequence: 0 }, KEY) === null, '序号 0 必须拒绝');
  assert(mod.verifyEventBridgeEnvelope({ ...base, sequence: 1.5 }, KEY) === null, '非整数序号必须拒绝');
  assert(mod.verifyEventBridgeEnvelope({ ...base, event: null }, KEY) === null, '非对象事件体必须拒绝');
  assert(mod.verifyEventBridgeEnvelope({ ...base, mac: 'zz' }, KEY) === null, '非 hex mac 必须拒绝');
});

summary();
