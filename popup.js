"use strict";

/**
 * popup.js — controls the LT Firestore Sync popup.
 *
 * Lifecycle:
 *   1. On load: restore saved config from chrome.storage.local.
 *   2. User clicks a dump button → save config → send START_DUMP to service
 *      worker → disable buttons → stream DUMP_PROGRESS lines into #status.
 *   3. On DUMP_RESULT: re-enable buttons, colour-code the result line.
 *   4. Config changes (leagueId, season, downloadDir) are saved on blur.
 */

// ─── Elements ─────────────────────────────────────────────────────────────────

const leagueIdInput  = document.getElementById("leagueId");
const seasonInput    = document.getElementById("season");
const downloadDirInput = document.getElementById("downloadDir");
const chkAllTeams    = document.getElementById("chkAllTeams");
const btnDump        = document.getElementById("btnDump");
const btnActivity    = document.getElementById("btnActivity");
const statusEl       = document.getElementById("status");

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

function startDump(activityDump = false) {
  saveConfig();
  clearStatus();
  setDisabled(true);

  const msg = {
    type:        "START_DUMP",
    leagueId:    leagueIdInput.value.trim() || undefined,
    season:      seasonInput.value.trim()   || undefined,
    allTeams:    chkAllTeams.checked,
    activityDump,
  };

  chrome.runtime.sendMessage(msg, (response) => {
    if (!response?.started) {
      logResult(false, "Failed to start dump — service worker did not respond.");
      setDisabled(false);
    }
  });
}

function setDisabled(disabled) {
  btnDump.disabled     = disabled;
  btnActivity.disabled = disabled;
}

btnDump.addEventListener("click",     () => startDump(false));
btnActivity.addEventListener("click", () => startDump(true));

// ─── Progress messages from service worker ────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "DUMP_PROGRESS") {
    logLine(message.text);
  } else if (message.type === "DUMP_RESULT") {
    logResult(message.success, message.text);
    setDisabled(false);
  }
});

// ─── Initialise ───────────────────────────────────────────────────────────────

loadConfig().catch((err) => {
  console.warn("LT Sync: could not load config:", err.message);
});
