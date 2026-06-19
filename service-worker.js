/**
 * Service worker (background) — Manifest V3.
 *
 * Responsibilities:
 *   1. Receive "START_DUMP" messages from the popup.
 *   2. Ask the content script on the active LT tab for the Firebase token.
 *   3. Run the Firestore dump (mirrors scripts/lt_firestore_dump.py).
 *   4. Collect all fetched JSON files in memory.
 *   5. Bundle them into a single ZIP and download via chrome.downloads.download().
 *   6. Post progress + result messages back to the popup.
 *
 * Firestore document set (same as lt_firestore_dump.py _doc_set()):
 *   - leagues/<id>/docs/extensionSalaries
 *   - leagues/<id>/docs/positionOverrides
 *   - leagues/<id>/seasons/<season>/docs/rfatenders
 *   - All team docs under leagues/<id>/seasons/<season>/teams/
 *   - seasons/<season>/playerArrays/players   (player master)
 *   - playerDetails/<player_id>               (sample bio)
 *
 * Activity collections (when activityDump=true):
 *   - leagues/<id>/trades
 *   - leagues/<id>/activityMessages
 *   - leagues/<id>/transactions
 *   - leagues/<id>/freeAgentAuctionResults
 *   - leagues/<id>/moneyEvents/<teamId>  (per team)
 *
 * Player stat docs (when playerStatsDump=true):
 *   - seasons/<season>/playerArrays/playerSeasonStats
 *   - seasons/<season>/playerArrays/playerSeasonProjections
 *
 * Output: a single lt_firestore_dump_<YYYY-MM-DD>.zip containing one JSON
 * file per document.  File contents match scripts/lt_firestore_dump.py exactly:
 * pretty JSON, 2-space indent, keys sorted (mirrors json.dumps sort_keys=True).
 */

"use strict";

import { createZip } from "./lib/zip.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PROJECT_ID = "figment-football";
const DEFAULT_LEAGUE_ID = "ce5UVtdRpYY9KWMyDweW";
const DEFAULT_SEASON = "2026";
const DEFAULT_SAMPLE_PLAYER_ID = "23189"; // Bijan Robinson

const FIRESTORE_BASE = (project) =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

const ACTIVITY_COLLECTIONS = [
  "trades",
  "activityMessages",
  "transactions",
  "freeAgentAuctionResults",
];

// Per-player stat docs under seasons/<season>/playerArrays/.
// Mirrors scripts/lt_firestore_dump.py _PLAYER_STATS_DOCS.
const PLAYER_STATS_DOCS = [
  "playerSeasonStats",        // LT's per-player PPG / stats used for PBS ranking
  "playerSeasonProjections",  // LT's per-player projections (forward-looking)
];

// ─── Firestore helpers ────────────────────────────────────────────────────────

/**
 * GET a single Firestore document.  Throws a descriptive error on non-200.
 */
async function getDoc(project, docPath, token) {
  const url = `${FIRESTORE_BASE(project)}/${docPath}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    if (resp.status === 401) {
      throw new Error(
        "401 Unauthorized — Firebase token expired. Reload the LT page, then retry."
      );
    }
    if (resp.status === 403) {
      throw new Error(
        `403 Forbidden — check league-id and team-id. Path: ${docPath}`
      );
    }
    if (resp.status === 404) {
      throw new Error(`404 Not Found — no document at ${docPath}. Body: ${body.slice(0, 200)}`);
    }
    throw new Error(`HTTP ${resp.status} from Firestore path ${docPath}: ${body.slice(0, 200)}`);
  }

  return resp.json();
}

/**
 * List every document in a Firestore collection, following nextPageToken
 * pagination.  Returns a merged { documents: [...all pages...] } dict —
 * same shape as a single-page listing so consumers treat it uniformly.
 *
 * Matches lt_firestore_dump.py _list_collection().
 */
async function listCollection(project, collectionPath, token) {
  const base = `${FIRESTORE_BASE(project)}/${collectionPath}`;
  const documents = [];
  let pageToken = null;

  while (true) {
    const url = pageToken ? `${base}?pageToken=${pageToken}` : base;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(
        `HTTP ${resp.status} listing collection ${collectionPath}: ${body.slice(0, 200)}`
      );
    }

    const page = await resp.json();
    documents.push(...(page.documents || []));
    pageToken = page.nextPageToken || null;
    if (!pageToken) break;
  }

  return { documents };
}

/**
 * Enumerate all teams in the league.
 * Returns [{ teamId, label }, ...] — mirrors lt_firestore_dump.py _list_teams().
 */
async function listTeams(project, leagueId, season, token) {
  const listing = await listCollection(
    project,
    `leagues/${leagueId}/seasons/${season}/teams`,
    token
  );
  return listing.documents.map((doc) => {
    const fullName = doc.name || "";
    const teamId = fullName.includes("/") ? fullName.split("/").pop() : fullName;
    const label =
      (doc.fields?.name?.stringValue) || teamId;
    return { teamId, label };
  });
}

// ─── JSON formatting ──────────────────────────────────────────────────────────

/**
 * Recursively sort object keys, then serialise to 2-space indented JSON.
 * Matches Python's json.dumps(obj, indent=2, sort_keys=True).
 */
function sortedStringify(val, indent = 2) {
  return JSON.stringify(_sortKeys(val), null, indent) + "\n";
}

function _sortKeys(val) {
  if (Array.isArray(val)) return val.map(_sortKeys);
  if (val !== null && typeof val === "object") {
    const sorted = {};
    for (const k of Object.keys(val).sort()) {
      sorted[k] = _sortKeys(val[k]);
    }
    return sorted;
  }
  return val;
}

// ─── Progress messaging ───────────────────────────────────────────────────────

/** Send a progress update to the popup (if it's still open). */
function postProgress(msg) {
  chrome.runtime
    .sendMessage({ type: "DUMP_PROGRESS", text: msg })
    .catch(() => {
      // Popup closed — swallow the error.
    });
}

/** Send final status (done or error) to the popup. */
function postResult(success, text) {
  chrome.runtime
    .sendMessage({ type: "DUMP_RESULT", success, text })
    .catch(() => {});
}

// ─── Token retrieval ──────────────────────────────────────────────────────────

/**
 * Ask the content script on the active LT tab for the Firebase token.
 * Returns the token string or throws if no active LT tab / token unavailable.
 */
async function getTokenFromContentScript() {
  const tabs = await chrome.tabs.query({ url: "https://app.leaguetycoon.com/*" });

  if (!tabs.length) {
    throw new Error(
      "No active League Tycoon tab found. " +
        "Open https://app.leaguetycoon.com in Chrome, make sure you're signed in, " +
        "then retry."
    );
  }

  // Prefer the focused tab; fall back to the first match.
  const tab = tabs.find((t) => t.active) || tabs[0];

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: "GET_FIREBASE_TOKEN" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(
          new Error(
            `Could not reach content script: ${chrome.runtime.lastError.message}. ` +
              "Try reloading the League Tycoon tab, then retry."
          )
        );
        return;
      }
      if (!response) {
        reject(new Error("No response from content script."));
        return;
      }
      if (response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response.token);
    });
  });
}

// ─── Zip download ─────────────────────────────────────────────────────────────

/**
 * Download a ZIP as a single file to Chrome's downloads folder.
 *
 * Uses a base64 data: URL — the correct approach in MV3 service workers
 * (URL.createObjectURL is not available without a DOM context).
 */
async function downloadZip(zipName, zipBytes) {
  // Convert Uint8Array → binary string → base64 data URL.
  let binary = "";
  for (let i = 0; i < zipBytes.length; i++) {
    binary += String.fromCharCode(zipBytes[i]);
  }
  const dataUrl = "data:application/zip;base64," + btoa(binary);

  const { downloadDir = "" } = await chrome.storage.local.get("downloadDir");
  const filename = downloadDir
    ? `${downloadDir.replace(/\/*$/, "")}/${zipName}`
    : zipName;

  return new Promise((resolve) => {
    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: false },
      (downloadId) => resolve(downloadId ?? -1)
    );
  });
}

// ─── Core dump logic ──────────────────────────────────────────────────────────

/**
 * Run the full Firestore dump.  Mirrors scripts/lt_firestore_dump.py.
 *
 * All fetched documents are collected in memory and bundled as a single
 * lt_firestore_dump_<YYYY-MM-DD>.zip at the end.
 *
 * @param {object} opts
 * @param {string}  opts.project         Firebase project id (default: figment-football)
 * @param {string}  opts.leagueId        LT league id
 * @param {string}  opts.season          Season year string (default: "2026")
 * @param {string}  opts.samplePlayerId  Player id for the optional playerDetails sample
 * @param {boolean} opts.rosterDump      Dump standard docs + all team docs (default: true)
 * @param {boolean} opts.activityDump    Dump activity collections (CAP-05)
 * @param {boolean} opts.playerStatsDump Dump per-player stat docs (mirrors --player-stats)
 * @param {boolean} opts.includeSampleBio  Fetch one playerDetails doc as a diagnostic
 */
async function runDump(opts = {}) {
  const {
    project = DEFAULT_PROJECT_ID,
    leagueId = DEFAULT_LEAGUE_ID,
    season = DEFAULT_SEASON,
    samplePlayerId = DEFAULT_SAMPLE_PLAYER_ID,
    rosterDump = true,
    activityDump = false,
    playerStatsDump = false,
    includeSampleBio = false,
  } = opts;

  postProgress("Requesting Firebase token from LT tab…");
  const token = await getTokenFromContentScript();
  postProgress("Token OK — fetching Firestore documents.");

  // All files collected here; downloaded as a single zip at the end.
  const collectedFiles = new Map(); // filename (without .json) → Uint8Array
  let fetched = 0;
  let errors = 0;

  const encoder = new TextEncoder();

  /**
   * Fetch one document and add it to the collection.
   *
   * @param {boolean} optional  When true, a 404 is logged as a warning
   *   (⚠) rather than an error (✗) and does not increment the error count.
   */
  async function fetchAndCollect(name, docPath, { optional = false } = {}) {
    try {
      postProgress(`  Fetching ${name}…`);
      const doc = await getDoc(project, docPath, token);
      const json = sortedStringify(doc);
      collectedFiles.set(name + ".json", encoder.encode(json));
      fetched++;
      postProgress(`  ✓ ${name}.json`);
    } catch (err) {
      if (optional && err.message.startsWith("404")) {
        postProgress(`  ⚠ ${name}: not found in this league — skipped`);
      } else {
        errors++;
        postProgress(`  ✗ ${name}: ${err.message}`);
      }
    }
  }

  /**
   * Fetch a collection listing and add it to the collection.
   *
   * @param {boolean} optional  When true, a 403 is logged as a warning (⚠)
   *   rather than an error (✗) and does not increment the error count.
   */
  async function fetchCollectionAndCollect(name, collectionPath, { optional = false } = {}) {
    try {
      postProgress(`  Listing collection ${name}…`);
      const listing = await listCollection(project, collectionPath, token);
      const json = sortedStringify(listing);
      collectedFiles.set(name + ".json", encoder.encode(json));
      fetched++;
      postProgress(`  ✓ ${name}.json (${listing.documents.length} docs)`);
    } catch (err) {
      if (optional && err.message.startsWith("HTTP 403")) {
        postProgress(`  ⚠ ${name}: permission denied — skipped (commissioner-only collection)`);
      } else {
        errors++;
        postProgress(`  ✗ ${name}: ${err.message}`);
      }
    }
  }

  // ── Roster / standard docs ────────────────────────────────────────────────

  if (rosterDump) {
    await fetchAndCollect(
      "extensionSalaries",
      `leagues/${leagueId}/docs/extensionSalaries`
    );
    await fetchAndCollect(
      "positionOverrides",
      `leagues/${leagueId}/docs/positionOverrides`
    );
    await fetchAndCollect(
      "rfatenders",
      `leagues/${leagueId}/seasons/${season}/docs/rfatenders`,
      { optional: true }   // only exists when commissioner enables RFA
    );
    await fetchAndCollect(
      "players_master",
      `seasons/${season}/playerArrays/players`
    );

    postProgress(`  Enumerating teams in league ${leagueId} season ${season}…`);
    try {
      const teams = await listTeams(project, leagueId, season, token);
      postProgress(`  Found ${teams.length} teams.`);
      for (const { teamId, label } of teams) {
        await fetchAndCollect(
          `team_${teamId}`,
          `leagues/${leagueId}/seasons/${season}/teams/${teamId}`
        );
        postProgress(`     → ${label}`);
      }
    } catch (err) {
      errors++;
      postProgress(`  ✗ team enumeration: ${err.message}`);
    }
  }

  // ── Sample player bio (diagnostic) ───────────────────────────────────────

  if (includeSampleBio) {
    await fetchAndCollect(
      "playerDetails_sample",
      `playerDetails/${samplePlayerId}`
    );
  }

  // ── Activity collections (CAP-05) ────────────────────────────────────────

  // trades may be restricted to commissioner-level Firestore rules in some
  // leagues — treat a 403 as a warning so other collections still succeed.
  const OPTIONAL_ACTIVITY = new Set(["trades"]);

  if (activityDump) {
    postProgress("  Fetching activity collections…");
    for (const name of ACTIVITY_COLLECTIONS) {
      await fetchCollectionAndCollect(name, `leagues/${leagueId}/${name}`, {
        optional: OPTIONAL_ACTIVITY.has(name),
      });
    }

    // Per-team moneyEvents
    try {
      const teams = await listTeams(project, leagueId, season, token);
      for (const { teamId } of teams) {
        await fetchAndCollect(
          `moneyEvents_${teamId}`,
          `leagues/${leagueId}/moneyEvents/${teamId}`
        );
      }
    } catch (err) {
      errors++;
      postProgress(`  ✗ moneyEvents: ${err.message}`);
    }
  }

  // ── Player stats (EXT-04 calibration inputs) ──────────────────────────────

  if (playerStatsDump) {
    postProgress("  Fetching per-player stat docs…");
    for (const name of PLAYER_STATS_DOCS) {
      await fetchAndCollect(name, `seasons/${season}/playerArrays/${name}`);
    }
  }

  // ── Bundle and download ───────────────────────────────────────────────────

  if (collectedFiles.size === 0) {
    postResult(false, "No categories selected — nothing to dump.");
    return;
  }

  postProgress(`  Bundling ${collectedFiles.size} file(s) into zip…`);
  const files = Object.fromEntries(collectedFiles);
  const zipBytes = createZip(files);
  const today = new Date().toISOString().slice(0, 10);
  const zipName = `lt_firestore_dump_${today}.zip`;
  await downloadZip(zipName, zipBytes);

  const summary = `Done. ${fetched} file(s) → ${zipName}${errors ? ` (${errors} error(s))` : ""}.`;
  postProgress(summary);

  if (errors > 0) {
    postResult(false, `${summary} Check the progress log for which files failed.`);
  } else {
    postResult(true, summary);
  }
}

// ─── Message listener (entry point from popup) ────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "START_DUMP") {
    // Acknowledge immediately so the popup knows the job started.
    sendResponse({ started: true });

    runDump({
      project: message.project || DEFAULT_PROJECT_ID,
      leagueId: message.leagueId || DEFAULT_LEAGUE_ID,
      season: message.season || DEFAULT_SEASON,
      samplePlayerId: message.samplePlayerId || DEFAULT_SAMPLE_PLAYER_ID,
      rosterDump: message.rosterDump !== false,          // default true
      activityDump: message.activityDump === true,
      playerStatsDump: message.playerStatsDump === true,
      includeSampleBio: message.includeSampleBio === true,
    }).catch((err) => {
      postResult(false, `Unexpected error: ${err.message}`);
    });

    return false; // synchronous response already sent
  }

  if (message.type === "GET_CONFIG") {
    chrome.storage.local.get(["downloadDir", "leagueId", "season"], sendResponse);
    return true;
  }

  if (message.type === "SET_CONFIG") {
    chrome.storage.local.set(message.config, () => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
