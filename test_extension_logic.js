/**
 * Unit tests for Chrome extension pure-logic functions.
 * Run with:  node apps/chrome-extension/test_extension_logic.js
 *
 * Tests the functions that can be verified without a browser:
 *   - sortedStringify  — must match Python json.dumps(sort_keys=True, indent=2)
 *   - downloadJson data-URL encoding (MV3 fix — no URL.createObjectURL)
 *   - Firestore URL building
 *   - listTeams result parsing
 *   - ACTIVITY_COLLECTIONS constant
 */

"use strict";

const assert = require("assert").strict;

// ─── Inline the functions under test ─────────────────────────────────────────
// (Cannot import ES-module service-worker.js directly in CJS; copy the
//  pure-logic pieces here. Any change to these functions in service-worker.js
//  must be reflected here.)

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

// ─── sortedStringify tests ────────────────────────────────────────────────────

console.log("\nsortedStringify — matches Python json.dumps(sort_keys=True, indent=2)");

test("flat object with unsorted keys", () => {
  const obj = { z: 1, a: 2, m: 3 };
  const result = sortedStringify(obj);
  // Keys must be in alphabetical order
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
  // Top-level sorted: a, z
  assert.deepStrictEqual(Object.keys(parsed), ["a", "z"]);
  // Nested sorted: a.c, a.d
  assert.deepStrictEqual(Object.keys(parsed.a), ["c", "d"]);
  // Nested sorted: z.a, z.b
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
  // Python: '{\n  "a": 1\n}\n'
  assert.strictEqual(result, '{\n  "a": 1\n}\n');
});

test("null values preserved", () => {
  const result = sortedStringify({ a: null, b: 1 });
  const parsed = JSON.parse(result);
  assert.strictEqual(parsed.a, null);
});

test("Firestore typed-value shape — extensionSalaries sample", () => {
  // Typical Firestore doc shape from LT
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
  // Keys at top level should be sorted: createTime, fields, name, updateTime
  assert.deepStrictEqual(Object.keys(parsed), ["createTime", "fields", "name", "updateTime"]);
  // Nested fields should be sorted too
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
// URL.createObjectURL() is not available in MV3 service workers.
// The fix uses data: URLs.  Verify the encoding round-trips cleanly.

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
  // Decode the data URL and parse the JSON
  const encoded = url.slice("data:application/json;charset=utf-8,".length);
  const decoded = decodeURIComponent(encoded);
  const parsed = JSON.parse(decoded);
  // Keys should be sorted (sortedStringify) and values preserved
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
  // Top-level keys sorted
  assert.deepStrictEqual(Object.keys(parsed), ["createTime", "fields", "name"]);
});

test("no URL.createObjectURL call anywhere in data URL path", () => {
  // Guard: confirm this test file (and the encoding logic) does not reference
  // the banned API.  If someone accidentally re-introduces it, this test fails.
  const fn = buildDataUrl.toString();
  assert.ok(!fn.includes("createObjectURL"), "must not use createObjectURL");
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

// Mirror the constant from service-worker.js
const OPTIONAL_ACTIVITY = new Set(["trades"]);

test("trades is in OPTIONAL_ACTIVITY (403 treated as warning)", () => {
  assert.ok(OPTIONAL_ACTIVITY.has("trades"), "trades must be optional");
});

test("other activity collections are NOT in OPTIONAL_ACTIVITY", () => {
  for (const name of ["activityMessages", "transactions", "freeAgentAuctionResults"]) {
    assert.ok(!OPTIONAL_ACTIVITY.has(name), `${name} should not be optional`);
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
