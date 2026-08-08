"use strict";

/**
 * popup.js — controls the LT Firestore Sync popup.
 *
 * Lifecycle:
 *   1. On load: restore saved config from chrome.storage.local.
 *   2. User selects data categories and clicks "Dump Selected" →
 *      save config → send START_DUMP to service worker →
 *      disable button → stream DUMP_PROGRESS lines into #status.
 *   3. On DUMP_RESULT: re-enable button, colour-code the result line.
 *   4. Config changes (leagueId, season, downloadDir) are saved on blur.
 */

// ─── Elements ─────────────────────────────────────────────────────────────────

const leagueIdInput    = document.getElementById("leagueId");
const seasonInput      = document.getElementById("season");
const downloadDirInput = document.getElementById("downloadDir");
const chkRoster        = document.getElementById("chkRoster");
const chkActivity      = document.getElementById("chkActivity");
const chkPlayerStats   = document.getElementById("chkPlayerStats");
const chkSampleBio     = document.getElementById("chkSampleBio");
const btnDump          = document.getElementById("btnDump");
const statusEl         = document.getElementById("status");

const btnShowIdToken      = document.getElementById("btnShowIdToken");
const idTokenPanel        = document.getElementById("idTokenPanel");
const idTokenValue        = document.getElementById("idTokenValue");
const idTokenExpiry       = document.getElementById("idTokenExpiry");
const btnCopyIdToken      = document.getElementById("btnCopyIdToken");
const btnHideIdToken      = document.getElementById("btnHideIdToken");

const btnShowRefreshToken = document.getElementById("btnShowRefreshToken");
const refreshTokenPanel   = document.getElementById("refreshTokenPanel");
const refreshTokenValue   = document.getElementById("refreshTokenValue");
const btnCopyRefreshToken = document.getElementById("btnCopyRefreshToken");
const btnHideRefreshToken = document.getElementById("btnHideRefreshToken");

const credErrorEl         = document.getElementById("credError");

// ─── Config persistence ───────────────────────────────────────────────────────

async function loadConfig() {
  const config = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
  if (config.leagueId)    leagueIdInput.value    = config.leagueId;
  if (config.season)      seasonInput.value      = config.season;
  if (config.downloadDir !== undefined) downloadDirInput.value = config.downloadDir;
}

function saveConfig() {
  const config = {
    leagueId:    leagueIdInput.value.trim()    || undefined,
    season:      seasonInput.value.trim()      || undefined,
    downloadDir: downloadDirInput.value.trim() || "",
  };
  chrome.runtime.sendMessage({ type: "SET_CONFIG", config });
}

[leagueIdInput, seasonInput, downloadDirInput].forEach((el) =>
  el.addEventListener("blur", saveConfig)
);

// ─── Status log ───────────────────────────────────────────────────────────────

function logLine(text) {
  statusEl.classList.add("visible");
  const line = document.createTextNode(text + "\n");
  statusEl.appendChild(line);
  statusEl.scrollTop = statusEl.scrollHeight;
}

function logResult(success, text) {
  statusEl.classList.add("visible");
  const span = document.createElement("span");
  span.className = success ? "result-ok" : "result-err";
  span.textContent = (success ? "✓ " : "✗ ") + text + "\n";
  statusEl.appendChild(span);
  statusEl.scrollTop = statusEl.scrollHeight;
}

function clearStatus() {
  statusEl.innerHTML = "";
  statusEl.classList.remove("visible");
}

// ─── Dump trigger ─────────────────────────────────────────────────────────────

function startDump() {
  saveConfig();
  clearStatus();
  setDisabled(true);

  const msg = {
    type:             "START_DUMP",
    leagueId:         leagueIdInput.value.trim() || undefined,
    season:           seasonInput.value.trim()   || undefined,
    rosterDump:       chkRoster.checked,
    activityDump:     chkActivity.checked,
    playerStatsDump:  chkPlayerStats.checked,
    includeSampleBio: chkSampleBio.checked,
  };

  chrome.runtime.sendMessage(msg, (response) => {
    if (!response?.started) {
      logResult(false, "Failed to start dump — service worker did not respond.");
      setDisabled(false);
    }
  });
}

function setDisabled(disabled) {
  btnDump.disabled = disabled;
}

btnDump.addEventListener("click", startDump);

// ─── Progress messages from service worker ────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "DUMP_PROGRESS") {
    logLine(message.text);
  } else if (message.type === "DUMP_RESULT") {
    logResult(message.success, message.text);
    setDisabled(false);
  }
});

// ─── Credentials reveal (ID token + refresh token) ─────────────────────────────
//
// Nothing renders until its own button is clicked. Each revealed value
// auto-hides after AUTO_HIDE_MS; closing the popup destroys the document
// entirely (Chrome MV3 popups don't persist state), which covers the
// "or on popup close" half of the requirement for free.
//
// Neither token is ever logged, written to chrome.storage, or sent
// anywhere outside this popup's DOM.

const AUTO_HIDE_MS = 60_000;

let idTokenHideTimer = null;
let refreshTokenHideTimer = null;

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

function showCredError(text) {
  credErrorEl.textContent = text;
  credErrorEl.hidden = false;
}

function clearCredError() {
  credErrorEl.hidden = true;
  credErrorEl.textContent = "";
}

async function fetchAuthTokens() {
  const response = await chrome.runtime.sendMessage({ type: "GET_AUTH_TOKENS" });
  if (!response || response.error) {
    throw new Error(response?.error || "No response from service worker.");
  }
  return response;
}

function hideIdToken() {
  idTokenPanel.hidden = true;
  idTokenValue.value = "";
  idTokenExpiry.textContent = "";
  idTokenExpiry.classList.remove("expired");
  if (idTokenHideTimer) {
    clearTimeout(idTokenHideTimer);
    idTokenHideTimer = null;
  }
}

function hideRefreshToken() {
  refreshTokenPanel.hidden = true;
  refreshTokenValue.value = "";
  if (refreshTokenHideTimer) {
    clearTimeout(refreshTokenHideTimer);
    refreshTokenHideTimer = null;
  }
}

async function revealIdToken() {
  clearCredError();
  try {
    const { accessToken, expirationTime } = await fetchAuthTokens();
    if (!accessToken) throw new Error("No ID token available.");

    idTokenValue.value = accessToken;
    const { text, expired } = formatExpiry(expirationTime);
    idTokenExpiry.textContent = text;
    idTokenExpiry.classList.toggle("expired", expired);
    idTokenPanel.hidden = false;

    if (idTokenHideTimer) clearTimeout(idTokenHideTimer);
    idTokenHideTimer = setTimeout(hideIdToken, AUTO_HIDE_MS);
  } catch (err) {
    showCredError(err.message);
  }
}

async function revealRefreshToken() {
  clearCredError();
  try {
    // Deliberately does not check expiry — an expired ID token says
    // nothing about the refresh token's validity.
    const { refreshToken } = await fetchAuthTokens();
    if (!refreshToken) throw new Error("No refresh token available.");

    refreshTokenValue.value = refreshToken;
    refreshTokenPanel.hidden = false;

    if (refreshTokenHideTimer) clearTimeout(refreshTokenHideTimer);
    refreshTokenHideTimer = setTimeout(hideRefreshToken, AUTO_HIDE_MS);
  } catch (err) {
    showCredError(err.message);
  }
}

async function copyValue(input, button) {
  try {
    await navigator.clipboard.writeText(input.value);
    const original = button.textContent;
    button.textContent = "Copied!";
    setTimeout(() => {
      button.textContent = original;
    }, 1200);
  } catch (err) {
    showCredError(`Copy failed: ${err.message}`);
  }
}

btnShowIdToken.addEventListener("click", revealIdToken);
btnHideIdToken.addEventListener("click", hideIdToken);
btnCopyIdToken.addEventListener("click", () => copyValue(idTokenValue, btnCopyIdToken));

btnShowRefreshToken.addEventListener("click", revealRefreshToken);
btnHideRefreshToken.addEventListener("click", hideRefreshToken);
btnCopyRefreshToken.addEventListener("click", () => copyValue(refreshTokenValue, btnCopyRefreshToken));

// ─── Initialise ───────────────────────────────────────────────────────────────

loadConfig().catch((err) => {
  console.warn("LT Sync: could not load config:", err.message);
});
