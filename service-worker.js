/**
 * Service worker (background) — Manifest V3.
 *
 * Responsibilities:
 *   1. Receive "START_DUMP" messages from the popup.
 *   2. Ask the content script on the active LT tab for the Firebase token.
 *   3. Run the Firestore dump (mirrors scripts/lt_firestore_dump.py).
 *   4. Download each JSON file via chrome.downloads.download().
 *   5. Post progress + result messages back to the popup.
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
 * Output matches scripts/lt_firestore_dump.py exactly:
 *   - Pretty JSON, 2-space indent, keys sorted (mirrors json.dumps sort_keys=True)
 *   - One file per document, named <name>.json
 *   - Downloaded to Chrome's configured downloads folder.
 *     Point Chrome's downloads folder at data/raw/lt_firestore/ in the repo
 *     for seamless integration with run_pipe_10().
 */

"use strict";

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

// ─── Download helper ──────────────────────────────────────────────────────────

/**
 * Download one JSON document to Chrome's downloads folder.
 *
 * Chrome extensions cannot write directly to the filesystem.  Each file
 * is downloaded via chrome.downloads using a data: URL.
 *
 * Note: URL.createObjectURL() is NOT available in MV3 service workers
 * (they run in a non-DOM context).  data: URLs are the correct approach —
 * chrome.downloads.download() accepts them for any file size Chrome supports.
 *
 * To land files in the right repo location, configure Chrome's download
 * folder to point at <repo-root>/data/raw/lt_firestore/, or set the
 * "Download dir" field in the popup (stored in chrome.storage.local as
 * "downloadDir") to use a relative subdirectory.
 *
 * Returns the download id (or -1 on error) for progress tracking.
 */
async function downloadJson(name, doc) {
  const json = sortedStringify(doc);

  // data: URL approach — works in MV3 service workers (no DOM context needed).
  const dataUrl =
    "data:application/json;charset=utf-8," + encodeURIComponent(json);

  // Retrieve optional subdirectory prefix from extension storage.
  const { downloadDir = "" } = await chrome.storage.local.get("downloadDir");
  const filename = downloadDir
    ? `${downloadDir.replace(/\/*$/, "")}/${name}.json`
    : `${name}.json`;

  return new Promise((resolve) => {
    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: false },
      (downloadId) => resolve(downloadId ?? -1)
    );
  });
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

// ─── Core dump logic ──────────────────────────────────────────────────────────

/**
 * Run the full Firestore dump.  Mirrors scripts/lt_firestore_dump.py.
 *
 * @param {object} opts
 * @param {string} opts.project      Firebase project id (default: figment-football)
 * @param {string} opts.leagueId     LT league id
 * @param {string} opts.season       Season year string (default: "2026")
 * @param {string} opts.samplePlayerId  Player id for the playerDetails sample
 * @param {boolean} opts.allTeams    Dump every team doc (vs just the sample)
 * @param {boolean} opts.activityDump  Also dump activity collections (CAP-05)
 */
async function runDump(opts = {}) {
  const {
    project = DEFAULT_PROJECT_ID,
    leagueId = DEFAULT_LEAGUE_ID,
    season = DEFAULT_SEASON,
    samplePlayerId = DEFAULT_SAMPLE_PLAYER_ID,
    allTeams = true,
    activityDump = false,
  } = opts;

  postProgress("Requesting Firebase token from LT tab…");
  const token = await getTokenFromContentScript();
  postProgress("Token OK — starting Firestore dump.");

  let saved = 0;
  let errors = 0;

  /**
   * Fetch one document and download it as <name>.json.
   *
   * @param {boolean} optional  When true, a 404 is logged as a warning
   *   (⚠) rather than an error (✗) and does not increment the error count.
   *   Use for documents that legitimately may not exist in every league
   *   (e.g. rfatenders — only present when the commissioner enables RFA).
   */
  async function fetchAndSave(name, docPath, { optional = false } = {}) {
    try {
      postProgress(`  Fetching ${name}…`);
      const doc = await getDoc(project, docPath, token);
      await downloadJson(name, doc);
      saved++;
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
   * Fetch a collection listing and download it as <name>.json.
   *
   * @param {boolean} optional  When true, a 403 is logged as a warning (⚠)
   *   rather than an error (✗) and does not increment the error count.
   *   Use for collections that may be restricted to commissioner-level access
   *   (e.g. trades — Firestore security rules vary by league).
   */
  async function fetchCollectionAndSave(name, collectionPath, { optional = false } = {}) {
    try {
      postProgress(`  Listing collection ${name}…`);
      const listing = await listCollection(project, collectionPath, token);
      await downloadJson(name, listing);
      saved++;
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

  // ── Standard 6-doc set (same as lt_firestore_dump.py default run) ──────────

  await fetchAndSave(
    "extensionSalaries",
    `leagues/${leagueId}/docs/extensionSalaries`
  );
  await fetchAndSave(
    "positionOverrides",
    `leagues/${leagueId}/docs/positionOverrides`
  );
  await fetchAndSave(
    "rfatenders",
    `leagues/${leagueId}/seasons/${season}/docs/rfatenders`,
    { optional: true }   // only exists when commissioner enables RFA
  );
  await fetchAndSave(
    "players_master",
    `seasons/${season}/playerArrays/players`
  );
  await fetchAndSave(
    "playerDetails_sample",
    `playerDetails/${samplePlayerId}`
  );

  // ── Team docs ──────────────────────────────────────────────────────────────

  if (allTeams) {
    postProgress(`  Enumerating teams in league ${leagueId} season ${season}…`);
    try {
      const teams = await listTeams(project, leagueId, season, token);
      postProgress(`  Found ${teams.length} teams.`);
      for (const { teamId, label } of teams) {
        await fetchAndSave(
          `team_${teamId}`,
          `leagues/${leagueId}/seasons/${season}/teams/${teamId}`
        );
        postProgress(`     → ${label}`);
      }
    } catch (err) {
      errors++;
      postProgress(`  ✗ team enumeration: ${err.message}`);
    }
  } else {
    // Fallback: dump just the sample team doc (Kyle's own team is DEFAULT_SAMPLE_TEAM_ID
    // in the Python script; keep as undefined here — user must configure if needed).
    postProgress("  allTeams=false — skipping team docs.");
  }

  // ── Activity collections (CAP-05) ─────────────────────────────────────────

  // trades may be restricted to commissioner-level Firestore rules in some
  // leagues — treat a 403 as a warning so other collections still succeed.
  const OPTIONAL_ACTIVITY = new Set(["trades"]);

  if (activityDump) {
    postProgress("  Fetching activity collections…");
    for (const name of ACTIVITY_COLLECTIONS) {
      await fetchCollectionAndSave(name, `leagues/${leagueId}/${name}`, {
        optional: OPTIONAL_ACTIVITY.has(name),
      });
    }

    // Per-team moneyEvents
    try {
      const teams = await listTeams(project, leagueId, season, token);
      for (const { teamId } of teams) {
        await fetchAndSave(
          `moneyEvents_${teamId}`,
          `leagues/${leagueId}/moneyEvents/${teamId}`
        );
      }
    } catch (err) {
      errors++;
      postProgress(`  ✗ moneyEvents: ${err.message}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const summary = `Done. ${saved} file(s) downloaded${errors ? `, ${errors} error(s)` : ""}.`;
  postProgress(summary);

  if (errors > 0) {
    postResult(
      false,
      `${summary} Check the progress log for which files failed.`
    );
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
      allTeams: message.allTeams !== false,   // default true
      activityDump: message.activityDump === true,
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
