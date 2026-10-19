"""Fall Colour Watch: autumn timing model, this season's forecast, and the files the page reads.

  python -m pipelines.foliage.build

Timing model
    Target: the MODIS (MCD12Q2) mid-green-down date of each site, 2001 onward. It is the day the canopy has lost
    half its seasonal greenness, which in a deciduous canopy falls between first colour and leaf drop.
    Model: each site's typical date, shifted by how warm its September was. A warm September delays the autumn,
    and one slope (days per °C) is shared by every site. I tested candidates by leaving each year out: September
    warmth beat a site's typical date (MAE 3.55 vs 3.79 days). A cold degree-day senescence model (Delpierre et al.
    2009), August or late-summer windows, and a linear trend did not.
    Sites whose satellite signal is noisier than ±9 days a year are dominated by summer-dry grass or evergreen forest,
    so they are not modelled. A city among them (Victoria) borrows a nearby city's typical date and slope, applied to
    its own September weather.
    This season: once September is over it is known. Before that, the rest of the month is filled with each past
    year's weather. The model's own out-of-sample errors give the range.

Calibration to what people see
    iNaturalist observers annotate trees as green, coloured or leafless. Each observation is aligned on that year's
    green-down date (observed, or predicted). Two logistic curves (green → turning, leafy → bare) then place the colour
    window around the satellite date, and per-species shifts say which trees go early or late.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timezone

import numpy as np
import pandas as pd
from scipy.optimize import minimize

from .config import INAT_BARE, INAT_COLORED, INAT_GREEN, OUT, RAW, SITES
from .species import HUES, SPECIES, TIER_BLURB, TIMING, lookup

CITIES = {
    "victoria": {"name": "Greater Victoria", "site": "victoria", "inat": "pnw", "center": [-123.36, 48.44], "zoom": 12.6,
                 "tree_cities": ["victoria", "esquimalt"], "credit": "City of Victoria and Township of Esquimalt"},
    "vancouver": {"name": "Vancouver", "site": "vancouver", "inat": "pnw", "center": [-123.12, 49.255], "zoom": 12.2,
                  "tree_cities": ["vancouver"], "credit": "City of Vancouver"},
    "toronto": {"name": "Toronto", "site": "toronto", "inat": "greatlakes", "center": [-79.40, 43.70], "zoom": 11.4,
                "tree_cities": ["toronto"], "credit": "City of Toronto"},
}
TODAY = pd.Timestamp(date.today())
SEASON = TODAY.year if TODAY.month >= 6 else TODAY.year - 1
CELL_LAT, CELL_LON = 0.01, 0.014          # map chunk size, about 1.1 km
LOCAL_KM = 120                            # iNaturalist observations near a city
MAX_SD = 9.0                              # noisier satellite records are not leaf colour
SEP = (244, 273)                          # September, as days of year (non-leap)
# iNaturalist "Colored Leaves" marks visible colour onset; each tree is mostly bare ~24 days after its own onset
# (about a week to full colour, then ~16 days from 50% colour to 50% leaf fall at Harvard Forest)
LEAF_FALL_GAP = 24.0


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else round(float(o), 3)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (pd.Timestamp, datetime, date)):
        return o.strftime("%Y-%m-%d")
    return o


def dump(path, obj, quiet=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean(obj), f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    if not quiet:
        print(f"  wrote {path.relative_to(OUT)} ({path.stat().st_size / 1024:,.0f} KB)")


# ============================================================================= weather & targets

def load_weather() -> tuple[dict[str, pd.Series], pd.Timestamp]:
    w = pd.read_parquet(RAW / "weather.parquet")
    out = {}
    for site, g in w.groupby("site"):
        g = g.sort_values(["date", "source"])           # archive before forecast for the same day
        out[site] = g.drop_duplicates("date", keep="first").set_index("date").tmean.astype(float).interpolate(limit=3)
    return out, w[w.source == "archive"].date.max()


def sep_mean(t: pd.Series, year: int, fill_from: int | None = None) -> float:
    """Mean daily temperature over September; days not yet observed come from `fill_from`'s September."""
    seg = t[(t.index >= pd.Timestamp(year, 9, 1)) & (t.index <= pd.Timestamp(year, 9, 30))]
    if len(seg) >= 30 or fill_from is None:
        return float(seg.mean()) if len(seg) >= 27 else np.nan
    rest = t[(t.index > (seg.index.max().replace(year=fill_from) if len(seg) else pd.Timestamp(fill_from, 8, 31)))
             & (t.index <= pd.Timestamp(fill_from, 9, 30))]
    return float(np.concatenate([seg.to_numpy(), rest.to_numpy()]).mean())


# ============================================================================= timing model

def fit(D: pd.DataFrame):
    """Site means of green-down and September temperature, and one shared slope (days per °C)."""
    mu = D.groupby("site").obs.mean()
    tbar = D.groupby("site").tsep.mean()
    a = D.tsep - D.site.map(tbar)
    dev = D.obs - D.site.map(mu)
    beta = float(np.sum(a * dev) / np.sum(a ** 2))
    return {"mu": mu.to_dict(), "tbar": tbar.to_dict(), "beta": beta}


def predict(m, site, tsep):
    return m["mu"][site] + m["beta"] * (tsep - m["tbar"][site])


def evaluate(D: pd.DataFrame):
    """Leave-one-year-out: refit without the year, predict it, and compare with the typical date and a linear trend."""
    rows = []
    for y in sorted(D.year.unique()):
        tr, te = D[D.year != y], D[D.year == y]
        m = fit(tr)
        for r in te.itertuples():
            q = tr[tr.site == r.site]
            b = np.polyfit(q.year, q.obs, 1)
            rows.append({"site": r.site, "year": int(y), "obs": r.obs, "model": predict(m, r.site, r.tsep),
                         "clim": float(q.obs.median()), "trend": float(np.polyval(b, y)), "tsep": r.tsep})
    return pd.DataFrame(rows)


def season_forecast(site: str, donor: str, weather: dict, m: dict, resid: np.ndarray, hist_years: list[int]):
    """This season's green-down: September known (or filled from past years), plus the model's out-of-sample errors."""
    t = weather[site]
    sep_done = TODAY >= pd.Timestamp(SEASON, 10, 1)
    temps = [sep_mean(t, SEASON)] if sep_done else [sep_mean(t, SEASON, fill_from=y) for y in hist_years]
    tbar_own = float(np.nanmean([sep_mean(t, y) for y in hist_years]))
    centres = np.array([m["mu"][donor] + m["beta"] * (x - tbar_own) for x in temps])
    rng = np.random.default_rng(7)
    sims = rng.choice(centres, 4000) + rng.choice(resid, 4000)
    return {"p10": float(np.percentile(sims, 10)), "p50": float(np.percentile(sims, 50)), "p90": float(np.percentile(sims, 90)),
            "sep_anom": float(np.mean(temps) - tbar_own), "sep_mean": float(np.mean(temps)), "sep_done": bool(sep_done),
            "typical": float(m["mu"][donor]), "sims": np.percentile(sims, np.arange(0, 101, 2)).round(1).tolist()}


# ============================================================================= iNaturalist calibration

def haversine(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = np.sin((lat2 - lat1) * r / 2) ** 2 + np.cos(lat1 * r) * np.cos(lat2 * r) * np.sin((lon2 - lon1) * r / 2) ** 2
    return 12742 * np.arcsin(np.sqrt(a))


def logistic_fit(x: np.ndarray, y: np.ndarray, w: np.ndarray | None = None):
    """P(y=1|x) = 1/(1+exp(-(x-t)/s)). Returns (t, s, se_t)."""
    w = np.ones_like(x, dtype=float) if w is None else w

    def nll(p):
        t, ls = p
        s = np.exp(ls)
        z = np.clip((x - t) / s, -30, 30)
        pr = 1 / (1 + np.exp(-z))
        pr = np.clip(pr, 1e-6, 1 - 1e-6)
        return -np.sum(w * (y * np.log(pr) + (1 - y) * np.log(1 - pr)))
    t0 = float(np.median(x))
    r = minimize(nll, [t0, np.log(8)], method="Nelder-Mead", options={"xatol": 0.01, "fatol": 0.01, "maxiter": 2000})
    t, ls = r.x
    # standard error of t from a numerical Hessian
    h = 0.5
    f0, fp, fm = nll([t, ls]), nll([t + h, ls]), nll([t - h, ls])
    d2 = (fp - 2 * f0 + fm) / h ** 2
    se = float(1 / math.sqrt(d2)) if d2 > 0 else np.nan
    return float(t), float(np.exp(ls)), se


def calibrate(inat: pd.DataFrame, mgd: dict[tuple, float]):
    """Align observations on each city-year's green-down date; fit the colour window and species shifts."""
    out = {}
    for ckey, c in CITIES.items():
        site = c["site"]
        lon0, lat0 = c["center"]
        d = inat[(inat.region == c["inat"])].copy()
        d["km"] = haversine(lat0, lon0, d.lat.to_numpy(), d.lon.to_numpy())
        d = d[(d.km <= LOCAL_KM) & d.observed_on.notna()]
        d["year"] = d.observed_on.dt.year
        d["doy"] = d.observed_on.dt.dayofyear
        d["ref"] = [mgd.get((site, y)) for y in d.year]
        d = d.dropna(subset=["ref"])
        d["rel"] = d.doy - d.ref
        d = d[(d.rel > -70) & (d.rel < 70)]
        hit = [lookup(str(t)) for t in d.taxon]
        d["key"] = [h[0] if h else None for h in hit]
        turned = (d.leaves != INAT_GREEN).astype(float).to_numpy()
        bare = (d.leaves == INAT_BARE).astype(float).to_numpy()
        t1, s1, se1 = logistic_fit(d.rel.to_numpy(float), turned)
        t2, s2, se2 = logistic_fit(d.rel.to_numpy(float), bare)
        # species shifts on the turning curve, slope fixed at the pooled value, shrunk toward the timing prior
        shifts = {}
        for key, g in d.dropna(subset=["key"]).groupby("key"):
            prior = TIMING[SPECIES[key]["timing"]]
            n = len(g)
            if n >= 15 and 0 < g.leaves.ne(INAT_GREEN).mean() < 1:
                x, yv = g.rel.to_numpy(float) - t1, g.leaves.ne(INAT_GREEN).astype(float).to_numpy()
                r = minimize(lambda p: -np.sum(yv * np.log(np.clip(1 / (1 + np.exp(-(x - p[0]) / s1)), 1e-6, 1)) +
                                               (1 - yv) * np.log(np.clip(1 - 1 / (1 + np.exp(-(x - p[0]) / s1)), 1e-6, 1))),
                             [0.0], method="Nelder-Mead")
                est = float(np.clip(r.x[0], -30, 30))
                k = 40.0
                shifts[key] = {"shift": (n * est + k * prior) / (n + k), "n": n, "measured": est}
            else:
                shifts[key] = {"shift": float(prior), "n": n, "measured": None}
        # the pooled turning curve mixes early and late species; refit it with each species' shift removed,
        # so a single tree turns over a realistic width rather than the whole city's spread
        k_ = d.dropna(subset=["key"])
        adj = k_.rel.to_numpy(float) - k_.key.map(lambda k: shifts[k]["shift"]).to_numpy(float)
        t1w, s1w, se1w = logistic_fit(adj, k_.leaves.ne(INAT_GREEN).astype(float).to_numpy())
        # leaf fall: iNaturalist under-records bare trees (people rarely photograph them), so the "no leaves" curve
        # runs late. Use the ground-phenology gap between 50% colour and 50% leaf fall instead (Harvard Forest, ~16 d).
        # trees of one species vary a lot (microsite, age, drought stress on street trees), and the observed spread s1w
        # captures that; leaf fall follows each tree's own onset, so it shares the same spread
        out[ckey] = {"t1": t1w, "s1": s1w, "se1": se1w, "t2": t1w + LEAF_FALL_GAP, "s2": s1w, "se2": None,
                     "t2_inat": t2, "n": int(len(d)), "years": sorted(int(y) for y in d.year.unique()), "shifts": shifts}
        print(f"  calibration {ckey}: n={len(d):,} turning at MGD{t1w:+.1f}d (within-species s={s1w:.1f}; pooled {t1:+.1f}, s={s1:.1f}); "
              f"iNat bare at {t2:+.1f}d (not used); {sum(1 for v in shifts.values() if v['measured'] is not None)} species measured", flush=True)
    return out


def recent_check(inat: pd.DataFrame, city: str, cal: dict, mgd_pred: float):
    """Share of observations annotated as turning or bare in the last 21 days, against what the model expects."""
    c = CITIES[city]
    lon0, lat0 = c["center"]
    d = inat[(inat.region == c["inat"]) & (inat.observed_on >= TODAY - pd.Timedelta(days=21))].copy()
    d = d[haversine(lat0, lon0, d.lat.to_numpy(), d.lon.to_numpy()) <= LOCAL_KM]
    if len(d) < 8:
        return {"n": int(len(d))}
    # compare like with like: each photographed tree against its own species' expected timing
    shift = np.array([cal["shifts"].get(h[0], {}).get("shift", 0.0) if (h := lookup(str(t))) else 0.0 for t in d.taxon])
    rel = d.observed_on.dt.dayofyear.to_numpy(float) - mgd_pred - shift
    exp = 1 / (1 + np.exp(-(rel - cal["t1"]) / cal["s1"]))
    return {"n": int(len(d)), "observed": float((d.leaves != INAT_GREEN).mean()), "expected": float(exp.mean())}


# ============================================================================= trees → map tiles

def build_trees(trees: pd.DataFrame, species_index: dict[str, int]):
    for ckey, c in CITIES.items():
        t = trees[trees.city.isin(c["tree_cities"])].copy()
        t["sp"] = t.key.map(species_index)
        t["ix"] = np.floor(t.lon / CELL_LON).astype(int)
        t["iy"] = np.floor(t.lat / CELL_LAT).astype(int)
        cells = []
        commons = sorted(set(t.common.fillna("").astype(str)))           # inventory common names, shared per city
        cidx = {n: i for i, n in enumerate(commons)}
        base = OUT / "trees" / ckey
        if base.exists():
            for f in base.glob("*.json"):
                f.unlink()
        for (ix, iy), g in t.groupby(["ix", "iy"]):
            # coordinates as integers (degrees × 1e5, ~1 m): the JSON writer rounds floats to 3 decimals
            streets_here = sorted(set(g.street.fillna("").astype(str)))
            sidx = {n: i for i, n in enumerate(streets_here)}
            rows = [[int(round(r.lon * 1e5)), int(round(r.lat * 1e5)), int(r.sp), int(r.dbh_cm) if pd.notna(r.dbh_cm) else 0,
                     sidx[str(r.street or "")], cidx[str(r.common or "")]] for r in g.itertuples()]
            dump(base / f"{ix}_{iy}.json", {"s": streets_here, "r": rows}, quiet=True)
            hist = g.sp.value_counts()
            cells.append([int(ix), int(iy), int(len(g)), [[int(k), int(v)] for k, v in hist.items()]])
        # streets with the most colourful trees
        colourful = t[t.key.map(lambda k: SPECIES[k]["tier"] in ("S", "A", "B"))]
        st = colourful[colourful.street.str.len() > 0].groupby("street")
        streets = sorted(([name, int(len(g)), [[int(k), int(v)] for k, v in g.sp.value_counts().items()],
                           [round(g.lon.median(), 5), round(g.lat.median(), 5)]] for name, g in st if len(g) >= 6),
                         key=lambda r: -r[1])[:700]
        dump(base / "index.json", {"cell": [CELL_LON, CELL_LAT], "cells": cells, "streets": streets, "commons": commons, "n": int(len(t))})
        print(f"  trees {ckey}: {len(t):,} trees in {len(cells)} tiles, {len(streets)} streets", flush=True)


def pick_photos(inat: pd.DataFrame):
    """One autumn photo per species key: coloured leaves, CC licence, research grade preferred, most faves."""
    ok = inat[(inat.leaves == INAT_COLORED) & inat.photo.notna() & inat.photo_license.notna()].copy()
    hit = [lookup(str(t)) for t in ok.taxon]
    ok["key"] = [h[0] if h else None for h in hit]
    ok = ok.dropna(subset=["key"])
    ok["score"] = ok.faves * 3 + (ok.quality == "research") * 2 + ok.observed_on.dt.month.isin([10, 11])
    best = ok.sort_values("score", ascending=False).groupby("key").head(1)
    local = {r.key: {"url": r.photo, "attr": r.photo_attr, "license": r.photo_license, "obs": int(r.obs_id), "place": r.place}
             for r in best.itertuples()}
    # prefer the community's most-favourited autumn photo of each species (fetched separately), then a local one
    path = RAW / "photos.json"
    top = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return {**local, **top}


# ============================================================================= main

def main():
    gen = datetime.now(timezone.utc).isoformat(timespec="minutes")
    weather, archive_end = load_weather()
    tg = pd.read_parquet(RAW / "modis.parquet").dropna(subset=["midgreendown"])
    T = {s: {int(r.year): float(r.midgreendown) for r in g.itertuples()} for s, g in tg.groupby("site")}
    good = [s for s in SITES if s in T and len(T[s]) >= 15 and np.std(list(T[s].values())) <= MAX_SD]
    print(f"  sites with a usable satellite record: {good}", flush=True)
    hist_years = sorted({y for s in good for y in T[s]})

    D = pd.DataFrame([{"site": s, "year": y, "obs": d, "tsep": sep_mean(weather[s], y)} for s in good for y, d in T[s].items()]).dropna()
    model = fit(D)
    ev = evaluate(D)
    for k in ("model", "clim", "trend"):
        ev[f"e_{k}"] = (ev[k] - ev.obs).abs()
    skill = ev.groupby("site")[["e_model", "e_clim", "e_trend"]].mean()
    print(f"  September model: {model['beta']:+.2f} days per °C · LOYO MAE {ev.e_model.mean():.2f} d "
          f"vs typical date {ev.e_clim.mean():.2f} d vs trend {ev.e_trend.mean():.2f} d", flush=True)
    print(skill.round(2).to_string())
    resid_all = (ev.obs - ev.model).to_numpy()
    cover = float(np.mean([(np.quantile(np.delete(resid_all, i), 0.1) <= r <= np.quantile(np.delete(resid_all, i), 0.9))
                           for i, r in enumerate(resid_all)]))

    # this season, per site; cities without a usable record borrow a nearby city's typical date and slope
    forecast, borrowed = {}, {}
    for s in SITES:
        donor = s if s in good else None
        if donor is None and any(c["site"] == s for c in CITIES.values()):
            donor = "vancouver" if SITES[s]["region"] in ("victoria", "vancouver") else "toronto"
            borrowed[s] = donor
        if donor is None:
            continue
        r = (ev[ev.site == donor].obs - ev[ev.site == donor].model).to_numpy()
        forecast[s] = season_forecast(s, donor, weather, model, r if len(r) >= 15 else resid_all, hist_years)
    for s, f in forecast.items():
        print(f"  {s:11s} {SEASON}: green-down ~day {f['p50']:.0f} (80% {f['p10']:.0f}–{f['p90']:.0f}), September {f['sep_anom']:+.1f} °C"
              + (f" [borrows {borrowed[s]}]" if s in borrowed else ""), flush=True)

    # green-down per city-year: satellite where usable, the model where borrowed, the forecast for this season
    mgd = {(s, y): d for s in good for y, d in T[s].items()}
    for s, donor in borrowed.items():
        tb = float(np.nanmean([sep_mean(weather[s], y) for y in hist_years]))
        mgd.update({(s, y): model["mu"][donor] + model["beta"] * (sep_mean(weather[s], y) - tb) for y in hist_years})
    for s, f in forecast.items():
        mgd[(s, SEASON)] = f["p50"]

    inat = pd.read_parquet(RAW / "inat.parquet")
    cal = calibrate(inat, mgd)
    trees = pd.read_parquet(RAW / "trees.parquet")
    present = trees.key.value_counts()
    species_keys = [k for k in SPECIES if k in present.index]
    species_index = {k: i for i, k in enumerate(species_keys)}
    photos = pick_photos(inat)
    build_trees(trees, species_index)

    cities = {}
    for ckey, c in CITIES.items():
        s = c["site"]
        f, cl = forecast.get(s), cal[ckey]
        t_city = trees[trees.city.isin(c["tree_cities"])]
        donor = borrowed.get(s, s)
        hist = T.get(donor, {})
        yrs, ds = np.array(sorted(hist)), np.array([hist[y] for y in sorted(hist)])
        # the September story: each past year's temperature anomaly against its green-down shift (own or donor site)
        sep_pts = ev[ev.site == donor][["year", "tsep", "obs"]].copy()
        sep_pts["anom"] = sep_pts.tsep - model["tbar"][donor]
        sep_pts["shift"] = sep_pts.obs - model["mu"][donor]
        cities[ckey] = {
            "name": c["name"], "center": c["center"], "zoom": c["zoom"], "credit": c["credit"], "site": s, "borrowed": borrowed.get(s),
            "n_trees": int(len(t_city)), "mgd": f, "t1": cl["t1"], "s1": cl["s1"], "t2": cl["t2"], "s2": cl["s2"],
            "se1": cl["se1"], "se2": cl["se2"], "n_inat": cl["n"], "inat_years": cl["years"],
            "shifts": {species_index[k]: v["shift"] for k, v in cl["shifts"].items() if k in species_index},
            "shift_measured": {species_index[k]: v["measured"] for k, v in cl["shifts"].items() if k in species_index and v["measured"] is not None},
            "species_counts": {species_index[k]: int(v) for k, v in t_city.key.value_counts().items() if k in species_index},
            "recent": recent_check(inat, ckey, cl, f["p50"]) if f else {"n": 0},
            "trend_per_decade": float(np.polyfit(yrs, ds, 1)[0] * 10) if len(yrs) > 5 else None,
            "clim_mgd": float(np.median(ds)) if len(ds) else None,
            "skill": skill.loc[donor].to_dict() if donor in skill.index else None,
            "september": {"points": sep_pts[["year", "anom", "shift"]].round(2).values.tolist(), "beta": model["beta"],
                          "this_anom": f["sep_anom"] if f else None, "sep_done": f["sep_done"] if f else None},
        }
    sites_out = {}
    for s, meta in SITES.items():
        hist = T.get(s, {})
        sites_out[s] = {**meta, "usable": s in good, "history": [[y, hist[y]] for y in sorted(hist)],
                        "forecast": forecast.get(s) if s in good else None, "skill": skill.loc[s].to_dict() if s in skill.index else None,
                        "sd": float(np.std(list(hist.values()))) if hist else None}
    species = [{"key": k, "i": species_index[k], **SPECIES[k], "colour": HUES[SPECIES[k]["hue"]],
                "photo": photos.get(k) or photos.get(k.split()[0]),
                "count": {ck: int(((trees.city.isin(c["tree_cities"])) & (trees.key == k)).sum()) for ck, c in CITIES.items()}}
               for k in species_keys]
    sight = {}
    for ckey, c in CITIES.items():
        lon0, lat0 = c["center"]
        d = inat[(inat.leaves == INAT_COLORED) & inat.photo.notna() & (inat.observed_on >= TODAY - pd.Timedelta(days=28))].copy()
        d = d[haversine(lat0, lon0, d.lat.to_numpy(), d.lon.to_numpy()) <= 80].sort_values("observed_on", ascending=False).head(24)
        sight[ckey] = [{"date": r.observed_on, "taxon": r.common or r.taxon, "sci": r.taxon, "photo": r.photo, "attr": r.photo_attr,
                        "license": r.photo_license, "place": r.place, "obs": int(r.obs_id), "lon": r.lon, "lat": r.lat}
                       for r in d.itertuples()]
    dump(OUT / "foliage.json", {
        "generated": gen, "season": SEASON, "today": TODAY, "weather_to": archive_end, "cities": cities, "sites": sites_out,
        "species": species, "hues": HUES, "tiers": TIER_BLURB, "sightings": sight,
        "model": {"beta": model["beta"], "sites": good, "coverage80": cover,
                  "loyo": ev[["site", "year", "obs", "model", "clim", "trend"]].round(1).values.tolist(),
                  "mae": {"model": float(ev.e_model.mean()), "clim": float(ev.e_clim.mean()), "trend": float(ev.e_trend.mean())}},
    })


if __name__ == "__main__":
    main()
