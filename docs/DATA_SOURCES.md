# Data provenance and redistribution

The default Demo and Live Muse modes use local evidence. They never request live routing, geocoding, places or weather. Live Muse changes only the inference provider. Full Live explicitly enables external providers, subject to their flags and budgets. No map tiles are bundled or bulk downloaded; the optional basemap needs a network connection, while route lines, exits and simulation remain available without tiles.

## OpenStreetMap routes and places

`data/routes/toronto-montreal.json` is a simplified OSRM road geometry with Overpass `motorway_junction` exits. Its `fetchedAt` records acquisition time. `data/recorded/routes/*.json` contains validated, simplified OSRM routes and exits with their acquisition time and attribution. `data/recorded/overpass/*.json` contains small bounded OSM query recordings, query cache keys, and `at` acquisition timestamps. These are evidence snapshots, not current business verification. Current recordings cover route geometry for Home–Letchworth and Home–Niagara, and limited place windows; they do **not** provide comprehensive place coverage for arbitrary routes.

These OSM-derived data files are distributed under the [Open Database License 1.0 (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/): **© OpenStreetMap contributors**. See [OSM copyright and licensing](https://www.openstreetmap.org/copyright) and [OSMF attribution guidelines](https://osmfoundation.org/wiki/Attribution_Guidelines). The ODbL applies to the OSM-derived data, including the complete derived datasets distributed here. Keep this notice and attribution when redistributing or modifying those datasets. The public [OSRM demo service](https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server) and [Nominatim service](https://operations.osmfoundation.org/policies/nominatim/) have separate usage policies; open data licensing does not imply unlimited hosted-service access.

Real OSM places retain their OSM IDs, snapshot date, and cached provenance. Missing opening hours, menu details, and facility evidence stay unknown. Chain-level hints are marked possible, not verified. Caches are read before any optional network access; places use bounded 30 km tiles, with memory/disk caching and in-flight Overpass deduplication.

## Fictional demo stops

`data/stops/*.mock.json` contains authored fictional businesses and illustrative scores/hours, anchored to the real 401 road geometry and exits at runtime. These are explicitly labeled **FICTIONAL DEMO**. They are suitable for the recommended keyless Highway 401 demonstration and do not establish claims about actual businesses. No scraped reviews or third-party proprietary POI results are included.

## Weather

`data/weather/demo.snapshot.json` is an **authored mock snapshot dated 2026-11-04**, released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). It is not an observation, a live forecast, or a recorded Open-Meteo response. It supplies repeatable sunny/cloudy/cold/rain/snow scenario values, displayed as simulated; scenario times are replay times. Demo and Live Muse use it even if a client requests live weather.

Optional Full Live weather uses [Open-Meteo](https://open-meteo.com/), with hourly evidence cached by coarse spatial cell and timezone for 30 minutes. Forecast failures and dates outside the available forecast range are labeled and fall back to simulated conditions. Open-Meteo data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); its [terms](https://open-meteo.com/en/terms) separately limit the free API to non-commercial use. Retain Open-Meteo attribution when sharing its forecasts or recordings. No Open-Meteo recordings are currently committed.

## TomTom

**No raw TomTom responses or TomTom-derived fixtures are committed.** Optional TomTom verification/along-route search remains server-only and in-memory; it requires Full Live, `TOMTOM_LIVE=1`, and a server-side key, and is budget capped. Development and automated tests must make zero live TomTom requests unless separately approved by the project owner. Unit tests use injected mock responses.

The [official TomTom terms page](https://docs.tomtom.com/legal/terms-and-conditions) did not expose readable storage/redistribution terms during the submission audit (2026-11-04). Redistribution permission has therefore **not been established**. Do not export or commit TomTom caches; review the terms applicable to your own account before extending storage or distribution.

## Recorded or mock AI

Demo decisions use deterministic mock parsing and ranking. They are not saved live Muse completions and must not be labeled Live. Live Muse calls use the judge's server-side key and the same bounded deterministic context. Model errors, invalid output or deadlines fall back to mock/deterministic decisions with visible provenance.
