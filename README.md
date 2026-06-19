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
3. Verify **League ID** and **Season** match your league  
   (defaults are the IDs from our league - BLB)
4. Click **⬇ Dump Selected** Chrome downloads a single `lt_firestore_dump_<date>.zip`.

## Token expiry

The Firebase ID token expires every ~60 minutes. If you see an error like
`"401 Unauthorized — Firebase token expired"`, just reload the LT page and
retry — the Firebase SDK auto-refreshes the token on page load.

You do **not** need to manually copy/paste the token anywhere. The extension
reads it automatically from the page's IndexedDB as long as you're signed in.

## Notes

- time stamps are UTC
- In transactions each object is a single asset, you can join by tradeID, team1 is the team sending the asset, team2 is receiving the asset

## ZIP format

The ZIP uses STORE mode (no compression). Files unzip instantly and the
archive is created entirely in-browser — no server round-trip, no external
library dependency.
