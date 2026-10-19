# Fall Foliage Watch

Fall-colour forecast for ~800k street trees, a colour tier list, day trips and 25 satellite autumns. Region: Greater Victoria, Vancouver, Toronto & Ontario.

**Live dashboard: https://markandrewjenkins.github.io/fall-foliage-watch/**

Built only on free, open government and citizen-science data. A Python pipeline fetches and models the data,
and a static Vite + d3 + MapLibre page presents it. GitHub Actions refreshes everything daily and publishes it
to GitHub Pages.

## Method in brief

- **Satellite autumns:** NASA MODIS MCD12Q2 mid-green-down dates (2001–2025), the median of a 5 × 5 km window per place, fetched from the ORNL DAAC subset service (no login). Places with year-to-year scatter above ±9 days are dominated by summer-dry grass or evergreen forest and aren't modelled; Victoria, Cowichan and the Fraser Valley fall into this group.
- **Timing model:** each place's typical date, shifted +1.8 days per °C of September warmth, with one slope shared by every place. Tested by leaving each year out: ±3.55 days against ±3.79 for the typical date. A cold-degree-day senescence model, August windows and a linear trend all did no better and were dropped. Victoria borrows Vancouver's typical date and slope, applied to its own September.
- **Street-tree colour:** iNaturalist "Leaves" annotations (green / coloured / leafless) are aligned on each year's green-down. They give when colour starts, how widely trees of one species vary (±15 days), and per-species shifts shrunk toward horticultural priors. Leaf fall is set ~24 days after each tree's colour onset (ground phenology), because people rarely photograph bare trees. The page shows observers' last-three-weeks share against the model's as a live check.
- **Map:** ~800k deciduous trees from the Victoria, Esquimalt, Vancouver and Toronto inventories, split into ~1 km JSON tiles that load as you pan, with species-mix squares when zoomed out. A searchable checklist picks individual species (tier chips act as presets), and the squares fade where few of the chosen trees grow.
- **Day trips:** in a closed forest canopy the satellite's half-way green-down falls close to peak colour, so trip cards use it directly.

All data is published under open licences (OGL-Canada, OGL-Vancouver, OGL-Victoria, OGL-Toronto; NASA data is public domain). iNaturalist observations remain © their observers.

## Design

The page has a Classic design and a themed alternative, **Kodachrome** (1970s road-trip scrapbook / slide light table), switched with the
button in the top bar or with `?skin=alt` / `?skin=classic` in the URL. Each has a day and a night version.

## Running locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # macOS/Linux: .venv/bin/pip
.venv/Scripts/python -m pipelines.foliage.fetch daily
.venv/Scripts/python -m pipelines.foliage.build
cd site && npm ci && npm run dev
```

Data licences are listed at the foot of the dashboard.
