// =========================
// DOM ELEMENTS
// =========================
const mapContainer = document.getElementById("mapContainer");
const playPauseBtn = document.getElementById("playPauseBtn");
const timeLabel = document.getElementById("timeLabel");
const speedSelect = document.getElementById("speedSelect");
const modeSelect = document.getElementById("modeSelect");

const faultList = document.getElementById("faultList");
const historyList = document.getElementById("historyList");

// Search elements, tries common ids first, then falls back to reasonable guesses
const searchInput =
  document.getElementById("palletSearchInput") ||
  document.getElementById("searchInput") ||
  document.getElementById("historySearchInput") ||
  document.querySelector('input[id*="search" i]') ||
  document.querySelector('#sidePanel input[type="text"]') ||
  document.querySelector('input[type="text"]');

const searchBtn =
  document.getElementById("palletSearchBtn") ||
  document.getElementById("searchBtn") ||
  document.querySelector('button[id*="search" i]') ||
  document.querySelector('#sidePanel button') ||
  document.querySelector('button');

// =========================
// SIM STATE
// =========================
let running = false;
let speed = 1;
let mode = "live";

let events = [];
let currentIndex = 0;

let pallets = {};
let palletHistory = {};

// Average-mode state
let avgPalletId = null;
let avgStep = 0;
let avgOutboundIndex = 0;

// Random fault counter
let stepCounter = 0;

// Station IDs we recognise in the HTML
const stationIds = [
  "INBOUND01",
  "NOTIPOINT01", "NOTIPOINT02", "NOTIPOINT03", "NOTIPOINT04",
  "DEPOINT01", "DEPOINT02", "DEPOINT03",
  "OUTPOINT01", "OUTPOINT02", "OUTPOINT03"
];

// For "direction" check (log-based fault: backwards movement)
const stationOrder = [...stationIds];
const stationIndex = {};
stationOrder.forEach((id, idx) => { stationIndex[id] = idx; });

// Average-mode route (before outbound)
const avgRoute = [
  "INBOUND01",
  "NOTIPOINT01",
  "NOTIPOINT02",
  "NOTIPOINT03",
  "NOTIPOINT04",
  "DEPOINT01"
];
const avgOutboundStations = ["OUTPOINT01", "OUTPOINT02", "OUTPOINT03"];

function getNextAvgOutbound() {
  const s = avgOutboundStations[avgOutboundIndex];
  avgOutboundIndex = (avgOutboundIndex + 1) % avgOutboundStations.length;
  return s;
}

// =========================
// UI EVENTS
// =========================
if (playPauseBtn) {
  playPauseBtn.addEventListener("click", () => {
    running = !running;
    playPauseBtn.textContent = running ? "Pause" : "Play";
  });
}

if (speedSelect) {
  speedSelect.addEventListener("change", () => {
    speed = Number(speedSelect.value);
  });
}

if (modeSelect) {
  modeSelect.addEventListener("change", () => {
    const raw = (modeSelect.value || "").toLowerCase();
    if (raw.includes("live")) mode = "live";
    else if (raw.includes("avg") || raw.includes("average")) mode = "average";
    else mode = raw || "live";

    resetSimulation();

    if (mode === "live") {
      loadLogs();
    }
  });
}

// =========================
// UTIL
// =========================
function formatTime(idx) {
  const s = idx;
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

// =========================
// SEARCH
// =========================
function normalisePalletId(raw) {
  const v = (raw || "").trim();
  if (!v) return "";
  if (v.startsWith("P") || v.startsWith("AVG_")) return v;
  return "P" + v;
}

function renderPalletHistory(rawId) {
  if (!historyList) return;

  historyList.innerHTML = "";

  const palletId = normalisePalletId(rawId);
  if (!palletId) return;

  const hist = palletHistory[palletId];
  if (!hist || hist.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No history for " + palletId;
    historyList.appendChild(li);
    return;
  }

  const start = Math.max(0, hist.length - 80);
  for (let i = start; i < hist.length; i++) {
    const row = hist[i];
    const li = document.createElement("li");
    li.textContent = `${formatTime(row.timeIndex)} | ${palletId} | ${row.station}`;
    historyList.appendChild(li);
  }
}

if (searchBtn && searchInput) {
  searchBtn.addEventListener("click", () => {
    renderPalletHistory(searchInput.value);
  });

  searchInput.addEventListener("keydown", e => {
    if (e.key === "Enter") renderPalletHistory(searchInput.value);
  });
}

// =========================
// PALLET HELPERS
// =========================
function createPallet(id, stationId) {
  if (pallets[id]) return;

  const el = document.createElement("div");
  el.className = "pallet";
  el.textContent = id;
  mapContainer.appendChild(el);

  pallets[id] = {
    el,
    lastStation: null,
    faultActive: false
  };

  palletHistory[id] = [];
  movePallet(id, stationId);
}

function movePallet(id, stationId) {
  const pallet = pallets[id];
  if (!pallet) return;

  if (pallet.faultActive) return;

  const station = document.getElementById(stationId);
  if (!station) return;

  const rect = station.getBoundingClientRect();
  const base = mapContainer.getBoundingClientRect();

  let x = rect.left - base.left + 40;
  let y = rect.top - base.top + 55;

  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > mapContainer.clientWidth - 50) x = mapContainer.clientWidth - 50;
  if (y > mapContainer.clientHeight - 50) y = mapContainer.clientHeight - 50;

  pallet.el.style.left = x + "px";
  pallet.el.style.top = y + "px";

  const prevStation = pallet.lastStation;
  pallet.lastStation = stationId;

  palletHistory[id].push({
    timeIndex: currentIndex,
    station: stationId
  });

  if (prevStation && stationIndex[prevStation] != null && stationIndex[stationId] != null) {
    if (stationIndex[stationId] < stationIndex[prevStation]) {
      triggerFault(id, stationId, "Backward movement in log");
    }
  }
}

function removePallet(id) {
  if (!pallets[id]) return;
  pallets[id].el.remove();
  delete pallets[id];
}

// =========================
// STATION FLASH (TEMPORARY)
// =========================
function flashStationOnce(stationId, durationMs) {
  const el = document.getElementById(stationId);
  if (!el) return;

  el.classList.add("station-fault");

  const ms = Number(durationMs) > 0 ? Number(durationMs) : 1500;
  setTimeout(() => {
    el.classList.remove("station-fault");
  }, ms);
}

// =========================
// FAULT HANDLING
// =========================
function triggerFault(palletId, stationId, reason) {
  const pallet = pallets[palletId];
  if (!pallet) return;

  pallet.el.classList.add("fault");
  flashStationOnce(stationId, 1500);

  pallet.faultActive = true;

  pallet.lastStation = "INBOUND01";
  movePalletToInbound(palletId);

  if (faultList) {
    const li = document.createElement("li");
    li.textContent = `${formatTime(currentIndex)} | ${palletId} | ${stationId} | ${reason}`;
    faultList.prepend(li);
  }

  setTimeout(() => {
    if (!pallets[palletId]) return;
    pallets[palletId].faultActive = false;
    pallets[palletId].el.classList.remove("fault");
  }, 1500);
}

function movePalletToInbound(palletId) {
  const p = pallets[palletId];
  if (!p) return;

  const inbound = document.getElementById("INBOUND01");
  if (!inbound) return;

  const sRect = inbound.getBoundingClientRect();
  const bRect = mapContainer.getBoundingClientRect();

  let x = sRect.left - bRect.left + 40;
  let y = sRect.top - bRect.top + 55;

  p.el.style.left = x + "px";
  p.el.style.top = y + "px";
}


// RANDOM FAULT

function triggerRandomFault() {
  const ids = Object.keys(pallets);
  if (ids.length === 0) return;

  const randomId = ids[Math.floor(Math.random() * ids.length)];
  const p = pallets[randomId];

  const stationId = p.lastStation || "UNKNOWN";
  triggerFault(randomId, stationId, "System Jam");
}

// =========================
// LOG PARSING
// =========================
function parseLogs(text) {
  const lines = text.split("\n").filter(l => l.includes("##"));
  const parsed = [];

  for (const line of lines) {
    const parts = line.split(/\.{2,}/);
    if (parts.length < 5) continue;

    const eventType = parts[1].replace(/[^A-Z]/g, "").trim();
    const src = (parts[2] || "").trim();
    const dest = (parts[3] || "").trim();

    const idRaw = (parts[parts.length - 2] || "").replace(/\D/g, "");
    if (!idRaw) continue;
    const palletId = "P" + idRaw;

    // 1) SPAWN
    if (eventType === "SETDEST" && src === "INBOUND01") {
      parsed.push({ type: "SPAWN", palletId, station: "INBOUND01" });
      continue;
    }

    // 2) ARRIVAL
    if (eventType === "ARRIVAL") {
      const srcStation = stationIds.includes(src) ? src : null;
      const destStation = stationIds.includes(dest) ? dest : null;

      if (srcStation) parsed.push({ type: "MOVE", palletId, station: srcStation });
      if (destStation) parsed.push({ type: "MOVE", palletId, station: destStation });
      continue;
    }

    // 3) SETDEST
    if (eventType === "SETDEST") {
      const srcIsStation = stationIds.includes(src);
      const destIsStation = stationIds.includes(dest);

      if (srcIsStation && destIsStation && src !== "INBOUND01") {
        const srcIsDE = src.startsWith("DEPOINT");
        const destIsOUT = dest.startsWith("OUTPOINT");

        // Inject DEPOINT02 and DEPOINT03 visuals when logs jump from DEPOINT01 straight to OUTPOINT
        if (srcIsDE && destIsOUT) {
          parsed.push({ type: "MOVE", palletId, station: src });

          if (src === "DEPOINT01") {
            parsed.push({ type: "MOVE", palletId, station: "DEPOINT02" });
            parsed.push({ type: "MOVE", palletId, station: "DEPOINT03" });
          } else if (src === "DEPOINT02") {
            parsed.push({ type: "MOVE", palletId, station: "DEPOINT03" });
          }

          parsed.push({ type: "MOVE", palletId, station: dest });
          continue;
        }

        // Default movement
        parsed.push({ type: "MOVE", palletId, station: src });
        parsed.push({ type: "MOVE", palletId, station: dest });
      }
      continue;
    }

    // 4) LOCEXIT remove
    if (eventType === "LOCEXIT") {
      const srcStation = stationIds.includes(src) ? src : null;
      if (srcStation) parsed.push({ type: "MOVE", palletId, station: srcStation });
      parsed.push({ type: "REMOVE", palletId });
      continue;
    }
  }

  return parsed;
}

// =========================
// LOAD LOGS FROM BACKEND
// =========================
async function loadLogs() {
  try {
    const res = await fetch("http://localhost:8000/logs");
    const text = await res.text();
    events = parseLogs(text);
    currentIndex = 0;
  } catch (err) {
    console.error("Error loading logs:", err);
  }
}

// =========================
// AVERAGE MODE (SIMULATION)
// =========================
function averageStep() {
  if (!avgPalletId) {
    avgPalletId = "AVG_" + String(currentIndex).padStart(5, "0");
    avgStep = 0;
    createPallet(avgPalletId, avgRoute[0]);
    return;
  }

  avgStep++;

  if (avgStep < avgRoute.length) {
    movePallet(avgPalletId, avgRoute[avgStep]);
  } else if (avgStep === avgRoute.length) {
    const out = getNextAvgOutbound();
    movePallet(avgPalletId, out);
  } else if (avgStep > avgRoute.length + 1) {
    removePallet(avgPalletId);
    avgPalletId = null;
    avgStep = 0;
  }
}

// =========================
// SIM RESET
// =========================
function resetSimulation() {
  Object.keys(pallets).forEach(id => removePallet(id));
  pallets = {};
  palletHistory = {};
  events = [];
  currentIndex = 0;
  avgPalletId = null;
  avgStep = 0;
  stepCounter = 0;

  if (faultList) faultList.innerHTML = "";
  if (historyList) historyList.innerHTML = "";
  if (timeLabel) timeLabel.textContent = "Time: 00:00:00";
}

// =========================
// MAIN TICK LOOP
// =========================
const TICK_MS = 900;

setInterval(() => {
  if (!running) return;

  for (let i = 0; i < speed; i++) {
    if (mode === "live") {
      if (!events || events.length === 0) break;
      if (currentIndex >= events.length) break;

      const evt = events[currentIndex];

      if (evt.type === "SPAWN") {
        createPallet(evt.palletId, evt.station);
      }

      if (evt.type === "MOVE") {
        if (!pallets[evt.palletId]) {
          createPallet(evt.palletId, evt.station);
        } else {
          movePallet(evt.palletId, evt.station);
        }
      }

      if (evt.type === "REMOVE") {
        removePallet(evt.palletId);
      }

      currentIndex++;
      stepCounter++;
    } else if (mode === "average") {
      averageStep();
      currentIndex++;
      stepCounter++;
    }

    if (stepCounter > 0 && stepCounter % 40 === 0) {
      triggerRandomFault();
    }
  }

  if (timeLabel) {
    timeLabel.textContent = "Time: " + formatTime(currentIndex);
  }

}, TICK_MS);


mode = "live";
loadLogs();
