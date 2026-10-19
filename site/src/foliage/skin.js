// "Kodachrome" skin extras for Fall Foliage Watch: a 1970s autumn road trip told through slide film.
// - a slide-projector control strip under the header (tray counter wheels + live readouts)
// - day-trip cards decorated as postcards (stamp + circular postmark)
// - a one-shot projector "click-clack" lamp flicker on load (skipped under reduced motion)
// - a basemap tint (faded road atlas by day, light table by night) and a footer flavour line.
// Everything exists only while data-skin="alt" is on <html> and is removed when switched off.
// Uses only data main.js already loaded, handed over through skinData().

const root = document.documentElement;
const on = () => root.dataset.skin === "alt";
const dark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const nf = new Intl.NumberFormat("en-CA");

const S = { F: null, P: null, D0: 244, D1: 349, city: null };
let built = null, flashed = false, mapRef = null;

/** main.js pushes data here: skinData({ F, P, D0, D1 }) after load, skinData({ city }) on every city change. */
export function skinData(patch) {
  Object.assign(S, patch);
  sync();
}

window.addEventListener("skinchange", sync);
window.addEventListener("foliage:basemap", (e) => { mapRef = e.detail.map; tint(mapRef); });

function sync() {
  if (!on()) { teardown(); return; }
  build();
  update();
}

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ------------------------------------------------------------------ dates (mirror main.js, UTC)
const doyDate = (doy) => new Date(Date.UTC(S.F.season, 0, 1) + (doy - 1) * 864e5);
const isoDoy = (iso) => { const d = new Date(iso + "T00:00:00Z"); return Math.round((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1; };
const md = (doy) => doyDate(doy).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" }).replace(".", "").toUpperCase();

// ------------------------------------------------------------------ build / teardown
function build() {
  if (built || !document.querySelector(".topbar")) return;

  // projector control strip
  const strip = h("div", "kc-strip");
  strip.setAttribute("aria-hidden", "true");
  strip.innerHTML = `<div class="kc-strip-in">
    <span class="kc-lamp"><i class="kc-dot"></i>Lamp on</span>
    <span class="kc-tray"><em>Days to peak</em><span class="kc-wheels" data-k="wheels"></span></span>
    <span class="kc-r"><em>Tray</em><b data-k="city">—</b></span>
    <span class="kc-r"><em>Peak</em><b data-k="peak">—</b></span>
    <span class="kc-r"><em>In colour today</em><b data-k="today">—</b></span>
    <span class="kc-r"><em>Trees mapped</em><b data-k="trees">—</b></span>
    <span class="kc-r kc-asof"><em>Data as of</em><b data-k="asof">—</b></span>
  </div>`;
  document.querySelector(".topbar").after(strip);

  // footer flavour
  const flav = h("p", "kc-flavour", "Next slide, please.");
  flav.setAttribute("aria-hidden", "true");
  document.querySelector("footer.site .wrap")?.append(flav);

  // postcards: re-decorate whenever main.js re-renders the trip cards
  const trips = document.getElementById("trips");
  const obs = new MutationObserver(() => { postcards(); datestamps(); });
  if (trips) obs.observe(trips, { childList: true });
  const sights = document.getElementById("sightings");
  if (sights) obs.observe(sights, { childList: true });

  built = { strip, flav, obs };
  if (!flashed && !still()) { flashed = true; flash(); }
  if (mapRef) tint(mapRef);
}

function teardown() {
  if (!built) return;
  built.obs.disconnect();
  built.strip.remove(); built.flav.remove();
  document.querySelectorAll(".kc-post, .kc-datestamp").forEach((n) => n.remove());
  document.querySelectorAll(".trip[data-kc]").forEach((n) => delete n.dataset.kc);
  document.querySelector(".kc-flash")?.remove();
  built = null;
}

// ------------------------------------------------------------------ live readouts
function update() {
  if (!built || !S.F || !S.P || !S.city || !S.P[S.city]) return;
  const { F, D0, D1 } = S, c = F.cities[S.city], p = S.P[S.city];
  const set = (k, v) => built.strip.querySelectorAll(`[data-k="${k}"]`).forEach((n) => { n.textContent = v; });
  const t = isoDoy(F.today), sh = p.share[Math.min(D1, Math.max(D0, t)) - D0];
  const days = p.peak - t;
  set("city", c.name.toUpperCase());
  set("peak", md(p.peak));
  set("today", `${Math.round(sh.colour * 100)}%`);
  set("trees", nf.format(c.n_trees));
  const g = new Date(F.generated);
  set("asof", `${g.toLocaleDateString("en-CA", { month: "short", day: "numeric" }).replace(".", "").toUpperCase()} ${g.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
  // mechanical tray-counter wheels; a minus wheel once the peak has passed
  const wheels = built.strip.querySelector('[data-k="wheels"]');
  const txt = (days < 0 ? "-" : "") + String(Math.abs(days)).padStart(3, "0");
  wheels.replaceChildren(...[...txt].map((ch) => { const w = h("span", "kc-wheel"); w.append(h("span", "", ch)); return w; }));
  if (!still()) wheels.querySelectorAll(".kc-wheel span").forEach((s, i) =>
    s.animate([{ transform: "translateY(-110%)" }, { transform: "translateY(18%)" }, { transform: "none" }], { duration: 420 + i * 110, easing: "cubic-bezier(.3,.6,.3,1)" }));
  postcards();
  datestamps();
}

// ------------------------------------------------------------------ snapshot date-back imprint on sighting photos
function datestamps() {
  if (!on()) return;
  document.querySelectorAll("#sightings .sighting").forEach((a) => {
    const ph = a.querySelector(".ph");
    if (!ph || ph.querySelector(".kc-datestamp")) return;
    const m = (a.querySelector(".sw")?.textContent || "").match(/(\d{2})(\d{2})-(\d{2})-(\d{2})\s*$/);
    if (!m) return;
    const s = h("span", "kc-datestamp", `'${m[2]} ${m[3]} ${m[4]}`);
    s.setAttribute("aria-hidden", "true");
    ph.append(s);
  });
}

// ------------------------------------------------------------------ postcards (day-trip cards)
const LEAF = `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3l3 6 5-2-1 7 6-4-1 6 5 1-4 4 3 2-9 2 1 4-7-2v8h-2v-8l-7 2 1-4-9-2 3-2-4-4 5-1-1-6 6 4-1-7 5 2z" fill="currentColor"/></svg>`;
function postmark(name, prov, date, year) {
  const id = "kcpm-" + Math.random().toString(36).slice(2, 8);
  const ring = `${name} · ${prov} · `;
  return `<svg class="kc-postmark" viewBox="0 0 120 70" aria-hidden="true">
    <defs><path id="${id}" d="M35 35 m-25 0 a25 25 0 1 1 50 0 a25 25 0 1 1 -50 0"/></defs>
    <circle cx="35" cy="35" r="32" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="35" cy="35" r="19" fill="none" stroke="currentColor" stroke-width="1"/>
    <text font-size="${ring.length > 34 ? 6 : 7}" letter-spacing=".4" fill="currentColor"><textPath href="#${id}" textLength="155">${ring}</textPath></text>
    <text x="35" y="33" text-anchor="middle" font-size="8.5" fill="currentColor">${date}</text>
    <text x="35" y="43" text-anchor="middle" font-size="8.5" fill="currentColor">${year}</text>
    <path d="M70 18 q8 -5 16 0 t16 0 t16 0 M70 28 q8 -5 16 0 t16 0 t16 0 M70 38 q8 -5 16 0 t16 0 t16 0 M70 48 q8 -5 16 0 t16 0 t16 0" fill="none" stroke="currentColor" stroke-width="1.4"/>
  </svg>`;
}
function postcards() {
  if (!on() || !S.F) return;
  const F = S.F, today = new Date(F.today + "T00:00:00Z");
  const date = today.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" }).replace(".", "").toUpperCase();
  document.querySelectorAll("#trips .trip").forEach((card, i) => {
    if (card.dataset.kc) return;
    const s = card.querySelector(".t-spark")?.id?.replace(/^spark-/, "");
    const site = F.sites[s];
    if (!site) return;
    card.dataset.kc = "1";
    const prov = site.region === "toronto" ? "ONT" : "B.C.";
    const name = site.name.split(" (")[0].toUpperCase();
    const stamp = h("div", "kc-post kc-stamp");
    stamp.setAttribute("aria-hidden", "true");
    stamp.innerHTML = `<span class="kc-stamp-in">${LEAF}<b>${[8, 10, 12][i % 3]}¢</b></span>`;
    const pm = h("div", "kc-post kc-pm");
    pm.setAttribute("aria-hidden", "true");
    pm.innerHTML = postmark(name, prov, date, String(F.season));
    const hi = h("div", "kc-post kc-greet", "Greetings from");
    hi.setAttribute("aria-hidden", "true");
    card.querySelector("h3")?.before(hi);
    card.prepend(stamp, pm);
  });
}

// ------------------------------------------------------------------ projector click-clack
function flash() {
  const f = h("div", "kc-flash");
  f.setAttribute("aria-hidden", "true");
  f.append(h("i", "kc-gate"));
  document.body.append(f);
  f.addEventListener("animationend", (e) => { if (e.target === f) f.remove(); });
  setTimeout(() => f.remove(), 2200);
}

// ------------------------------------------------------------------ basemap: faded road atlas (day), light table (night)
const TINT = {
  day: { land: "#e6d8bb", bg: "#ecdfc4", water: "#b5ccc6", green: "#d8d6ae", bldg: "#e2d2b4", road: "#fbf4e4", minor: "#f3e9d3", casing: "#cdb893", rail: "#c3ad8a", label: "#6a5038" },
  night: { land: "#21180f", bg: "#1e160f", water: "#0f1517", green: "#252417", bldg: "#2a2017", road: "#3a2d21", minor: "#2c2219", casing: "#463627", rail: "#3a2d21", label: "#bba486" },
};
function tint(map) {
  if (!on() || !map?.getStyle) return; // Classic: main.js's own tintBasemap() already ran
  const P = dark() ? TINT.night : TINT.day;
  const set = (id, prop, v) => { try { map.setPaintProperty(id, prop, v); } catch { /* absent in this style */ } };
  const data = new Set(["cells", "trees", "trees-icons", "sightings"]);
  for (const l of map.getStyle()?.layers || []) {
    const id = l.id;
    if (data.has(id)) continue;
    if (l.type === "background") set(id, "background-color", P.bg);
    else if (l.type === "fill") {
      if (/water/.test(id)) set(id, "fill-color", P.water);
      else if (/park|wood|grass|forest|cemetery/.test(id)) set(id, "fill-color", P.green);
      else if (/landuse|landcover|residential/.test(id)) set(id, "fill-color", P.land);
      else if (/building/.test(id)) set(id, "fill-color", P.bldg);
    } else if (l.type === "line") {
      if (/waterway|water/.test(id)) set(id, "line-color", P.water);
      else if (/casing/.test(id)) set(id, "line-color", P.casing);
      else if (/rail/.test(id)) set(id, "line-color", P.rail);
      else if (/minor|path|service|track|pier/.test(id)) set(id, "line-color", P.minor);
      else if (/highway|road|street|motorway|trunk|primary|secondary|tertiary/.test(id)) set(id, "line-color", P.road);
    } else if (l.type === "symbol" && /place|label|name|road/.test(id)) {
      set(id, "text-color", P.label);
    }
  }
}

// start: covers the skin already being on at page load (skinData() also calls sync once data arrives)
if (on()) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync); else sync(); }
