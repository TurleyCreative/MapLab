# Site Lab (internal)

A site analysis tool for England, built on Mapbox GL JS v3 and open data.

Workflow: **find the place → draw the red line → set the study area → analyse**. Then:
- move between **Plan / 3D / Axonometric / Eye level**, with the selected building linked to its card by a leader line
- open a **building passport** (A3, print or save as PDF)
- export an **axonometric or plan drawing as SVG** (editable in Illustrator or InDesign) or PNG

## Run it

```bash
npm install
```

```bash
echo "VITE_MAPBOX_TOKEN=pk.your-public-token" > .env.local
```

```bash
npm run dev
```

Open http://localhost:5173. To deploy, run `npm run build` and serve `dist/` from any static host (internal server, Netlify, Vercel). On mapbox.com, restrict the token to that host's URL.

## What it does

| Feature | How |
|---|---|
| Search | Mapbox Geocoding v6, limited to GB |
| Red line | Draw or edit on the map (mapbox-gl-draw), or import GeoJSON / KML. Area and perimeter shown. |
| Proposed massing | Red line extruded to a height you set; appears in 3D and in the SVG axo |
| Study area | *Around the site* (buffer 50–800 m), *walking reach* (Mapbox Isochrone 5/10/15 min) or *draw your own* |
| Buildings | Mapbox Streets v8 vector tiles, fetched straight from the tiles API for the whole study area (not just what's on screen). Pieces split at tile edges are stitched back together. Numbered B001… outward from the site; buildings outside the study area are context (C…). |
| Designations | planning.data.gov.uk: conservation areas, listed buildings, scheduled monuments, registered parks and gardens, WHS, flood zones 2/3, TPO areas, SSSI, ancient woodland, LNR, green belt, Article 4, brownfield register, local planning authority |
| Everyday places | OpenStreetMap via Overpass (shops, schools, health, parks, bus, rail and tram). Falls back to Mapbox POI tiles if Overpass is busy. |
| Walking times | Mapbox Directions Matrix (walking) from each building to the nearest candidates in each category |
| Views | Plan and Axonometric use Mapbox's **orthographic camera**. Axo isolates the study area as a cut-out model. Eye level stands you in the nearest street at about 2× the building height from the facade, 1.7 m up. |
| Sun and shadow | suncalc v2 drives Mapbox v3 directional light with cast shadows, plus vector shadows in the SVG export |
| Axo SVG | Custom renderer (`src/axo.ts`): orthographic or plan-oblique projection, back-to-front face sorting, wall shading, plinth, ground layers clipped to the study area, cast shadows, north arrow, scale bar |
| Passport | `src/passport.ts`: plan among neighbours, mass with neighbours within 45 m, identity and form, protection and planning, getting about, everyday needs, evidence, sources |

## Code map

```
src/main.ts      UI, map layers, views, selection + leader line, export
src/tiles.ts     Mapbox Streets vector-tile extraction (buildings, roads, landuse, water, POIs)
src/model.ts     The site model: numbered buildings, local metric geometry, designations per building
src/axo.ts       SVG axonometric / plan renderer
src/passport.ts  Building passport sheet
src/planning.ts  planning.data.gov.uk datasets
src/osm.ts       Overpass, Directions Matrix, reverse geocoding
src/geo.ts       Local metric frame + polygon helpers
```

## Known limits / next steps

- England only. Scotland would add HES, SEPA and NatureScot services, and Wales DataMapWales.
- Building heights come from OSM via Mapbox. Where none is recorded the building is drawn at 6 m and labelled so. Swapping in OS NGD building heights (licensed) would improve this.
- Red line snapping to HM Land Registry INSPIRE polygons is not built yet.
- The in-map shadows need a real GPU; they are not visible in headless test browsers.
