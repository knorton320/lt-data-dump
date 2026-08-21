/**
 * Unit tests for Chrome extension pure-logic functions.
 * Run with:  node test_extension_logic.js
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
const DEFAULT_LEAGUE_ID  = "your-league-id";
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

// Auth-token extraction (mirrors content.js _extractAuthUserTokens/_isExpired)
function _extractAuthUserTokens(entries) {
  for (const entry of entries) {
    const key = entry.fbase_key || entry.key || "";
    if (!key.startsWith("firebase:authUser:")) continue;

    const authUser = entry.value;
    if (!authUser || typeof authUser !== "object") continue;

    const tokenMgr = authUser.stsTokenManager;
    if (!tokenMgr || !tokenMgr.accessToken) continue;

    return {
      accessToken: tokenMgr.accessToken,
      refreshToken: tokenMgr.refreshToken || null,
      expirationTime: Number(tokenMgr.expirationTime) || 0,
    };
  }
  throw new Error(
    'No firebase:authUser entry found in IndexedDB. ' +
      "Make sure you're signed in to League Tycoon (app.leaguetycoon.com)."
  );
}

function _isExpired(expirationTime) {
  return Boolean(expirationTime) && Date.now() > expirationTime;
}

// Expiry formatting (mirrors popup.js formatExpiry)
function formatExpiry(expirationTime) {
  const ms = Number(expirationTime) || 0;
  if (!ms) return { text: "expiry unknown", expired: false };
  const deltaMs = ms - Date.now();
  if (deltaMs <= 0) {
    return { text: "expired — reload the LT page to refresh", expired: true };
  }
  const mins = Math.round(deltaMs / 60000);
  return { text: mins < 1 ? "expires in <1 min" : `expires in ${mins} min`, expired: false };
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
            { mapValue: { fields: { playerID: { integerValue: "25907" }, extensionSalary: { integerValue: "49" } } } },
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
        fields: { name: { stringValue: "Sample Team" } },
      },
    ],
  };
  const teams = parseTeamsFromListing(listing);
  assert.strictEqual(teams.length, 1);
  assert.strictEqual(teams[0].teamId, "teamId123");
  assert.strictEqual(teams[0].label, "Sample Team");
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

// ─── _extractAuthUserTokens / _isExpired (EXT-556 credential reveal) ─────────

console.log("\n_extractAuthUserTokens — single reader, both callers");

function makeAuthUserEntry({ accessToken, refreshToken, expirationTime }) {
  return {
    fbase_key: "firebase:authUser:AIzaSyBmmXw_T84cWhbUU6NztpGECjvtH9YBgeI:[DEFAULT]",
    value: {
      stsTokenManager: { accessToken, refreshToken, expirationTime },
    },
  };
}

test("extracts accessToken, refreshToken, and expirationTime together", () => {
  const entries = [makeAuthUserEntry({
    accessToken: "id-token-abc",
    refreshToken: "refresh-token-xyz",
    expirationTime: Date.now() + 3_600_000,
  })];
  const tokens = _extractAuthUserTokens(entries);
  assert.strictEqual(tokens.accessToken, "id-token-abc");
  assert.strictEqual(tokens.refreshToken, "refresh-token-xyz");
  assert.ok(tokens.expirationTime > Date.now());
});

test("expired ID token is still extracted — extraction never rejects on expiry", () => {
  const entries = [makeAuthUserEntry({
    accessToken: "expired-id-token",
    refreshToken: "still-valid-refresh-token",
    expirationTime: Date.now() - 3_600_000, // an hour in the past
  })];
  const tokens = _extractAuthUserTokens(entries);
  assert.strictEqual(tokens.accessToken, "expired-id-token");
  assert.strictEqual(tokens.refreshToken, "still-valid-refresh-token");
  assert.ok(_isExpired(tokens.expirationTime), "sanity: this expirationTime should read as expired");
});

test("refreshToken is null (not undefined) when absent from stsTokenManager", () => {
  const entries = [{
    fbase_key: "firebase:authUser:abc:[DEFAULT]",
    value: { stsTokenManager: { accessToken: "id-token-only" } },
  }];
  const tokens = _extractAuthUserTokens(entries);
  assert.strictEqual(tokens.refreshToken, null);
});

test("throws when no firebase:authUser entry is present", () => {
  assert.throws(() => _extractAuthUserTokens([{ fbase_key: "some:other:key", value: {} }]), /No firebase:authUser entry found/);
});

test("throws on empty entries list (not signed in)", () => {
  assert.throws(() => _extractAuthUserTokens([]), /No firebase:authUser entry found/);
});

test("skips entries with no stsTokenManager.accessToken", () => {
  const entries = [
    { fbase_key: "firebase:authUser:a:[DEFAULT]", value: { stsTokenManager: {} } },
    makeAuthUserEntry({ accessToken: "the-real-one", refreshToken: "r", expirationTime: 0 }),
  ];
  const tokens = _extractAuthUserTokens(entries);
  assert.strictEqual(tokens.accessToken, "the-real-one");
});

console.log("\n_isExpired — shared expiry check (dump path + reveal UI)");

test("expirationTime in the future is not expired", () => {
  assert.strictEqual(_isExpired(Date.now() + 60_000), false);
});

test("expirationTime in the past is expired", () => {
  assert.strictEqual(_isExpired(Date.now() - 1), true);
});

test("falsy/zero expirationTime (unknown) is treated as not expired", () => {
  assert.strictEqual(_isExpired(0), false);
  assert.strictEqual(_isExpired(undefined), false);
});

// ─── formatExpiry — popup.js ID-token expiry display ─────────────────────────

console.log("\nformatExpiry — human-readable ID token expiry");

test("future expiry renders 'expires in N min'", () => {
  const { text, expired } = formatExpiry(Date.now() + 43 * 60_000);
  assert.ok(/expires in \d+ min/.test(text), text);
  assert.strictEqual(expired, false);
});

test("past expiry renders the expired message and expired=true", () => {
  const { text, expired } = formatExpiry(Date.now() - 60_000);
  assert.strictEqual(text, "expired — reload the LT page to refresh");
  assert.strictEqual(expired, true);
});

test("unknown (0) expiry renders a neutral message, not a false expired claim", () => {
  const { text, expired } = formatExpiry(0);
  assert.strictEqual(text, "expiry unknown");
  assert.strictEqual(expired, false);
});

test("sub-minute future expiry renders '<1 min', not '0 min'", () => {
  const { text } = formatExpiry(Date.now() + 5_000);
  assert.strictEqual(text, "expires in <1 min");
});

// ─── Expired-ID-token-but-valid-refresh-token integration case ──────────────

console.log("\nExpired ID token must not block revealing the refresh token");

test("end-to-end: expired ID token extraction still yields a usable refresh token for the reveal UI", () => {
  const entries = [makeAuthUserEntry({
    accessToken: "expired-id-token",
    refreshToken: "durable-refresh-token",
    expirationTime: Date.now() - 10_000,
  })];

  // This is what readAuthTokens()/GET_AUTH_TOKENS hands the popup — no
  // expiry check happens here, unlike getFirebaseToken()'s dump path.
  const tokens = _extractAuthUserTokens(entries);
  assert.ok(_isExpired(tokens.expirationTime), "the ID token in this fixture must actually be expired");
  assert.strictEqual(tokens.refreshToken, "durable-refresh-token", "refresh token must still be present and usable");

  const idExpiry = formatExpiry(tokens.expirationTime);
  assert.strictEqual(idExpiry.expired, true, "ID-token panel should render the expired state");
});

// ─── League ID — no hardcoded default (service-worker.js) ───────────────────

console.log("\nLeague ID — blank input must error, never silently fall back");

// Mirrors the validation now inlined in service-worker.js runDump(): no
// DEFAULT_LEAGUE_ID constant exists anymore, so a missing/blank leagueId
// must be caught explicitly rather than defaulting to anyone's real league.
function resolveLeagueIdOrThrow(leagueId) {
  if (!leagueId) {
    throw new Error(
      "League ID is required — enter your League Tycoon league ID in the popup before dumping."
    );
  }
  return leagueId;
}

test("blank league ID throws instead of resolving to a default", () => {
  assert.throws(() => resolveLeagueIdOrThrow(""), /League ID is required/);
  assert.throws(() => resolveLeagueIdOrThrow(undefined), /League ID is required/);
});

test("a real league ID passes through unchanged", () => {
  assert.strictEqual(resolveLeagueIdOrThrow("someLeagueId123"), "someLeagueId123");
});

// ─── Credential-row width fix (#612) — popup.html CSS regression guard ──────
//
// The reveal buttons put a ~200-char Firebase token into a flex-row
// <input readonly>. A flex item's default `min-width: auto` refuses to
// shrink below its content-based minimum, which can blow the popup out
// past its declared 340px body width — the real-Chrome-popup-auto-sizing
// failure mode #612 reported ("much wider than the actual text"). The
// fix is `min-width: 0` on the flex container *and* the input, standard
// for this class of bug. Verified live in this session (Playwright,
// headless Chromium, not committed as a repo dependency — see PR notes):
// document.body stayed exactly 340px with a 205-char ID token and a
// 157-char refresh token both revealed simultaneously, before vs. after
// this CSS change. This test is the cheap, dependency-free regression
// guard: assert the fix stays in the source so a future edit to
// popup.html can't silently drop it.

console.log("\nCredential-row width fix (#612) — CSS present in popup.html");

const fs = require("fs");
const path = require("path");
const _popupHtml = fs.readFileSync(
  path.join(__dirname, "popup.html"),
  "utf8"
);

function _cssBlock(html, selector) {
  const idx = html.indexOf(selector);
  assert.ok(idx !== -1, `selector ${JSON.stringify(selector)} not found in popup.html`);
  const braceStart = html.indexOf("{", idx);
  const braceEnd = html.indexOf("}", braceStart);
  return html.slice(braceStart + 1, braceEnd);
}

test(".cred-row is a min-width:0 flex container (lets children shrink instead of forcing overflow)", () => {
  const block = _cssBlock(_popupHtml, ".cred-row {");
  assert.match(block, /display:\s*flex/);
  assert.match(block, /min-width:\s*0/);
});

test('.cred-row input[type="text"] has min-width:0 + flex:1 1 auto so a long token cannot widen the popup', () => {
  const block = _cssBlock(_popupHtml, '.cred-row input[type="text"] {');
  assert.match(block, /min-width:\s*0/, "missing min-width:0 — the flex-overflow fix from #612");
  assert.match(block, /flex:\s*1\s+1\s+auto/, "missing flex:1 1 auto — input should fill, not overflow, the row");
  assert.match(block, /width:\s*100%/);
});

test("body keeps its declared 340px width (the popup's contract) alongside the fix", () => {
  const block = _cssBlock(_popupHtml, "body {");
  assert.match(block, /width:\s*340px/);
});

test("token inputs stay readonly + not truncated by CSS (no text-overflow: ellipsis / overflow: hidden on the value)", () => {
  // AC: "Overflow/scroll within the input, not truncation of its content."
  // Guard against a future fix that reaches for text-overflow:ellipsis
  // instead of min-width:0 — that would hide part of the token value.
  const block = _cssBlock(_popupHtml, '.cred-row input[type="text"] {');
  assert.doesNotMatch(block, /text-overflow/);
});

// ─── Public-mirror leak guard (#556) ─────────────────────────────────────────
//
// This repo is a public mirror of a private one. A short list of values must
// never cross over: the league id, the owner's and team's names, the private
// repo's slug and internal paths. Those genericizations live only in this
// working tree — there is no CI relationship between the two repos — so the
// delta used to be maintained by memory alone, and it regressed at least once
// (a port clobbered an already-sanitized value and it had to be re-applied by
// hand). This is the enforcement: every shipped file, every test run.
//
// The identifying values are stored base64-encoded rather than in plaintext.
// A guard that hardcodes the very names it forbids would leak them itself and
// make this file greppable for exactly what it exists to protect.
//
// Deliberately NOT flagged — each would fire on legitimate content:
//   - "#<number>" ticket refs: private ticket numbers ride along in ported
//     code comments and are tolerated (see the #612 block above).
//   - Player ids (e.g. 25907): LT platform-wide ids for public NFL players.
//     They identify no league, team, or owner, and a bare 5-digit number
//     would false-positive on timestamps, row counts, and cap figures.
//   - "figment-football" and the AIzaSy... Firebase web API key: public
//     project identifiers, not secrets.
//   - "League Tycoon": the product name. Note it contains the substring
//     "our League", so the league-nickname pattern is word-anchored instead
//     of matching loose prose.

console.log("\nPublic-mirror leak guard (#556)");

const _dec = (b64) => Buffer.from(b64, "base64").toString("utf8");
const _frag = (...parts) => parts.join("");

// Stripped before scanning — legitimate occurrences.
const _GUARD_ALLOWED = [
  _frag("knor", "ton") + "320/lt-data-dump", // this repo's own clone URL
];

const _GUARD_PATTERNS = [
  { label: "private league id",        sub: _dec("Y2U1VVZ0ZFJwWVk5S1dNeUR3ZVc=") },
  { label: "league owner name",        sub: _dec("S3lsZSBOb3J0b24=") },
  { label: "league team name",         sub: _dec("VGhhdCBPbmUgRWdnIFdhcyA0MCBZYXJkcw==") },
  { label: "private league nickname",  re: new RegExp(`\\b${_dec("QkxC")}\\b`) },
  { label: "private repo slug",        sub: _frag("league", "-tycoon") },
  { label: "private repo path",        sub: _frag("apps/chrome", "-extension") },
  { label: "private product branding", sub: _frag("GM", " Suite") },
  { label: "private pipeline path",    sub: _frag("data/raw/", "lt_firestore") },
  { label: "private pipeline helper",  re: new RegExp(_frag("run_pipe", "_\\d+")) },
  { label: "private github user",      sub: _frag("knor", "ton") },
  {
    label: "private-range IP",
    re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/,
  },
];

const _GUARD_EXTS = new Set([".js", ".html", ".json", ".md"]);

function _guardFiles(dir = __dirname, rel = "") {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const abs = path.join(dir, ent.name);
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(..._guardFiles(abs, r));
    else if (_GUARD_EXTS.has(path.extname(ent.name))) out.push({ rel: r, abs });
  }
  return out;
}

const _GUARD_FILES = _guardFiles();

test("leak guard has files to scan (an empty scan would pass forever, silently)", () => {
  for (const name of ["popup.html", "popup.js", "service-worker.js", "content.js", "README.md", "manifest.json"]) {
    assert.ok(
      _GUARD_FILES.some((f) => f.rel === name),
      `${name} is missing from the guard's scan set`
    );
  }
});

for (const { label, sub, re } of _GUARD_PATTERNS) {
  test(`no ${label} in any shipped file`, () => {
    const hits = [];
    for (const { rel, abs } of _GUARD_FILES) {
      let content = fs.readFileSync(abs, "utf8");
      for (const allowed of _GUARD_ALLOWED) content = content.split(allowed).join("");
      content.split("\n").forEach((line, i) => {
        if (sub ? line.includes(sub) : re.test(line)) hits.push(`${rel}:${i + 1}`);
      });
    }
    assert.deepStrictEqual(hits, [], `${label} found at ${hits.join(", ")}`);
  });
}

// ── Delta guards ────────────────────────────────────────────────────────────
// Assert the *shape* rather than pinning the exact private value: a real LT
// league id is 20 base62 characters, and "your-league-id" fails that by
// design. This keeps catching real ids even if the private one ever changes.

const _looksLikeRealLeagueId = (v) => /^[A-Za-z0-9]{20}$/.test(v);

test("DEFAULT_LEAGUE_ID here is a placeholder, not a real league id", () => {
  assert.ok(
    !_looksLikeRealLeagueId(DEFAULT_LEAGUE_ID),
    `DEFAULT_LEAGUE_ID has the shape of a real league id: ${DEFAULT_LEAGUE_ID}`
  );
});

test("popup.html leagueId placeholder is generic, not a real league id", () => {
  const m = _popupHtml.match(/id="leagueId"[^>]*placeholder="([^"]*)"/);
  assert.ok(m, "could not find the leagueId input placeholder in popup.html");
  assert.ok(
    !_looksLikeRealLeagueId(m[1]),
    `leagueId placeholder has the shape of a real league id: ${m[1]}`
  );
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
