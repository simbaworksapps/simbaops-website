const $ = (id) => document.getElementById(id);

const els = {
  dbStatus: $("dbStatus"),
  airportSearch: $("airportSearch"),
  airportResults: $("airportResults"),
  airportCard: $("airportCard"),
  runwaySelect: $("runwaySelect"),
  runwayDirection: $("runwayDirection"),
  settingsBtn: $("settingsBtn"),
  clockBtn: $("clockBtn"),
  manualIdent: $("manualIdent"),
  manualHeading: $("manualHeading"),
  applyManualBtn: $("applyManualBtn"),
  windInput: $("windInput"),
  xwindLimit: $("xwindLimit"),
  tailwindLimit: $("tailwindLimit"),
  compassSvg: $("compassSvg"),
  crosswindMetric: $("crosswindMetric"),
  headwindMetric: $("headwindMetric"),
  angleMetric: $("angleMetric"),
  rankingList: $("rankingList"),
  windBadge: $("windBadge"),
  selectedRunwayBadge: $("selectedRunwayBadge"),
  bestRunwayBadge: $("bestRunwayBadge"),
  clockCompare: $("clockCompare"),
  clockWindArrow: $("clockWindArrow"),
  installBtn: $("installBtn"),
  installMessage: $("installMessage"),
  messageCenterPanel: $("messageCenterPanel"),
  settingsModal: $("settingsModal"),
  manualModal: $("manualModal"),
  clockModal: $("clockModal"),
  installModal: $("installModal"),
  updateMessage: $("updateMessage"),
  updateBtn: $("updateBtn"),
  suggestionText: $("suggestionText"),
  sendSuggestionBtn: $("sendSuggestionBtn"),
  swState: $("swState")
};

const SETTINGS_KEY = "simba-xwind-settings-v1";
const FAA_CYCLE_NAME = "FAA NASR";
const FAA_CYCLE_DATE_LABEL = "11JUN26";
const FAA_CYCLE_CURRENT = true;
function applyAirportOverrides(baseAirports, overrides) {
  const byIdent = new Map(baseAirports.map((airport) => [airport.ident, { ...airport }]));
  Object.entries(overrides || {}).forEach(([ident, override]) => {
    const key = String(ident || "").toUpperCase();
    const current = byIdent.get(key) || { ident: key };
    byIdent.set(key, {
      ...current,
      ...override,
      ident: current.ident || key,
      runways: Array.isArray(override.runways) ? override.runways : current.runways
    });
  });
  return [...byIdent.values()];
}

const baseAirports = Array.isArray(window.XWIND_AIRPORTS) ? window.XWIND_AIRPORTS : [];
const airportOverrides = window.XWIND_AIRPORT_OVERRIDES || {};
const airports = applyAirportOverrides(baseAirports, airportOverrides);
let selectedAirport = null;
let selectedRunway = null;
let deferredInstallPrompt = null;
let waitingWorker = null;

const defaultSettings = {
  xwindLimit: 25,
  tailwindLimit: 10,
  airport: "KMCF",
  wind: ""
};

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings() {
  const settings = {
    xwindLimit: Number(els.xwindLimit.value || defaultSettings.xwindLimit),
    tailwindLimit: Number(els.tailwindLimit.value || defaultSettings.tailwindLimit),
    airport: selectedAirport?.ident || "",
    wind: els.windInput.value
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function norm360(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const wrapped = ((n % 360) + 360) % 360;
  return wrapped === 0 ? 360 : wrapped;
}

function signedDiff(from, to) {
  return ((((from - to) % 360) + 540) % 360) - 180;
}

function renderClockTicks() {
  const ticks = document.getElementById("clockTicks");
  if (!ticks || ticks.childElementCount) return;

  for (let i = 0; i < 60; i += 1) {
    const major = i % 5 === 0;
    const tick = document.createElementNS("http://www.w3.org/2000/svg", "line");
    tick.setAttribute("x1", "160");
    tick.setAttribute("x2", "160");
    tick.setAttribute("y1", major ? "67" : "72");
    tick.setAttribute("y2", "80");
    tick.setAttribute("transform", `rotate(${i * 6} 160 160)`);
    tick.setAttribute("class", major ? "clock-tick major" : "clock-tick");
    ticks.appendChild(tick);
  }
}

function parseWind(raw) {
  const value = String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!value) return null;
  const metarWind = String(raw || "").trim().toUpperCase().match(/\b(VRB|\d{3})(\d{2})(?:G(\d{2}))?KT\b/);
  if (metarWind) {
    const dirText = metarWind[1];
    const speed = Number(metarWind[2]);
    const gust = metarWind[3] ? Number(metarWind[3]) : null;
    if (dirText === "VRB") return { variable: true, dir: null, speed, gust, raw: metarWind[0] };
    return { variable: false, dir: norm360(Number(dirText)), speed, gust, raw: metarWind[0] };
  }
  const clean = value.replace("KTS", "").replace("KT", "").replace("/", "");
  const vrb = /^VRB(\d{1,2})(?:G(\d{1,2}))?$/.exec(clean);
  if (vrb) {
    return { variable: true, dir: null, speed: Number(vrb[1]), gust: vrb[2] ? Number(vrb[2]) : null, raw: value };
  }
  const match = /^(\d{3})(\d{1,2})(?:G(\d{1,2}))?$/.exec(clean);
  if (!match) return null;
  const dir = norm360(Number(match[1]));
  const speed = Number(match[2]);
  const gust = match[3] ? Number(match[3]) : null;
  if (!dir || speed < 0 || speed > 99 || (gust !== null && gust < speed)) return null;
  return { variable: false, dir, speed, gust, raw: value };
}

function runwayEndpoints(airport) {
  if (!airport) return [];
  return airport.runways.flatMap((r) => [
    {
      airportRunway: r,
      ident: r.le,
      opposite: r.he,
      heading: r.leHdg,
      length: r.length,
      width: r.width,
      surface: r.surface,
      lighted: r.lighted
    },
    {
      airportRunway: r,
      ident: r.he,
      opposite: r.le,
      heading: r.heHdg,
      length: r.length,
      width: r.width,
      surface: r.surface,
      lighted: r.lighted
    }
  ]);
}

function manualRunway() {
  const heading = norm360(els.manualHeading.value);
  if (!heading) return null;
  const fallbackIdent = String(Math.round(heading / 10)).padStart(2, "0").replace("00", "36");
  const ident = String(els.manualIdent.value || fallbackIdent).replace(/^RWY\s*/i, "").toUpperCase();
  const reciprocal = norm360(heading + 180);
  const oppositeDigits = String(Math.round(reciprocal / 10)).padStart(2, "0").replace("00", "36");
  return { ident, opposite: oppositeDigits, heading, manual: true };
}

function activeRunways() {
  const airportEnds = runwayEndpoints(selectedAirport);
  const manual = manualRunway();
  return manual ? [...airportEnds, manual] : airportEnds;
}

function searchAirports(query) {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const starts = [];
  const contains = [];
  for (const a of airports) {
    const hay = `${a.ident} ${a.icao || ""} ${a.iata || ""} ${a.gps || ""} ${a.local || ""} ${a.name} ${a.municipality || ""} ${a.country || ""}`.toUpperCase();
    if (!hay.includes(q)) continue;
    const codeHit = [a.ident, a.icao, a.iata, a.gps, a.local].filter(Boolean).some((c) => c.startsWith(q));
    (codeHit ? starts : contains).push(a);
    if (starts.length + contains.length >= 32) break;
  }
  return [...starts, ...contains].slice(0, 12);
}

function airportLabel(a) {
  if (!a) return "";
  const bits = [a.municipality, a.region || a.country].filter(Boolean).join(", ");
  return bits || a.country || "";
}

function runwayPairSummary(a) {
  if (!a?.runways?.length) return "No runway data";
  return `RWY ${a.runways.map((r) => r.id || `${r.le}/${r.he}`).join(" | ")}`;
}

function formatSourceLabel(source) {
  return String(source || "").replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, year, month, day) => {
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    return `${day}${months[Number(month) - 1] || month}${String(year).slice(-2)}`;
  });
}

function isFallbackAirport(airport) {
  return String(airport?.source || "").toLowerCase().includes("ourairports");
}

function selectAirport(airport) {
  selectedAirport = airport;
  selectedRunway = runwayEndpoints(airport)[0] || null;
  els.airportSearch.value = airport ? airport.ident : "";
  els.airportResults.classList.remove("open");
  renderAirport();
  renderRunwayButtons();
  calculateAndRender();
  saveSettings();
}

function renderSearch() {
  const hits = searchAirports(els.airportSearch.value);
  els.airportResults.innerHTML = "";
  if (!hits.length) {
    els.airportResults.classList.remove("open");
    return;
  }
  for (const a of hits) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "result-item";
    item.innerHTML = `<span class="result-ident">${a.ident}</span><span class="result-copy"><span class="result-name">${a.name}</span><span class="result-meta">${airportLabel(a)} | ${runwayPairSummary(a)}</span></span>`;
    item.addEventListener("click", () => selectAirport(a));
    els.airportResults.appendChild(item);
  }
  els.airportResults.classList.add("open");
}

function renderAirport() {
  const name = selectedAirport ? `${selectedAirport.ident} ${selectedAirport.name}` : "No airport selected";
  const source = selectedAirport?.source ? ` | ${formatSourceLabel(selectedAirport.source)}` : "";
  const meta = selectedAirport ? `${airportLabel(selectedAirport)} | ${runwayPairSummary(selectedAirport)}${source}` : "Use airport search or MAN runway mode";
  const fallback = isFallbackAirport(selectedAirport)
    ? `<div class="fallback-note">Fallback data: verify runway heading with current charts.</div>`
    : "";
  els.airportCard.innerHTML = `<div class="airport-name">${name}</div><div class="airport-meta">${meta}</div>${fallback}`;
}

function runwayDirectionText(runway) {
  if (!runway) return "Select a runway";
  const heading = Math.round(runway.heading).toString().padStart(3, "0");
  return `${runway.manual ? "MAN" : "RWY"} ${runway.ident} | ${heading}°`;
}

function runwayClockText(runway) {
  if (!runway) return "--";
  const heading = Math.round(runway.heading).toString().padStart(3, "0");
  return `${runway.ident} | ${heading}°`;
}

function sameRunway(a, b) {
  return a && b && a.ident === b.ident && Math.round(a.heading * 10) === Math.round(b.heading * 10);
}

function renderRunwayButtons() {
  const runways = runwayEndpoints(selectedAirport);
  els.runwaySelect.innerHTML = "";
  if (!selectedRunway && runways.length) selectedRunway = runways[0];
  els.runwayDirection.textContent = runwayDirectionText(selectedRunway);
  runways.forEach((r, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${r.ident} | ${Math.round(r.heading).toString().padStart(3, "0")}°`;
    option.selected = sameRunway(r, selectedRunway);
    els.runwaySelect.appendChild(option);
  });
  const manualOption = document.createElement("option");
  manualOption.value = "MAN";
  manualOption.textContent = "MAN | Manual";
  manualOption.selected = Boolean(selectedRunway?.manual);
  els.runwaySelect.appendChild(manualOption);
}
function calcComponents(runway, wind, speed) {
  if (!runway || !wind || wind.variable) return null;
  const rel = signedDiff(wind.dir, runway.heading);
  const angle = Math.abs(rel);
  const radians = angle * Math.PI / 180;
  const cross = Math.abs(speed * Math.sin(radians));
  const along = speed * Math.cos(radians);
  const side = rel > 0 ? "from right" : rel < 0 ? "from left" : "none";
  return {
    runway,
    wind,
    speed,
    angle,
    cross,
    along,
    side,
    signedHeadwind: along,
    headwind: along >= 0 ? along : 0,
    tailwind: along < 0 ? Math.abs(along) : 0
  };
}

function clockEstimate(angle, speed) {
  const refs = [
    { angle: 0, text: "0", value: 0 },
    { angle: 15, text: "1/4", value: speed * .25 },
    { angle: 30, text: "1/2", value: speed * .5 },
    { angle: 45, text: "3/4", value: speed * .75 },
    { angle: 60, text: "full xwind", value: speed }
  ];
  return refs.reduce((best, item) => (
    Math.abs(angle - item.angle) < Math.abs(angle - best.angle) ? item : best
  ), refs[0]);
}

function rawClockMethodAngle(result) {
  if (!result) return null;
  return result.signedHeadwind < 0 ? 180 - result.angle : result.angle;
}

function clockMethodAngle(result) {
  const axisAngle = rawClockMethodAngle(result);
  if (axisAngle === null) return null;
  return Math.min(60, Math.max(0, axisAngle));
}

function formatClockMethodAngle(result) {
  const axisAngle = rawClockMethodAngle(result);
  if (axisAngle === null) return "--";
  return axisAngle >= 60 ? `â‰¥60\u00B0` : `${Math.round(Math.max(0, axisAngle))}\u00B0`;
}

function classify(result) {
  const xLimit = Number(els.xwindLimit.value || 0);
  const tLimit = Number(els.tailwindLimit.value || 0);
  if (!result) return "good";
  if (result.cross > xLimit || result.tailwind > tLimit) return "bad";
  if (result.cross > xLimit * .8 || (tLimit && result.tailwind > tLimit * .8)) return "warn";
  return "good";
}

function setMetric(el, label, value, note, state) {
  el.className = state || "";
  el.querySelector("span").textContent = label;
  el.querySelector("strong").textContent = value;
  el.querySelector("small").textContent = note;
}

function limitState(value, limit) {
  const n = Number(value || 0);
  const max = Number(limit || 0);
  if (!max) return "";
  if (n > max) return "bad";
  if (n > max * .8) return "warn";
  return "";
}

function tailwindState(tailwind) {
  if (Number(tailwind || 0) <= 0) return "";
  return limitState(tailwind, els.tailwindLimit.value) || "warn";
}

function tailwindValueClass(signedHeadwind) {
  const tailwind = Math.max(0, -Number(signedHeadwind || 0));
  return tailwindState(tailwind);
}

function formatKt(n) {
  return `${Math.round(n)} kt`;
}

function formatAirportCount(count) {
  if (count >= 1000) return `${Math.round(count / 1000)}K`;
  return String(count);
}

function renderDatabaseStatus() {
  const statusClass = FAA_CYCLE_CURRENT ? "current" : "stale";
  els.dbStatus.innerHTML = `${formatAirportCount(airports.length)} airports | ${FAA_CYCLE_NAME} <span class="cycle-date ${statusClass}">${FAA_CYCLE_DATE_LABEL}</span>`;
}

function describeWind(wind) {
  if (!wind) return "Invalid wind";
  if (wind.variable) return `VRB ${wind.speed}${wind.gust ? `G${wind.gust}` : ""}`;
  return `${String(wind.dir).padStart(3, "0")} at ${wind.speed}${wind.gust ? `G${wind.gust}` : ""}`;
}

function formatWindBadge(wind) {
  if (!wind) return "Wind --";
  if (wind.variable) return `Wind VRB/${String(wind.speed).padStart(2, "0")}${wind.gust ? `G${wind.gust}` : ""}`;
  return `Wind ${String(wind.dir).padStart(3, "0")}/${String(wind.speed).padStart(2, "0")}${wind.gust ? `G${wind.gust}` : ""}`;
}

function updateSelectedRunwayBadge() {
  els.selectedRunwayBadge.textContent = selectedRunway ? `RWY ${selectedRunway.ident}` : "RWY --";
}

function updateClockCompare(items) {
  const cells = els.clockCompare?.querySelectorAll("b");
  if (!cells?.length) return;
  items.forEach((value, index) => {
    if (!cells[index]) return;
    const text = typeof value === "object" ? value.text : value;
    const state = typeof value === "object" ? value.state : "";
    cells[index].textContent = text;
    cells[index].className = state ? `value-${state}` : "";
  });
}

function updateClockWindArrow(result) {
  const arrow = els.clockWindArrow;
  if (!arrow || !result?.wind || result.wind.variable) {
    arrow?.setAttribute("hidden", "");
    return;
  }
  const capped = clockMethodAngle(result);
  const radians = capped * 6 * Math.PI / 180;
  const length = 84;
  const x2 = 160 + length * Math.sin(radians);
  const y2 = 160 - length * Math.cos(radians);
  arrow.setAttribute("x1", "160");
  arrow.setAttribute("y1", "160");
  arrow.setAttribute("x2", x2.toFixed(1));
  arrow.setAttribute("y2", y2.toFixed(1));
  arrow.removeAttribute("hidden");
}

function updateMetrics(result, gustResult, wind) {
  els.windBadge.textContent = formatWindBadge(wind);
  updateSelectedRunwayBadge();
  if (!selectedRunway) {
    updateClockWindArrow(null);
    updateClockCompare(["--", "--", "--", "--", "--", "--"]);
    setMetric(els.crosswindMetric, "XW", "--", "Select runway", "");
    setMetric(els.headwindMetric, "HW", "--", "--", "");
    setMetric(els.angleMetric, "Angle", "--", "Clock method", "");
    return;
  }
  if (!wind) {
    updateClockWindArrow(null);
    updateClockCompare(["--", runwayClockText(selectedRunway), "--", "--", "--", "--"]);
    setMetric(els.crosswindMetric, "XW", "--", "Enter wind", "");
    setMetric(els.headwindMetric, "HW", "--", "--", "");
    setMetric(els.angleMetric, "Angle", "--", "Clock method", "");
    return;
  }
  if (wind.variable) {
    updateClockWindArrow(null);
    updateClockCompare([formatWindBadge(wind).replace("Wind ", ""), runwayClockText(selectedRunway), `0-${formatKt(wind.gust || wind.speed)}`, "VRB", "VRB", "Full possible"]);
    setMetric(els.crosswindMetric, "XW", `0-${formatKt(wind.gust || wind.speed)}`, "Variable wind, worst case possible", "warn");
    setMetric(els.headwindMetric, "HW", "Variable", "Use runway ranking cautiously", "warn");
    setMetric(els.angleMetric, "Angle", "VRB", "Exact angle unavailable", "warn");
        return;
  }
  const checkResult = gustResult || result;
  const xState = limitState(checkResult.cross, els.xwindLimit.value);
  const gustText = gustResult ? `G${Math.round(gustResult.cross)}` : "";
  setMetric(els.crosswindMetric, "XW", `${Math.round(result.cross)}${gustText} kt`, `${result.side} | limit ${els.xwindLimit.value}`, xState);
  const isTail = result.tailwind > 0;
  const steadyAlong = Math.round(result.signedHeadwind);
  const gustAlong = gustResult ? Math.round(gustResult.signedHeadwind) : null;
  const along = `${steadyAlong}${gustAlong !== null ? `G${gustAlong}` : ""} kt`;
  const tailCheck = checkResult.tailwind;
  const hState = isTail ? tailwindState(tailCheck) : "";
  setMetric(els.headwindMetric, "HW", along, `Runway ${selectedRunway.ident} ${Math.round(selectedRunway.heading).toString().padStart(3, "0")}°`, hState);
  const clockAngle = clockMethodAngle(result);
  const estimate = clockEstimate(clockAngle, result.speed);
  const clockText = `${estimate.text.replace(/^about /, "")} (${formatKt(estimate.value)})`;
  updateClockWindArrow(result);
  updateClockCompare([
    formatWindBadge(wind).replace("Wind ", ""),
    runwayClockText(selectedRunway),
    `${Math.round(result.cross)}${gustText ? `/${gustText}` : ""} kt`,
    { text: along, state: tailwindValueClass(steadyAlong) },
    `${Math.round(clockAngle)}°`,
    clockText
  ]);
  const clockCells = els.clockCompare?.querySelectorAll("b");
  if (clockCells?.[4]) clockCells[4].textContent = formatClockMethodAngle(result);
  setMetric(els.angleMetric, "Angle", `${Math.round(result.angle)}°`, estimate.text, "");
  }

function scoreRunways(wind) {
  return activeRunways().map((r) => {
    const length = Number(r.length || 0);
    const width = Number(r.width || 0);
    if (!wind || wind.variable) return { runway: r, result: null, score: 9999, length, width };
    const speed = wind.gust || wind.speed;
    const result = calcComponents(r, wind, speed);
    const score = result.cross * 3 + result.tailwind * 8 - result.headwind * .2;
    return { runway: r, result, score, length, width };
  }).sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.length !== b.length) return b.length - a.length;
    return b.width - a.width;
  });
}

function statusLabel(status, isBest) {
  if (isBest) return "BEST";
  if (status === "bad") return "WARN";
  if (status === "warn") return "CAUT";
  return "GOOD";
}

function renderRanking(wind) {
  const ranked = scoreRunways(wind).slice(0, 8);
  const best = wind && !wind.variable ? ranked[0]?.runway || null : null;
  els.bestRunwayBadge.textContent = best ? `Best ${best.ident}` : "Best --";
  els.rankingList.innerHTML = "";
  if (!ranked.length) {
    els.rankingList.innerHTML = `<div class="airport-meta">Select an airport or enter a manual runway.</div>`;
    return;
  }
  ranked.forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    const r = item.runway;
    row.className = `rank-row${sameRunway(r, selectedRunway) ? " selected" : ""}`;
    const status = classify(item.result);
    const isBest = index === 0;
    const hdg = Math.round(r.heading).toString().padStart(3, "0");
    const dimensions = r.length ? `${r.length}${r.width ? ` x ${r.width}` : ""} ft` : "Length unknown";
    const detail = `${hdg}° | ${dimensions}${r.surface ? ` | ${r.surface}` : ""}`;
    const windLine = formatWindBadge(wind);
    const hwState = item.result ? tailwindValueClass(Math.round(item.result.signedHeadwind)) : "";
    const components = item.result
      ? `<span>XW ${Math.round(item.result.cross)} kt</span><span class="${hwState ? `value-${hwState}` : ""}">HW ${Math.round(item.result.signedHeadwind)} kt</span><span>${Math.round(item.result.angle)}°</span>`
      : `<span>XW --</span><span>HW --</span><span>--&deg;</span>`;
    row.innerHTML = `<span class="rank-left"><span class="rank-rwy">${r.ident}</span><span class="pill ${status}">${statusLabel(status, isBest)}</span></span><span><span class="rank-main">${detail}</span><span class="rank-wind">${windLine}</span><span class="rank-sub">${components}</span></span>`;
    row.addEventListener("click", () => {
      selectedRunway = r;
      renderRunwayButtons();
      calculateAndRender();
    });
    els.rankingList.appendChild(row);
  });
}

function selectBestRunway() {
  const wind = parseWind(els.windInput.value);
  if (!wind || wind.variable) return;
  const best = scoreRunways(wind)[0];
  if (!best) return;
  selectedRunway = best.runway;
  renderRunwayButtons();
  calculateAndRender();
}

function polar(cx, cy, radius, heading) {
  const rad = (heading - 90) * Math.PI / 180;
  return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
}

function lineSvg(x1, y1, x2, y2, attrs = {}) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  for (const [k, v] of Object.entries(attrs)) line.setAttribute(k, v);
  return line;
}

function textSvg(x, y, text, attrs = {}) {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t.setAttribute("x", x);
  t.setAttribute("y", y);
  t.textContent = text;
  for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v);
  return t;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function addCompassDefs(svg) {
  const defs = svgEl("defs");
  const windGradient = svgEl("linearGradient", {
    id: "windGradient",
    x1: "0%",
    y1: "0%",
    x2: "100%",
    y2: "100%"
  });
  windGradient.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#9bdcff" }));
  windGradient.appendChild(svgEl("stop", { offset: "55%", "stop-color": "#4fa8ff" }));
  windGradient.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#1f6fff" }));
  defs.appendChild(windGradient);

  const marker = svgEl("marker", {
    id: "windArrowHead",
    viewBox: "0 0 10 10",
    refX: "9",
    refY: "5",
    markerWidth: "4",
    markerHeight: "4",
    orient: "auto-start-reverse"
  });
  marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#4fa8ff" }));
  defs.appendChild(marker);

  svg.appendChild(defs);
}

function drawBestBox(group, y) {
  group.appendChild(svgEl("rect", {
    x: -17,
    y: y - 13,
    width: 32,
    height: 26,
    rx: 4,
    fill: "none",
    stroke: "#5ba7ff",
    "stroke-width": 4
  }));
}

function drawThresholdBars(group, y, width, color) {
  for (let i = -2; i <= 2; i += 1) {
    group.appendChild(lineSvg(i * 5, y, i * 5, y + 20, {
      stroke: color,
      "stroke-width": 3,
      "stroke-linecap": "square"
    }));
  }
}

function drawRunway(svg, cx, cy, opts) {
  const len = opts.active ? 315 : 292;
  const width = opts.active ? 34 : 24;
  const offset = Number(opts.offset || 0);
  const group = svgEl("g", { transform: `translate(${cx} ${cy}) rotate(${opts.heading}) translate(${offset} 0)` });
  const runwayFill = opts.active ? "#2f3842" : "#4d5a68";
  const edgeStroke = opts.active ? "#f4c542" : "#617189";
  const marking = opts.active ? "#eef2f7" : "#cbd5e1";

  group.appendChild(svgEl("rect", {
    x: -width / 2,
    y: -len / 2,
    width,
    height: len,
    rx: 6,
    fill: runwayFill,
    stroke: edgeStroke,
    "stroke-width": opts.active ? 3 : 1.5,
    opacity: opts.active ? 1 : .66
  }));

  group.appendChild(lineSvg(0, -len / 2 + 62, 0, len / 2 - 62, {
    stroke: marking,
    "stroke-width": 2,
    "stroke-dasharray": "12 10",
    "stroke-linecap": "round",
    opacity: opts.active ? .92 : .45
  }));

  drawThresholdBars(group, -len / 2 + 13, width, marking);
  drawThresholdBars(group, len / 2 - 33, width, marking);

  const heTextY = -len / 2 + 52;
  const leTextY = len / 2 - 52;
  if (opts.bestEnd === "le") drawBestBox(group, leTextY);
  if (opts.bestEnd === "he") drawBestBox(group, heTextY);

  const heActive = opts.activeEnd === opts.he;
  const leActive = opts.activeEnd === opts.le;
  group.appendChild(textSvg(0, heTextY, opts.he, {
    fill: heActive ? "#f4c542" : opts.active ? "#fff8d6" : "#e5e7eb",
    "font-size": opts.active ? "16" : "12",
    "font-weight": "900",
    "text-anchor": "middle",
    "dominant-baseline": "middle",
    transform: `rotate(180 0 ${heTextY})`
  }));
  const leText = textSvg(0, leTextY, opts.le, {
    fill: leActive ? "#f4c542" : opts.active ? "#fff8d6" : "#e5e7eb",
    "font-size": opts.active ? "16" : "12",
    "font-weight": "900",
    "text-anchor": "middle",
    "dominant-baseline": "middle"
  });
  group.appendChild(leText);

  svg.appendChild(group);
}

function runwayAxisKey(runway) {
  const axis = ((Number(runway.leHdg || 0) % 180) + 180) % 180;
  return String(Math.round(axis / 5) * 5);
}

function runwayParallelOffset(runway, group) {
  if (!group || group.length < 2) return 0;
  const ordered = [...group].sort((a, b) => {
    const suffixOrder = { L: 0, C: 1, R: 2 };
    const aSuffix = String(a.le || "").match(/[LCR]$/)?.[0] || "";
    const bSuffix = String(b.le || "").match(/[LCR]$/)?.[0] || "";
    const aRank = suffixOrder[aSuffix] ?? 9;
    const bRank = suffixOrder[bSuffix] ?? 9;
    if (aRank !== bRank) return aRank - bRank;
    return String(a.le || "").localeCompare(String(b.le || ""));
  });
  const index = ordered.indexOf(runway);
  const spacing = Math.max(30, Math.min(42, 118 / group.length));
  return (index - (group.length - 1) / 2) * spacing;
}

function selectedRunwayDrawSpec(parallelGroups = new Map()) {
  if (!selectedRunway) return null;
  const airportRunway = selectedRunway.airportRunway;
  if (!airportRunway) {
    return { heading: selectedRunway.heading, offset: 0, len: 315, width: 34 };
  }
  const group = parallelGroups.get(runwayAxisKey(airportRunway));
  return {
    heading: airportRunway.leHdg,
    offset: runwayParallelOffset(airportRunway, group),
    len: 315,
    width: 34
  };
}

function runwayContactPoint(cx, cy, windDir, spec) {
  if (!spec) return null;
  const windRad = (windDir - 90) * Math.PI / 180;
  const start = {
    x: cx + 191 * Math.cos(windRad),
    y: cy + 191 * Math.sin(windRad)
  };
  const dir = {
    x: -Math.cos(windRad),
    y: -Math.sin(windRad)
  };
  const runwayRad = spec.heading * Math.PI / 180;
  const cos = Math.cos(runwayRad);
  const sin = Math.sin(runwayRad);
  const toLocal = (point) => {
    const dx = point.x - cx;
    const dy = point.y - cy;
    return {
      x: dx * cos + dy * sin - spec.offset,
      y: -dx * sin + dy * cos
    };
  };
  const toWorld = (point) => ({
    x: cx + (point.x + spec.offset) * cos - point.y * sin,
    y: cy + (point.x + spec.offset) * sin + point.y * cos
  });
  const p = toLocal(start);
  const d = {
    x: dir.x * cos + dir.y * sin,
    y: -dir.x * sin + dir.y * cos
  };
  const halfW = spec.width / 2;
  const halfL = spec.len / 2;
  const hits = [];
  if (Math.abs(d.x) > 0.0001) {
    [-halfW, halfW].forEach((x) => {
      const t = (x - p.x) / d.x;
      const y = p.y + t * d.y;
      if (t > 0 && y >= -halfL && y <= halfL) hits.push({ t, point: { x, y } });
    });
  }
  if (Math.abs(d.y) > 0.0001) {
    [-halfL, halfL].forEach((y) => {
      const t = (y - p.y) / d.y;
      const x = p.x + t * d.x;
      if (t > 0 && x >= -halfW && x <= halfW) hits.push({ t, point: { x, y } });
    });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.t - b.t);
  return { start, end: toWorld(hits[0].point), local: hits[0].point };
}

function drawWindContactGuide(svg, cx, cy, wind, spec) {
  const contact = runwayContactPoint(cx, cy, wind.dir, spec);
  if (!contact) return;
  svg.appendChild(lineSvg(contact.end.x, contact.end.y, contact.start.x, contact.start.y, {
    stroke: "#5ba7ff",
    "stroke-width": 2,
    "stroke-dasharray": "7 6",
    "stroke-linecap": "round",
    opacity: .8
  }));
  return contact;
}

function drawAngleText(svg, point, label, dx = 0, dy = 0) {
  if (!point || !label) return;
  const lx = point.x + dx;
  const ly = point.y + dy;
  svg.appendChild(textSvg(lx + 1.4, ly + 1.4, label, {
    fill: "#030813",
    "font-size": "15",
    "font-weight": "950",
    "text-anchor": "middle",
    "dominant-baseline": "middle",
    opacity: "1"
  }));
  svg.appendChild(textSvg(lx, ly, label, {
    fill: "#5ba7ff",
    "font-size": "15",
    "font-weight": "950",
    "text-anchor": "middle",
    "dominant-baseline": "middle"
  }));
}

function drawWindArrowAngles(svg, cx, cy, windDir, radius, selectedLabel, selectedHeading, oppositeLabel, oppositeHeading) {
  const spread = 14;
  const selectedSide = signedDiff(selectedHeading, windDir) >= 0 ? 1 : -1;
  let oppositeSide = signedDiff(oppositeHeading, windDir) >= 0 ? 1 : -1;
  if (oppositeSide === selectedSide) oppositeSide = -selectedSide;
  const [selectedX, selectedY] = polar(cx, cy, radius, norm360(windDir + selectedSide * spread));
  const [oppositeX, oppositeY] = polar(cx, cy, radius, norm360(windDir + oppositeSide * spread));
  drawAngleText(svg, { x: selectedX, y: selectedY }, selectedLabel);
  drawAngleText(svg, { x: oppositeX, y: oppositeY }, oppositeLabel);
}

function drawAircraftMarker(svg, cx, cy, runway, spec = null) {
  if (!runway) return;
  let x;
  let y;
  if (spec) {
    const isLowEnd = !runway.airportRunway || sameRunway(runway, {
      ident: runway.airportRunway.le,
      heading: runway.airportRunway.leHdg
    });
    const runwayRad = spec.heading * Math.PI / 180;
    const cos = Math.cos(runwayRad);
    const sin = Math.sin(runwayRad);
    const localY = (isLowEnd ? 1 : -1) * (spec.len / 2 + 38);
    x = cx + spec.offset * cos - localY * sin;
    y = cy + spec.offset * sin + localY * cos;
  } else {
    [x, y] = polar(cx, cy, 194, norm360(runway.heading + 180));
  }
  const group = svgEl("g", {
    transform: `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${runway.heading})`,
    opacity: ".95"
  });
  group.appendChild(svgEl("path", {
    d: "M 0 -15 L 5 -2 L 17 3 L 17 7 L 4 5 L 4 12 L 9 15 L 9 18 L 0 15 L -9 18 L -9 15 L -4 12 L -4 5 L -17 7 L -17 3 L -5 -2 Z",
    fill: "#f4c542",
    stroke: "#070d17",
    "stroke-width": "2",
    "stroke-linejoin": "round"
  }));
  svg.appendChild(group);
}

function renderCompass(wind) {
  const svg = els.compassSvg;
  svg.innerHTML = "";
  const cx = 210;
  const cy = 210;
  const best = wind && !wind.variable ? scoreRunways(wind)[0]?.runway || null : null;
  const selectedEndIdent = selectedRunway?.ident || "";
  addCompassDefs(svg);
  const outer = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  outer.setAttribute("cx", cx);
  outer.setAttribute("cy", cy);
  outer.setAttribute("r", 188);
  outer.setAttribute("fill", "#070d17");
  outer.setAttribute("stroke", "#3c516e");
  outer.setAttribute("stroke-width", "3");
  svg.appendChild(outer);

  for (let h = 0; h < 360; h += 10) {
    const major = h % 30 === 0;
    const [x1, y1] = polar(cx, cy, major ? 170 : 178, h);
    const [x2, y2] = polar(cx, cy, 186, h);
    svg.appendChild(lineSvg(x1, y1, x2, y2, { stroke: major ? "#aeb8c8" : "#53657e", "stroke-width": major ? 2 : 1 }));
  }
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([label, h]) => {
    const [x, y] = polar(cx, cy, 154, h);
    svg.appendChild(textSvg(x, y + 6, label, { fill: label === "N" ? "#f4c542" : "#aeb8c8", "font-size": "22", "font-weight": "900", "text-anchor": "middle" }));
  });

  const runways = selectedAirport ? selectedAirport.runways : [];
  const parallelGroups = runways.reduce((groups, runway) => {
    const key = runwayAxisKey(runway);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(runway);
    return groups;
  }, new Map());
  const sortedRunways = [...runways].sort((a, b) => {
    const aActive = selectedRunway && (sameRunway(selectedRunway, { ident: a.le, heading: a.leHdg }) || sameRunway(selectedRunway, { ident: a.he, heading: a.heHdg }));
    const bActive = selectedRunway && (sameRunway(selectedRunway, { ident: b.le, heading: b.leHdg }) || sameRunway(selectedRunway, { ident: b.he, heading: b.heHdg }));
    return Number(aActive) - Number(bActive);
  });
  for (const r of sortedRunways) {
    const active = selectedRunway && (sameRunway(selectedRunway, { ident: r.le, heading: r.leHdg }) || sameRunway(selectedRunway, { ident: r.he, heading: r.heHdg }));
    const bestEnd = best && sameRunway(best, { ident: r.le, heading: r.leHdg }) ? "le"
      : best && sameRunway(best, { ident: r.he, heading: r.heHdg }) ? "he"
      : null;
    const group = parallelGroups.get(runwayAxisKey(r));
    drawRunway(svg, cx, cy, {
      le: r.le,
      he: r.he,
      heading: r.leHdg,
      active,
      bestEnd,
      activeEnd: active ? selectedEndIdent : "",
      offset: runwayParallelOffset(r, group)
    });
  }

  if (selectedRunway?.manual) {
    const reciprocal = norm360(selectedRunway.heading + 180);
    drawRunway(svg, cx, cy, {
      le: selectedRunway.ident,
      he: selectedRunway.opposite || String(Math.round(reciprocal / 10)).padStart(2, "0"),
      heading: selectedRunway.heading,
      active: true,
      bestEnd: null,
      activeEnd: selectedRunway.ident
    });
  }

  const selectedSpec = selectedRunwayDrawSpec(parallelGroups);
  drawAircraftMarker(svg, cx, cy, selectedRunway, selectedSpec);

  if (wind && !wind.variable) {
    const contact = drawWindContactGuide(svg, cx, cy, wind, selectedSpec);
    if (contact && selectedRunway) {
      const selectedAngle = Math.round(Math.abs(signedDiff(wind.dir, selectedRunway.heading)));
      const oppositeHeading = norm360(selectedRunway.heading + 180);
      const oppositeAngle = Math.round(Math.abs(signedDiff(wind.dir, oppositeHeading)));
      const midX = (contact.start.x + contact.end.x) / 2;
      const midY = (contact.start.y + contact.end.y) / 2;
      const labelRadius = Math.max(78, Math.min(168, Math.hypot(midX - cx, midY - cy)));
      drawWindArrowAngles(svg, cx, cy, wind.dir, labelRadius, `${selectedAngle}°`, selectedRunway.heading, `${oppositeAngle}°`, oppositeHeading);
    }
    const [sx, sy] = polar(cx, cy, 198, wind.dir);
    const [ex, ey] = polar(cx, cy, 191, wind.dir);
    svg.appendChild(lineSvg(sx, sy, ex, ey, {
      stroke: "url(#windGradient)",
      "stroke-width": 4,
      "stroke-linecap": "round",
      "marker-end": "url(#windArrowHead)"
    }));
  }

}

function calculateAndRender() {
  const wind = parseWind(els.windInput.value);
  const runway = selectedRunway || manualRunway();
  const result = wind && runway ? calcComponents(runway, wind, wind.speed) : null;
  const gustResult = wind?.gust && runway ? calcComponents(runway, wind, wind.gust) : null;
  updateMetrics(result, gustResult, wind);
  renderRanking(wind);
  renderCompass(wind);
  saveSettings();
}

function displayModeMatches(mode) {
  return Boolean(window.matchMedia?.(`(display-mode: ${mode})`)?.matches);
}

function isInstalledApp() {
  return window.navigator.standalone === true
    || displayModeMatches("standalone")
    || displayModeMatches("fullscreen")
    || displayModeMatches("minimal-ui")
    || document.referrer.startsWith("android-app://");
}

function sendSuggestion() {
  const body = String(els.suggestionText?.value || "").trim();
  const subject = encodeURIComponent("XWIND Calc suggestion");
  const encodedBody = encodeURIComponent(body || "Suggestion or concern:");
  window.location.href = `mailto:simbaworksapps@gmail.com?subject=${subject}&body=${encodedBody}`;
}

function refreshMessageCenter() {
  const showInstall = !isInstalledApp();
  const showUpdatePrompt = Boolean(waitingWorker);
  els.installMessage.hidden = !showInstall;
  els.updateMessage.hidden = !showUpdatePrompt;

  const count = Number(showInstall) + Number(showUpdatePrompt);
  if (count === 0) {
    els.messageCenterPanel.hidden = true;
    return;
  }

  els.messageCenterPanel.hidden = false;
}

async function clearAppCaches() {
  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    els.swState.textContent = "Browser only";
    refreshMessageCenter();
    return;
  }
  navigator.serviceWorker.register("service-worker.js").then((reg) => {
    els.swState.textContent = "Offline ready";
    if (reg.waiting) showUpdate(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
      });
    });
  }).catch(() => {
    els.swState.textContent = "Online only";
    refreshMessageCenter();
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload());
}

function showUpdate(worker) {
  waitingWorker = worker;
  els.swState.textContent = "Update ready";
  refreshMessageCenter();
}

function initInstall() {
  ["standalone", "fullscreen", "minimal-ui"].forEach((mode) => {
    const query = window.matchMedia?.(`(display-mode: ${mode})`);
    query?.addEventListener?.("change", refreshMessageCenter);
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    refreshMessageCenter();
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    refreshMessageCenter();
  });
  els.installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      openModal("installModal");
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    refreshMessageCenter();
  });
  refreshMessageCenter();
}

function openModal(id) {
  const modal = els[id];
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  const modal = els[id];
  if (modal) modal.hidden = true;
  if (!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("modal-open");
}

function selectSearchText() {
  requestAnimationFrame(() => els.airportSearch.select());
}

function chooseAirportFromSearch() {
  const query = els.airportSearch.value.trim();
  if (!query) return;
  const q = query.toUpperCase();
  const exact = airports.find((a) =>
    [a.ident, a.icao, a.iata, a.gps, a.local].filter(Boolean).some((code) => code.toUpperCase() === q)
  );
  const candidate = exact || searchAirports(query)[0];
  if (candidate) selectAirport(candidate);
  else renderSearch();
}

function applyManualRunway() {
  const manual = manualRunway();
  if (!manual) {
    if (!els.manualIdent.value.trim()) els.manualIdent.focus();
    else els.manualHeading.focus();
    return;
  }
  selectedAirport = null;
  selectedRunway = manual;
  els.airportSearch.value = "MANUAL";
  closeModal("manualModal");
  renderAirport();
  renderRunwayButtons();
  calculateAndRender();
}

function sequenceOnEnter(items) {
  items.forEach((item, index) => {
    item.el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const next = items[index + 1];
      if (next) {
        next.el.focus();
        if (typeof next.el.select === "function") next.el.select();
        return;
      }
      item.done();
    });
  });
}

function boot() {
  renderDatabaseStatus();
  const settings = loadSettings();
  renderClockTicks();
  els.xwindLimit.value = settings.xwindLimit;
  els.tailwindLimit.value = settings.tailwindLimit;
  els.windInput.value = settings.wind || "";

  const startAirport = airports.find((a) => a.ident === settings.airport) || airports.find((a) => a.ident === "KMCF");
  if (startAirport) selectAirport(startAirport);
  renderAirport();
  renderRunwayButtons();
  calculateAndRender();

  els.airportSearch.addEventListener("input", renderSearch);
  els.airportSearch.addEventListener("focus", selectSearchText);
  els.airportSearch.addEventListener("click", selectSearchText);
  els.windInput.addEventListener("focus", () => requestAnimationFrame(() => els.windInput.select()));
  els.windInput.addEventListener("click", () => requestAnimationFrame(() => els.windInput.select()));
  els.airportSearch.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    chooseAirportFromSearch();
    els.airportSearch.blur();
  });
  els.windInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    calculateAndRender();
    els.windInput.blur();
  });
  els.runwaySelect.addEventListener("change", () => {
    if (els.runwaySelect.value === "MAN") {
      openModal("manualModal");
      renderRunwayButtons();
      return;
    }
    const runways = runwayEndpoints(selectedAirport);
    selectedRunway = runways[Number(els.runwaySelect.value)];
    els.runwayDirection.textContent = runwayDirectionText(selectedRunway);
    calculateAndRender();
  });
  [els.windInput, els.xwindLimit, els.tailwindLimit].forEach((el) => {
    el.addEventListener("input", () => {
      renderRunwayButtons();
      calculateAndRender();
    });
    el.addEventListener("change", calculateAndRender);
  });
  els.settingsBtn.addEventListener("click", () => openModal("settingsModal"));
  els.clockBtn.addEventListener("click", () => openModal("clockModal"));
  els.sendSuggestionBtn.addEventListener("click", sendSuggestion);
  document.querySelectorAll(".modal-close").forEach((button) => {
    button.addEventListener("click", () => closeModal(button.dataset.close));
  });
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal.id);
    });
  });
  els.applyManualBtn.addEventListener("click", applyManualRunway);
  sequenceOnEnter([
    { el: els.manualIdent },
    { el: els.manualHeading, done: applyManualRunway }
  ]);
  sequenceOnEnter([
    { el: els.xwindLimit },
    { el: els.tailwindLimit, done: () => { calculateAndRender(); closeModal("settingsModal"); } }
  ]);
  els.updateBtn.addEventListener("click", async () => {
    await clearAppCaches();
    if (waitingWorker) waitingWorker.postMessage({ type: "SKIP_WAITING" });
    else window.location.reload();
  });

  initInstall();
  registerServiceWorker();
}

boot();
