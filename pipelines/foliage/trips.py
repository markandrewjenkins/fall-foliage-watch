"""Trip-planner networks and ready-made colour routes for Fall Foliage Watch.

  python -m pipelines.foliage.trips

Run after pipelines.foliage.build: writes trip_<city>_<mode>.json (road networks with each street's trees by species)
and trips.json (ready-made routes through the streets with the most S- and A-tier autumn trees).
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from pipelines.common import treetrips

from .config import OUT, RAW

SHARED = Path(__file__).resolve().parents[2] / "data" / "sunday" / "raw"     # reuse Sunday Drive's road download when present
OSM = Path(__file__).resolve().parents[2] / "data" / "osm"                  # city extracts (.osm.pbf) from BBBike
CITIES = {
    "victoria": {"pbf": "Victoria", "bbox": (48.400, -123.440, 48.475, -123.300), "tree_cities": ["victoria", "esquimalt"]},
    "vancouver": {"pbf": "Vancouver", "bbox": (49.195, -123.230, 49.320, -123.020), "tree_cities": ["vancouver"]},
    "toronto": {"pbf": "Toronto", "bbox": (43.580, -79.640, 43.860, -79.110), "tree_cities": ["toronto"]},
}


def main():
    F = json.loads((OUT / "foliage.json").read_text(encoding="utf-8"))
    idx = {s["key"]: s["i"] for s in F["species"]}
    good = {s["i"] for s in F["species"] if s["tier"] in ("S", "A")}
    trees = pd.read_parquet(RAW / "trees.parquet")
    trees = trees[trees.key.isin(idx)].assign(cls=lambda d: d.key.map(idx).astype(int))
    out = {}
    for key, c in CITIES.items():
        print(f"{key}…", flush=True)
        t = trees[trees.city.isin(c["tree_cities"])][["lon", "lat", "street", "cls"]]
        out[key] = {"presets": treetrips.build_city(key, c["bbox"], RAW / f"trip_{key}", OUT, "trip_", t, good,
                                                   shared=[SHARED / key / "roads.json"], pbf_city=c["pbf"], osm_dir=OSM, label="S- and A-tier colour trees")}
    (OUT / "trips.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print("  wrote trips.json", flush=True)


if __name__ == "__main__":
    main()
