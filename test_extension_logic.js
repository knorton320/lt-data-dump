/**
 * Unit tests for Chrome extension pure-logic functions.
 * Run with:  node apps/chrome-extension/test_extension_logic.js
 *
 * Tests the functions that can be verified without a browser:
 *   - sortedStringify  — must match Python json.dumps(sort_keys=True, indent=2)
 *   - Firestore URL building
 *   - listTeams result parsing
 *   - ACTIVITY_COLLECTIONS constant
 *   - crc32 / createZip (lib/zip.js, inlined here)
 *   - Category selection → message flag mapping (popup.js pure logic)
 */

"use strict";

const assert = require("assert").strict;

// ─── Inline the functions under test ─────────────────────────────────────────
// (Cannot import ES-module files directly in CJS; copy the pure-logic pieces
//  here. Any change to these functions in the source files must be reflected.)

const DEFAULT_PROJECT_ID = "figment-football";
const DEFAULT_LEAGUE_ID  = "ce5UVtdRpYY9KWMyDweW";
const DEFAULT_SEASON     = "2026";

const FIRESTORE_BASE = (project) =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

const ACTIVITY_COLLECTIONS = [
  "trades",
  "activityMessages",
  "transactions",
  "freeAgentAuctionResults",
];

const PLAYER_STATS_DOCS = [
  "playerSeasonStats",
  "playerSeasonProjections",
];

function _sortKeys(val) {
  if (Array.isArray(val)) return val.map(_sortKeys);
  if (val !== null && typeof val === "object") {
    const sorted = {};
    for (const k of Object.keys(val).sort()) sorted[k] = _sortKeys(val[k]);
    return sorted;
  }
  return val;
}

function sortedStringify(val, indent = 2) {
  return JSON.stringify(_sortKeys(val), null, indent) + "\n";
}

// Parses a listCollection response to extract team ids/labels (mirrors listTeams)
function parseTeamsFromListing(listing) {
  return (listing.documents || []).map((doc) => {
    const fullName = doc.name || "";
    const teamId = fullName.includes("/") ? fullName.split("/").pop() : fullName;
    const label = doc.fields?.name?.stringValue || teamId;
    return { teamId, label };
  });
}

// ─── Inlined lib/zip.js (CRC-32 + createZip) ─────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16le(view, offset, value) {
  view.setUint16(offset, value, true);
}
function u32le(view, offset, value) {
  view.setUint32(offset, value, true);
}

function concatBytes(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

function encodeFilename(name) {
  const bytes = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i) & 0x7f;
  return bytes;
}

function localFileHeader(nameBytes, size, crc) {
  const hdr = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(hdr.buffer);
  u32le(v, 0,  0x04034b50);
  u16le(v, 4,  20); u16le(v, 6, 0); u16le(v, 8, 0);
  u16le(v, 10, 0); u16le(v, 12, 0);
  u32le(v, 14, crc); u32le(v, 18, size); u32le(v, 22, size);
  u16le(v, 26, nameBytes.length); u16le(v, 28, 0);
  hdr.set(nameBytes, 30);
  return hdr;
}

function centralDirHeader(nameBytes, size, crc, localOffset) {
  const hdr = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(hdr.buffer);
  u32le(v, 0,  0x02014b50);
  u16le(v, 4,  20); u16le(v, 6,  20); u16le(v, 8,  0); u16le(v, 10, 0);
  u16le(v, 12, 0); u16le(v, 14, 0);
  u32le(v, 16, crc); u32le(v, 20, size); u32le(v, 24, size);
  u16le(v, 28, nameBytes.length); u16le(v, 30, 0); u16le(v, 32, 0);
  u16le(v, 34, 0); u16le(v, 36, 0); u32le(v, 38, 0);
  u32le(v, 42, localOffset);
  hdr.set(nameBytes, 46);
  return hdr;
}

function endOfCentralDirectory(entryCount, centralDirSize, centralDirOffset) {
  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  u32le(v, 0,  0x06054b50);
  u16le(v, 4,  0); u16le(v, 6, 0);
  u16le(v, 8,  entryCount); u16le(v, 10, entryCount);
  u32le(v, 12, centralDirSize); u32le(v, 16, centralDirOffset);
  u16le(v, 20, 0);
  return eocd;
}

function createZip(files) {
  const enc = typeof TextEncoder !== "undefined"
    ? new TextEncoder()
    : { encode: (s) => Buffer.from(s, "utf8") };
  const entries = [];
  let localOffset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = encodeFilename(name);
    const chk = crc32(data);
    const hdr = localFileHeader(nameBytes, data.length, chk);
    entries.push({ nameBytes, data, crc: chk, size: data.length, hdr, localOffset });
    localOffset += hdr.length + data.length;
  }
  const centralDirOffset = localOffset;
  const centralParts = entries.map(({ nameBytes, crc, size, localOffset: off }) =>
    centralDirHeader(nameBytes, size, crc, off)
  );
  const centralDirSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = endOfCentralDirectory(entries.length, centralDirSize, centralDirOffset);
  return concatBytes([
    ...entries.flatMap(({ hdr, data }) => [hdr, data]),
    ...centralParts,
    eocd,
  ]);
}

// Category selection helper (mirrors popup.js startDump message building)
function buildDumpMessage({ rosterChecked, activityChecked, playerStatsChecked, bioChecked }) {
  return {
    type:             "START_DUMP",
    rosterDump:       rosterChecked,
    activityDump:     activityChecked,
    playerStatsDump:  playerStatsChecked,
    includeSampleBio: bioChecked,
  };
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function readUint32LE(buf, offset) {
  return (buf[offset] | (buf[offset+1] << 8) | (buf[offset+2] << 16) | (buf[offset+3] << 24)) >>> 0;
}

function readUint16LE(buf, offset) {
  return (buf[offset] | (buf[offset+1] << 8)) >>> 0;
}

// ─── sortedStringify tests ────────────────────────────────────────────────────

console.log("\nsortedStringify — matches Python json.dumps(sort_keys=True, indent=2)");

test("flat object with unsorted keys", () => {
  const obj = { z: 1, a: 2, m: 3 };
  const result = sortedStringify(obj);
  const parsed = JSON.parse(result);
  const keys = Object.keys(parsed);
  assert.deepStrictEqual(keys, ["a", "m", "z"]);
  assert.strictEqual(parsed.a, 2);
  assert.strictEqual(parsed.z, 1);
});

test("nested object — recursive key sort", () => {
  const obj = { z: { b: 1, a: 2 }, a: { d: 4, c: 3 } };
  const result = sortedStringify(obj);
  const parsed = JSON.parse(result);
  assert.deepStrictEqual(Object.keys(parsed), ["a", "z"]);
  assert.deepStrictEqual(Object.keys(parsed.a), ["c", "d"]);
  assert.deepStrictEqual(Object.keys(parsed.z), ["a", "b"]);
});

test("array items preserved in order", () => {
  const obj = { items: [3, 1, 2] };
  const result = sortedStringify(obj);
  const parsed = JSON.parse(result);
  assert.deepStrictEqual(parsed.items, [3, 1, 2]);
});

test("trailing newline present (matches Python output)", () => {
  const result = sortedStringify({ x: 1 });
  assert.ok(result.endsWith("\n"), "must end with newline");
});

test("2-space indent (matches Python indent=2)", () => {
  const result = sortedStringify({ a: 1 });
  assert.strictEqual(result, '{\n  "a": 1\n}\n');
});

test("null values preserved", () => {
  const result = sortedStringify({ a: null, b: 1 });
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.a, null);
});

test("Firestore typed-value shape — extensionSalaries sample", () => {
  const doc = {
    name: "projects/figment-football/databases/(default)/documents/leagues/abc/docs/extensionSalaries",
    fields: {
      playerSalaries: {
        arrayValue: {
          values: [
            { mapValue: { fields: { playerID: { integerValue: "23189" }, extensionSalary: { integerValue: "49" } } } },
          ],
        },
      },
    },
    createTime: "2026-01-01T00:00:00Z",
    updateTime: "2026-05-31T12:00:00Z",
  };
  const result = sortedStringify(doc);
  const parsed = JSON.parse(result);
  assert.deepStrictEqual(Object.keys(parsed), ["createTime", "fields", "name", "updateTime"]);
  assert.deepStrictEqual(Object.keys(parsed.fields), ["playerSalaries"]);
});

test("empty object", () => {
  assert.strictEqual(sortedStringify({}), "{}\n");
});

test("array of objects", () => {
  const arr = [{ b: 2, a: 1 }, { d: 4, c: 3 }];
  const result = sortedStringify(arr);
  const parsed = JSON.parse(result);
  assert.deepStrictEqual(Object.keys(parsed[0]), ["a", "b"]);
  assert.deepStrictEqual(Object.keys(parsed[1]), ["c", "d"]);
});

// ─── Firestore URL tests ──────────────────────────────────────────────────────

console.log("\nFirestore URL building");

test("document URL format", () => {
  const base = FIRESTORE_BASE(DEFAULT_PROJECT_ID);
  const url = `${base}/leagues/${DEFAULT_LEAGUE_ID}/docs/extensionSalaries`;
  assert.ok(url.startsWith("https://firestore.googleapis.com/v1/projects/figment-football/"));
  assert.ok(url.endsWith("/extensionSalaries"));
});

test("collection listing URL format", () => {
  const base = FIRESTORE_BASE(DEFAULT_PROJECT_ID);
  const url = `${base}/leagues/${DEFAULT_LEAGUE_ID}/seasons/${DEFAULT_SEASON}/teams`;
  assert.ok(url.includes("/seasons/2026/teams"));
  assert.ok(!url.endsWith("/"), "collection URL should not end with /");
});

test("team doc URL format", () => {
  const base = FIRESTORE_BASE(DEFAULT_PROJECT_ID);
  const teamId = "05bZncCIfLtzCJfSu1Dq";
  const url = `${base}/leagues/${DEFAULT_LEAGUE_ID}/seasons/${DEFAULT_SEASON}/teams/${teamId}`;
  assert.ok(url.endsWith(`/teams/${teamId}`));
});

test("activity collection URLs", () => {
  const base = FIRESTORE_BASE(DEFAULT_PROJECT_ID);
  for (const name of ACTIVITY_COLLECTIONS) {
    const url = `${base}/leagues/${DEFAULT_LEAGUE_ID}/${name}`;
    assert.ok(url.includes(`/${name}`), `URL should include ${name}`);
  }
});

// ─── Team listing parser tests ────────────────────────────────────────────────

console.log("\nparseTeamsFromListing");

test("extracts teamId from Firestore doc name", () => {
  const listing = {
    documents: [
      {
        name: "projects/figment-football/databases/(default)/documents/leagues/abc/seasons/2026/teams/teamId123",
        fields: { name: { stringValue: "That One Egg Was 40 Yards" } },
      },
    ],
  };
  const teams = parseTeamsFromListing(listing);
  assert.strictEqual(teams.length, 1);
  assert.strictEqual(teams[0].teamId, "teamId123");
  assert.strictEqual(teams[0].label, "That One Egg Was 40 Yards");
});

test("falls back to teamId when name field absent", () => {
  const listing = {
    documents: [
      {
        name: "projects/figment-football/databases/(default)/documents/leagues/abc/seasons/2026/teams/xyz",
        fields: {},
      },
    ],
  };
  const teams = parseTeamsFromListing(listing);
  assert.strictEqual(teams[0].label, "xyz");
});

test("handles empty documents list", () => {
  const teams = parseTeamsFromListing({ documents: [] });
  assert.strictEqual(teams.length, 0);
});

test("handles missing documents key", () => {
  const teams = parseTeamsFromListing({});
  assert.strictEqual(teams.length, 0);
});

test("parses 10 teams correctly", () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({
    name: `projects/p/databases/(default)/documents/leagues/l/seasons/2026/teams/team${i}`,
    fields: { name: { stringValue: `Team ${i}` } },
  }));
  const teams = parseTeamsFromListing({ documents: docs });
  assert.strictEqual(teams.length, 10);
  assert.strictEqual(teams[3].teamId, "team3");
  assert.strictEqual(teams[3].label, "Team 3");
});

// ─── downloadJson data-URL encoding (MV3 fix) ────────────────────────────────

console.log("\ndownloadJson — data: URL encoding (MV3 fix)");

function buildDataUrl(doc) {
  const json = sortedStringify(doc);
  return "data:application/json;charset=utf-8," + encodeURIComponent(json);
}

test("data: URL starts with correct MIME prefix", () => {
  const url = buildDataUrl({ a: 1 });
  assert.ok(url.startsWith("data:application/json;charset=utf-8,"));
});

test("data: URL round-trips back to the original doc", () => {
  const doc = { z: 3, a: 1, m: 2 };
  const url = buildDataUrl(doc);
  const encoded = url.slice("data:application/json;charset=utf-8,".length);
  const decoded = decodeURIComponent(encoded);
  const parsed = JSON.parse(decoded);
  assert.deepStrictEqual(Object.keys(parsed), ["a", "m", "z"]);
  assert.strictEqual(parsed.z, 3);
});

test("data: URL encodes nested Firestore doc correctly", () => {
  const doc = {
    name: "projects/figment-football/databases/(default)/documents/leagues/abc",
    fields: { extensionSalary: { integerValue: "49" } },
    createTime: "2026-01-01T00:00:00Z",
  };
  const url = buildDataUrl(doc);
  const encoded = url.slice("data:application/json;charset=utf-8,".length);
  const parsed = JSON.parse(decodeURIComponent(encoded));
  assert.strictEqual(parsed.fields.extensionSalary.integerValue, "49");
  assert.deepStrictEqual(Object.keys(parsed), ["createTime", "fields", "name"]);
});

test("no URL.createObjectURL call anywhere in data URL path", () => {
  const fn = buildDataUrl.toString();
  assert.ok(!fn.includes("createObjectURL"), "must not use createObjectURL");
});

// ─── PLAYER_STATS_DOCS constant ──────────────────────────────────────────────

console.log("\nPLAYER_STATS_DOCS constant — mirrors lt_firestore_dump.py --player-stats");

test("contains both expected doc names", () => {
  assert.ok(PLAYER_STATS_DOCS.includes("playerSeasonStats"), "missing playerSeasonStats");
  assert.ok(PLAYER_STATS_DOCS.includes("playerSeasonProjections"), "missing playerSeasonProjections");
});

test("has exactly 2 entries (parity with Python _PLAYER_STATS_DOCS)", () => {
  assert.strictEqual(PLAYER_STATS_DOCS.length, 2);
});

test("playerSeasonStats URL uses seasons/<season>/playerArrays/ path", () => {
  const season = DEFAULT_SEASON;
  const base = FIRESTORE_BASE(DEFAULT_PROJECT_ID);
  const url = `${base}/seasons/${season}/playerArrays/playerSeasonStats`;
  assert.ok(url.includes(`/seasons/${season}/playerArrays/playerSeasonStats`));
});

test("playerSeasonProjections URL uses seasons/<season>/playerArrays/ path", () => {
  const season = DEFAULT_SEASON;
  const base = FIRESTORE_BASE(DEFAULT_PROJECT_ID);
  const url = `${base}/seasons/${season}/playerArrays/playerSeasonProjections`;
  assert.ok(url.includes(`/seasons/${season}/playerArrays/playerSeasonProjections`));
});

test("player stats paths match Python script _PLAYER_STATS_DOCS doc_path format", () => {
  const season = "2026";
  for (const name of PLAYER_STATS_DOCS) {
    const docPath = `seasons/${season}/playerArrays/${name}`;
    assert.ok(docPath.startsWith("seasons/"), `${name}: path must start with seasons/`);
    assert.ok(docPath.endsWith(`/${name}`), `${name}: path must end with doc name`);
  }
});

test("player stats docs are NOT activity collections (separate category)", () => {
  for (const name of PLAYER_STATS_DOCS) {
    assert.ok(!ACTIVITY_COLLECTIONS.includes(name), `${name} should not be in ACTIVITY_COLLECTIONS`);
  }
});

// ─── Activity collections constant ───────────────────────────────────────────

console.log("\nACTIVITY_COLLECTIONS constant");

test("contains all 4 CAP-05 collections", () => {
  const required = ["trades", "activityMessages", "transactions", "freeAgentAuctionResults"];
  for (const name of required) {
    assert.ok(ACTIVITY_COLLECTIONS.includes(name), `missing ${name}`);
  }
});

// ─── OPTIONAL_ACTIVITY set — trades 403 gate ─────────────────────────────────

console.log("\nOPTIONAL_ACTIVITY — trades is commissioner-restricted");

const OPTIONAL_ACTIVITY = new Set(["trades"]);

test("trades is in OPTIONAL_ACTIVITY (403 treated as warning)", () => {
  assert.ok(OPTIONAL_ACTIVITY.has("trades"), "trades must be optional");
});

test("other activity collections are NOT in OPTIONAL_ACTIVITY", () => {
  for (const name of ["activityMessages", "transactions", "freeAgentAuctionResults"]) {
    assert.ok(!OPTIONAL_ACTIVITY.has(name), `${name} should not be optional`);
  }
});

// ─── CRC-32 tests ────────────────────────────────────────────────────────────

console.log("\ncrc32 — IEEE 802.3 polynomial");

test("CRC32 of empty bytes is 0x00000000", () => {
  assert.strictEqual(crc32(new Uint8Array(0)), 0x00000000);
});

test("CRC32 of [0x31] ('1') is 0x83dcefb7", () => {
  // Known CRC32 value for single byte 0x31
  assert.strictEqual(crc32(new Uint8Array([0x31])), 0x83dcefb7);
});

test("CRC32 of 'hello' bytes is 0x3610a686", () => {
  const hello = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
  assert.strictEqual(crc32(hello), 0x3610a686);
});

test("CRC32 of 'abc' bytes is 0x352441c2", () => {
  const abc = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
  assert.strictEqual(crc32(abc), 0x352441c2);
});

test("CRC32 produces consistent results for same input", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  assert.strictEqual(crc32(data), crc32(data));
});

test("CRC32 produces different results for different inputs", () => {
  const a = new Uint8Array([1, 2, 3]);
  const b = new Uint8Array([3, 2, 1]);
  assert.notStrictEqual(crc32(a), crc32(b));
});

test("CRC32 returns a non-negative 32-bit integer (unsigned)", () => {
  const data = new Uint8Array([0xff, 0xff, 0xff]);
  const result = crc32(data);
  assert.ok(result >= 0, "CRC32 must be non-negative");
  assert.ok(result <= 0xffffffff, "CRC32 must fit in 32 bits");
});

// ─── createZip tests ─────────────────────────────────────────────────────────

console.log("\ncreateZip — STORE mode ZIP archive");

test("empty zip has valid end-of-central-directory signature", () => {
  const zip = createZip({});
  // EOCD is always 22 bytes at the end; signature = 0x06054b50
  assert.strictEqual(zip.length, 22);
  assert.strictEqual(readUint32LE(zip, 0), 0x06054b50);
});

test("empty zip reports 0 entries", () => {
  const zip = createZip({});
  assert.strictEqual(readUint16LE(zip, 8),  0); // entries on disk
  assert.strictEqual(readUint16LE(zip, 10), 0); // total entries
});

test("single-file zip starts with local file header signature", () => {
  const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const zip = createZip({ "test.json": data });
  assert.strictEqual(readUint32LE(zip, 0), 0x04034b50, "LFH signature missing");
});

test("single-file zip: compression method is STORE (0)", () => {
  const data = new Uint8Array([1, 2, 3]);
  const zip = createZip({ "a.json": data });
  assert.strictEqual(readUint16LE(zip, 8), 0, "compression method must be 0 (STORE)");
});

test("single-file zip: file data follows immediately after local header", () => {
  const content = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  const name = "hello.json";
  const zip = createZip({ [name]: content });
  // Local header is 30 + name.length bytes
  const dataOffset = 30 + name.length;
  const extracted = zip.slice(dataOffset, dataOffset + content.length);
  assert.deepStrictEqual(extracted, content);
});

test("single-file zip: CRC in local header matches crc32 of content", () => {
  const content = new Uint8Array([65, 66, 67]); // "ABC"
  const name = "a.json";
  const zip = createZip({ [name]: content });
  const expectedCrc = crc32(content);
  const actualCrc = readUint32LE(zip, 14); // CRC offset in LFH
  assert.strictEqual(actualCrc, expectedCrc);
});

test("single-file zip: sizes in local header match content length", () => {
  const content = new Uint8Array([1, 2, 3, 4, 5]);
  const name = "test.json";
  const zip = createZip({ [name]: content });
  assert.strictEqual(readUint32LE(zip, 18), content.length, "compressed size");
  assert.strictEqual(readUint32LE(zip, 22), content.length, "uncompressed size");
});

test("two-file zip has EOCD reporting 2 entries", () => {
  const zip = createZip({
    "a.json": new Uint8Array([1]),
    "b.json": new Uint8Array([2, 3]),
  });
  // Find EOCD: last 22 bytes
  const eocdOffset = zip.length - 22;
  assert.strictEqual(readUint32LE(zip, eocdOffset), 0x06054b50, "EOCD signature");
  assert.strictEqual(readUint16LE(zip, eocdOffset + 8),  2, "entries on disk");
  assert.strictEqual(readUint16LE(zip, eocdOffset + 10), 2, "total entries");
});

test("two-file zip has central directory entries in order", () => {
  const fileA = new Uint8Array([10, 20]);
  const fileB = new Uint8Array([30, 40, 50]);
  const zip = createZip({ "a.json": fileA, "b.json": fileB });
  // Central directory starts after all local file records
  // LFH_a = 30 + 6 = 36 bytes, data_a = 2 bytes → 38 bytes
  // LFH_b = 30 + 6 = 36 bytes, data_b = 3 bytes → 39 bytes
  // central dir offset = 38 + 39 = 77
  const eocdOffset = zip.length - 22;
  const cdOffset = readUint32LE(zip, eocdOffset + 16);
  // First central dir entry must have CD signature
  assert.strictEqual(readUint32LE(zip, cdOffset), 0x02014b50, "central dir signature");
});

test("zip file is byte-equivalent when extracted (round-trip check)", () => {
  const content = Buffer.from('{"a": 1, "b": 2}\n', "utf8");
  const name = "data.json";
  const zip = createZip({ [name]: new Uint8Array(content) });

  // Extract: read name length from LFH at offset 26, then skip to data offset
  const nameLen = readUint16LE(zip, 26);
  const extraLen = readUint16LE(zip, 28);
  const dataStart = 30 + nameLen + extraLen;
  const dataSize = readUint32LE(zip, 22); // uncompressed size from LFH

  const extracted = Buffer.from(zip.slice(dataStart, dataStart + dataSize));
  assert.deepStrictEqual(extracted, content);
});

// ─── Category selection → message mapping ────────────────────────────────────

console.log("\nCategory selection → START_DUMP message flags");

test("all categories checked → all flags true", () => {
  const msg = buildDumpMessage({
    rosterChecked: true,
    activityChecked: true,
    playerStatsChecked: true,
    bioChecked: true,
  });
  assert.strictEqual(msg.rosterDump,       true);
  assert.strictEqual(msg.activityDump,     true);
  assert.strictEqual(msg.playerStatsDump,  true);
  assert.strictEqual(msg.includeSampleBio, true);
});

test("default state (roster/activity/stats on, bio off)", () => {
  const msg = buildDumpMessage({
    rosterChecked: true,
    activityChecked: true,
    playerStatsChecked: true,
    bioChecked: false,  // sample bio defaults OFF
  });
  assert.strictEqual(msg.rosterDump,       true);
  assert.strictEqual(msg.activityDump,     true);
  assert.strictEqual(msg.playerStatsDump,  true);
  assert.strictEqual(msg.includeSampleBio, false);
});

test("only roster checked", () => {
  const msg = buildDumpMessage({
    rosterChecked: true,
    activityChecked: false,
    playerStatsChecked: false,
    bioChecked: false,
  });
  assert.strictEqual(msg.rosterDump,      true);
  assert.strictEqual(msg.activityDump,    false);
  assert.strictEqual(msg.playerStatsDump, false);
});

test("only activity checked", () => {
  const msg = buildDumpMessage({
    rosterChecked: false,
    activityChecked: true,
    playerStatsChecked: false,
    bioChecked: false,
  });
  assert.strictEqual(msg.rosterDump,   false);
  assert.strictEqual(msg.activityDump, true);
});

test("nothing checked produces all-false flags", () => {
  const msg = buildDumpMessage({
    rosterChecked: false,
    activityChecked: false,
    playerStatsChecked: false,
    bioChecked: false,
  });
  assert.strictEqual(msg.rosterDump,       false);
  assert.strictEqual(msg.activityDump,     false);
  assert.strictEqual(msg.playerStatsDump,  false);
  assert.strictEqual(msg.includeSampleBio, false);
});

test("message type is always START_DUMP", () => {
  const msg = buildDumpMessage({ rosterChecked: false, activityChecked: false, playerStatsChecked: false, bioChecked: false });
  assert.strictEqual(msg.type, "START_DUMP");
});

// ─── ZIP manifest (which files end up in the archive) ────────────────────────

console.log("\nZIP manifest — which files end up in the archive");

function extractZipManifest(zip) {
  // Walk local file headers to find file names
  const names = [];
  let pos = 0;
  while (pos + 4 < zip.length) {
    const sig = readUint32LE(zip, pos);
    if (sig !== 0x04034b50) break; // not a LFH — stop
    const nameLen  = readUint16LE(zip, pos + 26);
    const extraLen = readUint16LE(zip, pos + 28);
    const size     = readUint32LE(zip, pos + 22);
    const nameBytes = zip.slice(pos + 30, pos + 30 + nameLen);
    let name = "";
    for (let i = 0; i < nameBytes.length; i++) name += String.fromCharCode(nameBytes[i]);
    names.push(name);
    pos += 30 + nameLen + extraLen + size;
  }
  return names;
}

test("roster-only selection produces expected file names in zip", () => {
  const files = {
    "extensionSalaries.json": new Uint8Array([1]),
    "positionOverrides.json": new Uint8Array([2]),
    "players_master.json":    new Uint8Array([3]),
    "team_abc.json":          new Uint8Array([4]),
  };
  const zip = createZip(files);
  const manifest = extractZipManifest(zip);
  assert.ok(manifest.includes("extensionSalaries.json"));
  assert.ok(manifest.includes("positionOverrides.json"));
  assert.ok(manifest.includes("players_master.json"));
  assert.ok(manifest.includes("team_abc.json"));
  assert.strictEqual(manifest.length, 4);
});

test("activity selection produces expected file names in zip", () => {
  const files = {};
  for (const name of ACTIVITY_COLLECTIONS) {
    files[name + ".json"] = new Uint8Array([0]);
  }
  const zip = createZip(files);
  const manifest = extractZipManifest(zip);
  for (const name of ACTIVITY_COLLECTIONS) {
    assert.ok(manifest.includes(name + ".json"), `missing ${name}.json`);
  }
});

test("player-stats selection produces exactly 2 stat files in zip", () => {
  const files = {};
  for (const name of PLAYER_STATS_DOCS) {
    files[name + ".json"] = new Uint8Array([0]);
  }
  const zip = createZip(files);
  const manifest = extractZipManifest(zip);
  assert.strictEqual(manifest.length, 2);
  assert.ok(manifest.includes("playerSeasonStats.json"));
  assert.ok(manifest.includes("playerSeasonProjections.json"));
});

test("combined roster + activity produces all expected files", () => {
  const files = {
    "extensionSalaries.json": new Uint8Array([1]),
    "trades.json":            new Uint8Array([2]),
    "activityMessages.json":  new Uint8Array([3]),
  };
  const zip = createZip(files);
  const manifest = extractZipManifest(zip);
  assert.strictEqual(manifest.length, 3);
  assert.ok(manifest.includes("extensionSalaries.json"));
  assert.ok(manifest.includes("trades.json"));
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
