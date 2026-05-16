# Rocket Alerts Map

Real-time map of Israeli civil rocket alerts (Tzeva Adom), with a Hebrew RTL interface built on Leaflet and plain JS.

## The problem

The Home Front Command (Oref) publishes live alert data as a JSON feed. Fetching it directly from browser JavaScript is blocked by CORS — browsers refuse cross-origin requests unless the server explicitly allows them, and Oref's API doesn't. The workaround is a proxy that fetches server-side and adds the right headers before handing the data back.

## How it works

**Frontend** (`map.html`, `map-app.js`, `map.css`)  
Leaflet map with Hebrew RTL layout. Polls for live alerts, renders affected areas as polygons, and shows a status badge indicating which data source is currently active.

**Area data** (`lamas.json`)  
Static mapping of alert area codes to city names and coordinates, sourced from official area classification data.

**Local proxy** (`alerts_proxy.py`)  
Plain Python — no framework. Forwards the upstream JSON with CORS headers and no-cache. Used as the first fallback candidate so the app works from a local machine without depending on the Vercel deployment.

## Fallback chain

The fetch routine tries endpoints in order and uses the first successful response:

```
1. Local proxy (alerts_proxy.py)
2. Vercel-hosted proxy
3. Official Oref URL directly
```

The UI shows a live source health badge so you always know which source is active and whether it's healthy. On consecutive failures, the source is marked unhealthy, the last alert stays visible until it expires, and state clears appropriately.

## Robustness

A fair amount of work went into handling the ways the upstream API misbehaves:

- **Payload parsing** — strips BOM characters and null bytes, unwraps nested `contents` strings, classifies each response as `alert` / `empty` / `invalid` to avoid crashing on malformed data
- **City resolution** — normalizes city names (punctuation, dashes, spacing variants) and checks multiple lookup maps to handle inconsistent input formats
- **Area coverage fallback** — if `lamas.json` fails to load, generates coverage polygons from resolved city coordinates so alerts still render without the area group data
- **Simulate mode** — built-in buttons create mock alerts so the UI can be tested without a live source

## Stack

- Leaflet.js, plain JS, CSS (client)
- Python standard library only (local proxy)
- Vercel (proxy deployment)

## Running locally

Open `map.html` directly in a browser. To use the local proxy:

```bash
python alerts_proxy.py
```

No dependencies beyond the Python standard library.
