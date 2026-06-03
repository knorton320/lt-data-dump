/**
 * Content script — runs on app.leaguetycoon.com pages.
 *
 * Responsibilities:
 *   1. Listen for "GET_FIREBASE_TOKEN" messages from the service worker.
 *   2. Read the Firebase ID token out of the page's IndexedDB
 *      (database: firebaseLocalStorageDb, store: firebaseLocalStorage,
 *      key pattern: firebase:authUser:*).
 *   3. Reply with { token } on success or { error } on failure.
 *
 * Why a content script?
 *   Service workers cannot access the page's origin-scoped IndexedDB.
 *   Content scripts share the page origin (https://app.leaguetycoon.com)
 *   and can read the same IndexedDB the Firebase JS SDK writes to.
 *
 * Security note:
 *   The token is only passed to chrome.runtime (same extension), never
 *   to any external destination. The extension's host_permissions are
 *   scoped to app.leaguetycoon.com and firestore.googleapis.com only.
 */

"use strict";

/** Open the Firebase local-storage IndexedDB and return the access token. */
function getFirebaseToken() {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open("firebaseLocalStorageDb");

    openReq.onerror = () =>
      reject(
        new Error(
          "Cannot open firebaseLocalStorageDb — are you signed in to League Tycoon?"
        )
      );

    openReq.onsuccess = (evt) => {
      const db = evt.target.result;

      // The object store name may vary across Firebase SDK versions;
      // try "firebaseLocalStorage" first, fall back to scanning all stores.
      const storeName = db.objectStoreNames.contains("firebaseLocalStorage")
        ? "firebaseLocalStorage"
        : [...db.objectStoreNames][0];

      if (!storeName) {
        db.close();
        reject(new Error("No object stores found in firebaseLocalStorageDb"));
        return;
      }

      const tx = db.transaction([storeName], "readonly");
      const store = tx.objectStore(storeName);
      const getAllReq = store.getAll();

      getAllReq.onerror = () => {
        db.close();
        reject(new Error("Failed to read firebaseLocalStorage entries"));
      };

      getAllReq.onsuccess = (e) => {
        db.close();
        const entries = e.target.result || [];

        for (const entry of entries) {
          // Each entry is { fbase_key, value } where value is the Firebase
          // auth-user JSON blob.  The key starts with "firebase:authUser:".
          const key = entry.fbase_key || entry.key || "";
          if (!key.startsWith("firebase:authUser:")) continue;

          const authUser = entry.value;
          if (!authUser || typeof authUser !== "object") continue;

          const tokenMgr = authUser.stsTokenManager;
          if (!tokenMgr || !tokenMgr.accessToken) continue;

          // Check expiry — token lifetime is ~60 min.
          const expiresAt = Number(tokenMgr.expirationTime) || 0;
          if (expiresAt && Date.now() > expiresAt) {
            reject(
              new Error(
                "Firebase token is expired. Reload the LT page to refresh it, " +
                  "then try the dump again."
              )
            );
            return;
          }

          resolve(tokenMgr.accessToken);
          return;
        }

        reject(
          new Error(
            'No firebase:authUser entry found in IndexedDB. ' +
              "Make sure you're signed in to League Tycoon (app.leaguetycoon.com)."
          )
        );
      };
    };
  });
}

// ─── Message listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_FIREBASE_TOKEN") return false;

  getFirebaseToken()
    .then((token) => sendResponse({ token }))
    .catch((err) => sendResponse({ error: err.message }));

  // Return true to keep the message channel open for the async reply.
  return true;
});
