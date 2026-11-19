import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import * as turf from '@turf/turf';
import * as SunCalc from 'suncalc';
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import './style.css';

import { DATASETS, fetchDataset, fetchPlanningAuthority, describe, entityUrl } from './planning';
import { fetchStreets, fetchPoisFromTiles } from './tiles';
import { buildModel, modelGeoJSON, GREEN, type SiteModel, type Bldg } from './model';
import { fetchPois, fetchBuildingAt, reverseGeocode, type Poi } from './osm';
import { renderAxo, groundLayers, LOOK, type AxoBuilding, type GroundPolys } from './axo';
import { openPassport, useLabel } from './passport';
import { fmtArea, fmtDist, toLocalPolys, type XY } from './geo';

const TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string;
mapboxgl.accessToken = TOKEN;

type PolyF = Feature<Polygon | MultiPolygon>;
type View = 'plan' | '3d' | 'axo' | 'eye';
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const S = {
  red: null as PolyF | null,
  study: null as PolyF | null,
  drawnStudy: null as PolyF | null,
  studyMode: 'buffer' as 'buffer' | 'walk' | 'draw',
  bufferM: 200,
  walkMin: 10,
  walk: empty as FeatureCollection,
  drawing: null as null | 'red' | 'study',
  model: null as SiteModel | null,
  designations: empty as FeatureCollection,
  pois: [] as Poi[],
  place: '',
  lpa: null as string | null,
  selected: null as Bldg | null,
  view: 'plan' as View,
  visible: new Set<string>([...DATASETS.filter((d) => d.on).map((d) => d.id), 'walk', 'pois']),
  massing: 0,
};

// ---------------------------------------------------------------- map
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11',
  center: [-2.2557, 53.4776],
  zoom: 16,
  preserveDrawingBuffer: true,
  antialias: true,
  maxZoom: 25, // eye level needs the camera within ~16 m of its look-at point
});
map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');

const draw = new MapboxDraw({
  displayControlsDefault: false,
  styles: [
    { id: 'gl-draw-fill', type: 'fill', filter: ['all', ['==', '$type', 'Polygon']], paint: { 'fill-color': '#d7262e', 'fill-opacity': 0.08 } },
    { id: 'gl-draw-line', type: 'line', filter: ['any', ['==', '$type', 'LineString'], ['==', '$type', 'Polygon']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d7262e', 'line-width': 2.5 } },
    { id: 'gl-draw-vertex-halo', type: 'circle', filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']], paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#d7262e', 'circle-stroke-width': 2 } },
    { id: 'gl-draw-midpoint', type: 'circle', filter: ['all', ['==', 'meta', 'midpoint'], ['==', '$type', 'Point']], paint: { 'circle-radius': 3, 'circle-color': '#d7262e' } },
  ],
});
map.addControl(draw);

function addLayers() {
  // Quieter base: a drawing, not a map app.
  for (const l of map.getStyle()!.layers ?? []) {
    if (l.type === 'symbol' && /poi|transit|airport|natural|water-point|settlement-subdivision/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
  }
  if (map.getLayer('building')) map.setPaintProperty('building', 'fill-color', '#dddcd7');

  map.addSource('mask', { type: 'geojson', data: empty });
  map.addSource('red', { type: 'geojson', data: empty });
  map.addSource('study', { type: 'geojson', data: empty });
  map.addSource('walk', { type: 'geojson', data: empty });
  map.addSource('model', { type: 'geojson', data: empty });
  map.addSource('pois', { type: 'geojson', data: empty });
  map.addSource('selected', { type: 'geojson', data: empty });

  map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#fbfaf7', 'fill-opacity': 0.6 } });

  for (const d of DATASETS) {
    map.addSource(`ds-${d.id}`, { type: 'geojson', data: empty });
    if (d.kind === 'fill') {
      const color: any = d.id === 'flood-risk-zone' ? ['match', ['to-string', ['get', 'flood-risk-level']], '3', '#1f5fc4', '#7fb2f0'] : d.color;
      map.addLayer({ id: `ds-${d.id}-f`, type: 'fill', source: `ds-${d.id}`, paint: { 'fill-color': color, 'fill-opacity': 0.16 } });
      map.addLayer({ id: `ds-${d.id}-l`, type: 'line', source: `ds-${d.id}`, paint: { 'line-color': color, 'line-width': 1.6, 'line-dasharray': [3, 2] } });
    }
  }

  map.moveLayer('mask'); // mask sits over the designations so the study area reads clearly
  map.addLayer({ id: 'walk', type: 'line', source: 'walk', paint: { 'line-color': '#1b1b1b', 'line-width': ['match', ['get', 'contour'], 5, 1.6, 10, 1.2, 0.8], 'line-dasharray': [1, 2], 'line-opacity': 0.7 } });
  map.addLayer({ id: 'study-line', type: 'line', source: 'study', paint: { 'line-color': '#141414', 'line-width': 1.2, 'line-dasharray': [6, 3] } });
  map.addLayer({ id: 'red-fill', type: 'fill', source: 'red', paint: { 'fill-color': '#d7262e', 'fill-opacity': 0.07 } });
  map.addLayer({ id: 'red-line', type: 'line', source: 'red', paint: { 'line-color': '#d7262e', 'line-width': 3 } });
  map.addLayer({ id: 'selected-line', type: 'line', source: 'selected', paint: { 'line-color': '#2433e0', 'line-width': 3 } });

  map.addLayer({
    id: 'context-3d', type: 'fill-extrusion', source: 'composite', 'source-layer': 'building', minzoom: 14,
    filter: ['==', ['get', 'extrude'], 'true'],
    paint: { 'fill-extrusion-color': '#e8e7e2', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'min_height'], 'fill-extrusion-opacity': 0.9 },
  });
  map.addLayer({
    id: 'model-3d', type: 'fill-extrusion', source: 'model',
    paint: {
      'fill-extrusion-color': [
        'case',
        ['boolean', ['feature-state', 'selected'], false], '#2433e0',
        ['boolean', ['feature-state', 'hover'], false], '#9aa3ff',
        ['get', 'listed'], '#c9b2de',
        ['get', 'inSite'], '#f1b2b5',
        ['get', 'inStudy'], '#ffffff',
        '#e3e2dd',
      ],
      'fill-extrusion-height': ['get', 'h'],
      'fill-extrusion-base': ['get', 'minH'],
      'fill-extrusion-opacity': 0.96,
    },
  });
  map.addSource('massing', { type: 'geojson', data: empty });
  map.addLayer({ id: 'massing-3d', type: 'fill-extrusion', source: 'massing', paint: { 'fill-extrusion-color': '#e6262e', 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.75 } });

  map.addLayer({
    id: 'ds-listed', type: 'circle', source: 'ds-listed-building',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 18, 6], 'circle-color': ['match', ['get', 'listed-building-grade'], 'I', '#3b1066', 'II*', '#6a32a0', '#a57cc9'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 },
  });
  map.addLayer({ id: 'ds-brownfield', type: 'circle', source: 'ds-brownfield-land', paint: { 'circle-radius': 5, 'circle-color': '#a0522d', 'circle-opacity': 0.8, 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  map.addLayer({
    id: 'pois', type: 'circle', source: 'pois',
    paint: {
      'circle-radius': ['match', ['get', 'cat'], 'rail', 6, 'bus', 3, 3.5],
      'circle-color': ['match', ['get', 'cat'], 'rail', '#141414', 'bus', '#555', 'shop', '#d08a00', 'school', '#2b7bb9', 'health', '#c0392b', 'park', '#3f8f3f', '#888'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
    },
  });
  map.addLayer({ id: 'pois-label', type: 'symbol', source: 'pois', filter: ['==', ['get', 'cat'], 'rail'], layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'] }, paint: { 'text-color': '#141414', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });

  applySun();
  applyVisibility();
  restoreProject();
}

map.on('style.load', () => {
  addLayers();
  map.setCamera({ 'camera-projection': 'orthographic' });
});

// ---------------------------------------------------------------- search
let searchT = 0;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchT);
  const q = (e.target as HTMLInputElement).value.trim();
  if (q.length < 3) return void ($('#results').innerHTML = '');
  searchT = window.setTimeout(async () => {
    const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&country=gb&autocomplete=true&limit=6&access_token=${TOKEN}`);
    const j = await r.json();
    $('#results').innerHTML = (j.features ?? [])
      .map((f: any, i: number) => `<li data-i="${i}">${esc(f.properties.name)}<small>${esc(f.properties.place_formatted ?? '')}</small></li>`)
      .join('');
    $('#results').querySelectorAll('li').forEach((li) =>
      li.addEventListener('click', () => {
        const f = j.features[+li.dataset.i!];
        map.flyTo({ center: f.geometry.coordinates, zoom: 17.2, pitch: 0, bearing: 0 });
        S.place = f.properties.context?.place?.name ?? f.properties.name;
        $('#results').innerHTML = '';
      }),
    );
  }, 250);
});

$('#example').onclick = () => {
  // A block in Castlefield, Manchester, to show the workflow end to end.
  setRed(turf.polygon([[[-2.25668, 53.47735], [-2.25545, 53.47783], [-2.25492, 53.47729], [-2.25611, 53.47683], [-2.25668, 53.47735]]]) as PolyF);
  S.place = 'Castlefield, Manchester';
  map.fitBounds(turf.bbox(S.study!) as any, { padding: 60, duration: 800 });
};

// ---------------------------------------------------------------- drawing
function startDraw(kind: 'red' | 'study') {
  draw.deleteAll();
  S.drawing = kind;
  if (S.view !== 'plan') setView('plan');
  draw.changeMode('draw_polygon');
  $('#redHint').textContent = 'Click each corner. Double-click (or click the first corner) to finish.';
}
$('#drawRed').onclick = () => startDraw('red');
$('#drawStudy').onclick = () => startDraw('study');
$('#editRed').onclick = () => {
  if (!S.red) return;
  draw.deleteAll();
  S.drawing = 'red';
  const [id] = draw.add(S.red as any);
  draw.changeMode('direct_select', { featureId: id });
  $('#redHint').textContent = 'Drag a corner to move it. Click the map outside the shape when done.';
};
$('#clearRed').onclick = () => setRed(null);

function finishDraw() {
  const f = draw.getAll().features[0] as PolyF | undefined;
  if (!f || f.geometry.type !== 'Polygon' || f.geometry.coordinates[0].length < 4) return;
  const clean = turf.polygon(f.geometry.coordinates) as PolyF;
  if (S.drawing === 'red') setRed(clean);
  else if (S.drawing === 'study') ((S.drawnStudy = clean), updateStudy());
}
map.on('draw.create', () => {
  finishDraw();
  draw.deleteAll();
  S.drawing = null;
});
map.on('draw.update', finishDraw);
map.on('draw.modechange', (e: any) => {
  if (e.mode === 'simple_select' && S.drawing) {
    finishDraw();
    draw.deleteAll();
    S.drawing = null;
  }
});

$<HTMLInputElement>('#importRed').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const text = await file.text();
  let poly: PolyF | null = null;
  if (file.name.toLowerCase().endsWith('.kml')) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const c = doc.querySelector('Polygon outerBoundaryIs coordinates, Polygon coordinates')?.textContent?.trim();
    if (c) {
      const ring = c.split(/\s+/).map((t) => t.split(',').slice(0, 2).map(Number));
      if (ring.length > 3) poly = turf.polygon([ring]) as PolyF;
    }
  } else {
    const j = JSON.parse(text);
    const feats: Feature[] = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [{ type: 'Feature', geometry: j, properties: {} }];
    poly = (feats.find((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon') as PolyF) ?? null;
  }
  if (!poly) return alert('No polygon found in that file.');
  setRed(poly);
  map.fitBounds(turf.bbox(S.study ?? poly) as any, { padding: 60 });
};

function setRed(f: PolyF | null) {
  S.red = f;
  (map.getSource('red') as mapboxgl.GeoJSONSource)?.setData(f ?? empty);
  $<HTMLButtonElement>('#editRed').disabled = !f;
  $<HTMLButtonElement>('#clearRed').disabled = !f;
  $('#redStat').textContent = f ? `Red line ${fmtArea(turf.area(f))} · perimeter ${fmtDist(turf.length(turf.polygonToLine(f as any) as any, { units: 'meters' }))}` : '';
  $('#redHint').textContent = f ? 'Red line drawn. Set the study area, then analyse.' : 'Click each corner of the site boundary. Double-click to finish.';
  updateMassing();
  updateStudy();
  saveProject();
}

$<HTMLInputElement>('#massing').oninput = (e) => {
  S.massing = Math.max(0, +(e.target as HTMLInputElement).value || 0);
  updateMassing();
};
function updateMassing() {
  const src = map.getSource('massing') as mapboxgl.GeoJSONSource | undefined;
  src?.setData(S.red && S.massing > 0 ? { ...S.red, properties: { h: S.massing } } : empty);
}

// ---------------------------------------------------------------- study area
document.querySelectorAll<HTMLButtonElement>('#studyMode button').forEach((b) =>
  b.addEventListener('click', () => {
    S.studyMode = b.dataset.mode as any;
    document.querySelectorAll('#studyMode button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== S.studyMode));
    updateStudy();
  }),
);
$<HTMLInputElement>('#bufferM').oninput = (e) => {
  S.bufferM = +(e.target as HTMLInputElement).value;
  $('#bufferLbl').textContent = `${S.bufferM} m`;
  updateStudy();
};
document.querySelectorAll<HTMLButtonElement>('#walkMin button').forEach((b) =>
  b.addEventListener('click', () => {
    S.walkMin = +b.dataset.v!;
    document.querySelectorAll('#walkMin button').forEach((x) => x.classList.toggle('on', x === b));
    updateStudy();
  }),
);

let studySeq = 0;
async function updateStudy() {
  const seq = ++studySeq;
  let study: PolyF | null = null;
  if (S.studyMode === 'draw') study = S.drawnStudy;
  else if (S.red && S.studyMode === 'buffer') study = turf.buffer(S.red, S.bufferM, { units: 'meters' }) as PolyF;
  else if (S.red && S.studyMode === 'walk') {
    const fc = await isochrone(S.red);
    if (seq !== studySeq) return;
    const hit = fc.features.find((f) => f.properties?.contour === S.walkMin) as PolyF | undefined;
    if (hit) study = turf.union(turf.featureCollection([hit, S.red as any])) as PolyF ?? hit;
  }
  S.study = study;
  (map.getSource('study') as mapboxgl.GeoJSONSource)?.setData(study ?? empty);
  (map.getSource('mask') as mapboxgl.GeoJSONSource)?.setData(study ? maskOf(study) : empty);
  $('#studyStat').textContent = study
    ? S.red
      ? `Red line ${fmtArea(turf.area(S.red))} within a ${fmtArea(turf.area(study))} study area`
      : `Study area ${fmtArea(turf.area(study))}, no red line`
    : '';
  $<HTMLButtonElement>('#analyse').disabled = !study;
}

const walkCache = new Map<string, FeatureCollection>();
async function isochrone(f: PolyF): Promise<FeatureCollection> {
  const c = turf.centroid(f).geometry.coordinates;
  const key = c.map((v) => v.toFixed(5)).join(',');
  if (!walkCache.has(key)) {
    const r = await fetch(`https://api.mapbox.com/isochrone/v1/mapbox/walking/${c[0]},${c[1]}?contours_minutes=5,10,15&polygons=true&denoise=1&access_token=${TOKEN}`);
    walkCache.set(key, await r.json());
  }
  return walkCache.get(key)!;
}

function maskOf(study: PolyF): Feature<Polygon> {
  const holes = study.geometry.type === 'Polygon' ? [study.geometry.coordinates[0]] : study.geometry.coordinates.map((p) => p[0]);
  return turf.polygon([[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...holes.map((h) => (turf.booleanClockwise(h) ? h : h.slice().reverse()))]);
}

// ---------------------------------------------------------------- analysis
$('#analyse').onclick = analyse;
async function analyse() {
  if (!S.study) return;
  const btn = $<HTMLButtonElement>('#analyse');
  btn.disabled = true;
  const say = (t: string) => ($('#progress').textContent = t);
  try {
    const context = turf.buffer(S.study, 120, { units: 'meters' }) as PolyF;
    const ctxBox = turf.bbox(context);
    const poiBox = turf.bbox(turf.buffer(S.study, 1200, { units: 'meters' })!);
    const c = turf.centroid(S.red ?? S.study).geometry.coordinates as [number, number];
    say('Fetching buildings, designations and places…');

    const dsP = Promise.all(DATASETS.map((d) => fetchDataset(d.id, ctxBox).catch(() => empty)));
    // OpenStreetMap via Overpass first; if every Overpass server is busy, read places from Mapbox's tiles.
    const poiP = fetchPois(poiBox).catch((e) => (console.warn('Overpass unavailable, using Mapbox tiles', e), fetchPoisFromTiles(poiBox, TOKEN)));
    const walkP = S.red ? isochrone(S.red) : Promise.resolve(empty);
    const lpaP = fetchPlanningAuthority(c[0], c[1]);
    const placeP = S.place ? Promise.resolve(null) : reverseGeocode(c[0], c[1], TOKEN);
    const streets = await fetchStreets(ctxBox, TOKEN, say);
    say('Reading designations…');
    const ds = await dsP;
    S.designations = { type: 'FeatureCollection', features: ds.flatMap((x) => x.features) };
    DATASETS.forEach((d, i) => (map.getSource(`ds-${d.id}`) as mapboxgl.GeoJSONSource).setData(ds[i]));

    say('Building the site model…');
    S.model = buildModel(streets, S.study, S.red, context, S.designations);
    (map.getSource('model') as mapboxgl.GeoJSONSource).setData(modelGeoJSON(S.model));

    S.pois = await poiP;
    (map.getSource('pois') as mapboxgl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: S.pois.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { cat: p.cat, name: p.name } })),
    });
    S.walk = await walkP;
    const walkLines: Feature[] = [];
    for (const f of S.walk.features) {
      const l: any = turf.polygonToLine(f as any);
      for (const x of l.type === 'FeatureCollection' ? l.features : [l]) walkLines.push({ ...x, properties: { contour: f.properties?.contour } });
    }
    (map.getSource('walk') as mapboxgl.GeoJSONSource).setData({ type: 'FeatureCollection', features: walkLines });
    S.lpa = await lpaP;
    const pl = await placeP;
    if (pl) S.place = [pl.street, pl.place].filter(Boolean).join(', ');

    map.setLayoutProperty('context-3d', 'visibility', 'none');
    renderLayerList();
    applyVisibility();
    renderSummary();
    select(null);
    ['#expAxo', '#expPlan'].forEach((s) => ($<HTMLButtonElement>(s).disabled = false));
    const n = S.model.buildings.filter((b) => b.inStudy).length;
    say(`${n} buildings in the study area · tiles z${streets.zoom}`);
  } catch (e) {
    console.error(e);
    say(`Something failed: ${(e as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- layers panel
function renderLayerList() {
  const counts = new Map<string, number>();
  const study = S.study;
  for (const f of S.designations.features) {
    const id = f.properties?.dataset;
    if (study && f.geometry && safe(() => turf.booleanIntersects(f as any, study), false)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const groups = ['Heritage', 'Environment', 'Planning'] as const;
  let html = '';
  for (const g of groups) {
    html += `<div class="lyr-group">${g}</div>`;
    for (const d of DATASETS.filter((x) => x.group === g)) {
      const n = counts.get(d.id) ?? 0;
      html += `<label class="lyr"><input type="checkbox" data-l="${d.id}" ${S.visible.has(d.id) ? 'checked' : ''}/><span class="sw ${d.kind === 'point' ? 'pt' : ''}" style="border-color:${d.color};background:${d.color}33"></span>${d.label}<span class="n">${S.model ? n : ''}</span></label>`;
    }
  }
  html += `<div class="lyr-group">Movement</div>
    <label class="lyr"><input type="checkbox" data-l="walk" ${S.visible.has('walk') ? 'checked' : ''}/><span class="sw" style="border-color:#141414;border-style:dotted"></span>Walking reach 5 · 10 · 15 min</label>
    <label class="lyr"><input type="checkbox" data-l="pois" ${S.visible.has('pois') ? 'checked' : ''}/><span class="sw pt" style="border-color:#141414;background:#14141433"></span>Transport & everyday places<span class="n">${S.pois.length || ''}</span></label>
    <div class="lyr-group">Base</div>
    <label class="lyr"><input type="checkbox" data-l="labels" ${S.visible.has('labels') ? 'checked' : ''}/><span class="sw" style="border-color:#999"></span>Street names</label>`;
  $('#layers').innerHTML = html;
  $('#layers').querySelectorAll<HTMLInputElement>('input[data-l]').forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.checked ? S.visible.add(cb.dataset.l!) : S.visible.delete(cb.dataset.l!);
      applyVisibility();
    }),
  );
}

function applyVisibility() {
  const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  for (const d of DATASETS) {
    const on = S.visible.has(d.id);
    vis(`ds-${d.id}-f`, on);
    vis(`ds-${d.id}-l`, on);
  }
  const flat = S.view === 'plan'; // point markers read in plan; in 3D the tinted buildings carry it
  vis('ds-listed', flat && S.visible.has('listed-building'));
  vis('ds-brownfield', flat && S.visible.has('brownfield-land'));
  vis('walk', S.visible.has('walk'));
  vis('pois', flat && S.visible.has('pois'));
  vis('pois-label', S.visible.has('pois'));
  for (const l of map.getStyle()?.layers ?? []) if (l.type === 'symbol' && /road-label|road-number|road-exit|street/.test(l.id)) vis(l.id, S.visible.has('labels'));
}

// ---------------------------------------------------------------- summary
function renderSummary() {
  const m = S.model!;
  const inStudy = m.buildings.filter((b) => b.inStudy);
  const onSite = inStudy.filter((b) => b.inSite);
  const tallest = inStudy.reduce<Bldg | null>((t, b) => (b.heightKnown && (!t || b.h > t.h) ? b : t), null);
  const listed = inStudy.reduce((n, b) => n + b.listed.length, 0);
  const onRed = S.red ? S.designations.features.filter((f) => f.geometry && safe(() => turf.booleanIntersects(f as any, S.red!), false)) : [];
  const c = turf.centroid(S.red ?? S.study!).geometry.coordinates;
  const near = (cat: string) =>
    S.pois.filter((p) => p.cat === cat).map((p) => ({ p, d: turf.distance(c, [p.lon, p.lat], { units: 'meters' }) })).sort((a, b) => a.d - b.d);
  const rail = near('rail')[0];
  const buses = near('bus').filter((x) => x.d <= 400).length;
  const colorOf = (id: string) => DATASETS.find((d) => d.id === id)?.color ?? '#999';

  $('#summary').innerHTML = `
    <div class="ref">SITE</div>
    <h1>${esc(S.place || 'The site')}</h1>
    <p class="muted">${esc(S.lpa ?? '')}</p>
    <h2>Red line and study area</h2>
    <dl class="kv">
      ${S.red ? `<dt>Red line</dt><dd>${fmtArea(turf.area(S.red))}</dd>` : ''}
      <dt>Study area</dt><dd>${fmtArea(turf.area(S.study!))} · ${S.studyMode === 'buffer' ? `${S.bufferM} m around` : S.studyMode === 'walk' ? `${S.walkMin} min walk` : 'drawn'}</dd>
      <dt>Buildings</dt><dd>${inStudy.length} in the study area, ${onSite.length} on the site</dd>
      ${tallest ? `<dt>Tallest</dt><dd>${tallest.ref}, ${tallest.h.toFixed(0)} m</dd>` : ''}
      <dt>Listed</dt><dd>${listed} listed building entries</dd>
    </dl>
    <h2>On the red line</h2>
    ${onRed.length ? onRed.map((f) => `<div class="desig"><span class="sw" style="background:${colorOf(f.properties?.dataset)}"></span><a href="${entityUrl(f)}" target="_blank">${esc(describe(f))}</a></div>`).join('') : `<p class="muted">${S.red ? 'No designations touch the red line.' : 'No red line drawn.'}</p>`}
    <h2>Getting about</h2>
    ${rail ? `<p>Nearest station: <b>${esc(rail.p.name)}</b>, ${fmtDist(rail.d)} (${rail.p.kind})</p>` : '<p class="muted">No station within 1.2 km.</p>'}
    <p>${buses} bus stops within 400 m</p>
    <p class="muted" style="margin-top:14px">Click any building to read it. Use the views above to move between plan, 3D, axonometric and eye level; the selection stays linked.</p>`;
}

// ---------------------------------------------------------------- selection + leader line
let hoverId: number | null = null;
map.on('mousemove', 'model-3d', (e) => {
  if (S.drawing) return;
  map.getCanvas().style.cursor = 'pointer';
  const id = e.features?.[0]?.id as number;
  if (hoverId !== null && hoverId !== id) map.setFeatureState({ source: 'model', id: hoverId }, { hover: false });
  hoverId = id;
  map.setFeatureState({ source: 'model', id }, { hover: true });
});
map.on('mouseleave', 'model-3d', () => {
  map.getCanvas().style.cursor = '';
  if (hoverId !== null) map.setFeatureState({ source: 'model', id: hoverId }, { hover: false });
  hoverId = null;
});
map.on('click', (e) => {
  if (S.drawing || !S.model) return;
  const hit = map.queryRenderedFeatures(e.point, { layers: ['model-3d'] })[0];
  select(hit ? S.model.buildings[hit.id as number] : null);
});

let osmSeq = 0;
function select(b: Bldg | null) {
  if (S.selected) map.setFeatureState({ source: 'model', id: S.selected.idx }, { selected: false });
  S.selected = b;
  (map.getSource('selected') as mapboxgl.GeoJSONSource)?.setData(b ? b.feature : empty);
  $('#summary').hidden = !!b;
  $('#card').hidden = !b;
  if (!b) return void drawLeader();
  map.setFeatureState({ source: 'model', id: b.idx }, { selected: true });
  renderCard(b, null);
  const seq = ++osmSeq;
  fetchBuildingAt(b.ll[0], b.ll[1]).then((o) => seq === osmSeq && renderCard(b, o?.tags ?? {}));
  drawLeader();
}

function renderCard(b: Bldg, tags: Record<string, string> | null) {
  const use = tags ? useLabel(tags, b.type) : b.type === 'building' ? '…' : useLabel({}, b.type);
  const name = tags?.name || b.places[0];
  const colorOf = (id: string) => DATASETS.find((d) => d.id === id)?.color ?? '#999';
  const study = S.model!.buildings.filter((x) => x.inStudy).sort((x, y) => x.ref.localeCompare(y.ref));
  const i = study.indexOf(b);
  $('#card').innerHTML = `
    <span class="anchor" id="anchor"></span>
    <div class="ref">${b.ref}${b.inSite ? ' · ON THE SITE' : b.inStudy ? '' : ' · CONTEXT'}</div>
    <h1>${esc(name || use)}</h1>
    <p class="muted">${name ? esc(use) : ''}${tags?.['addr:street'] ? ` · ${esc([tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '))}` : ''}</p>
    <h2>Identity and form</h2>
    <dl class="kv">
      <dt>Height</dt><dd>${b.heightKnown ? `${b.h.toFixed(1)} m` : '<span class="muted">not recorded (6 m drawn)</span>'}</dd>
      ${tags?.['building:levels'] ? `<dt>Storeys</dt><dd>${esc(tags['building:levels'])}</dd>` : ''}
      <dt>Footprint</dt><dd>${fmtArea(b.area)}</dd>
      <dt>Date</dt><dd>${esc(tags?.start_date ?? 'not recorded')}</dd>
      <dt>To red line</dt><dd>${S.red ? (b.inSite ? '<b class="red">on the site</b>' : fmtDist(Math.max(0, turf.pointToPolygonDistance(b.ll, S.red as any, { units: 'meters' })))) : '—'}</dd>
    </dl>
    <h2>Protection and planning</h2>
    ${b.listed.map((l) => `<div class="desig"><span class="sw" style="background:#7B3FA0"></span><a href="${entityUrl(l)}" target="_blank">Listed: ${esc(describe(l))}</a></div>`).join('')}
    ${b.designations.map((d) => `<div class="desig"><span class="sw" style="background:${colorOf(d.properties?.dataset)}"></span><a href="${entityUrl(d)}" target="_blank">${esc(describe(d))}</a></div>`).join('')}
    ${!b.listed.length && !b.designations.length ? '<p class="muted">No designations recorded.</p>' : ''}
    <div class="nav">
      <button class="primary" id="openPassport" style="width:100%">Building passport</button>
      <button id="prevB" ${i <= 0 ? 'disabled' : ''}>‹ Prev</button>
      <button id="nextB" ${i < 0 || i >= study.length - 1 ? 'disabled' : ''}>Next ›</button>
      <button id="eyeB">Eye level</button>
      <button id="closeB">Close</button>
    </div>`;
  $('#openPassport').onclick = () => openPassport(b, { model: S.model!, pois: S.pois, token: TOKEN, place: S.place, lpa: S.lpa }, $('#passport'));
  $('#prevB').onclick = () => (select(study[i - 1]), ensureVisible(study[i - 1]));
  $('#nextB').onclick = () => (select(study[i + 1]), ensureVisible(study[i + 1]));
  $('#eyeB').onclick = () => setView('eye');
  $('#closeB').onclick = () => select(null);
  drawLeader();
}

function ensureVisible(b: Bldg) {
  const p = map.project(b.ll);
  const c = map.getCanvas();
  if (p.x < 40 || p.y < 40 || p.x > c.clientWidth - 40 || p.y > c.clientHeight - 40) map.easeTo({ center: b.ll, duration: 500 });
}

/** The atlas leader: from the selected building on the map to its card, redrawn every frame. */
function drawLeader() {
  const svg = $('#leader');
  const b = S.selected;
  const anchor = document.getElementById('anchor');
  if (!b || !anchor || $('#card').hidden) return void (svg.innerHTML = '');
  const mr = $('#map').getBoundingClientRect();
  const pt = projectAt(b.ll, S.view === 'plan' ? 0 : b.h * 0.6);
  const x0 = mr.left + pt.x, y0 = mr.top + pt.y;
  const ar = anchor.getBoundingClientRect();
  const x1 = ar.left, y1 = Math.max(ar.top, $('#info').getBoundingClientRect().top + 10);
  const inside = pt.x >= 0 && pt.y >= 0 && pt.x <= mr.width && pt.y <= mr.height;
  if (!inside) return void (svg.innerHTML = '');
  const mx = x0 + (x1 - x0) * 0.55;
  svg.innerHTML = `<path d="M${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}" fill="none" stroke="#2433e0" stroke-width="1.5"/>
    <circle cx="${x0}" cy="${y0}" r="6" fill="none" stroke="#2433e0" stroke-width="2"/><circle cx="${x0}" cy="${y0}" r="2" fill="#2433e0"/>
    <circle cx="${x1}" cy="${y1}" r="3.5" fill="#2433e0"/>`;
}

/** Screen position of a point lifted to a height, so the leader lands on the building, not its base. */
function projectAt(ll: [number, number], h: number) {
  const base = map.project(ll);
  if (h <= 0 || map.getPitch() < 1) return base;
  // Mapbox has no public project-with-altitude, so use the camera matrix directly.
  try {
    const tr: any = (map as any).transform;
    const mc = mapboxgl.MercatorCoordinate.fromLngLat(ll, h);
    const m = tr.mercatorMatrix as number[];
    const v = [mc.x, mc.y, mc.z, 1]; // mercatorMatrix takes raw mercator units
    const o = [0, 1, 2, 3].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
    const x = (o[0] / o[3] + 1) * tr.width * 0.5;
    const y = (1 - o[1] / o[3]) * tr.height * 0.5;
    return isFinite(x) && isFinite(y) ? { x, y } : base;
  } catch {
    return base;
  }
}

map.on('render', drawLeader);
window.addEventListener('resize', drawLeader);
$('#info').addEventListener('scroll', drawLeader);

// ---------------------------------------------------------------- views
document.querySelectorAll<HTMLButtonElement>('#views [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as View)));
$('#rotL').onclick = () => map.easeTo({ bearing: map.getBearing() - 45, duration: 600 });
$('#rotR').onclick = () => map.easeTo({ bearing: map.getBearing() + 45, duration: 600 });

function setView(v: View) {
  const prev = S.view;
  S.view = v;
  document.querySelectorAll('#views [data-view]').forEach((x) => x.classList.toggle('on', (x as HTMLElement).dataset.view === v));
  map.setCamera({ 'camera-projection': v === 'axo' || v === 'plan' ? 'orthographic' : 'perspective' });
  const isolate = v === 'axo' && !!S.model;
  map.setFilter('model-3d', isolate ? ['==', ['get', 'inStudy'], true] : null);
  if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', isolate ? 'none' : 'visible');
  map.setPaintProperty('mask', 'fill-opacity', isolate ? 0.94 : 0.6);
  if (!S.model) map.setLayoutProperty('context-3d', 'visibility', v === 'plan' ? 'none' : 'visible');
  applyVisibility();
  const target = (S.selected?.ll ?? (S.red || S.study ? turf.centroid((S.red ?? S.study)!).geometry.coordinates : map.getCenter().toArray())) as [number, number];
  const bearing = Math.abs(map.getBearing()) < 1 ? -30 : map.getBearing();
  if (v === 'plan') map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  else if (v === '3d') map.easeTo({ pitch: 60, bearing, zoom: Math.max(map.getZoom(), 16), duration: 700 });
  else if (v === 'axo') {
    if (S.study) map.fitBounds(turf.bbox(S.study) as any, { pitch: 55, bearing, padding: 50, duration: 700 });
    else map.easeTo({ pitch: 55, bearing, duration: 700 });
  } else if (v === 'eye') {
    const { from, look } = eyePoint(target);
    // Mapbox caps pitch at 85°, so aim at the ground 16 m ahead (≈84°): near-horizontal, the way a person sees.
    const heading = turf.bearing(from, look);
    const aim = turf.destination(from, 16, heading, { units: 'meters' }).geometry.coordinates as [number, number];
    const cam = map.getFreeCameraOptions();
    cam.position = mapboxgl.MercatorCoordinate.fromLngLat(from, 1.7);
    cam.lookAtPoint(aim);
    map.setFreeCameraOptions(cam);
  }
  if (prev === 'eye' && v !== 'eye') map.easeTo({ center: target, zoom: 16.5, duration: 700 });
  setTimeout(drawLeader, 750);
}

/** Stand in a street at a comfortable distance from the facade (about twice the height), facing the building. */
function eyePoint(target: [number, number]): { from: [number, number]; look: [number, number] } {
  const m = S.model;
  const fallback = () => ({ from: turf.destination(target, 80, map.getBearing() + 180, { units: 'meters' }).geometry.coordinates as [number, number], look: target });
  if (!m) return fallback();
  const t = m.frame.toLocal(target);
  const sel = S.selected;
  const want = sel ? Math.min(80, Math.max(25, sel.h * 2)) : 60;
  const edges: [XY, XY][] = sel ? sel.polys.flatMap((pl) => pl[0].map((q, i) => [q, pl[0][(i + 1) % pl[0].length]] as [XY, XY])) : [];
  const distTo = (q: XY) => (edges.length ? Math.min(...edges.map(([a, b]) => { const c = closestOnSegment(q, a, b); return Math.hypot(c[0] - q[0], c[1] - q[1]); })) : Math.hypot(q[0] - t[0], q[1] - t[1]));
  const near = m.buildings.filter((b) => Math.hypot(b.centroid[0] - t[0], b.centroid[1] - t[1]) < want + 200);
  const inBuilding = (q: XY) => near.some((b) => b.polys.some((pl) => pointInRing(q, pl[0])));
  let best: { q: XY; score: number } | null = null;
  for (const r of m.roads) {
    if (/rail|track/.test(r.cls)) continue;
    for (const line of r.lines)
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
        for (let k = 0; k <= n; k++) {
          const q: XY = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
          if (Math.abs(q[0] - t[0]) > want + 150 || Math.abs(q[1] - t[1]) > want + 150) continue;
          const score = Math.abs(distTo(q) - want);
          if ((!best || score < best.score) && !inBuilding(q)) best = { q, score };
        }
      }
  }
  if (!best) return fallback();
  return { from: m.frame.toLngLat(best.q), look: target };
}
function closestOnSegment(p: XY, a: XY, b: XY): XY {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}
function pointInRing(p: XY, r: XY[]) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++)
    if (r[i][1] > p[1] !== r[j][1] > p[1] && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
  return c;
}

// ---------------------------------------------------------------- sun
const today = new Date();
$<HTMLInputElement>('#sunDate').value = today.toISOString().slice(0, 10);
$<HTMLInputElement>('#sunDate').onchange = applySun;
$<HTMLInputElement>('#sunTime').oninput = applySun;
$<HTMLInputElement>('#sunOn').onchange = applySun;

function sunNow() {
  const d = new Date($<HTMLInputElement>('#sunDate').value + 'T00:00:00');
  const mins = +$<HTMLInputElement>('#sunTime').value;
  d.setHours(Math.floor(mins / 60), mins % 60);
  const c = map.getCenter();
  const p = SunCalc.getPosition(d, c.lat, c.lng);
  // suncalc v2: degrees, azimuth clockwise from north.
  const alt = p.altitude;
  const az = p.azimuth;
  const toSun: XY = [Math.sin((az * Math.PI) / 180), Math.cos((az * Math.PI) / 180)]; // east, north
  return { d, alt, az, toSun };
}

function applySun() {
  const s = sunNow();
  const on = $<HTMLInputElement>('#sunOn').checked && s.alt > 0;
  $('#sunStat').textContent = `${s.d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · sun ${s.alt > 0 ? `${s.alt.toFixed(0)}° up, from ${compass(s.az)}` : 'below the horizon'}`;
  if (!map.isStyleLoaded()) return;
  map.setLights([
    { id: 'ambient', type: 'ambient', properties: { color: '#ffffff', intensity: on ? 0.55 : 0.8 } },
    {
      id: 'sun', type: 'directional',
      properties: { color: '#ffffff', intensity: on ? 0.55 : 0.3, direction: [s.az, Math.min(89, Math.max(5, 90 - s.alt))], 'cast-shadows': on, 'shadow-intensity': 0.55 },
    },
  ]);
}
const compass = (a: number) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(a / 45) % 8];

// ---------------------------------------------------------------- export
function overlayPolys(): GroundPolys[] {
  const m = S.model!;
  const out: GroundPolys[] = [];
  for (const d of DATASETS) {
    if (d.kind !== 'fill' || !S.visible.has(d.id)) continue;
    const polys = S.designations.features
      .filter((f) => f.properties?.dataset === d.id && (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'))
      .flatMap((f) => toLocalPolys(f.geometry as any, m.frame));
    if (polys.length) out.push({ polys, fill: d.color, opacity: 0.14, stroke: d.color, strokeWidth: 1.2, dash: '5 3' });
  }
  if (m.redPolys) out.push({ polys: m.redPolys, fill: '#d7262e', opacity: 0.08, stroke: '#d7262e', strokeWidth: 2.4 });
  return out;
}

function exportDrawing(kind: 'axo' | 'plan') {
  const m = S.model;
  if (!m) return;
  const mode = $<HTMLSelectElement>('#axoMode').value as 'ortho' | 'oblique';
  const s = sunNow();
  const buildings: AxoBuilding[] = m.buildings
    .filter((b) => b.cut)
    .map((b) => ({
      polys: b.cut!, z0: b.minH, z1: b.h, label: b.ref,
      look: b === S.selected ? LOOK.selected : b.listed.length ? LOOK.listed : b.inSite ? LOOK.site : LOOK.context,
    }));
  if (S.massing > 0 && m.redPolys) buildings.push({ polys: m.redPolys, z0: 0, z1: S.massing, look: LOOK.massing, label: 'Proposed' });
  const pitch = kind === 'plan' ? 0 : S.view === 'axo' || S.view === '3d' ? map.getPitch() : 55;
  const svg = renderAxo(
    {
      buildings: kind === 'plan' ? buildings.map((b) => ({ ...b, z1: b.z0 })) : buildings,
      clip: m.studyPolys,
      ground: [...groundLayers(m, GREEN), ...overlayPolys()],
      shadows: $<HTMLInputElement>('#sunOn').checked && s.alt > 0 ? { toSun: s.toSun, alt: s.alt } : undefined,
    },
    {
      bearing: kind === 'plan' ? 0 : map.getBearing(), mode: kind === 'plan' ? 'ortho' : mode, pitch,
      width: 1800, plinth: kind === 'axo' && $<HTMLInputElement>('#optPlinth').checked ? 10 : 0,
      background: '#ffffff', north: true, scaleBar: kind === 'plan' || mode === 'oblique', labels: $<HTMLInputElement>('#optLabels').checked,
    },
  );
  showExport(svg, `${slug(S.place || 'site')}-${kind}`);
}
$('#expAxo').onclick = () => exportDrawing('axo');
$('#expPlan').onclick = () => exportDrawing('plan');
$('#expPng').onclick = () => map.getCanvas().toBlob((b) => b && download(b, `${slug(S.place || 'site')}-${S.view}.png`));

function showExport(svg: string, name: string) {
  const host = $('#exportView');
  host.hidden = false;
  host.innerHTML = `<div class="pp-toolbar"><span>${esc(name)}.svg</span><button data-a="svg">Download SVG</button><button data-a="png">Download PNG</button><button data-a="close">Close</button></div><div class="ex-body">${svg}</div>`;
  host.querySelector<HTMLButtonElement>('[data-a=close]')!.onclick = () => (host.hidden = true);
  host.querySelector<HTMLButtonElement>('[data-a=svg]')!.onclick = () => download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
  host.querySelector<HTMLButtonElement>('[data-a=png]')!.onclick = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width * 2;
      c.height = img.height * 2;
      const g = c.getContext('2d')!;
      g.scale(2, 2);
      g.drawImage(img, 0, 0);
      c.toBlob((b) => b && download(b, `${name}.png`));
    };
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  };
}

function download(b: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
function safe<T>(fn: () => T, fb: T): T {
  try {
    return fn();
  } catch {
    return fb;
  }
}

// ---------------------------------------------------------------- remember the last site (this browser only)
const KEY = 'site-lab:last';
function saveProject() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ red: S.red, place: S.place, mode: S.studyMode, bufferM: S.bufferM, walkMin: S.walkMin }));
  } catch { /* storage blocked */ }
}
let restored = false;
function restoreProject() {
  if (restored) return;
  restored = true;
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!j?.red) return;
    S.place = j.place ?? '';
    S.bufferM = j.bufferM ?? 200;
    $<HTMLInputElement>('#bufferM').value = String(S.bufferM);
    $('#bufferLbl').textContent = `${S.bufferM} m`;
    setRed(j.red);
    map.jumpTo({ center: turf.centroid(j.red).geometry.coordinates as [number, number], zoom: 16 });
  } catch { /* nothing saved */ }
}

renderLayerList();
// Exposed for debugging in the console.
(window as any).siteLab = { map, S, setView, select, analyse };
