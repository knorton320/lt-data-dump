# League Tycoon Data Dump — Firestore Sync Chrome Extension

Manifest V3 Chrome extension that dumps your League Tycoon Firestore data
to local JSON files.

## What it does

1. Reads your Firebase ID token from the page's IndexedDB on
   `app.leaguetycoon.com` — the same token LT uses for every request.
2. Hits the Firestore REST API (`firestore.googleapis.com`) and fetches the
   same documents the Python script fetches:
   - `extensionSalaries.json` — LT calculated extensions
   - `positionOverrides.json` — any league specific positional changes
   - `rfatenders.json` — RFA tender prices
   - `team_<teamId>.json` × 10 — every team's roster + contract state
   - `players_master.json` — player id↔name mapping
   - `playerDetails_sample.json` — sample bio fields from Bijan
3. Downloads each file to Chrome's configured downloads folder.
4. Optional "Dump Activity And Roster Data" button also fetches:
   - `trades.json`, `activityMessages.json`, `transactions.json`,
     `freeAgentAuctionResults.json`, `moneyEvents_<teamId>.json` × 10
   - `trades.json` is only scoped for the commissioner permissions today, this data is availible in transactions but needs to be translated from ID's

## Install (developer mode)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select `lt-data-dump/` from where you cloned the Github repo
5. The "League Tycoon Data Dump" extension appears in your toolbar

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
4. Click **⬇ Dump Roster Data** to fetch all 10 team docs + meta docs

Chrome will download each `.json` file.

## Token expiry

The Firebase ID token expires every ~60 minutes. If you see an error like
`"401 Unauthorized — Firebase token expired"`, just reload the LT page and
retry — the Firebase SDK auto-refreshes the token on page load.

You do **not** need to manually copy/paste the token anywhere. The extension
reads it automatically from the page's IndexedDB as long as you're signed in.

## Notes
- time stamps are UTC
- In transactions each object is a single asset, you can join by tradeID, team1 is the team sending the asset, team2 is receiving the asset
