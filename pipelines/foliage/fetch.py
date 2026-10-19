"""Download raw inputs for Fall Colour Watch.

  python -m pipelines.foliage.fetch [trees|inat|photos|modis|weather|daily|all]

trees    every deciduous street tree in Victoria, Esquimalt, Vancouver and Toronto (municipal inventories)
inat     iNaturalist observations of tree genera carrying the "Leaves" annotation (green / colored / no live leaves)
modis    MODIS MCD12Q2 autumn green-down dates, 2001 onward, for each city canopy and day-trip site
weather  daily temperature for every site: ERA5 reanalysis (Open-Meteo archive) plus the current forecast
"""
from __future__ import annotations

import datetime as dt
import io
import json
import sys
import time

import numpy as np
import pandas as pd
import requests

from pipelines.common.http import USER_AGENT, get_json

from .config import (INAT_FIRST_YEAR, INAT_REGIONS, INAT_TERM_LEAVES, MODIS_API, MODIS_FIRST, MODIS_LAST, RAW, SITES)
from .species import SPECIES, lookup

S = requests.Session()
S.headers["User-Agent"] = USER_AGENT

VAN_TREES = "https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/public-trees/exports/json"
VIC_TREES = "https://maps.victoria.ca/server/rest/services/OpenData/OpenData_Parks/MapServer/15/query"
ESQ_TREES = "https://gis.esquimalt.ca/arcgis/rest/services/Services/Trees/MapServer/0/query"
TOR_PACKAGE = "street-tree-data"
TOR_CKAN = "https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show"
INAT_OBS = "https://api.inaturalist.org/v1/observations"


def save(df: pd.DataFrame, name: str) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    df.to_parquet(RAW / f"{name}.parquet", index=False)


def _street(addr: str | None) -> str:
    parts = (addr or "").split()
    if parts and parts[0].replace("-", "").isdigit():
        parts = parts[1:]
    return " ".join(parts).title()


def _keep(rows: list[dict]) -> pd.DataFrame:
    """Keep trees whose botanical name maps to a deciduous species in the trait table."""
    out = []
    for r in rows:
        hit = lookup(r["botanical"])
        if hit and r.get("lon") and r.get("lat"):
            r["key"] = hit[0]
            out.append(r)
    return pd.DataFrame(out)


def _arcgis(url: str, where: str, fields: str) -> list[dict]:
    rows, offset = [], 0
    while True:
        d = get_json(url, {"where": where, "outFields": fields, "outSR": 4326, "f": "json", "resultOffset": offset,
                           "resultRecordCount": 2000, "orderByFields": "OBJECTID"})
        feats = d.get("features", [])
        rows += feats
        # servers cap pages below the requested size (Esquimalt: 1,000), so follow their "more records" flag
        if not feats or not d.get("exceededTransferLimit"):
            return rows
        offset += len(feats)


def trees() -> None:
    frames = []
    print("Vancouver public trees…", flush=True)
    van = get_json(VAN_TREES, {"select": "asset_id,address,local_area,genus_name,species_name,cultivar_name,common_name,"
                                         "diameter_cm,height_m,geo_point_2d"}, timeout=600)
    frames.append(_keep([{
        "city": "vancouver", "id": f"van-{r['asset_id']}",
        "botanical": " ".join(x for x in [(r.get("genus_name") or "").title(), (r.get("species_name") or "").lower(),
                                          f"'{r['cultivar_name'].title()}'" if r.get("cultivar_name") else ""] if x),
        "common": (r.get("common_name") or "").title(), "street": _street(r.get("address")), "area": (r.get("local_area") or "").title(),
        "dbh_cm": r.get("diameter_cm"), "height_m": r.get("height_m"),
        "lon": (r.get("geo_point_2d") or {}).get("lon"), "lat": (r.get("geo_point_2d") or {}).get("lat")} for r in van]))
    print(f"  kept {len(frames[-1]):,} of {len(van):,}", flush=True)

    print("City of Victoria trees…", flush=True)
    vic = _arcgis(VIC_TREES, "1=1", "SiteID,Address,OnStreet,Street,BotanicalName,CommonName,DiameterAtBreastHeight,Height,Area")
    frames.append(_keep([{
        "city": "victoria", "id": f"vic-{f['attributes'].get('SiteID')}", "botanical": f["attributes"].get("BotanicalName") or "",
        "common": f["attributes"].get("CommonName") or "", "street": (f["attributes"].get("OnStreet") or f["attributes"].get("Street") or "").title(),
        "area": f["attributes"].get("Area") or "", "dbh_cm": f["attributes"].get("DiameterAtBreastHeight"), "height_m": f["attributes"].get("Height"),
        "lon": (f.get("geometry") or {}).get("x"), "lat": (f.get("geometry") or {}).get("y")} for f in vic]))
    print(f"  kept {len(frames[-1]):,} of {len(vic):,}", flush=True)

    print("Township of Esquimalt trees…", flush=True)
    esq = _arcgis(ESQ_TREES, "1=1", "uniqueid,SPP_bot,SPP_com,DBH,address,onstr,street,suffix,active")
    frames.append(_keep([{
        "city": "esquimalt", "id": f"esq-{f['attributes'].get('uniqueid')}", "botanical": f["attributes"].get("SPP_bot") or "",
        "common": f["attributes"].get("SPP_com") or "",
        "street": (f["attributes"].get("onstr") if (f["attributes"].get("onstr") or "Unassigned") != "Unassigned"
                   else " ".join(x for x in [f["attributes"].get("street"), f["attributes"].get("suffix")] if x) or "").title(),
        "area": "Esquimalt", "dbh_cm": f["attributes"].get("DBH"), "height_m": None,
        "lon": (f.get("geometry") or {}).get("x"), "lat": (f.get("geometry") or {}).get("y")} for f in esq]))
    print(f"  kept {len(frames[-1]):,} of {len(esq):,}", flush=True)

    print("Toronto street trees (datastore dump, ~690k rows)…", flush=True)
    res = get_json(TOR_CKAN, {"id": TOR_PACKAGE})["result"]["resources"]
    rid = next(r["id"] for r in res if r.get("datastore_active"))      # the dump carries BOTANICAL_NAME and GeoJSON points
    url = f"https://ckan0.cf.opendata.inter.prod-toronto.ca/datastore/dump/{rid}"
    tor = pd.read_csv(io.BytesIO(S.get(url, timeout=1800).content), low_memory=False)
    tor.columns = [c.strip().upper() for c in tor.columns]
    if "LONGITUDE" not in tor and "GEOMETRY" in tor:
        xy = tor.GEOMETRY.str.extract(r"\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)")
        tor["LONGITUDE"], tor["LATITUDE"] = xy[0].astype(float), xy[1].astype(float)
    frames.append(_keep([{
        "city": "toronto", "id": f"tor-{r.get('STRUCTID') or r.get('OBJECTID')}", "botanical": str(r.get("BOTANICAL_NAME") or ""),
        "common": str(r.get("COMMON_NAME") or ""), "street": str(r.get("STREETNAME") or "").title(), "area": f"Ward {r.get('WARD')}",
        "dbh_cm": r.get("DBH_TRUNK"), "height_m": None, "lon": r.get("LONGITUDE"), "lat": r.get("LATITUDE")}
        for r in tor.to_dict("records")]))
    print(f"  kept {len(frames[-1]):,} of {len(tor):,}", flush=True)

    df = pd.concat(frames, ignore_index=True)
    for c in ("dbh_cm", "height_m", "lon", "lat"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    save(df, "trees")
    print(f"  trees: {len(df):,} deciduous street trees · {df.key.nunique()} species groups", flush=True)


def _genus_ids() -> dict[str, int]:
    """iNaturalist taxon ids for every genus in the trait table (cached)."""
    path = RAW / "inat_genera.json"
    cache = json.loads(path.read_text()) if path.exists() else {}
    for g in sorted({k.split()[0] for k in SPECIES}):
        if g in cache:
            continue
        d = get_json("https://api.inaturalist.org/v1/taxa", {"q": g, "rank": "genus", "per_page": 5}, min_interval=1.1)
        hit = next((t for t in d.get("results", []) if t["name"].lower() == g and t.get("iconic_taxon_name") == "Plantae"), None)
        if hit:
            cache[g] = hit["id"]
    RAW.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, indent=1))
    return cache


def inat() -> None:
    """Every annotated observation (green / colored / bare leaves) of the street-tree genera, Aug–Dec, both regions."""
    ids = _genus_ids()
    taxa = ",".join(str(v) for v in ids.values())
    rows = []
    for rkey, box in INAT_REGIONS.items():
        id_above, n = 0, 0
        while True:
            d = get_json(INAT_OBS, {**box, "taxon_id": taxa, "term_id": INAT_TERM_LEAVES, "verifiable": "true",
                                    "d1": f"{INAT_FIRST_YEAR}-08-01", "month": "8,9,10,11,12", "per_page": 200,
                                    "order_by": "id", "order": "asc", "id_above": id_above}, min_interval=1.1, timeout=120)
            res = d.get("results", [])
            for o in res:
                leaves = [a["controlled_value_id"] for a in o.get("annotations", []) if a.get("controlled_attribute_id") == INAT_TERM_LEAVES]
                if not leaves or not o.get("location"):
                    continue
                lat, lon = map(float, o["location"].split(","))
                tx = o.get("taxon") or {}
                anc = {a.get("rank"): a.get("name") for a in (tx.get("ancestors") or [])}
                photo = next((ph for ph in o.get("photos", []) if ph.get("license_code")), None)
                rows.append({"region": rkey, "obs_id": o["id"], "observed_on": o.get("observed_on"), "leaves": leaves[0],
                             "lat": lat, "lon": lon, "place": o.get("place_guess"), "quality": o.get("quality_grade"),
                             "taxon": tx.get("name"), "rank": tx.get("rank"), "common": tx.get("preferred_common_name"),
                             "faves": o.get("faves_count", 0),
                             "photo": photo["url"].replace("/square.", "/medium.") if photo else None,
                             "photo_attr": photo.get("attribution") if photo else None,
                             "photo_license": photo.get("license_code") if photo else None})
            n += len(res)
            if len(res) < 200:
                break
            id_above = res[-1]["id"]
            if n % 2000 == 0:
                print(f"    {rkey}: {n:,}", flush=True)
        print(f"  iNaturalist {rkey}: {n:,} annotated tree observations", flush=True)
    df = pd.DataFrame(rows)
    df["observed_on"] = pd.to_datetime(df.observed_on, errors="coerce")
    save(df, "inat")


def _modis(lat: float, lon: float, band: str, a: str, b: str) -> dict[str, np.ndarray]:
    for attempt in range(4):
        try:
            r = S.get(MODIS_API, params={"latitude": lat, "longitude": lon, "band": band, "startDate": a, "endDate": b,
                                         "kmAboveBelow": 2, "kmLeftRight": 2}, headers={"Accept": "application/json"}, timeout=180)
            return {s["calendar_date"][:4]: np.array(s["data"]) for s in r.json()["subset"]}
        except Exception:
            time.sleep(10 * (attempt + 1))
    return {}


def modis() -> None:
    """Per site and year: median MidGreendown / Senescence day-of-year over good-quality pixels (5 x 5 km)."""
    chunks = [(y, min(y + 9, MODIS_LAST)) for y in range(MODIS_FIRST, MODIS_LAST + 1, 10)]
    rows = []
    for key, s in SITES.items():
        bands = {}
        for band in ("MidGreendown", "Senescence", "QA_Overall"):
            vals = {}
            for a, b in chunks:
                vals.update(_modis(s["lat"], s["lon"], f"{band}.Num_Modes_01", f"A{a}001", f"A{b}001"))
                time.sleep(0.4)
            bands[band] = vals
        for y in sorted(bands["MidGreendown"]):
            qa = bands["QA_Overall"].get(y)
            jan1 = (dt.date(int(y), 1, 1) - dt.date(1970, 1, 1)).days - 1
            rec = {"site": key, "year": int(y)}
            for band in ("MidGreendown", "Senescence"):
                v = bands[band].get(y)
                if v is None:
                    continue
                ok = (v < 32767) & ((qa <= 1) if qa is not None else True)
                doy = v[ok] - jan1
                doy = doy[(doy > 180) & (doy < 366)]
                rec[band.lower()] = float(np.median(doy)) if len(doy) >= 5 else None
                rec[f"n_{band.lower()}"] = int(len(doy))
            rows.append(rec)
        print(f"  MODIS {key}: {sum(1 for r in rows if r['site'] == key and r.get('midgreendown'))} years", flush=True)
    save(pd.DataFrame(rows), "modis")


def weather() -> None:
    keys = list(SITES)
    lat = ",".join(str(SITES[k]["lat"]) for k in keys)
    lon = ",".join(str(SITES[k]["lon"]) for k in keys)
    daily = "temperature_2m_mean,temperature_2m_min,temperature_2m_max,precipitation_sum"
    end = (dt.date.today() - dt.timedelta(days=6)).isoformat()
    arch = get_json("https://archive-api.open-meteo.com/v1/archive", {"latitude": lat, "longitude": lon, "start_date": "2000-01-01",
                    "end_date": end, "daily": daily, "timezone": "auto"}, timeout=900)
    fc = get_json("https://api.open-meteo.com/v1/forecast", {"latitude": lat, "longitude": lon, "daily": daily, "past_days": 14,
                  "forecast_days": 16, "timezone": "auto"}, timeout=300)
    frames = []
    for src, data in (("archive", arch), ("forecast", fc)):
        for k, loc in zip(keys, data if isinstance(data, list) else [data]):
            d = loc["daily"]
            f = pd.DataFrame({"date": pd.to_datetime(d["time"]), "tmean": d["temperature_2m_mean"], "tmin": d["temperature_2m_min"],
                              "tmax": d["temperature_2m_max"], "precip": d["precipitation_sum"]})
            f["site"], f["source"] = k, src
            frames.append(f)
    df = pd.concat(frames, ignore_index=True)
    save(df, "weather")
    print(f"  weather: {len(df):,} site-days, archive to {end}, forecast to {df.date.max():%Y-%m-%d}", flush=True)


CC = "cc0,cc-by,cc-by-sa,cc-by-nc,cc-by-nc-sa"


def photos() -> None:
    """For every species in the trait table: the most-favourited research-grade iNaturalist photo of it in autumn
    colour, anywhere, under a Creative Commons licence (credited on the page)."""
    out = {}
    for key, tr in SPECIES.items():
        name = key[0].upper() + key[1:]
        name = name.replace(" x ", " × ")
        d = get_json(INAT_OBS, {"taxon_name": name, "term_id": INAT_TERM_LEAVES, "term_value_id": 39, "quality_grade": "research",
                                "photo_license": CC, "order_by": "votes", "per_page": 6}, min_interval=1.1, timeout=120)
        for o in d.get("results", []):
            ph = next((p for p in o.get("photos", []) if (p.get("license_code") or "") in CC.split(",")), None)
            if ph:
                out[key] = {"url": ph["url"].replace("/square.", "/medium."), "attr": ph.get("attribution"),
                            "license": ph.get("license_code"), "obs": o["id"], "place": o.get("place_guess"), "faves": o.get("faves_count", 0)}
                break
        print(f"  photo {key}: {'yes' if key in out else 'none'}", flush=True)
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "photos.json").write_text(json.dumps(out, indent=1), encoding="utf-8")


def daily() -> None:
    """Daily refresh: weather and iNaturalist; trees, satellite and photos only when missing from the cache."""
    weather()
    inat()
    for name, fn in [("modis", modis), ("photos", photos), ("trees", trees)]:
        if not (RAW / (f"{name}.json" if name == "photos" else f"{name}.parquet")).exists():
            print(f"{name} missing, fetching…", flush=True)
            fn()


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what == "daily":
        daily()
    for name, fn in [("weather", weather), ("modis", modis), ("inat", inat), ("photos", photos), ("trees", trees)]:
        if what in (name, "all"):
            print(f"{name}…", flush=True)
            fn()
