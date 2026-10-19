"""Fall Foliage Watch configuration."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "foliage" / "raw"
OUT = ROOT / "site" / "public" / "data" / "foliage"

INAT_TERM_LEAVES, INAT_GREEN, INAT_COLORED, INAT_BARE = 36, 38, 39, 40
INAT_FIRST_YEAR = 2017
ANGIOSPERMS = 47125
# lowland regions for pooled leaf-colour annotations (iNaturalist)
INAT_REGIONS = {
    "pnw": dict(swlat=45.5, swlng=-125.5, nelat=50.2, nelng=-121.6),          # BC coast + western WA/OR lowlands
    "greatlakes": dict(swlat=41.5, swlng=-84.0, nelat=46.5, nelng=-74.0),     # southern Ontario + neighbours
}

# MODIS MCD12Q2 land-surface phenology (ORNL DAAC subset API, no login); a 5 x 5 km window per site
MODIS_API = "https://modis.ornl.gov/rst/api/v1/MCD12Q2/subset"
MODIS_FIRST, MODIS_LAST = 2001, 2025
SITES = {
    # city canopies (model targets)
    "toronto": {"name": "Toronto ravines", "lat": 43.70, "lon": -79.37, "region": "toronto", "kind": "city"},
    "vancouver": {"name": "Vancouver west side", "lat": 49.235, "lon": -123.16, "region": "vancouver", "kind": "city"},
    "victoria": {"name": "Oak Bay & Fairfield", "lat": 48.425, "lon": -123.33, "region": "victoria", "kind": "city"},
    # day trips
    "algonquin": {"name": "Algonquin Park (Hwy 60)", "lat": 45.55, "lon": -78.40, "region": "toronto", "kind": "trip"},
    "muskoka": {"name": "Muskoka (Huntsville)", "lat": 45.33, "lon": -79.20, "region": "toronto", "kind": "trip"},
    "haliburton": {"name": "Haliburton Highlands", "lat": 45.05, "lon": -78.50, "region": "toronto", "kind": "trip"},
    "killarney": {"name": "Killarney", "lat": 46.05, "lon": -81.35, "region": "toronto", "kind": "trip"},
    "bruce": {"name": "Bruce Peninsula", "lat": 45.10, "lon": -81.40, "region": "toronto", "kind": "trip"},
    "escarpment": {"name": "Niagara Escarpment (Dundas)", "lat": 43.27, "lon": -79.95, "region": "toronto", "kind": "trip"},
    "rouge": {"name": "Rouge National Urban Park", "lat": 43.82, "lon": -79.17, "region": "toronto", "kind": "trip"},
    "kawartha": {"name": "Kawartha Highlands", "lat": 44.75, "lon": -78.25, "region": "toronto", "kind": "trip"},
    "fraser": {"name": "Fraser Valley (Chilliwack)", "lat": 49.15, "lon": -121.90, "region": "vancouver", "kind": "trip"},
    "cowichan": {"name": "Cowichan Valley", "lat": 48.80, "lon": -123.75, "region": "victoria", "kind": "trip"},
    "manning": {"name": "Manning Park larches", "lat": 49.03, "lon": -120.85, "region": "vancouver", "kind": "trip"},
    "kootenay": {"name": "Kootenay larches (Kimberley)", "lat": 49.70, "lon": -116.05, "region": "vancouver", "kind": "trip"},
}
