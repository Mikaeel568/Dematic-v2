// =========================
// DOM ELEMENTS
// =========================
const mapContainer = document.getElementById("mapContainer");
const playPauseBtn = document.getElementById("playPauseBtn");
const timeLabel = document.getElementById("timeLabel");
const speedSelect = document.getElementById("speedSelect");
const modeSelect = document.getElementById("modeSelect");

const faultList = document.getElementById("faultList"); // optional, if exists

// =========================
// SIM STATE
// =========================
let running = false;
let speed = 1;
let mode = "live";            // "live" (log) or "average"

let events = [];              // parsed log events (live mode)
let currentIndex = 0;         // logical time index

let pallets = {};             // palletId -> { el, lastStation }
let palletHistory = {};       // palletId -> [{timeIndex, station}]

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
  // treat each event index as ~1 second
  const s = idx;
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
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
    lastStation: null
  };

  palletHistory[id] = [];
  movePallet(id, stationId);
}

function movePallet(id, stationId) {
  const pallet = pallets[id];
  if (!pallet) return;

  const station = document.getElementById(stationId);
  if (!station) {
    console.warn("Station not found in DOM:", stationId);
    return;
  }

  const rect = station.getBoundingClientRect();
  const base = mapContainer.getBoundingClientRect();

  // Position pallet slightly BELOW the station label so it doesn't cover text
  let x = rect.left - base.left + 40;
  let y = rect.top - base.top + 55;

  // Safety clamps to keep inside map
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > mapContainer.clientWidth - 50) x = mapContainer.clientWidth - 50;
  if (y > mapContainer.clientHeight - 50) y = mapContainer.clientHeight - 50;

  pallet.el.style.left = x + "px";
  pallet.el.style.top = y + "px";

  // record last station
  const prevStation = pallet.lastStation;
  pallet.lastStation = stationId;

  // record history
  palletHistory[id].push({
    timeIndex: currentIndex,
    station: stationId
  });

  // log-based fault check (backwards movement)
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
// FAULT HANDLING
// =========================
function triggerFault(palletId, stationId, reason) {
  const pallet = pallets[palletId];
  if (!pallet) return;

  pallet.el.classList.add("fault"); // rely on .pallet.fault style in CSS if present

  if (faultList) {
    const li = document.createElement("li");
    li.textContent = `${formatTime(currentIndex)} | ${palletId} | ${stationId} | ${reason}`;
    faultList.prepend(li);
  }

  // Auto-clear visual fault after 5 seconds
  setTimeout(() => {
    if (pallets[palletId]) {
      pallets[palletId].el.classList.remove("fault");
    }
  }, 5000);
}

function triggerRandomFault() {
  const ids = Object.keys(pallets);
  if (ids.length === 0) return;

  const randomId = ids[Math.floor(Math.random() * ids.length)];
  const p = pallets[randomId];

  const stationId = p.lastStation || "UNKNOWN";
  triggerFault(randomId, stationId, "Random demo fault");
}

// =========================
// LOG PARSING (for LIVE mode)
// =========================
//
// Example lines:
//
// 08-12-25 08:25:37.725 ~WMS1PLC1...SETDEST..INBOUND01....NOTIPOINT01....10000000...##
// 08-12-25 08:25:42.818 ~PLC1WMS1...ARRIVAL..NOTIPOINT01..NOTIPOINT02....10000000...##
// 08-12-25 08:26:05.043 ~WMS1PLC1...SETDEST..DEPOINT02....OUTPOINT02.....10000000...##
// 08-12-25 08:26:12.224 ~PLC1WMS1...LOCEXIT..OUTPOINT02..................10000000...##
//
// Rules we’ll use:
//  - SPAWN:   SETDEST INBOUND01 → NOTIPOINT01  (show pallet at INBOUND01)
//  - MOVE:    ARRIVAL moves via src and dest (so we see NOTIPOINT01 & NOTIPOINT02)
//  - MOVE:    SETDEST from DEPOINT* → DEPOINT*/OUTPOINT* moves the pallet
//  - REMOVE:  LOCEXIT at OUTPOINT removes pallet
//
function parseLogs(text) {
  const lines = text.split("\n").filter(l => l.includes("##"));
  const parsed = [];

  for (const line of lines) {
    // split on ANY sequence of 2+ dots
    const parts = line.split(/\.{2,}/);
    if (parts.length < 5) continue;

    const eventType = parts[1].replace(/[^A-Z]/g, "").trim();
    const src = (parts[2] || "").trim();
    const dest = (parts[3] || "").trim();

    // pallet id is always the last meaningful numeric token
    const idRaw = (parts[parts.length - 2] || "").replace(/\D/g, "");
    if (!idRaw) continue;
    const palletId = "P" + idRaw;

    // ---------------------
    // 1) SPAWN: SETDEST from INBOUND01
    // ---------------------
    if (eventType === "SETDEST" && src === "INBOUND01") {
      // show pallet at INBOUND01 once
      parsed.push({ type: "SPAWN", palletId, station: "INBOUND01" });
      continue;
    }

    // ---------------------
    // 2) ARRIVAL: move through NOTIPOINTs and into DEPOINT01 / OUTPOINTs
    //    We move to both src and dest (if valid stations) so NOTIPOINT01
    //    is visible and we see the full path.
    // ---------------------
    if (eventType === "ARRIVAL") {
      const srcStation = stationIds.includes(src) ? src : null;
      const destStation = stationIds.includes(dest) ? dest : null;

      if (srcStation) {
        parsed.push({ type: "MOVE", palletId, station: srcStation });
      }
      if (destStation) {
        parsed.push({ type: "MOVE", palletId, station: destStation });
      }
      continue;
    }

    // ---------------------
    // 3) SETDEST from DEPOINT* -> DEPOINT* / OUTPOINT*:
    //    use this to move across DEPOINT02/03 and to the chosen OUTPOINT.
    // ---------------------
    if (eventType === "SETDEST") {
      const srcIsStation = stationIds.includes(src);
      const destIsStation = stationIds.includes(dest);

      // Only treat as movement if both are real stations and NOT inbound
      if (srcIsStation && destIsStation && src !== "INBOUND01") {
        parsed.push({ type: "MOVE", palletId, station: src });
        parsed.push({ type: "MOVE", palletId, station: dest });
      }
      continue;
    }

    // ---------------------
    // 4) LOCEXIT: final OUTPOINT + remove
    // ---------------------
    if (eventType === "LOCEXIT") {
      const srcStation = stationIds.includes(src) ? src : null;
      if (srcStation) {
        parsed.push({ type: "MOVE", palletId, station: srcStation });
      }
      parsed.push({ type: "REMOVE", palletId });
      continue;
    }

    // DESTREQ / others are ignored for visualisation
  }

  console.log("Parsed events:", parsed.length);
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
    console.log("Events loaded:", events.length);
  } catch (err) {
    console.error("Error loading logs:", err);
  }
}

// =========================
// AVERAGE MODE (SIMULATION)
// =========================
function averageStep() {
  if (!avgPalletId) {
    // spawn a new average pallet at INBOUND
    avgPalletId = "AVG_" + String(currentIndex).padStart(5, "0");
    avgStep = 0;
    createPallet(avgPalletId, avgRoute[0]);
    return;
  }

  avgStep++;

  if (avgStep < avgRoute.length) {
    // move along fixed route
    movePallet(avgPalletId, avgRoute[avgStep]);
  } else if (avgStep === avgRoute.length) {
    // now send to outbound in round-robin
    const out = getNextAvgOutbound();
    movePallet(avgPalletId, out);
  } else if (avgStep > avgRoute.length + 1) {
    // done: remove this pallet, next tick spawns a new one
    removePallet(avgPalletId);
    avgPalletId = null;
    avgStep = 0;
  }
}

// =========================
// SIM RESET
// =========================
function resetSimulation() {
  // remove all pallets
  Object.keys(pallets).forEach(id => removePallet(id));
  pallets = {};
  palletHistory = {};
  events = [];
  currentIndex = 0;
  avgPalletId = null;
  avgStep = 0;
  stepCounter = 0;

  if (faultList) faultList.innerHTML = "";
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

    // Random demo fault every 40 steps (both modes)
    if (stepCounter > 0 && stepCounter % 40 === 0) {
      triggerRandomFault();
    }
  }

  if (timeLabel) {
    timeLabel.textContent = "Time: " + formatTime(currentIndex);
  }

}, TICK_MS);

// =========================
// INITIALISE
// =========================
mode = "live";
loadLogs();
