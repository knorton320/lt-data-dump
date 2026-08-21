# League Tycoon Data Dump — Firestore Sync Chrome Extension

Manifest V3 Chrome extension that dumps your League Tycoon Firestore data
to a single ZIP archive.

## What it does

1. Reads your Firebase ID token from the page's IndexedDB on
   `app.leaguetycoon.com` — the same token LT uses for every request.
2. Hits the Firestore REST API (`firestore.googleapis.com`) and fetches the
   selected data categories.
3. Bundles all fetched files into a single `lt_firestore_dump_<date>.zip` and
   downloads it via Chrome's configured downloads folder.

### Data categories (popup checkboxes)

| Category | Default | Files |
|---|---|---|
| Roster / standard docs | ✅ on | `extensionSalaries.json`, `positionOverrides.json`, `rfatenders.json`, `players_master.json`, `team_<id>.json` × 10 |
| Activity | ✅ on | `trades.json`, `activityMessages.json`, `transactions.json`, `freeAgentAuctionResults.json`, `moneyEvents_<id>.json` × 10 |
| Player stats & projections | ✅ on | `playerSeasonStats.json`, `playerSeasonProjections.json` |
| Sample player bio | ☐ off | `playerDetails_sample.json` — diagnostic only |

## Installation Guide

To clone and run this project locally, you'll need Git installed on your machine

1. Clone the repo -> run `git clone https://github.com/knorton320/lt-data-dump` from your terminal
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (toggle top-right)
4. Click **Load unpacked**
5. Select `lt-data-dump/` from the directory where you cloned the Github repo
6. The "League Tycoon Data Dump" extension appears in your toolbar

## Configure Chrome downloads folder

For seamless pipeline integration, point Chrome's download folder to a storage location

1. Chrome → Settings → Downloads → **Location** → Change
2. Navigate to desired folder and select it

Now every file the extension downloads lands directly where you or your application
expects it. No manual file-moving required.

Alternatively, set a **relative subdirectory prefix** in the extension popup's
"Download dir" field (e.g. `lt_firestore`). This prepends the path within
Chrome's downloads folder — useful if you don't want to change Chrome's global
downloads location.

## Usage

1. Go to `https://app.leaguetycoon.com` and sign in
2. Click the extension icon in Chrome's toolbar
3. Enter your **League ID** and **Season** — the League ID field has no
   default, so a blank dump errors clearly instead of pulling the wrong league
4. Click **⬇ Dump Selected** — Chrome downloads a single `lt_firestore_dump_<date>.zip`.

## Token expiry

The Firebase ID token expires every ~60 minutes. If you see an error like
`"401 Unauthorized — Firebase token expired"`, just reload the LT page and
retry — the Firebase SDK auto-refreshes the token on page load.

You do **not** need to manually copy/paste the token anywhere. The extension
reads it automatically from the page's IndexedDB as long as you're signed in.

## Credentials — reveal-and-copy tokens

Below the dump controls, a **Credentials** section can reveal either of the
two Firebase tokens the extension already reads for the dump itself — useful
for setting up something else that needs LT auth (e.g. an MCP server or other
automation) without the old dev-tools/IndexedDB dance.

| | **🔑 Show ID token** | **🔒 Show refresh token** |
|---|---|---|
| Lifetime | ~60 min | Until sign-out or password change |
| Use for | A quick curl, debugging, a short trial run | Persistent automation (MCP server, scheduled refresh) |
| If leaked | Expires within the hour on its own | Durable account access until explicitly revoked |

**Prefer the ID token for anything short-lived.** Reserve the refresh token
for setups that genuinely need to self-mint — it's a durable credential, and
the popup's warning text says so.

Behavior:
- Nothing renders until its button is clicked — an incidental screenshot of
  the normal dump flow won't capture either token.
- Each revealed value gets a **Copy** button and a **Hide** button.
- Auto-hides after ~60 seconds, or immediately when you close the popup
  (Chrome discards the popup's DOM on close, so there's nothing to persist).
- The ID token shows its expiry in human terms; if it's already expired, the
  refresh token is still revealable — an expired ID token says nothing about
  the refresh token's validity.
- If no signed-in League Tycoon session is found, the popup says so plainly
  instead of showing an empty field.
- Neither token is logged to the console, written to `chrome.storage`, or sent
  anywhere — this is purely a client-side clipboard convenience.

## Firestore API reference

Everything below documents the actual Firestore REST API that backs League
Tycoon — the same API this extension's credentials unlock. It is written so
that **a reader with only a token and this README can make a successful first
request** without reverse-engineering anything.

**Scope: read-only.** This reference deliberately covers **reads only**. The
refresh token is account-scoped, not read-scoped — it grants whatever your
account can do, which plausibly includes roster moves, trade responses, and
other league-affecting writes. A write does exist as a standard Firestore
`commit`/`update` request, but the recipe is intentionally omitted here: a
public how-to for raw-REST writes against a fantasy league is a support
burden for League Tycoon and is abusable against other owners in your league.
If you're building something that needs to write, treat that as a separate,
much more carefully-scoped project — not an extension of this document.

Every schema below is grounded in a **real captured payload** — either a live
Firestore response captured while writing this document, or the shape LT's
own client emits during normal use. Nothing here is guessed from field-name
vibes.

### 1. Authentication

League Tycoon uses standard [Firebase Authentication](https://firebase.google.com/docs/auth) —
there is no separate LT-specific auth system, no API keys to request, and no
OAuth app to register. Two credentials matter:

| | **ID token** | **Refresh token** |
|---|---|---|
| Lifetime | ~60 minutes | Until sign-out, password change, or explicit revocation |
| What it's for | The `Authorization: Bearer` value on every Firestore request | Minting new ID tokens without touching a browser |
| Where it lives | `stsTokenManager.accessToken` (see below) | `stsTokenManager.refreshToken` (same record) |
| If leaked | Expires within the hour on its own | Durable account access until revoked |

**Where they live.** The Firebase JS SDK persists the signed-in user in the
browser's IndexedDB:

```
IndexedDB database:  firebaseLocalStorageDb
  → object store:    firebaseLocalStorage
    → key:           firebase:authUser:<firebase-web-api-key>:[DEFAULT]
      → JSON value:
        {
          "stsTokenManager": {
            "accessToken": "eyJhbGciOi...",   ← the ID token
            "refreshToken": "AMf-vBz...",     ← the refresh token
            "expirationTime": 1780261186000
          },
          ...
        }
```

This extension's **🔑 Show ID token** / **🔒 Show refresh token** buttons
(see "Credentials" above) read exactly this record and hand you the value
with a Copy button — they replace the manual DevTools → Application →
IndexedDB dance entirely. Use the ID token for anything short-lived (a quick
curl, a debugging session); reserve the refresh token for something that
needs to self-mint over time (a script, a scheduled job).

**Minting an ID token from a refresh token.** This is the same request the
Firebase SDK itself makes on token refresh — a plain POST to Google's public
`securetoken` endpoint, no LT-specific logic involved:

```bash
curl -s -X POST \
  "https://securetoken.googleapis.com/v1/token?key=AIzaSyBmmXw_T84cWhbUU6NztpGECjvtH9YBgeI" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&refresh_token=<your refresh token>"
```

Real response shape (values redacted; captured live against LT's Firebase
project):

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIs... (same JWT as id_token)",
  "expires_in": "3600",
  "token_type": "Bearer",
  "refresh_token": "AMf-vBz... (rotates on every mint \u2014 store the new value)",
  "id_token": "eyJhbGciOiJSUzI1NiIs... (JWT; this is the Bearer value)",
  "user_id": "{uid}",
  "project_id": "378550825308"
}
```

`AIzaSyBmmXw_T84cWhbUU6NztpGECjvtH9YBgeI` is LT's **public** Firebase web API
key — it identifies the project, the same way a Google Maps embed key does;
it does not authorize anything by itself. It's safe to hardcode; access is
gated entirely by the bearer token plus Firestore's Security Rules, not by
this key.

Every Firestore call carries the minted `id_token` (the JWT, not the
`access_token` field — Firebase's securetoken response includes both under
different names for historical reasons; they're the same token here) as a
bearer credential:

```
Authorization: Bearer <id_token>
```

**`invalid_grant`.** If the refresh token has been revoked (sign-out,
password change, or a long period of total inactivity), the mint request
returns `HTTP 400` with a body containing `"error": "invalid_grant"` (or
`INVALID_REFRESH_TOKEN` / `TOKEN_EXPIRED` in the nested Google error detail).
There's no partial-credit response here — re-capture the refresh token via
this extension's popup and you're back in business. There is no other manual
step in an otherwise fully automatable pipeline.

**Handling expiry mid-session.** A Firestore call with an expired or invalid
ID token returns `HTTP 401`. The correct handling is: detect the 401, mint a
fresh ID token from your refresh token, retry the same request once. A
long-running poller should track the token's `expires_in` and re-mint
proactively a few minutes before expiry rather than waiting to be rejected —
Firestore has no grace period on an expired JWT.

### 2. Base URL and request shapes

Every request goes to the standard [Firestore REST API](https://firebase.google.com/docs/firestore/use-rest-api):

```
https://firestore.googleapis.com/v1/projects/figment-football/databases/(default)/documents/<path>
```

`figment-football` is League Tycoon's Firebase project id — fixed, not a
per-league value. `<path>` is a `/`-separated Firestore document/collection
path, e.g. `leagues/{leagueId}/seasons/{season}/teams/{teamId}`. Every request
needs the `Authorization: Bearer <id_token>` header from §1.

There are three distinct ways to read a path, and which one works depends on
the collection — this is the single least obvious thing about this API and
it will 403 you if you assume the wrong one.

**`GET` a known document by id** — always works if your account has access to
that specific document:

```bash
curl -s -H "Authorization: Bearer $ID_TOKEN" \
  "https://firestore.googleapis.com/v1/projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId}"
```

Returns `200` with the document. This is the shape for every "single doc at a
known path" read in the catalog below.

**`LIST` a collection** (`GET` on the *collection* path, no document id at the
end) — **works for some collections and 403s for others**, and the
distinction is not obvious from the collection name alone:

| Collection | Unfiltered `LIST` |
|---|---|
| `activityMessages`, `transactions`, `freeAgentAuctionResults`, `tradeAuctions`, `seasons/{s}/teams` | ✅ 200 |
| `trades`, `blindBids` | ❌ 403 — requires a `runQuery` with an owning-team filter (see below) |
| `leagues/{id}/draft` | ❌ 403 — draft sub-documents must be `GET` by known id (§6) |

Confirmed live: an unfiltered `GET` on `leagues/{leagueId}/trades` returns

```json
{
  "error": {
    "code": 403,
    "message": "Missing or insufficient permissions.",
    "status": "PERMISSION_DENIED"
  }
}
```

**`runQuery` with a filter** — a `POST` to the *parent* path's `:runQuery`
endpoint, body is a `structuredQuery`. This is how you read `trades` and
`blindBids` at all:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $ID_TOKEN" -H "Content-Type: application/json" \
  -d '{"structuredQuery":{"from":[{"collectionId":"blindBids"}],
       "where":{"fieldFilter":{"field":{"fieldPath":"teamID"},
       "op":"EQUAL","value":{"stringValue":"<your team id>"}}}}}' \
  "https://firestore.googleapis.com/v1/projects/figment-football/databases/(default)/documents/leagues/{leagueId}:runQuery"
```

Confirmed live, filtered to **your own** team id (200 — empty array is the
normal at-rest state, see §7):

```json
[
  {
    "readTime": "2026-08-21T12:17:00.339529Z"
  }
]
```

The exact same query filtered to **any other team's** id:

```json
[
  {
    "error": {
      "code": 403,
      "message": "Missing or insufficient permissions.",
      "status": "PERMISSION_DENIED"
    }
  }
]
```

**Say this plainly: a league-wide view of `blindBids` is impossible by
design, not by configuration.** Security Rules allow only a `teamID`-filtered
read of your own bids — there is no query shape, filter, or endpoint that
returns another team's blind bids on your token. If you're building
something that wants "what did everyone bid," that data does not exist on
any single owner's credentials.

`trades` is more permissive — a `runQuery` filtered by `senderTeamID` (or
`receiverTeamID`) equal to your own team id returns every trade you were a
party to:

```json
{
  "document": {
    "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/trades/{tradeId}",
    "fields": {
      "id": {
        "stringValue": "{tradeId}"
      },
      "senderTeamID": {
        "stringValue": "{teamId}"
      },
      "receiverTeamID": {
        "stringValue": "{receiverTeamId}"
      },
      "tradeStatus": {
        "stringValue": "failed"
      },
      "processed": {
        "booleanValue": true
      },
      "accepted": {
        "booleanValue": false
      },
      "createdDate": {
        "timestampValue": "2026-05-08T03:21:35.611Z"
      }
    }
  },
  "readTime": "2026-08-21T12:17:00.525517Z"
}
... (47 total matching documents in the response array)
```

Note the response shape differs from `LIST`: `runQuery` returns a **JSON
array** of `{"document": {...}, "readTime": ...}` entries (or a single
`{"readTime": ...}` entry with no `"document"` key when nothing matches),
not a `{"documents": [...]}` object.

**The `draft` room specifically:** `GET leagues/{leagueId}/draft/clock`
works, but `LIST leagues/{leagueId}/draft` 403s, and
`GET leagues/{leagueId}/draft/{draftID}` **also** 403s — `draftID` is a
correlation key that shows up *inside* `nominatedPlayer`/`clock`'s field
data, not a Firestore document id. The draft room's real document ids are
`clock`, `nominatedPlayer`, `snakeDraftOrder`, `rookieDraftOrder`, and
`slowAuctionBids` — hardcode those, don't try to derive or list them. Full
detail in §6.

**Pagination.** `LIST` responses page at 100 documents by default and include
a `nextPageToken` when more remain; pass it back as a `pageToken` query
param. Worked example — `seasons/{season}/teams` with a small page size to
force pagination (confirmed live, both pages returned real data):

Page 1 (`?pageSize=3`):

```json
{
  "documents": [
    {
      "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId}",
      "fields": {
        "teamName": {
          "stringValue": "<redacted>"
        },
        "capSpace": {
          "integerValue": "36"
        }
      }
    },
    {
      "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId2}",
      "fields": {
        "teamName": {
          "stringValue": "<redacted>"
        },
        "capSpace": {
          "integerValue": "58"
        }
      }
    },
    {
      "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId3}",
      "fields": {
        "teamName": {
          "stringValue": "<redacted>"
        },
        "capSpace": {
          "integerValue": "41"
        }
      }
    }
  ],
  "nextPageToken": "AFTOeJy5EIaGF...(truncated)"
}
```

Page 2 (`?pageSize=3&pageToken=<nextPageToken from page 1>`):

```json
{
  "documents": [
    {
      "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId4}",
      "fields": {
        "teamName": {
          "stringValue": "<redacted>"
        },
        "capSpace": {
          "integerValue": "42"
        }
      }
    },
    {
      "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId5}",
      "fields": {
        "teamName": {
          "stringValue": "<redacted>"
        },
        "capSpace": {
          "integerValue": "117"
        }
      }
    },
    {
      "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId6}",
      "fields": {
        "teamName": {
          "stringValue": "<redacted>"
        },
        "capSpace": {
          "integerValue": "153"
        }
      }
    }
  ]
}
```

Keep requesting with the latest `nextPageToken` until a response omits the
key — that's the last page. Every LT collection this reference covers is
small enough (tens to low hundreds of documents) that you'll see this in
practice only a page or two deep.

**The typed-value envelope.** Firestore REST never returns flat JSON — every
field is wrapped in a type tag:

```json
{"fields": {"teamName": {"stringValue": "..."}, "wins": {"integerValue": "3"}}}
```

not

```json
{"teamName": "...", "wins": 3}
```

This is not cosmetic. Consumers written against the flat shape (because it's
what a human expects, or what a hand-written test fixture used) will read
`None`/`undefined` for every field and often fail silently rather than erroring
— a `dict.get("teamName")` on the real envelope returns `None`, not an
exception, so a naive integration can look like it's "working" while quietly
returning empty data for every document. Unwrap `{"stringValue": …}` /
`{"integerValue": …}` (returned as a **string**, not a JSON number —
`"integerValue": "3"`, not `"integerValue": 3`) / `{"doubleValue": …}` /
`{"booleanValue": …}` / `{"timestampValue": …}` / `{"nullValue": null}` /
`{"arrayValue": {"values": [...]}}` / `{"mapValue": {"fields": {...}}}`
explicitly before using any value.

One more trap in the same family: **an empty array serializes as
`{"arrayValue": {}}`** — no `"values"` key at all, not `{"arrayValue":
{"values": []}}`. Code that unconditionally does `field["arrayValue"]["values"]`
will `KeyError` on the empty case; check for the key first.

### 3. Data catalog — what lives where

One row per collection/document this extension's credentials can reach.
**Method** is whichever access pattern actually returns data (see §2).
**Scope** is who can read it: *own-team* (filtered to your team id only),
*league-wide* (any document in your league), or *global* (not scoped to any
league at all).

| Path | Method | Scope | Live or historical | Update cadence |
|---|---|---|---|---|
| `seasons/{season}/playerArrays/players` | `GET` | Global | Historical (per-season snapshot) | Rarely — roughly once per season |
| `leagues/{id}/seasons/{season}/teams/{teamId}` | `GET` | League-wide | Live | Every roster/cap-affecting action |
| `leagues/{id}/seasons/{season}/teams` | `LIST` | League-wide | Live | Same as above |
| `leagues/{id}/docs/extensionSalaries` | `GET` | League-wide | Live (computed) | Recalculated as extension activity happens |
| `leagues/{id}/docs/positionOverrides` | `GET` | League-wide | Live (computed) | Rare |
| `leagues/{id}/seasons/{season}/docs/rfatenders` | `GET` | League-wide | Historical | Only if your league uses RFA tenders — **404 is normal** if it doesn't (§7) |
| `leagues/{id}/trades` | `runQuery` (filter by `senderTeamID`/`receiverTeamID`) | Own-team | Historical | New doc per trade proposal |
| `leagues/{id}/activityMessages` | `LIST` | League-wide | Historical (append-only feed) | Continuous |
| `leagues/{id}/transactions` | `LIST` | League-wide | Historical | New doc per add/drop/contract action |
| `leagues/{id}/freeAgentAuctionResults` | `LIST` | League-wide | Historical | New doc per FA auction settlement |
| `leagues/{id}/moneyEvents_{teamId}` (i.e. `moneyEvents/{teamId}`) | `GET` | League-wide (per team) | Historical | New entry per cap-affecting transaction |
| `seasons/{season}/playerArrays/playerSeasonStats` | `GET` | Global | Historical | Weekly during the season; absent pre-season (§7) |
| `seasons/{season}/playerArrays/playerSeasonProjections` | `GET` | Global | Live (forward-looking) | Weekly |
| `playerDetails/{playerId}` | `GET` | Global | Live (bio) + historical (game logs subcollection) | Bio rarely changes; stats weekly |
| `leagues/{id}/seasons/{season}/docs/draftHistory` (i.e. `draftHistory_{season}`) | `GET` | League-wide | Historical, but **updates live during an active draft** | Continuous during a draft, static otherwise |
| `leagues/{id}/draft/clock` | `GET` (known id only) | League-wide | Live | Every clock tick during a draft |
| `leagues/{id}/draft/nominatedPlayer` | `GET` (known id only) | League-wide | Live | Every bid during a draft |
| `leagues/{id}/draft/rookieDraftOrder` | `GET` (known id only) | League-wide | Historical after the draft ends | Once, at draft setup |
| `leagues/{id}/draft/snakeDraftOrder` | `GET` (known id only) | League-wide | Historical after the draft ends | Once, at draft setup |
| `leagues/{id}/draft/slowAuctionBids` | `GET` (known id only) | League-wide | Live | Only exists if the draft is configured "slow" — 404 otherwise |
| `leagues/{id}/blindBids` | `runQuery` (filter by `teamID`, **own team only**) | Own-team | Live, empty at rest | New doc while a waiver bid is pending; removed on settlement |
| `leagues/{id}/tradeAuctions` | `LIST` | League-wide | Live, empty at rest | New doc while a trade-block auction is in-flight; removed on resolution |
| `leagues/{id}/docs/hallOfFame` | `GET` | League-wide | Historical | Updated at season end |
| `timeframes/upcoming` | `GET` | Global | Live | Continuous (current-week clock) |
| `leagues/{id}/seasons/{season}` (the season doc) | `GET` | League-wide | Historical, finalized at season end | Weekly during the season |
| `depthCharts/{nflTeamId}` | `GET` | Global | Live | Weekly, per NFL team — **keyed by NFL franchise id (1–35 or similar), not your LT team id** |
| `docs/injuries` | `GET` | Global | Live | Continuous |
| `leagues/{id}` (the league config doc) | `GET` | League-wide | Mostly static (settings) + a few live fields | Settings rarely change; a handful of top-level fields (waiver clock, latest result) update continuously |

### 4. Schemas

Field-level shapes, all confirmed against real captured payloads. Nullability
and units are called out where they aren't obvious. All type tags below
elide the Firestore typed-value wrapper for readability — e.g. `capSpace:
integer` means the real payload is `"capSpace": {"integerValue": "36"}`.

**Team document** (`leagues/{id}/seasons/{season}/teams/{teamId}`)

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same as the document id |
| `teamName` | string | Owner-chosen team name |
| `capSpace` | integer | Remaining cap room |
| `wins` / `losses` / `ties` | integer | Season record |
| `totalPointsFor` / `totalPointsAgainst` / `totalMaxPoints` | double | Season scoring totals |
| `extensionsUsed` / `tagsUsed` / `rookieOptionsUsed` | integer | Allotment counters for the season |
| `twoYearUsed` / `threeYearUsed` / `fourYearUsed` / `fiveYearUsed` | integer | Contract-length allotment counters |
| `roster` | array of maps | One entry per rostered player — see below |

`roster[]` entries:

| Field | Type | Notes |
|---|---|---|
| `id` | integer | The player id — same id space as `playerDetails/{id}` |
| `name` | string | Player name |
| `position` | string | **Can be entirely absent** — practice-squad rookies especially. Don't assume it's populated; check for the key. |
| `realSalary` | integer | **Full, undiscounted contract value.** This is the "real" cost of the contract before any roster-status discount. |
| `currentSalary` | integer | **The actual cap hit** — post-PS/IR-discount. **These two field names invert what their words suggest at a glance**: `realSalary` sounds like it should be the "actual" number, but it's the undiscounted one; `currentSalary` is the discounted, currently-charged number. Get this backwards and every cap calculation downstream is wrong in a way that won't throw an error. |
| `contractType` | string | Observed values include `extension`, `rookie`, `rookieoption`, `franchisetag`, `fadraft`, `freeagent` |
| `contractYears` | integer | Years remaining on the contract |
| `slot` | map (`{slotType, num}`) | The lineup slot assignment — `slotType` is a starter position (`QB`/`RB`/`WR`/`TE`/`FLEX`/`SFLX`), `BE` (bench), `PS` (practice squad), or `IR`; `num` disambiguates multiple slots of the same type |
| `hasBeenExtended` / `hasBeenTagged` / `hasBeenRookieOptioned` | boolean | Lifecycle flags |
| `extensionEligible` / `tagEligible` / `psEligible` / `contractEligible` / `rookieOptionEligible` | boolean | Whether each contract action is currently available for this player |
| `realSalaryList` | array of maps | Per-season salary schedule: `{season, salary, hardSet}` |

**`leagues/{id}` — the league config doc**

35 top-level fields covering both live state and settings. The ones worth
knowing:

| Field | Type | Notes |
|---|---|---|
| `leagueName` / `leagueOwner` / `leagueSize` / `leagueType` | — | League identity/settings |
| `owners` | map | `{userID: {displayName, teamID, selectedFrame}}` — real owner names keyed to team ids. This is the one place owner display names live; everywhere else in this catalog only opaque team ids appear. |
| `salaryCap` / `rolloverCap` / `minimumSalary` | integer | Cap constants for the league |
| `playersOnWaivers` | array | `[{playerID, expiration}]` — the current waiver wire |
| `activated` / `activationDeadline` / `weekResultsProcessed` / `weekWaiversProcessed` / `nextWaiverDropExpiration` | — | Operational clock/state flags |
| `latestWinningTeamID` / `latestLosingTeamID` | string | Most recent matchup result |
| `scoring` | map | Full scoring rule set (offense + DST) |
| `rosterSettings` | map | Roster size/slot configuration |
| `contractSettings` | map | Cap/contract rules — includes `tagPrices` (franchise tag $ by position) and `rfaTenderLevels` |
| `draftSettings` | map | Draft format/timing configuration, including `leagueDrafts[]` (per-format settings, including contract-bidding multipliers if your league uses that format) |
| `scheduleSettings` | map | Playoff structure (`playoffOptions`: team count, start week, bracket type) |
| `transactionSettings` / `waiverSettings` | map | Trade/waiver rules (deadlines, veto thresholds, FAAB windows) |

**Season doc** (`leagues/{id}/seasons/{season}`)

| Field | Type | Notes |
|---|---|---|
| `schedule` | array, one entry per week | `{matchups: [{team1, team2} × n]}` — the actual fantasy matchup schedule. Not to be confused with `seasons/{season}/schedule` (a separate, *global* document holding the **NFL** game schedule, keyed by NFL franchise id) |
| `finalStandings` | array of team ids | Ground-truth finish order, best to worst — only populated once the season completes |
| `playoffSchedule` | array of bracket entries | Keyed by bracket name (varies by league's playoff format); `BYE` appears as a literal team-id sentinel for bye rounds |

**`seasons/{season}/weekResults/week_{n}_results`** (one doc per week)

| Field | Type | Notes |
|---|---|---|
| `week` | integer | The week number — also encoded in the document id (`week_10_results`). Don't assume only one or the other is present; check the id if the field is ever missing on an older season. |
| `isPlayoffs` | boolean | |
| `matchupResults` | array of maps | One per matchup that week: `team1`/`team2` (team ids), `team1TotalScore`/`team2TotalScore` (double — carries real float noise, e.g. `121.42000000000002`; don't round unless you mean to), `team1TotalMaxPoints`/`team2TotalMaxPoints`, `team1Record`/`team2Record` (string, e.g. `"3-1-0"`). One of `team1`/`team2` can be the literal string `"BYE"` for a playoff bye. |

**There is no `winnerTeamID` or `isTie` field anywhere in this document —**
derive both from comparing `team1TotalScore` to `team2TotalScore` yourself.

**`draftHistory`** (`leagues/{id}/seasons/{season}/docs/draftHistory`)

| Field | Type | Notes |
|---|---|---|
| `history` | array of maps | Every completed lot — rookie-draft picks and preseason FA-auction sales interleaved in one array, distinguished by fields on each entry (contract-length/pick-number presence generally signals rookie picks; a straight `bid`/`winningTeamID` pair with no pick number signals an FA sale) |
| `autoPickTeams` / `autoPickTeamsByDraft` | array | Teams that had auto-pick enabled |

**`depthCharts/{nflTeamId}`** (global, one doc per **NFL** franchise)

| Field | Type | Notes |
|---|---|---|
| `teamID` | integer | The **NFL** team id — this collection has nothing to do with your LT fantasy team id |
| `qbList` / `rbList` / `wrList` / `teList` / `kList` + ~19 defensive position lists | array of `{playerID, teamID, fullName}` | Depth-ordered (starter first) per position |

**`playerDetails/{playerId}`** (global)

| Field | Type | Notes |
|---|---|---|
| `id` | integer | Same id used in every roster/transaction reference |
| `name` | string | |
| `teamID` | integer | **NFL** team id (not an LT fantasy team) |
| `age` / `college` / `experience` / `byeWeek` | — | Bio fields |
| `ownership` / `startPercentage` / `deltaOwnership` / `opponentPositionRank` | — | League-context percentages/ranks, recomputed regularly |

**`activityMessages/{id}`**

| Field | Type | Notes |
|---|---|---|
| `type` | string | Enum — observed values include `Trade`, `Add`, `Drop`, `Contract`, `FAAuction`, `PSActivated`, and general/system entries |
| `timeStamp` | timestamp | |
| `message` | string | Human-readable narrative text |

**`transactions/{id}`**

| Field | Type | Notes |
|---|---|---|
| `type` | string | e.g. `Trade` |
| `idArray` | array | Mixed team-id and player-id strings/ints involved in the transaction — the join key for "which teams/players does this transaction touch" |
| `team1ID` / `team2ID` | string | Present on trade-shaped transactions |
| `playerID` | integer | |
| `timeStamp` | timestamp | |
| `optionalDescription` | string or null | |

### 5. Example requests and responses

All of the following were executed against live LT data while writing this
document; response bodies are real, with league/team/player-owner
identifiers replaced by placeholders (`{leagueId}`, `{teamId}`) and any
free-text/name fields redacted.

**GET a team document:**

```bash
curl -s -H "Authorization: Bearer $ID_TOKEN" \
  "https://firestore.googleapis.com/v1/projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId}"
```

```json
{
  "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/seasons/2026/teams/{teamId}",
  "fields": {
    "id": {
      "stringValue": "{teamId}"
    },
    "teamName": {
      "stringValue": "<redacted>"
    },
    "capSpace": {
      "integerValue": "36"
    },
    "wins": {
      "integerValue": "0"
    },
    "losses": {
      "integerValue": "0"
    },
    "ties": {
      "integerValue": "0"
    },
    "extensionsUsed": {
      "integerValue": "3"
    },
    "tagsUsed": {
      "integerValue": "0"
    },
    "roster": {
      "arrayValue": {
        "values": [
          {
            "mapValue": {
              "fields": {
                "rookieOptionEligible": {
                  "booleanValue": false
                },
                "slot": {
                  "mapValue": {
                    "fields": {
                      "slotType": {
                        "stringValue": "WR"
                      },
                      "num": {
                        "integerValue": "0"
                      }
                    }
                  }
                },
                "psEligible": {
                  "booleanValue": false
                },
                "extensionEligible": {
                  "booleanValue": false
                },
                "contractType": {
                  "stringValue": "extension"
                },
                "id": {
                  "integerValue": "22564"
                },
                "tagEligible": {
                  "booleanValue": false
                },
                "realSalary": {
                  "integerValue": "57"
                },
                "contractEligible": {
                  "booleanValue": false
                },
                "position": {
                  "stringValue": "WR"
                },
                "currentSalary": {
                  "integerValue": "70"
                },
                "hasBeenTagged": {
                  "booleanValue": false
                },
                "hasBeenRookieOptioned": {
                  "booleanValue": false
                },
                "name": {
                  "stringValue": "Ja'Marr Chase"
                },
                "hasBeenExtended": {
                  "booleanValue": true
                },
                "realSalaryList": {
                  "arrayValue": {
                    "values": [
                      {
                        "mapValue": {
                          "fields": {
                            "salary": {
                              "integerValue": "70"
                            },
                            "season": {
                              "integerValue": "2026"
                            },
                            "hardSet": {
                              "booleanValue": true
                            }
                          }
                        }
                      }
                    ]
                  }
                },
                "contractYears": {
                  "integerValue": "2"
                }
              }
            }
          }
        ]
      }
    }
  }
}
```

**GET the draft clock (works even with no draft running — see §6):**

```bash
curl -s -H "Authorization: Bearer $ID_TOKEN" \
  "https://firestore.googleapis.com/v1/projects/figment-football/databases/(default)/documents/leagues/{leagueId}/draft/clock"
```

```json
{
  "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/draft/clock",
  "fields": {
    "countdown": {
      "integerValue": "0"
    },
    "timeStarted": {
      "timestampValue": "2026-05-30T00:17:24.039Z"
    }
  },
  "createTime": "2023-08-10T13:19:20.184205Z",
  "updateTime": "2026-05-30T00:17:24.100625Z"
}
```

**A paginated LIST** — see the full worked example with both pages in §2.

**A `runQuery` with a filter** — see the `blindBids` and `trades` examples in
§2, which are the canonical worked examples for this call shape.

### 6. Live draft

The live auction/draft room is its own access pattern (§2) and its own
polling contract — get this wrong and you'll silently under-report bids.

**What exists at each document id, live vs. idle:**

| Document | While a draft is running | While idle (no draft active) |
|---|---|---|
| `draft/clock` | `countdown` ticking down, `timeStarted` set | `countdown: 0`, `timeStarted` from the last draft |
| `draft/nominatedPlayer` | `playerID` non-zero, `bid` current high bid, `recentBids[]` populated, `isComplete: false` | `playerID: 0`, `bid: 0`, `isComplete: true`, `recentBids` empty, `winningTeamID` empty string, `draftID: null` |
| `draft/rookieDraftOrder`, `draft/snakeDraftOrder` | Populated once the draft format is finalized | Retained — this is the historical draft order, still readable after the fact |
| `draft/slowAuctionBids` | Only present if the league's draft is configured "slow" | 404 — this is normal, not an error, for any fast-format draft |

Confirmed live (idle state, real response, no draft currently running):

```json
{
  "name": "projects/figment-football/databases/(default)/documents/leagues/{leagueId}/draft/nominatedPlayer",
  "fields": {
    "playerID": {
      "integerValue": "0"
    },
    "bid": {
      "integerValue": "0"
    },
    "isComplete": {
      "booleanValue": true
    },
    "isPaused": {
      "booleanValue": false
    },
    "draftID": {
      "nullValue": null
    },
    "winningTeamID": {
      "stringValue": ""
    },
    "recentBids": {
      "arrayValue": {}
    },
    "season": {
      "integerValue": "2026"
    }
  }
}
```

**The single most important operational fact in this whole document:
`recentBids[]` is a rolling window capped at 12 entries — it is not the
full bid ladder.** In a long bidding war on a single player, the earliest
bids silently fall off the front of the array as new ones arrive. Anything
that reconstructs a full bid ladder, counts distinct bidders, or infers the
opening price **must accumulate `recentBids` across successive polls** —
treating a single snapshot as the complete history will systematically
under-count both the number of bidders and the price trajectory on any lot
with more than 12 bids.

**`draftHistory` is the authoritative completed-lot record**, and it updates
**live** during the draft as each lot closes — prefer reading it over trying
to infer a sale from a transition in `nominatedPlayer` (e.g. `playerID`
changing, or a brief `playerID: 0` gap between lots). The transition-based
approach works but is strictly more fragile; `draftHistory` is the ground
truth LT itself relies on.

**`runtimeDraft.budgets[]`** (a field on `nominatedPlayer` while a draft is
active) carries every team's live remaining auction budget — useful for
building a "who can still afford this player" view without summing
transactions yourself.

**Mock drafts run in their own throwaway league.** Starting a mock spins up a
brand-new `leagueID` distinct from your real league — the mock's live draft
room lives at the exact same `leagues/{mockLeagueId}/draft/*` paths described
above. `mockDrafts/{mockId}` (a separate top-level collection) holds only the
mock's *settings*, not its live state.

**Poll cadence.** LT's own client reads this data over Firestore's
long-lived Listen/subscribe channel, not repeated polling — but for a REST
client, polling `nominatedPlayer` + `clock` every 1–2 seconds during an
active auction is well within Firestore's normal per-project quotas and
matches what this reference's live testing used without triggering any
rate-limit response. There is no `Retry-After` or documented rate-limit
header on this API — if you're issuing more than a few requests per second
sustained, you're polling harder than any legitimate use case needs, not
approaching a real limit.

### 7. Errors and gotchas

| Response | Meaning | What to do |
|---|---|---|
| `401 UNAUTHENTICATED` | ID token expired, malformed, or missing | Mint a fresh ID token from your refresh token (§1) and retry once |
| `403 PERMISSION_DENIED` — on a collection `LIST` | The collection requires a `runQuery` with an owning-team filter, not an unfiltered list (§2) | Switch to `runQuery`, filtered by the field Security Rules actually check (`teamID`, `senderTeamID`, etc.) |
| `403 PERMISSION_DENIED` — on a `runQuery` | You filtered to a team id that isn't yours | This is not fixable by changing the query — that data is genuinely not readable on your token (blindBids, §2) |
| `404 NOT_FOUND` — `seasons/{s}/docs/rfatenders` | Benign. RFA tenders are an optional league feature; if your league doesn't use them, the document is simply never created | Not a bug — check whether your league's `contractSettings.rfaTenderLevels` / tender count is even enabled before treating this as a failure |
| `404 NOT_FOUND` — `playerSeasonStats` for the current season | Benign, pre-season. The document is created once real games have been played that season | Read the prior season's stats, or wait for the season to start |
| `200` with an empty result | Normal at-rest state for `tradeAuctions` and `blindBids` — both collections hold **only in-flight events** and are emptied the moment the event resolves (accepted, expired, or canceled) | Not an error and not evidence the collection is broken — capture opportunistically while an auction/bid is actually live if you need a non-empty example |
| `400 INVALID_ARGUMENT` | Almost always a malformed path — a missing path segment (e.g. an empty `{season}` producing `seasons//docs/...`) | Double-check every path template variable is actually substituted before the request goes out |

**One more shape trap, not a status code:** an empty Firestore array field
serializes as `{"arrayValue": {}}` with no `"values"` key at all (§2) — code
that unconditionally indexes into `["arrayValue"]["values"]` will crash on
the empty case specifically, which tends to be exactly the case a first-time
integration hits (an idle draft, a `recentBids` before any bid has been
placed, an empty roster slot list).

## Notes

- time stamps are UTC
- In transactions each object is a single asset, you can join by tradeID, team1 is the team sending the asset, team2 is receiving the asset

## ZIP format

The ZIP uses STORE mode (no compression). Files unzip instantly and the
archive is created entirely in-browser — no server round-trip, no external
library dependency.
