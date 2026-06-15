# XWIND Calc

Standalone offline-first aviation crosswind calculator PWA.

## Deploy

Upload this folder to a GitHub repository and point Cloudflare Pages at it. The app is fully static and offline-first.

- Build command: leave blank
- Output directory: `/` if this folder is the repo root, or `outputs/xwind` if deploying from the parent workspace
- Required files: `index.html`, `styles.css`, `app.js`, `manifest.json`, `service-worker.js`, `assets/`, `icons/`, `data/`

## Run Locally

```powershell
python -m http.server 8768
```

Then open `http://127.0.0.1:8768/`.

## Data

The bundled runway database uses FAA NASR APT CSV data for U.S. airports, a small curated chart-verified override layer for selected military and overseas fields, and OurAirports `airports.csv` / `runways.csv` as the worldwide fallback. The current generated file contains 35,752 airports with runway data before overrides.

Curated chart-verified overrides live in `data/military-overrides.js` so commonly visited fields can be corrected without regenerating the whole worldwide database. Current curated entries include EGUL, EGUN, EGVA, ETAR, ETAD, LGSA, LICZ, LPLA, LEMO, LERT, LTAG, OMAM, OKAS, ORAA, OTBH, OEPS, PGUA, RJTY, RODN, RKJK, and RKSO.

For U.S. airports, runway labels come from FAA NASR `APT_RWY` / `APT_RWY_END`. Civil FAA runway headings prefer FAA `TRUE_ALIGNMENT` with the airport's FAA magnetic variation of record so they stay close to chart-published runway bearings. FAA military fields use runway-end geometry with MAGVAR 2025 when that better matches checked military charts. The generator falls back to coordinate/MAGVAR or runway number only when needed. The OurAirports fallback converts true runway headings to magnetic with MAGVAR 2025 and calculates the opposite runway end as a reciprocal heading.

Runway heading tolerance: FAA/MAGVAR and chart-verified curated headings are expected to be within about 1 degree of current charted runway direction. MAGVAR-processed worldwide fallback headings are improved but may still be rounded, stale, or source-limited and can vary by several degrees or more, so users should verify against current official publications for operational use.

The current FAA cycle used here is NASR effective 2026-06-11. As of June 15, 2026, FAA lists this as the current NASR subscription cycle.

## Updating

When deploying a new version, bump `CACHE_NAME` in `service-worker.js`. Users with the installed app will see the Update button after the new service worker is detected.

Wind entry is manual. The wind box accepts compact wind groups such as `27015G25`, `270/15G25`, and `VRB06`.
