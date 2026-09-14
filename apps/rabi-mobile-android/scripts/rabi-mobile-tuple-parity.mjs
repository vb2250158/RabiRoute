import fs from "node:fs";
import { pathToFileURL } from "node:url";

function normalize(record, side, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${side}[${index}] must be an object`);
  }
  const tuple = {
    sourceDeviceId: String(record.sourceDeviceId ?? record.source_device_id ?? ""),
    chunkId: String(record.chunkId ?? record.chunk_id ?? ""),
    acceptedBytes: Number(record.acceptedBytes ?? record.accepted_bytes),
    sha256: String(record.sha256 ?? "").toLowerCase(),
    sourceSequence: Number(record.sourceSequence ?? record.source_sequence),
    streamSequence: Number(record.streamSequence ?? record.stream_sequence),
    terminal: record.terminal === undefined ? true : Boolean(record.terminal),
    terminalStatus: String(record.terminalStatus ?? record.terminal_status ?? "processed"),
  };
  if (!tuple.sourceDeviceId || !tuple.chunkId) throw new Error(`${side}[${index}] is missing tuple identity`);
  if (!Number.isSafeInteger(tuple.acceptedBytes) || tuple.acceptedBytes <= 0) {
    throw new Error(`${side}[${index}] has invalid acceptedBytes`);
  }
  if (!Number.isSafeInteger(tuple.sourceSequence) || tuple.sourceSequence <= 0) {
    throw new Error(`${side}[${index}] has invalid sourceSequence`);
  }
  if (!Number.isSafeInteger(tuple.streamSequence) || tuple.streamSequence <= 0) {
    throw new Error(`${side}[${index}] has invalid streamSequence`);
  }
  if (!/^[0-9a-f]{64}$/.test(tuple.sha256)) throw new Error(`${side}[${index}] has invalid sha256`);
  if (!tuple.terminal) throw new Error(`${side}[${index}] is not terminal`);
  return tuple;
}

export function compareTupleParity(phoneRecords, serverRecords) {
  if (!Array.isArray(phoneRecords) || !Array.isArray(serverRecords)) {
    throw new Error("phone and server tuple manifests must both be arrays");
  }
  const phone = phoneRecords.map((row, index) => normalize(row, "phone", index));
  const server = serverRecords.map((row, index) => normalize(row, "server", index));
  const duplicate = (rows, side) => {
    const sourceSequences = new Set();
    const chunkIds = new Set();
    for (const row of rows) {
      if (sourceSequences.has(row.sourceSequence)) throw new Error(`${side} duplicate source sequence ${row.sourceSequence}`);
      if (chunkIds.has(row.chunkId)) throw new Error(`${side} duplicate chunk id ${row.chunkId}`);
      sourceSequences.add(row.sourceSequence);
      chunkIds.add(row.chunkId);
    }
  };
  duplicate(phone, "phone");
  duplicate(server, "server");
  if (phone.length !== server.length) {
    throw new Error(`tuple count mismatch: phone=${phone.length} server=${server.length}`);
  }
  const fields = ["sourceDeviceId", "sourceSequence", "streamSequence", "chunkId", "acceptedBytes", "sha256"];
  for (let index = 0; index < phone.length; index += 1) {
    for (const field of fields) {
      if (phone[index][field] !== server[index][field]) {
        throw new Error(`tuple ${index} ${field} mismatch: phone=${phone[index][field]} server=${server[index][field]}`);
      }
    }
    if (!new Set(["processed", "operator_confirmed_processed"]).has(server[index].terminalStatus)) {
      throw new Error(`tuple ${index} has invalid server terminal status ${server[index].terminalStatus}`);
    }
  }
  return {
    matched: true,
    records: phone.length,
    bytes: phone.reduce((total, row) => total + row.acceptedBytes, 0),
    firstSourceSequence: phone.length ? phone[0].sourceSequence : null,
    lastSourceSequence: phone.length ? phone.at(-1).sourceSequence : null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const phone = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const server = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    process.stdout.write(`${JSON.stringify(compareTupleParity(phone, server))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
