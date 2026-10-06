import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { assertDomainSpec, evolutionDomainSpec } from '../lib/domain-storage.js';

test('the hand-written evolution domain spec satisfies the official storage-domain contract', () => {
  assert.equal(evolutionDomainSpec.name, 'evolution_domain');
  assert.match(evolutionDomainSpec.name, /^[a-z][a-z0-9_]*$/);
  assert.equal(evolutionDomainSpec.version, 1);
  assert.equal(evolutionDomainSpec.global.schema.safeParse(null).success, false);
  assert.deepEqual(evolutionDomainSpec.global.initial, { schema: 1, aggregate: {}, applied: {}, pending: null });
});

test('assertDomainSpec fails loud on a unit name outside UNIT_NAME_RE', () => {
  assert.throws(() => assertDomainSpec({ name: 'evolution-domain', version: 1, tables: {} }), /must match/);
});

test('assertDomainSpec fails loud on a nullable global (medium null sentinel)', () => {
  assert.throws(
    () => assertDomainSpec({ name: 'evolution_domain', version: 1, tables: {}, global: { schema: z.null(), initial: null } }),
    /must not accept null/,
  );
});

test('assertDomainSpec fails loud on an invalid table name', () => {
  assert.throws(
    () => assertDomainSpec({ name: 'evolution_domain', version: 1, tables: { 'bad-name': {} } }),
    /table 'bad-name' must match/,
  );
});
