import * as d3 from "d3";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { initTheme, initSkin, cssVar, tooltip, el, tipRow, loadJSON, fmtInt, treeList } from "../shared/ui.js";
import { skinData } from "./skin.js";

const DATA = "./data/foliage/";
const MAP_STYLE = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
const TIER_ORDER = ["S", "A", "B", "C", "D"];
const TIMING = { early: -9, mid: 0, late: 10, "very late": 18 };   // prior shifts (days), same as the pipeline
const D0 = 244, D1 = 349;                                           // slider range: Sep 1 – Dec 15
const TREE_ZOOM = 13.2, ICON_ZOOM = 15.4;

const isDark = initTheme(document.getElementById("theme"));
initSkin(document.getElementById("skin"));
const tip = tooltip();

let F, map;
const state = { city: "toronto", doy: 285, sp: new Set(), playing: false, historySite: null };   // sp: species shown on the map
const chunks = new Map();       // "city/ix_iy" -> rows
let index = {};                 // city -> tile index
let P = {};                     // per-city precomputed stage tables

// ------------------------------------------------------------------ dates
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const doyToDate = (doy, year = F.season) => new Date(Date.UTC(year, 0, 1) + (doy - 1) * 864e5);
const dateToDoy = (dt) => Math.round((Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - Date.UTC(dt.getUTCFullYear(), 0, 1)) / 864e5) + 1;
const fmtMD = (doy) => doyToDate(doy).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtLong = (doy) => doyToDate(doy).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const isoDoy = (iso) => dateToDoy(new Date(iso + "T00:00:00Z"));
const sig = (x) => 1 / (1 + Math.exp(-x));
const todayDoy = () => isoDoy(F.today);

// ------------------------------------------------------------------ the colour model
// For each species: P(turned) and P(bare) on each day, averaged over this season's forecast scenarios.
function precompute(ck) {
  const c = F.cities[ck];
  const sims = c.mgd ? c.mgd.sims.filter((_, i) => i % 2 === 1) : [c.clim_mgd];
  const shiftOf = (sp) => c.shifts[sp] ?? TIMING[F.species[sp].timing] ?? 0;
  const turn = [], bare = [];
  for (const s of F.species) {
    const sh = shiftOf(s.i), tr = new Float32Array(D1 - D0 + 1), br = new Float32Array(D1 - D0 + 1);
    for (let d = D0; d <= D1; d++) {
      let a = 0, b = 0;
      for (const m of sims) { a += sig((d - m - sh - c.t1) / c.s1); b += sig((d - m - sh - c.t2) / c.s2); }
      tr[d - D0] = a / sims.length; br[d - D0] = b / sims.length;
    }
    turn[s.i] = tr; bare[s.i] = br;
  }
  // city-wide shares weighted by tree counts, and each species' peak day (most colour showing)
  const w = Object.entries(c.species_counts).map(([sp, n]) => [+sp, n]);
  const tot = d3.sum(w, (x) => x[1]) || 1;
  const share = d3.range(D0, D1 + 1).map((d) => {
    let t = 0, b = 0;
    for (const [sp, n] of w) { t += n * turn[sp][d - D0]; b += n * bare[sp][d - D0]; }
    return { d, turned: t / tot, bare: b / tot, colour: Math.max(0, (t - b) / tot) };
  });
  const peakOf = F.species.map((s) => {
    let best = D0, v = -1;
    for (let d = D0; d <= D1; d++) { const x = turn[s.i][d - D0] - bare[s.i][d - D0]; if (x > v) { v = x; best = d; } }
    return best;
  });
  const windowOf = (sp) => {
    const tr = turn[sp], br = bare[sp];
    const a = d3.range(D0, D1 + 1).find((d) => tr[d - D0] >= 0.2) ?? D1;
    const b = d3.range(D0, D1 + 1).find((d) => br[d - D0] >= 0.5) ?? D1;
    return [a, peakOf[sp], b];
  };
  const peak = share.reduce((a, b) => (b.colour > a.colour ? b : a)).d;
  return { turn, bare, share, peakOf, windowOf, peak };
}
const amount = (sp, d) => Math.max(0, P[state.city].turn[sp][d - D0] - P[state.city].bare[sp][d - D0]);
function stageOf(sp, d) {
  const t = P[state.city].turn[sp][d - D0], b = P[state.city].bare[sp][d - D0];
  if (b >= 0.5) return "b";
  if (t - b >= 0.55) return "p";
  if (t >= 0.2) return "t";
  return "g";
}
const STAGE_LABEL = { g: "Green", t: "Turning", p: "Peak colour", b: "Mostly bare" };
const leafGreen = () => cssVar("--leaf-green") || "#6f8f4e";
const leafBare = () => cssVar("--leaf-bare") || "#b7a690";
function colourOf(sp, d) {
  const s = F.species[sp], t = P[state.city].turn[sp][d - D0], b = P[state.city].bare[sp][d - D0];
  const c = d3.interpolateLab(leafGreen(), s.colour)(Math.min(1, t / 0.75));
  return d3.interpolateLab(c, leafBare())(Math.min(1, b));
}
// Shares of green, each autumn hue and bare for a set of [species, count] pairs on day d (they sum to 1).
const HUE_ORDER = ["yellow", "gold", "orange", "scarlet", "red", "purple", "bronze", "brown"];
function hueShares(pairs, d) {
  const out = { green: 0, bare: 0, hues: {} };
  let tot = 0;
  for (const [sp, n] of pairs) {
    const t = P[state.city].turn[sp][d - D0], b = P[state.city].bare[sp][d - D0], a = Math.max(0, t - b), h = F.species[sp].hue;
    out.green += n * (1 - t); out.bare += n * b; out.hues[h] = (out.hues[h] || 0) + n * a; tot += n;
  }
  if (tot) { out.green /= tot; out.bare /= tot; for (const h in out.hues) out.hues[h] /= tot; }
  return out;
}
// One colour for a map square: its most common autumn hue, mixed with green and bare by their shares.
// (Averaging all hues together turns every square olive-brown.)
function mixColour(pairs, d) {
  const sh = hueShares(pairs, d);
  const colour = d3.sum(Object.values(sh.hues));
  const top = Object.entries(sh.hues).sort((a, b) => b[1] - a[1])[0];
  let c = top ? d3.interpolateLab(leafGreen(), F.hues[top[0]])(Math.min(1, (colour / Math.max(1e-6, colour + sh.green)) ** 0.7)) : leafGreen();
  c = d3.interpolateLab(c, leafBare())(Math.min(1, sh.bare * 1.1));
  return d3.color(c).formatHex();
}
// Stacked bands, bottom to top: bare, each hue, green.
function bandStack(pairs, days) {
  return days.map((d) => {
    const sh = hueShares(pairs, d);
    let y = 0;
    const segs = [["bare", sh.bare, leafBare()], ...HUE_ORDER.map((h) => [h, sh.hues[h] || 0, F.hues[h]]), ["green", sh.green, leafGreen()]]
      .map(([k, v, col]) => { const s0 = y; y += v; return { k, y0: s0, y1: y, col }; });
    return { d, segs };
  });
}

// ------------------------------------------------------------------ init
init().catch((err) => {
  console.error(err);
  document.querySelector("main").prepend(el("div", { class: "wrap", style: { padding: "24px", color: "var(--accent)" } }, `Could not load data: ${err.message}`));
});

async function init() {
  F = await loadJSON(DATA + "foliage.json");
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("city");
  state.city = F.cities[fromHash] ? fromHash : "toronto";
  for (const ck of Object.keys(F.cities)) P[ck] = precompute(ck);
  skinData({ F, P, D0, D1 });   // "Kodachrome" skin: share already-loaded data
  state.sp = new Set(F.species.map((s) => s.i));
  state.doy = Math.min(D1, Math.max(D0, todayDoy()));
  document.getElementById("season-label").textContent = `Autumn ${F.season} forecast`;
  buildCityButtons();
  buildTierChips();
  buildStageLegend();
  document.getElementById("slider").addEventListener("input", (e) => setDoy(+e.target.value));
  document.getElementById("play").addEventListener("click", togglePlay);
  document.getElementById("show-sightings").addEventListener("change", updateMapLayers);
  initMap();
  setCity(state.city, { initial: true });
  document.getElementById("generated").textContent = `Data refreshed ${new Date(F.generated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`;
  let raf, lastW = 0;
  new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w === lastW) return; lastW = w; cancelAnimationFrame(raf); raf = requestAnimationFrame(renderCharts); })
    .observe(document.querySelector("main"));
  window.addEventListener("themechange", () => {
    for (const ck of Object.keys(F.cities)) P[ck] = precompute(ck);   // colours read CSS tokens
    if (map) map.setStyle(isDark() ? MAP_STYLE.dark : MAP_STYLE.light);
    renderAll();
  });
}

function buildCityButtons() {
  const seg = document.getElementById("cities");
  seg.replaceChildren(...Object.entries(F.cities).map(([k, c]) => el("button", { type: "button", "data-k": k, onclick: () => setCity(k) }, c.name)));
}
// The map shows one set of species (state.sp). Tier chips are presets; the tree list edits it species by species.
const presentSp = (pred = () => true) => F.species.filter((s) => (F.cities[state.city].species_counts[s.i] || 0) > 0 && pred(s)).map((s) => s.i);
const allOn = (ids) => ids.length > 0 && ids.every((i) => state.sp.has(i));
let tierChips = [], allChip, list;
function syncFilters() {
  allChip?.setAttribute("aria-pressed", String(allOn(presentSp())));
  tierChips.forEach(([t, chip]) => chip.setAttribute("aria-pressed", String(allOn(presentSp((s) => s.tier === t)))));
  list?.paint();
  updateMapLayers();
  renderStreets();
  renderTiers();
}
function buildTierChips() {
  allChip = el("button", { type: "button", class: "chip", "aria-pressed": "true" }, "All trees");
  allChip.addEventListener("click", () => { F.species.forEach((s) => state.sp.add(s.i)); syncFilters(); });
  tierChips = TIER_ORDER.map((t) => {
    const chip = el("button", { type: "button", class: "chip", "aria-pressed": "true", title: F.tiers[t] }, `${t} tier`);
    chip.addEventListener("click", () => {
      const ids = F.species.filter((s) => s.tier === t).map((s) => s.i);
      if (allOn(presentSp())) state.sp = new Set(ids);                       // from "all", isolate the tier
      else if (allOn(ids.filter((i) => presentSp().includes(i)))) ids.forEach((i) => state.sp.delete(i));
      else ids.forEach((i) => state.sp.add(i));
      if (!state.sp.size) F.species.forEach((s) => state.sp.add(s.i));
      syncFilters();
    });
    return [t, chip];
  });
  document.getElementById("tier-chips").replaceChildren(allChip, ...tierChips.map(([, c]) => c));
}
// One row per species on this city's streets, best colour first, then most common.
function renderTreeList() {
  const c = F.cities[state.city];
  const items = F.species.filter((s) => (c.species_counts[s.i] || 0) > 0)
    .map((s) => ({ id: s.i, name: s.common, tier: s.tier, count: c.species_counts[s.i], colour: s.colour }))
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.count - a.count);
  list = treeList(document.getElementById("tree-list"), items, state.sp, syncFilters, { placeholder: "Find a tree…" });
}
function buildStageLegend() {
  const leaf = (fill, stroke = "var(--leaf-outline)") => {
    const ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 64 64");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", LEAF_PATH); p.setAttribute("fill", fill); p.setAttribute("stroke", stroke); p.setAttribute("stroke-width", "3");
    s.append(p); return s;
  };
  document.getElementById("stage-legend").replaceChildren(
    el("div", { class: "st" }, leaf("var(--leaf-green)"), "Green"),
    el("div", { class: "st" }, leaf("url(#lg-turn)"), "Turning"),
    el("div", { class: "st" }, leaf("#e0661b"), "Peak"),
    el("div", { class: "st" }, leaf("var(--leaf-bare)"), "Bare"));
  // shared gradient for the "turning" swatch
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  defs.setAttribute("width", "0"); defs.setAttribute("height", "0"); defs.style.position = "absolute";
  defs.innerHTML = '<defs><linearGradient id="lg-turn" x1="0" x2="1"><stop offset="0.45" stop-color="var(--leaf-green)"/><stop offset="0.55" stop-color="#e0661b"/></linearGradient></defs>';
  document.body.append(defs);
  const hues = el("div", { class: "hue-legend" }, ...Object.entries(F.hues).map(([k, v]) => el("span", {}, el("i", { style: { background: v } }), k)));
  document.getElementById("stage-legend").after(hues);
}

function setCity(k, { initial = false } = {}) {
  state.city = k;
  history.replaceState(null, "", `#city=${k}`);
  for (const b of document.querySelectorAll("#cities button")) b.setAttribute("aria-pressed", String(b.dataset.k === k));
  const sites = siteGroup(k).filter((s) => F.sites[s].usable);
  state.historySite = F.cities[k].site;
  if (!initial && map) map.flyTo({ center: F.cities[k].center, zoom: F.cities[k].zoom, duration: 1200 });
  loadIndex(k).then(() => { updateMapLayers(); refreshTrees(); renderStreets(); });
  renderTreeList();
  renderAll();
  syncFilters();
  buildHistoryButtons(sites);
  skinData({ city: k });
}

function setDoy(d) {
  state.doy = d;
  document.getElementById("slider").value = d;
  updateSliderLabel();
  updateMapLayers();
  renderStreets();
  renderRibbonPlayhead();
  renderCalendarPlayhead();
}
function togglePlay() {
  state.playing = !state.playing;
  const btn = document.getElementById("play");
  btn.innerHTML = state.playing
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
  if (!state.playing) return;
  if (state.doy >= D1) setDoy(D0);
  const step = () => {
    if (!state.playing) return;
    if (state.doy >= D1) { togglePlay(); return; }
    setDoy(state.doy + 1);
    setTimeout(step, 120);
  };
  step();
}
function updateSliderLabel() {
  const sh = P[state.city].share[state.doy - D0];
  document.getElementById("slider-date").textContent = fmtLong(state.doy);
  document.getElementById("slider-note").textContent = `· ${Math.round(sh.colour * 100)}% of street trees showing colour, ${Math.round(sh.bare * 100)}% bare${state.doy === todayDoy() ? " · today" : ""}`;
}

function renderAll() {
  renderHero();
  updateSliderLabel();
  renderTiers();
  renderTrips();
  renderSightings();
  renderLimitations();
  renderCharts();
  updateMapLayers();
  renderStreets();
}
function renderCharts() { renderRibbon(); renderCalendar(); renderRace(); renderHistory(); renderModelCard(); renderSeasonBar(); renderTrips(); }

// ------------------------------------------------------------------ hero
function renderHero() {
  const c = F.cities[state.city], p = P[state.city];
  const sims = c.mgd?.sims;
  const lo = sims ? p.peak + (sims[5] - sims[25]) : null, hi = sims ? p.peak + (sims[45] - sims[25]) : null;
  const today = todayDoy(), sh = p.share[Math.min(D1, Math.max(D0, today)) - D0];
  document.getElementById("hero-label").textContent = `Peak colour · ${c.name}`;
  document.getElementById("hero-date").textContent = fmtMD(p.peak);
  const days = p.peak - today;
  const when = days > 2 ? `about ${days} days away` : days < -2 ? `${-days} days ago` : "right about now";
  document.getElementById("hero-sub").textContent =
    `The day the most street trees should be showing colour, ${when}${lo ? ` (80% range ${fmtMD(Math.round(lo))} – ${fmtMD(Math.round(hi))})` : ""}. ` +
    `Early trees like ${earlyNames()} lead; ${lateNames()} hang on into ${fmtMD(Math.min(D1, p.peak + 21)).split(" ")[0]}.`;
  const tr = c.trend_per_decade;
  const stat = (label, value, sub) => el("div", { class: "card stat" }, el("div", { class: "label" }, label), el("div", { class: "value" }, value), el("div", { class: "sub" }, sub));
  const rc = c.recent || {};
  document.getElementById("stats").replaceChildren(
    stat("In colour today", `${Math.round(sh.colour * 100)}%`, `of street trees · ${Math.round(sh.bare * 100)}% already bare`),
    stat("Street trees mapped", fmtInt.format(c.n_trees), `deciduous trees in ${c.credit} inventories`),
    stat("Autumn's drift", tr == null ? "—" : `${tr > 0 ? "+" : ""}${tr.toFixed(1)} days`, `per decade, satellite green-down since 2001${tr > 0 ? " (later)" : " (earlier)"}`),
    rc.observed != null
      ? stat("Observers say", `${Math.round(rc.observed * 100)}%`, `of ${rc.n} trees photographed in 3 weeks were turning or bare (model: ${Math.round(rc.expected * 100)}%)`)
      : stat("Forecast error", c.skill ? `±${c.skill.e_model.toFixed(1)} days` : "—", "typical miss, tested on autumns the model never saw"));
}
function topByCount(filter) {
  const c = F.cities[state.city];
  return Object.entries(c.species_counts).map(([sp, n]) => [+sp, n]).filter(([sp]) => filter(F.species[sp])).sort((a, b) => b[1] - a[1]);
}
const earlyNames = () => topByCount((s) => s.timing === "early" && ["S", "A", "B"].includes(s.tier)).slice(0, 2).map(([sp]) => F.species[sp].common.toLowerCase() + "s").join(" and ") || "birches";
const lateNames = () => topByCount((s) => ["late", "very late"].includes(s.timing)).slice(0, 2).map(([sp]) => F.species[sp].common.toLowerCase() + "s").join(" and ") || "oaks";

// The colour wave: share of street trees showing each autumn hue through the season, scaled to the season's peak.
function colourWave(svg, w, h, pairs, days) {
  const cols = days.map((d) => { const sh = hueShares(pairs, d); return { d, ...Object.fromEntries(HUE_ORDER.map((k) => [k, sh.hues[k] || 0])) }; });
  const stack = d3.stack().keys(HUE_ORDER)(cols);
  const max = d3.max(stack.at(-1), (p) => p[1]) || 1;
  const x = d3.scaleLinear([days[0], days.at(-1)], [0, w]), y = d3.scaleLinear([0, max], [h, 1]);
  for (const layer of stack) {
    svg.append("path").datum(layer).attr("d", d3.area().x((p) => x(p.data.d)).y0((p) => y(p[0])).y1((p) => y(p[1])).curve(d3.curveMonotoneX))
      .style("fill", F.hues[layer.key]);
  }
  return { x, max };
}
function renderSeasonBar() {
  const host = document.getElementById("season-bar");
  const c = F.cities[state.city];
  const pairs = Object.entries(c.species_counts).map(([sp, n]) => [+sp, n]);
  const w = Math.max(240, host.clientWidth), h = 34;
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("class", "sb-svg").attr("viewBox", `0 0 ${w} ${h}`).attr("preserveAspectRatio", "none").attr("width", "100%").attr("height", h);
  svg.append("line").attr("x1", 0).attr("x2", w).attr("y1", h - 0.5).attr("y2", h - 0.5).style("stroke", "var(--axis)");
  const { x, max } = colourWave(svg, w, h, pairs, d3.range(D0, D1 + 1));
  const t = todayDoy();
  if (t >= D0 && t <= D1) host.append(el("div", { class: "sb-today", style: { left: `calc(${(x(t) / w) * 100}% - 1px)` }, title: "Today" }));
  const lab = el("div", { class: "sb-labels" });
  for (const [m, d] of [["Sep", 244], ["Oct", 274], ["Nov", 305], ["Dec", 335]]) lab.append(el("span", { style: { left: `${(x(d) / w) * 100}%` } }, m));
  host.append(lab);
  host.title = `Share of street trees showing colour through the season (peak ${Math.round(max * 100)}%)`;
}

// ------------------------------------------------------------------ map
const LEAF_PATH = "M32 6 C46 16 54 30 46 44 C42 51 36 54 32 56 C28 54 22 51 18 44 C10 30 18 16 32 6 Z M32 56 L32 62";
function leafImage(fill, fill2 = null, stage = "p") {
  const s = 64, c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d");
  const outline = cssVar("--leaf-outline") || "#3a2a1e";
  const path = new Path2D("M32 4 C47 15 56 30 47 45 C42 52 36 55 32 57 C28 55 22 52 17 45 C8 30 17 15 32 4 Z");
  if (stage === "b") {   // bare: a small fallen leaf outline
    ctx.globalAlpha = 0.75;
    ctx.translate(32, 36); ctx.scale(0.6, 0.6); ctx.rotate(0.7); ctx.translate(-32, -32);
  }
  ctx.lineWidth = 4; ctx.strokeStyle = outline; ctx.lineJoin = "round";
  ctx.stroke(path);
  if (fill2) {
    const g = ctx.createLinearGradient(14, 50, 50, 10);
    g.addColorStop(0.35, fill); g.addColorStop(0.65, fill2);
    ctx.fillStyle = g;
  } else ctx.fillStyle = fill;
  ctx.fill(path);
  ctx.strokeStyle = "rgba(0,0,0,0.28)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(32, 12); ctx.lineTo(32, 60); ctx.stroke();
  ctx.strokeStyle = outline; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(32, 57); ctx.lineTo(32, 63); ctx.stroke();
  return ctx.getImageData(0, 0, s, s);
}
function addLeafIcons() {
  const g = leafGreen(), b = leafBare();
  const put = (id, img) => { if (map.hasImage(id)) map.removeImage(id); map.addImage(id, img, { pixelRatio: 2 }); };
  put("leaf-g", leafImage(g));
  put("leaf-b", leafImage(b, null, "b"));
  for (const [k, v] of Object.entries(F.hues)) { put(`leaf-${k}-t`, leafImage(g, v)); put(`leaf-${k}-p`, leafImage(v)); }
}
function iconOf(sp, d) {
  const st = stageOf(sp, d);
  return st === "g" ? "leaf-g" : st === "b" ? "leaf-b" : `leaf-${F.species[sp].hue}-${st}`;
}

const BASEMAP = {
  light: { bg: "#efe7d8", water: "#cfdcdb", green: "#e2e2c9", building: "#e5d9c6" },
  dark: { bg: "#2c2724", water: "#262c30", green: "#33342c", building: "#3a3330" },
};
function tintBasemap() {
  const pal = BASEMAP[isDark() ? "dark" : "light"];
  for (const layer of map.getStyle().layers) {
    const id = layer.id.toLowerCase();
    try {
      if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", pal.bg);
      else if (layer.type === "fill" && id.includes("water")) map.setPaintProperty(layer.id, "fill-color", pal.water);
      else if (layer.type === "fill" && ["park", "landcover", "landuse", "wood", "grass"].some((k) => id.includes(k))) map.setPaintProperty(layer.id, "fill-color", pal.green);
      else if (layer.type === "fill" && id.includes("building")) map.setPaintProperty(layer.id, "fill-color", pal.building);
    } catch { /* not every layer supports the property */ }
  }
  window.dispatchEvent(new CustomEvent("foliage:basemap", { detail: { map } }));
}

function initMap() {
  const c = F.cities[state.city];
  map = new maplibregl.Map({
    container: "map", style: isDark() ? MAP_STYLE.dark : MAP_STYLE.light, center: c.center, zoom: c.zoom,
    attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("style.load", () => { tintBasemap(); addLeafIcons(); addMapLayers(); });
  map.on("moveend", refreshTrees);
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
  if (import.meta.env.DEV) window.__map = map;
  document.getElementById("map").append(el("div", { class: "map-hint", id: "map-hint" }, "Zoom in to see individual trees"));

  const pop = new maplibregl.Popup({ closeButton: true, maxWidth: "320px", className: "tree-popup" });
  for (const layer of ["trees", "trees-icons"]) {
    map.on("click", layer, (e) => { tip.hide(); pop.setLngLat(e.features[0].geometry.coordinates).setDOMContent(treeProfile(e.features[0].properties, true)).addTo(map); });
    map.on("mousemove", layer, (e) => {
      map.getCanvas().style.cursor = "pointer";
      if (pop.isOpen()) return;
      tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(treeProfile(e.features[0].properties, false)));
    });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; tip.hide(); });
  }
  map.on("mousemove", "cells", (e) => {
    if (map.getZoom() >= TREE_ZOOM) return;
    const p = e.features[0].properties;
    tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(
      el("div", { class: "t-title" }, `${fmtInt.format(p.n)} street trees in this square`),
      tipRow(p.fill, `${Math.round(p.colour * 100)}%`, "showing colour"),
      tipRow(leafBare(), `${Math.round(p.bare * 100)}%`, "bare"),
      el("div", { class: "t-title", style: { marginTop: "4px" } }, "Zoom in to see each tree")));
  });
  map.on("mouseleave", "cells", () => tip.hide());
  map.on("click", "cells", (e) => { if (map.getZoom() < TREE_ZOOM) map.flyTo({ center: e.lngLat, zoom: TREE_ZOOM + 1.2 }); });
  for (const evt of ["click", "mousemove"]) {
    map.on(evt, "sightings", (e) => {
      const p = e.features[0].properties;
      if (evt === "click") { tip.hide(); pop.setLngLat(e.features[0].geometry.coordinates).setDOMContent(sightingCard(p, true)).addTo(map); }
      else if (!pop.isOpen()) { map.getCanvas().style.cursor = "pointer"; tip.show(e.originalEvent.clientX, e.originalEvent.clientY, (t) => t.append(sightingCard(p, false))); }
    });
  }
  map.on("mouseleave", "sightings", () => { map.getCanvas().style.cursor = ""; tip.hide(); });
}

function addMapLayers() {
  const empty = { type: "FeatureCollection", features: [] };
  if (!map.getSource("cells")) map.addSource("cells", { type: "geojson", data: empty });
  if (!map.getSource("trees")) map.addSource("trees", { type: "geojson", data: empty });
  if (!map.getSource("sightings")) map.addSource("sightings", { type: "geojson", data: empty });
  map.addLayer({ id: "cells", type: "fill", source: "cells", paint: {
    "fill-color": ["get", "fill"],
    "fill-opacity": ["interpolate", ["linear"], ["zoom"],
      10, ["*", 0.78, ["+", 0.15, ["*", 0.85, ["get", "w"]]]], TREE_ZOOM - 0.4, ["*", 0.7, ["+", 0.15, ["*", 0.85, ["get", "w"]]]], TREE_ZOOM + 0.6, 0],
    "fill-outline-color": "rgba(0,0,0,0)" } });
  map.addLayer({ id: "trees", type: "circle", source: "trees", minzoom: TREE_ZOOM - 0.3, maxzoom: ICON_ZOOM, paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], TREE_ZOOM, 1.8, ICON_ZOOM, 4.5],
    "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], TREE_ZOOM, 0, 14.5, 0.7],
    "circle-opacity": ["interpolate", ["linear"], ["zoom"], TREE_ZOOM - 0.3, 0, TREE_ZOOM + 0.4, 1] } });
  map.addLayer({ id: "trees-icons", type: "symbol", source: "trees", minzoom: ICON_ZOOM, layout: {
    "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-anchor": "bottom",
    "icon-size": ["interpolate", ["linear"], ["zoom"], ICON_ZOOM, 0.42, 17, 0.7, 19, 1.0],
    "icon-rotate": ["%", ["*", ["get", "r"], 37], 40] } });
  map.addLayer({ id: "sightings", type: "circle", source: "sightings", layout: { visibility: "none" } });
  map.getSource("trees").setData(treeFC());
  updateMapLayers();
}

async function loadIndex(ck) {
  if (!index[ck]) index[ck] = await loadJSON(`${DATA}trees/${ck}/index.json`);
  return index[ck];
}
function cellPolygons() {
  const ix = index[state.city];
  if (!ix) return { type: "FeatureCollection", features: [] };
  const [dx, dy] = ix.cell, d = state.doy;
  return { type: "FeatureCollection", features: ix.cells.map(([x, y, n0, hist0]) => {
    const hist = hist0.filter(([sp]) => state.sp.has(sp)), n = d3.sum(hist, (h) => h[1]);
    if (!n) return null;
    let t = 0, b = 0;
    for (const [sp, k] of hist) { t += k * P[state.city].turn[sp][d - D0]; b += k * P[state.city].bare[sp][d - D0]; }
    const x0 = x * dx, y0 = y * dy;
    // w fades squares with only a few selected trees, so a single species reads as a density map
    return { type: "Feature", properties: { n, w: Math.min(1, Math.sqrt(n / 60)), fill: mixColour(hist, d), colour: Math.max(0, (t - b) / n), bare: b / n },
      geometry: { type: "Polygon", coordinates: [[[x0, y0], [x0 + dx, y0], [x0 + dx, y0 + dy], [x0, y0 + dy], [x0, y0]]] } };
  }).filter(Boolean) };
}
async function refreshTrees() {
  if (!map || !map.getSource("trees") || !index[state.city]) return;
  const hint = document.getElementById("map-hint");
  if (hint) hint.style.display = map.getZoom() >= TREE_ZOOM ? "none" : "";
  if (map.getZoom() < TREE_ZOOM - 0.3) return;
  const ix = index[state.city], [dx, dy] = ix.cell, bnd = map.getBounds();
  const have = new Set(ix.cells.map(([x, y]) => `${x}_${y}`));
  const want = [];
  for (let x = Math.floor(bnd.getWest() / dx); x <= Math.floor(bnd.getEast() / dx); x++)
    for (let y = Math.floor(bnd.getSouth() / dy); y <= Math.floor(bnd.getNorth() / dy); y++)
      if (have.has(`${x}_${y}`)) want.push(`${state.city}/${x}_${y}`);
  if (want.length > 60) return;                                       // too far out; the squares carry it
  await Promise.all(want.filter((k) => !chunks.has(k)).map(async (k) => chunks.set(k, await loadJSON(`${DATA}trees/${k}.json`))));
  state.visible = want;
  map.getSource("trees").setData(treeFC());
}
function treeFC() {
  const feats = [];
  for (const k of state.visible || []) {
    if (!k.startsWith(state.city + "/")) continue;
    const ch = chunks.get(k), commons = index[state.city].commons;
    if (!ch) continue;
    for (const [x, y, sp, dbh, si, ci] of ch.r) {
      const lon = x / 1e5, lat = y / 1e5, st = ch.s[si], cn = commons[ci];
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { sp, dbh, st, cn, t: F.species[sp].tier, r: Math.round((lon * 1e5 + lat * 1e5) % 97), lon, lat } });
    }
  }
  return { type: "FeatureCollection", features: feats };
}
function speciesMatch(fn, fallback) {
  return ["match", ["get", "sp"], ...F.species.flatMap((s) => [s.i, fn(s.i)]), fallback];
}
function updateMapLayers() {
  if (!map || !map.getLayer("trees")) return;
  const d = state.doy;
  map.getSource("cells").setData(cellPolygons());
  const filter = ["in", ["get", "sp"], ["literal", [...state.sp]]];
  for (const id of ["trees", "trees-icons"]) map.setFilter(id, filter);
  map.setPaintProperty("trees", "circle-color", speciesMatch((sp) => colourOf(sp, d), "#999"));
  map.setPaintProperty("trees", "circle-stroke-color", cssVar("--leaf-outline") || "#3a2a1e");
  map.setLayoutProperty("trees-icons", "icon-image", speciesMatch((sp) => iconOf(sp, d), "leaf-g"));
  const sightFC = { type: "FeatureCollection", features: (F.sightings[state.city] || []).map((s) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: s })) };
  map.getSource("sightings").setData(sightFC);
  map.setLayoutProperty("sightings", "visibility", document.getElementById("show-sightings").checked ? "visible" : "none");
  map.setPaintProperty("sightings", "circle-color", cssVar("--accent-2"));
  map.setPaintProperty("sightings", "circle-radius", ["interpolate", ["linear"], ["zoom"], 9, 4, 15, 7]);
  map.setPaintProperty("sightings", "circle-stroke-color", cssVar("--surface"));
  map.setPaintProperty("sightings", "circle-stroke-width", 2);
}

function photoBlock(sp, cls) {
  const ph = F.species[sp].photo;
  return el("div", { class: `${cls}${ph ? "" : " none"}`, style: ph ? { backgroundImage: `url("${ph.url}")` } : {} });
}
function treeProfile(p, pinned) {
  const s = F.species[p.sp], d = state.doy, [a, pk, b] = P[state.city].windowOf(p.sp);
  const st = stageOf(p.sp, d);
  const photo = photoBlock(p.sp, "pf-photo");
  photo.append(el("span", { class: `tier tier-${s.tier}` }, `${s.tier} tier`));
  const body = el("div", { class: "pf-body" },
    el("div", { class: "pf-name" }, el("i", { style: { background: s.colour } }), s.common),
    el("div", { class: "pf-sub" }, [p.st, p.cn && p.cn.toLowerCase() !== s.common.toLowerCase() ? p.cn : null].filter(Boolean).join(" · ")),
    el("dl", { class: "pf-attrs" },
      el("dt", {}, "Autumn colour"), el("dd", {}, s.hue),
      el("dt", {}, "Turns"), el("dd", {}, `${fmtMD(a)}, peak ${fmtMD(pk)}, bare by ${fmtMD(b)}`),
      p.dbh ? el("dt", {}, "Trunk") : null, p.dbh ? el("dd", {}, `${p.dbh} cm across`) : null),
    el("div", { class: "pf-stage" }, el("b", {}, STAGE_LABEL[st]), ` on ${fmtMD(d)} (forecast)`),
    el("p", { class: "pf-note" }, s.note));
  if (pinned) {
    body.append(el("div", { class: "pf-links" },
      el("a", { href: `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}`, target: "_blank", rel: "noopener" }, "Street View ↗"),
      s.photo ? el("a", { href: `https://www.inaturalist.org/observations/${s.photo.obs}`, target: "_blank", rel: "noopener" }, "Photo source ↗") : null));
    if (s.photo) body.append(el("div", { class: "pf-credit" }, `Typical ${s.common.toLowerCase()} in autumn colour. Photo ${s.photo.attr}`));
  } else body.append(el("div", { class: "pf-credit" }, "Click for Street View and the photo credit"));
  return el("div", { class: `profile${pinned ? " pinned" : ""}` }, photo, body);
}
function sightingCard(p, pinned) {
  return el("div", { class: `profile${pinned ? " pinned" : ""}` },
    p.photo ? el("div", { class: "pf-photo", style: { backgroundImage: `url("${p.photo}")` } }) : null,
    el("div", { class: "pf-body" },
      el("div", { class: "pf-name" }, p.taxon),
      el("div", { class: "pf-sub" }, `${p.place || "iNaturalist observation"} · ${p.date}`),
      p.attr ? el("div", { class: "pf-credit" }, p.attr) : null,
      pinned ? el("div", { class: "pf-links" }, el("a", { href: `https://www.inaturalist.org/observations/${p.obs}`, target: "_blank", rel: "noopener" }, "View on iNaturalist ↗")) : null));
}

function renderStreets() {
  const ix = index[state.city], ol = document.getElementById("streets");
  if (!ix) return;
  const d = state.doy;
  const scored = ix.streets.map(([name, n, hist, [lon, lat]]) => {
    const h = hist.filter(([sp]) => state.sp.has(sp));
    return { name, lon, lat, parts: h.map(([sp, k]) => [sp, k * amount(sp, d)]), score: d3.sum(h, ([sp, k]) => k * amount(sp, d)) };
  }).filter((s) => s.score > 0.5).sort((a, b) => b.score - a.score).slice(0, 8);
  const max = d3.max(scored, (s) => s.score) || 1;
  ol.replaceChildren(...(scored.length ? scored.map((s) => el("li", {}, el("button", { type: "button", onclick: () => map.flyTo({ center: [s.lon, s.lat], zoom: 16.2, duration: 1400 }) },
    el("span", { class: "s-name" }, s.name),
    el("span", { class: "s-val" }, `${Math.round(s.score)} in colour`),
    el("span", { class: "s-bar" }, ...s.parts.filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).map(([sp, v]) =>
      el("i", { style: { width: `${(100 * v) / max}%`, background: F.species[sp].colour } })))))) :
    [el("li", { class: "empty note" }, d < P[state.city].peak ? "Still mostly green on this date." : "Mostly bare on this date.")]));
}

// ------------------------------------------------------------------ tier list
function renderTiers() {
  const c = F.cities[state.city], p = P[state.city];
  const present = F.species.filter((s) => (c.species_counts[s.i] || 0) > 0);
  document.getElementById("tiers-sub").textContent = `${present.length} kinds of deciduous street tree in ${c.name}, ranked by how good their autumn colour is. Click one to show only that tree on the map.`;
  const rows = TIER_ORDER.map((t) => {
    const items = F.species.filter((s) => s.tier === t && ((c.species_counts[s.i] || 0) >= 5 || (["S", "A"].includes(t) && s.photo)))
      .sort((a, b) => (c.species_counts[b.i] || 0) - (c.species_counts[a.i] || 0)).slice(0, 14);
    if (!items.length) return null;
    return el("div", { class: "tier-row" },
      el("div", { class: `tier-label tier-${t}` }, el("b", {}, t), el("span", {}, F.tiers[t])),
      el("div", { class: "tier-items" }, ...items.map((s) => {
        const n = c.species_counts[s.i] || 0;
        const photo = photoBlock(s.i, "sp-photo");
        photo.append(el("i", { class: "hue", style: { background: s.colour }, title: s.hue }));
        return el("button", {
          type: "button", class: `sp-card${n ? "" : " absent"}${state.sp.size === 1 && state.sp.has(s.i) ? " active" : ""}`, title: s.note,
          onclick: () => {
            if (!n) return;
            const only = state.sp.size === 1 && state.sp.has(s.i);
            state.sp.clear();
            if (only) F.species.forEach((x) => state.sp.add(x.i)); else state.sp.add(s.i);
            syncFilters();
            if (!only) document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
          },
        }, photo, el("span", { class: "sp-name" }, s.common),
        el("span", { class: "sp-meta" }, n ? `${fmtInt.format(n)} on city streets` : "Not on city streets here"),
        n ? el("span", { class: "sp-peak" }, `Peak ~${fmtMD(p.peakOf[s.i])}`) : null);
      })));
  }).filter(Boolean);
  document.getElementById("tiers").replaceChildren(...rows);
}

// ------------------------------------------------------------------ charts
function frame(id, height, m) {
  const host = document.getElementById(id);
  const width = Math.max(260, host.clientWidth);
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("width", "100%");
  return { svg, g: svg.append("g").attr("transform", `translate(${m.l},${m.t})`), iw: width - m.l - m.r, ih: height - m.t - m.b };
}
const axisClean = (a) => a.select(".domain").remove();
const monthStarts = (lo, hi) => [244, 274, 305, 335].map((d) => d + (isLeap(F.season) ? 1 : 0)).filter((d) => d >= lo && d <= hi);

let ribbonX;
function renderRibbon() {
  const { g, iw, ih } = frame("ribbon", 34, { l: 0, r: 0, t: 2, b: 2 });
  const pairs = Object.entries(F.cities[state.city].species_counts).map(([sp, n]) => [+sp, n]);
  g.append("line").attr("x1", 0).attr("x2", iw).attr("y1", ih).attr("y2", ih).style("stroke", "var(--axis)");
  ribbonX = colourWave(g, iw, ih, pairs, d3.range(D0, D1 + 1, 2)).x;
  const t = todayDoy();
  if (t >= D0 && t <= D1) g.append("line").attr("x1", ribbonX(t)).attr("x2", ribbonX(t)).attr("y1", 0).attr("y2", ih).style("stroke", "var(--ink-2)").style("stroke-dasharray", "2 2");
  g.append("line").attr("class", "playhead").attr("y1", -2).attr("y2", ih + 2).style("stroke", "var(--ink)").style("stroke-width", 2);
  renderRibbonPlayhead();
}
function renderRibbonPlayhead() {
  if (!ribbonX) return;
  d3.select("#ribbon .playhead").attr("x1", ribbonX(state.doy)).attr("x2", ribbonX(state.doy));
}

let calX;
function renderCalendar() {
  const c = F.cities[state.city], p = P[state.city];
  const top = Object.entries(c.species_counts).map(([sp, n]) => [+sp, n]).filter(([sp, n]) => n >= 20)
    .sort((a, b) => b[1] - a[1]).slice(0, 14).map(([sp, n]) => ({ sp, n, w: p.windowOf(sp) })).sort((a, b) => a.w[1] - b.w[1]);
  document.getElementById("cal-title").textContent = `Colour window for ${c.name}'s ${top.length} most common street trees`;
  const m = { l: 140, r: 16, t: 8, b: 26 };
  const { svg, g, iw, ih } = frame("calendar", 26 * top.length + 34, m);
  const lo = d3.min(top, (r) => r.w[0]) - 5, hi = Math.min(D1, d3.max(top, (r) => r.w[2]) + 5);
  const x = (calX = d3.scaleLinear([lo, hi], [0, iw]));
  const y = d3.scaleBand(top.map((r) => r.sp), [0, ih]).padding(0.35);
  g.append("g").attr("class", "grid").selectAll("line").data(monthStarts(lo, hi)).join("line").attr("x1", x).attr("x2", x).attr("y1", 0).attr("y2", ih);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(d3.range(Math.ceil(lo / 7) * 7, hi, iw > 520 ? 14 : 21)).tickFormat(fmtMD).tickSize(0).tickPadding(8)).call(axisClean);
  const defs = svg.append("defs");
  for (const r of top) {
    const s = F.species[r.sp], id = `cal-${r.sp}`;
    const gr = defs.append("linearGradient").attr("id", id).attr("x1", 0).attr("x2", 1);
    const span = r.w[2] - r.w[0] || 1;
    gr.append("stop").attr("offset", 0).attr("stop-color", d3.interpolateLab(leafGreen(), s.colour)(0.35));
    gr.append("stop").attr("offset", Math.max(0.05, (r.w[1] - r.w[0]) / span)).attr("stop-color", s.colour);
    gr.append("stop").attr("offset", 1).attr("stop-color", leafBare());
    g.append("rect").attr("x", x(r.w[0])).attr("width", Math.max(2, x(r.w[2]) - x(r.w[0]))).attr("y", y(r.sp)).attr("height", y.bandwidth()).attr("rx", 4).style("fill", `url(#${id})`);
    g.append("circle").attr("cx", x(r.w[1])).attr("cy", y(r.sp) + y.bandwidth() / 2).attr("r", 5).style("fill", s.colour).style("stroke", "var(--ink)").style("stroke-width", 1.5);
    g.append("text").attr("class", "label").attr("x", -10).attr("y", y(r.sp) + y.bandwidth() / 2 + 4).attr("text-anchor", "end").text(s.common);
    g.append("rect").attr("x", -m.l).attr("width", iw + m.l).attr("y", y(r.sp) - 3).attr("height", y.bandwidth() + 6).style("fill", "transparent")
      .on("pointermove", (e) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${s.common} · ${fmtInt.format(r.n)} trees`),
        tipRow(null, fmtMD(r.w[0]), "starts turning"), tipRow(s.colour, fmtMD(r.w[1]), "peak colour"), tipRow(leafBare(), fmtMD(r.w[2]), "mostly bare"))))
      .on("pointerleave", () => tip.hide());
  }
  const t = todayDoy();
  if (t >= lo && t <= hi) {
    g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", -4).attr("y2", ih).style("stroke", "var(--ink-2)").style("stroke-dasharray", "3 3");
  }
  g.append("line").attr("class", "cal-playhead").attr("y1", -4).attr("y2", ih).style("stroke", "var(--accent)").style("stroke-width", 1.5);
  document.getElementById("cal-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "band", style: { background: `linear-gradient(90deg, ${leafGreen()}, #e0661b, ${leafBare()})` } }), "turning → peak → bare"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--ink-2)" } }), "today"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--accent)" } }), "map date"));
  renderCalendarPlayhead();
}
function renderCalendarPlayhead() {
  if (!calX) return;
  const [lo, hi] = calX.domain();
  d3.select("#calendar .cal-playhead").attr("x1", calX(state.doy)).attr("x2", calX(state.doy)).style("opacity", state.doy >= lo && state.doy <= hi ? 1 : 0);
}

function renderRace() {
  const c = F.cities[state.city], S = c.september;
  const host = document.getElementById("race");
  if (!S || !S.points.length) { host.replaceChildren(el("p", { class: "empty-note" }, "No usable satellite record for this city.")); return; }
  const m = { l: 44, r: 16, t: 14, b: 36 };
  const { g, iw, ih } = frame("race", 270, m);
  const pts = S.points.map(([year, anom, shift]) => ({ year, anom, shift }));
  const xe = d3.extent([...pts.map((p) => p.anom), S.this_anom ?? 0]), ye = d3.extent(pts, (p) => p.shift);
  const x = d3.scaleLinear([Math.min(-2, xe[0] - 0.3), Math.max(2, xe[1] + 0.3)], [0, iw]).nice();
  const y = d3.scaleLinear([Math.min(-10, ye[0] - 2), Math.max(10, ye[1] + 2)], [ih, 0]).nice();
  const signed = (v, digits = 0) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(5)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat((v) => signed(v)).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickFormat((v) => `${signed(v)}°`).tickSize(0).tickPadding(8)).call(axisClean);
  g.append("text").attr("class", "label").attr("x", iw / 2).attr("y", ih + 32).attr("text-anchor", "middle").text("September temperature vs normal (°C)");
  g.append("text").attr("class", "label").attr("x", 4).attr("y", -2).text("days later than typical");
  const [x0, x1] = x.domain();
  g.append("line").attr("x1", x(x0)).attr("x2", x(x1)).attr("y1", y(S.beta * x0)).attr("y2", y(S.beta * x1)).style("stroke", "var(--accent-2)").style("stroke-width", 2);
  g.selectAll("circle").data(pts).join("circle").attr("cx", (p) => x(p.anom)).attr("cy", (p) => y(p.shift)).attr("r", 4).style("fill", "var(--axis)").style("stroke", "var(--surface)")
    .on("pointermove", (e, p) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${p.year}`),
      tipRow(null, `${signed(p.anom, 1)} °C`, "September vs normal"), tipRow(null, `${signed(p.shift)} days`, "green-down vs typical"))))
    .on("pointerleave", () => tip.hide());
  if (S.this_anom != null) {
    const xa = x(S.this_anom), ya = y(S.beta * S.this_anom), right = xa > iw - 90;
    g.append("line").attr("x1", xa).attr("x2", xa).attr("y1", 0).attr("y2", ih).style("stroke", "var(--accent)").style("stroke-dasharray", "4 3");
    g.append("circle").attr("cx", xa).attr("cy", ya).attr("r", 6).style("fill", "var(--accent)").style("stroke", "var(--surface)").style("stroke-width", 2);
    g.append("text").attr("class", "label strong").attr("x", xa + (right ? -8 : 8)).attr("y", 12).attr("text-anchor", right ? "end" : "start").text(`${F.season}`);
  }
  document.getElementById("race-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "dot", style: { background: "var(--axis)" } }), "one autumn, 2001–2025"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--accent-2)" } }), `${S.beta.toFixed(1)} days per °C`),
    el("span", { class: "key" }, el("i", { class: "dot", style: { background: "var(--accent)" } }), `${F.season}`));
  const a = S.this_anom ?? 0;
  const donor = c.borrowed ? ` Greater Victoria's own satellite record is too noisy to use (summer-dry grass), so this borrows ${F.cities[c.borrowed].name}'s autumns, applied to Victoria's September.` : "";
  document.getElementById("race-sub").textContent = `Each dot is one autumn since 2001. September ${F.season} ran ${Math.abs(a).toFixed(1)} °C ${a >= 0 ? "warmer" : "cooler"} than normal${c.mgd && !c.mgd.sep_done ? " so far" : ""}, which shifts this autumn ${Math.abs(S.beta * a) < 0.5 ? "less than a day" : `about ${Math.round(Math.abs(S.beta * a))} day${Math.round(Math.abs(S.beta * a)) === 1 ? "" : "s"}`} ${a >= 0 ? "later" : "earlier"}. The scatter shows how much else matters: September explains only part of it.${donor}`;
  const rc = c.recent || {};
  document.getElementById("check-note").textContent = rc.observed != null
    ? `Reality check: of ${rc.n} trees iNaturalist observers photographed near ${c.name} in the last three weeks, ${Math.round(rc.observed * 100)}% were annotated as turning or bare. The model expected ${Math.round(rc.expected * 100)}% for those dates.`
    : `Too few annotated iNaturalist photos near ${c.name} in the last three weeks for a reality check (${rc.n || 0}).`;
}

// ------------------------------------------------------------------ day trips
function siteGroup(ck) {
  const bc = ["victoria", "vancouver"];
  return Object.keys(F.sites).filter((s) => (bc.includes(ck) ? bc.includes(F.sites[s].region) : F.sites[s].region === "toronto"));
}
function renderTrips() {
  // in a closed forest canopy the satellite's half-way green-down falls close to peak colour, so trips use it directly
  // (street trees are another matter: the city calibration above handles them)
  const ck = state.city, off = 0;
  const isBC = ck !== "toronto";
  document.getElementById("trips-title").textContent = isBC ? "Where's the colour on the coast and beyond?" : "Where's the colour in cottage country?";
  const t = todayDoy();
  const cards = siteGroup(ck).filter((s) => F.sites[s].kind === "trip" || s !== F.cities[ck].site).map((s) => {
    const S = F.sites[s];
    const hist = S.history.map(([y, d]) => d);
    const typical = hist.length ? d3.median(hist) + off : null;
    const fc = S.forecast ? S.forecast.p50 + off : null;
    let status, cls;
    if (!S.usable) { status = "Satellite record too noisy"; cls = "noisy"; }
    else if (fc == null) { status = "No forecast"; cls = "noisy"; }
    else if (t > fc + 8) { status = "Past peak"; cls = "past"; }
    else if (t >= fc - 5) { status = "At peak now"; cls = "peak"; }
    else { status = `Peak in ~${Math.round(fc - t)} days`; cls = "coming"; }
    const card = el("div", { class: "card trip" },
      el("span", { class: `t-status ${cls}` }, status),
      el("h3", {}, S.name),
      typical != null ? el("div", { class: "t-line" }, "Typical peak ", el("b", {}, fmtMD(Math.round(typical))), ` (2001–2025, ±${Math.round(S.sd || 0)} days)`) : null,
      fc != null && S.usable ? el("div", { class: "t-line" }, `This year `, el("b", {}, fmtMD(Math.round(fc))), ` (80%: ${fmtMD(Math.round(S.forecast.p10 + off))} – ${fmtMD(Math.round(S.forecast.p90 + off))})`) : null,
      !S.usable ? el("div", { class: "t-line" }, "Summer drought or evergreen forest drowns out the leaf-colour signal here, so the satellite can't time it.") : null,
      el("div", { class: "t-spark", id: `spark-${s}` }));
    return { s, card, S };
  });
  document.getElementById("trips").replaceChildren(...cards.map((c) => c.card));
  for (const { s, S } of cards) sparkline(`spark-${s}`, S.history);
  document.getElementById("trips-sub").textContent = `Peak colour from 25 autumns of satellite data: in a forest canopy, the day it has lost half its summer greenness falls close to peak colour. This year's date comes from the September model. Each sparkline shows one dot per autumn since 2001.`;
}
function sparkline(id, hist) {
  const host = document.getElementById(id);
  if (!host || !hist.length) return;
  const w = Math.max(200, host.clientWidth), h = 46;
  host.replaceChildren();
  const svg = d3.select(host).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("width", "100%");
  const x = d3.scaleLinear([2001, 2025], [4, w - 4]), y = d3.scaleLinear().domain(d3.extent(hist, (r) => r[1])).nice().range([h - 6, 6]);
  svg.append("path").datum(hist).attr("d", d3.line().x((r) => x(r[0])).y((r) => y(r[1]))).style("fill", "none").style("stroke", "var(--axis)");
  svg.selectAll("circle").data(hist).join("circle").attr("cx", (r) => x(r[0])).attr("cy", (r) => y(r[1])).attr("r", 2.4).style("fill", "var(--accent)")
    .on("pointermove", (e, r) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${r[0]}`), tipRow(null, fmtMD(Math.round(r[1])), "satellite green-down"))))
    .on("pointerleave", () => tip.hide());
}

// ------------------------------------------------------------------ history
function buildHistoryButtons(sites) {
  const seg = document.getElementById("history-sites");
  seg.replaceChildren(...sites.map((s) => el("button", { type: "button", "aria-pressed": String(s === state.historySite), onclick: () => { state.historySite = s; buildHistoryButtons(sites); renderHistory(); } }, F.sites[s].name.split(" (")[0])));
}
function renderHistory() {
  const s = state.historySite, S = F.sites[s];
  if (!S) return;
  const loyo = F.model.loyo.filter((r) => r[0] === s).map(([, y, obs, mod, clim]) => ({ y, obs, mod, clim }));
  const m = { l: 56, r: 16, t: 10, b: 26 };
  const { g, iw, ih } = frame("history", 280, m);
  const x = d3.scaleLinear([2000.5, 2025.5], [0, iw]);
  const ext = d3.extent([...loyo.flatMap((r) => [r.obs, r.mod]).filter((v) => v != null), ...S.history.map((r) => r[1])]);
  const y = d3.scaleLinear([ext[0] - 4, ext[1] + 4], [ih, 0]).nice();
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(5)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat((d) => fmtMD(d)).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(6).tickFormat(d3.format("d")).tickSize(0).tickPadding(8)).call(axisClean);
  if (loyo.length) {
    g.append("path").datum(loyo.filter((r) => r.mod != null)).attr("d", d3.line().x((r) => x(r.y)).y((r) => y(r.mod))).style("fill", "none").style("stroke", "var(--accent-2)").style("stroke-width", 2);
  }
  const yrs = S.history.map((r) => r[0]), ds = S.history.map((r) => r[1]);
  if (yrs.length > 5) {
    const mx = d3.mean(yrs), my = d3.mean(ds);
    const b = d3.sum(yrs, (v, i) => (v - mx) * (ds[i] - my)) / d3.sum(yrs, (v) => (v - mx) ** 2);
    g.append("line").attr("x1", x(2001)).attr("x2", x(2025)).attr("y1", y(my + b * (2001 - mx))).attr("y2", y(my + b * (2025 - mx))).style("stroke", "var(--ink-2)").style("stroke-dasharray", "5 4");
    document.getElementById("history-note").textContent = `${S.name}: green-down has shifted ${b > 0 ? "later" : "earlier"} by about ${Math.abs(b * 10).toFixed(1)} days per decade since 2001 (simple linear trend over ${yrs.length} autumns, ±${Math.round(S.sd)} days of year-to-year scatter). ${S.skill ? `The model's out-of-sample error here is ±${S.skill.e_model.toFixed(1)} days vs ±${S.skill.e_clim.toFixed(1)} for the typical date.` : ""}`;
  }
  g.selectAll("circle.obs").data(S.history).join("circle").attr("class", "obs").attr("cx", (r) => x(r[0])).attr("cy", (r) => y(r[1])).attr("r", 4.5).style("fill", "var(--accent)").style("stroke", "var(--surface)").style("stroke-width", 1.5)
    .on("pointermove", (e, r) => { const l = loyo.find((q) => q.y === r[0]); tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${S.name}, ${r[0]}`), tipRow(cssVar("--accent"), fmtMD(Math.round(r[1])), "satellite green-down"), l?.mod != null ? tipRow(cssVar("--accent-2"), fmtMD(Math.round(l.mod)), "model, without seeing this year") : null)); })
    .on("pointerleave", () => tip.hide());
  document.getElementById("history-legend").replaceChildren(
    el("span", { class: "key" }, el("i", { class: "dot", style: { background: "var(--accent)" } }), "Satellite green-down"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "var(--accent-2)" } }), "Model (each year predicted without itself)"),
    el("span", { class: "key" }, el("i", { class: "line", style: { background: "repeating-linear-gradient(90deg, var(--ink-2) 0 5px, transparent 5px 9px)" } }), "Trend"));
  document.getElementById("history-title").textContent = yrs.length > 5 && d3.mean(ds.slice(-8)) > d3.mean(ds.slice(0, 8)) + 1 ? "Is autumn arriving later? Here, yes." : "Is autumn arriving later?";
}

// ------------------------------------------------------------------ model card
function renderModelCard() {
  const rows = F.model.sites.map((s) => ({ s, name: F.sites[s].name, ...F.sites[s].skill, n: F.sites[s].history.length }));
  const tbl = el("table", { class: "data" },
    el("thead", {}, el("tr", {}, ...["Place", "Autumns", "Model", "Typical date", "Typical + trend"].map((h) => el("th", {}, h)))),
    el("tbody", {}, ...rows.map((r) => el("tr", { class: r.s === F.cities[state.city].site ? "chosen" : "" },
      el("td", {}, r.name), el("td", {}, r.n), el("td", {}, `±${r.e_model.toFixed(1)}`), el("td", {}, `±${r.e_clim.toFixed(1)}`), el("td", {}, `±${r.e_trend.toFixed(1)}`))),
    el("tr", {}, el("td", {}, el("b", {}, "All places")), el("td", {}, d3.sum(rows, (r) => r.n)),
      el("td", {}, el("b", {}, `±${F.model.mae.model.toFixed(1)}`)), el("td", {}, `±${F.model.mae.clim.toFixed(1)}`), el("td", {}, `±${F.model.mae.trend.toFixed(1)}`))));
  document.getElementById("cv-table").replaceChildren(tbl);
  const pts = F.model.loyo.filter((r) => r[3] != null).map(([s, y, obs, mod]) => ({ s, y, obs, mod }));
  const m = { l: 56, r: 12, t: 10, b: 34 };
  const { g, iw, ih } = frame("scatter", 280, m);
  const ext = d3.extent(pts.flatMap((p) => [p.obs, p.mod]));
  const x = d3.scaleLinear([ext[0] - 3, ext[1] + 3], [0, iw]), y = d3.scaleLinear(x.domain(), [ih, 0]);
  g.append("g").attr("class", "grid").selectAll("line").data(y.ticks(5)).join("line").attr("x1", 0).attr("x2", iw).attr("y1", y).attr("y2", y);
  g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(fmtMD).tickSize(0).tickPadding(6)).call(axisClean);
  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`).call(d3.axisBottom(x).ticks(5).tickFormat(fmtMD).tickSize(0).tickPadding(8)).call(axisClean);
  g.append("line").attr("x1", 0).attr("y1", ih).attr("x2", iw).attr("y2", 0).style("stroke", "var(--axis)").style("stroke-dasharray", "4 3");
  g.append("text").attr("class", "label").attr("x", iw / 2).attr("y", ih + 30).attr("text-anchor", "middle").text("Satellite green-down");
  const cur = F.cities[state.city].site;
  g.selectAll("circle").data(pts.sort((a, b) => (a.s === cur) - (b.s === cur))).join("circle").attr("cx", (p) => x(p.obs)).attr("cy", (p) => y(p.mod)).attr("r", (p) => (p.s === cur ? 4 : 3))
    .style("fill", (p) => (p.s === cur ? "var(--accent)" : "var(--axis)")).style("opacity", (p) => (p.s === cur ? 0.95 : 0.6))
    .on("pointermove", (e, p) => tip.show(e.clientX, e.clientY, (t) => t.append(el("div", { class: "t-title" }, `${F.sites[p.s].name}, ${p.y}`), tipRow(null, fmtMD(Math.round(p.obs)), "observed"), tipRow(null, fmtMD(Math.round(p.mod)), "predicted"))))
    .on("pointerleave", () => tip.hide());
}

// ------------------------------------------------------------------ sightings & limitations
function renderSightings() {
  const list = F.sightings[state.city] || [];
  const host = document.getElementById("sightings");
  document.getElementById("sightings-sub").textContent = `iNaturalist photos of trees annotated "coloured leaves" within 80 km of ${F.cities[state.city].name} in the last four weeks.`;
  host.replaceChildren(...(list.length ? list.slice(0, 12).map((s) => el("a", { class: "card sighting", href: `https://www.inaturalist.org/observations/${s.obs}`, target: "_blank", rel: "noopener" },
    el("div", { class: "ph", style: { backgroundImage: `url("${s.photo}")` } }),
    el("div", { class: "sb" }, el("span", { class: "sn" }, s.taxon), el("span", { class: "sw" }, `${s.place || ""} · ${s.date}`), el("span", { class: "sc" }, s.attr || "")))) :
    [el("p", { class: "empty-note" }, "No photos annotated yet this month.")]));
}
function renderLimitations() {
  const c = F.cities[state.city];
  const noisy = Object.values(F.sites).filter((s) => !s.usable).map((s) => s.name);
  const items = [
    `The satellite measures a 5 × 5 km canopy, not street trees. Street trees in warm city cores can turn days later than the ravines and parks that dominate the pixel.`,
    `Peak timing for each species comes from iNaturalist annotations, which only became common around 2020 (${c.n_inat.toLocaleString("en-CA")} annotated observations near ${c.name}). Species with fewer than about 40 lean on horticultural timing.`,
    `Autumn colour is notoriously hard to predict: drought, early frost and wind can strip leaves or dull colour in ways a temperature model can't see. The out-of-sample error is ±${F.model.mae.model.toFixed(1)} days, only a little better than ±${F.model.mae.clim.toFixed(1)} for just guessing the typical date.`,
    c.borrowed ? `${c.name}'s own satellite record is dominated by summer-dry grass, so its timing borrows ${F.cities[c.borrowed].name}'s autumns, applied to local September weather.` : null,
    noisy.length ? `${noisy.join(", ")}: the satellite signal there is dominated by summer-dry grass or evergreen forest, so I don't forecast it.` : null,
    `Hue is a property of each species (sweetgum purple, ginkgo yellow); individual trees and cultivars vary.`,
    `Inventories cover city-owned trees only; private yards and most park trees aren't in them.`,
  ].filter(Boolean);
  document.getElementById("limitations").replaceChildren(...items.map((t) => el("li", {}, t)));
}
