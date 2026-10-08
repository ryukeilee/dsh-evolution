// Frozen readEventBridgeEvidence from 9af8ffd; shared authentication is unchanged.
import fsp from "node:fs/promises";
import { verifyEventBridgeEnvelope } from "../../lib/orchestrator.js";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export async function readEventBridgeEvidence(eventsPath, experimentId) {
  if (!eventsPath || !experimentId) return null;
  let lines;
  try {
    lines = (await fsp.readFile(eventsPath, "utf8")).split("\n").filter((l) => l.trim());
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const key = arguments[2]?.key || process.env.DSH_EVOLUTION_EVENT_BRIDGE_KEY;
  const trustedWriters = new Set(arguments[2]?.trustedWriters || ["dsh-evolution-orchestrator"]);
  if (typeof key !== "string" || key.length < 16) return null;
  let measurement = null;
  let gates = null;
  let promotion = null;
  let canary = null;
  let latestAt = null;
  const sequences = new Map();
  const replayed = new Set();
  for (const line of lines) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue;
    }
    const verified = verifyEventBridgeEnvelope(envelope, key);
    if (!verified) continue;
    const { event, writer, sequence } = verified;
    if (!trustedWriters.has(writer)) continue;
    const prior = sequences.get(writer) || 0;
    if (sequence <= prior || replayed.has(`${writer}:${sequence}`)) continue;
    sequences.set(writer, sequence);
    replayed.add(`${writer}:${sequence}`);
    if (event?.experimentId !== experimentId || typeof event?.eventType !== "string") continue;
    latestAt = event.audit?.at || latestAt;
    if (event.eventType === "measurement-completed" && isObject(event.measurement)) measurement = event.measurement;
    if (event.eventType === "promotion-succeeded") {
      if (isObject(event.evidence)) gates = event.evidence;
      if (isObject(event.promotion)) promotion = event.promotion;
      if (isObject(event.measurement) && !measurement) measurement = event.measurement;
    }
    if (event.eventType === "canary-passed" && isObject(event.canary)) canary = event.canary;
  }
  const canaryObservations = Array.isArray(canary?.observations) ? canary.observations : [];
  const observations = [];
  if (measurement) observations.push(measurement);
  for (const entry of canaryObservations) observations.push(entry);
  if (observations.length === 0 && !gates && !promotion) return null;
  const runtimeRecovered = gates?.runtimeRecovered === true;
  return {
    version: 1,
    source: "event-bridge",
    capturedAt: latestAt || null,
    promotionTimestamp: promotion?.promotionTimestamp || null,
    observations,
    latestObservation: measurement || null,
    cleanupProof: null,
    recoveryProof: {
      status: runtimeRecovered ? "recovered" : "unknown",
      source: "event-bridge:promotion-succeeded",
      verificationSource: "event-bridge:gates.runtimeRecovered",
      capturedAt: promotion?.promotionTimestamp || latestAt || null,
      runtimeRecovered,
      gateEvidence: gates,
    },
    runtimeRecovered,
    gateEvidence: gates || null,
    durable: promotion
      ? {
          pluginName: promotion.pluginName,
          pluginPath: promotion.pluginPath,
          linkPath: promotion.linkPath,
          rowId: promotion.rowId,
          archivePath: promotion.archivePath,
          presetId: promotion.presetId,
          promotionTimestamp: promotion.promotionTimestamp,
          healthObservationWindow: promotion.healthObservationWindow,
        }
      : null,
    canary: canary
      ? {
          promotionTimestamp: canary.promotionTimestamp || promotion?.promotionTimestamp || null,
          healthObservationWindow: canary.healthObservationWindow || 2,
          startupVerified: canary.startupVerified === true,
          observations: canaryObservations,
        }
      : null,
  };
}

