/**
 * Content script — runs on app.leaguetycoon.com pages.
 *
 * Responsibilities:
 *   1. Listen for "GET_FIREBASE_TOKEN" (dump path) and "GET_AUTH_TOKENS"
 *      (credential-reveal UI) messages from the service worker.
 *   2. Read the Firebase auth tokens out of the page's IndexedDB
 *      (database: firebaseLocalStorageDb, store: firebaseLocalStorage,
 *      key pattern: firebase:authUser:*).
 *   3. Reply with the requested shape on success or { error } on failure.
 *
 * Why a content script?
 *   Service workers cannot access the page's origin-scoped IndexedDB.
 *   Content scripts share the page origin (https://app.leaguetycoon.com)
 *   and can read the same IndexedDB the Firebase JS SDK writes to.
 *
 * Security note:
 *   Tokens are only passed to chrome.runtime (same extension), never to
 *   any external destination, never logged, and never written to
 *   chrome.storage. The extension's host_permissions are scoped to
 *   app.leaguetycoon.com and firestore.googleapis.com only.
 */

"use strict";

/**
 * Pure parsing step: given the raw entries pulled from the
 * firebaseLocalStorage object store, find the firebase:authUser record and
 * extract the token triple. Separated from readAuthTokens() so it's
 * testable without a browser/IndexedDB (see test_extension_logic.js).
 *
 * @param {Array<{fbase_key?: string, key?: string, value: any}>} entries
 * @returns {{accessToken: string, refreshToken: string|null, expirationTime: number}}
 * @throws {Error} when no usable firebase:authUser entry is present
 */
function _extractAuthUserTokens(entries) {
  for (const entry of entries) {
    // Each entry is { fbase_key, value } where value is the Firebase
    // auth-user JSON blob.  The key starts with "firebase:authUser:".
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

/**
 * Given an expirationTime (ms epoch, 0/falsy = unknown), report whether the
 * ID token is expired. Separated out so the dump path's rejection and the
 * reveal UI's "expired — still show the refresh token" branch use the same
 * check instead of duplicating the comparison.
 */
function _isExpired(expirationTime) {
  return Boolean(expirationTime) && Date.now() > expirationTime;
}

/**
 * Open the Firebase local-storage IndexedDB and return the raw token triple.
 * This is the single reader — it does not judge expiry, it only reports
 * what's stored. Callers decide what expiry means for their use case.
 *
 * @returns {Promise<{accessToken: string, refreshToken: string|null, expirationTime: number}>}
 */
function readAuthTokens() {
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
        try {
          resolve(_extractAuthUserTokens(entries));
        } catch (err) {
          reject(err);
        }
      };
    };
  });
}

/**
 * Dump-path token getter. An expired ID token is useless for a Firestore
 * request, so this rejects on expiry — unlike readAuthTokens() itself.
 */
function getFirebaseToken() {
  return readAuthTokens().then(({ accessToken, expirationTime }) => {
    if (_isExpired(expirationTime)) {
      throw new Error(
        "Firebase token is expired. Reload the LT page to refresh it, " +
          "then try the dump again."
      );
    }
    return accessToken;
  });
}

// ─── Message listener ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_FIREBASE_TOKEN") {
    getFirebaseToken()
      .then((token) => sendResponse({ token }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // keep the message channel open for the async reply
  }

  if (message.type === "GET_AUTH_TOKENS") {
    // Credential-reveal UI: expired ID token must not block the refresh
    // token, so this calls the raw reader directly with no expiry check.
    readAuthTokens()
      .then((tokens) => sendResponse(tokens))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  return false;
});
