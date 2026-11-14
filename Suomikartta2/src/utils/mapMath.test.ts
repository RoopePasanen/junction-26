import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampZoom,
  clampCamera,
  isPointWithinFinlandBounds,
  resolveGoogleMapTypeId,
  latLngToWorldPixel,
  worldPixelToLatLng,
  zoomAroundScreenPoint,
  calculateScaleBar,
  formatLat,
  formatLng,
  validateCoordinateInput,
  MIN_ZOOM,
  MAX_ZOOM,
  FINLAND_GEOGRAPHIC_BOUNDS,
  DEFAULT_FINLAND_CAMERA,
} from './mapMath';
import {
  ALL_PLANNED_CAMERAS,
  CAMERAS_PER_CITY,
  PHYSICAL_CAMERAS_TOTAL,
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  TOTAL_TOP5_ACCIDENTS,
} from '../data/finlandWildlifePlan';
import {
  buildCameraPlanCsv,
  calculatePlanSummaryMetrics,
  calculateSingleCameraAreaSqMeters,
  clampCoverageConfig,
  computeCameraCoveragePolygons,
  computeCameraSectorPolygon,
  computeSingleCameraAreaHa,
  computeTotalPlanAreaKm2,
  DEFAULT_COVERAGE_CONFIG,
  filterCamerasByCityAndSearch,
  formatAreaCompact,
  getCameraBearings,
  MAX_CAMERA_RANGE_M,
  MIN_CAMERA_FOV_DEG,
  MIN_CAMERA_RANGE_M,
  resolveCityIdOnCameraSelect,
  resolveMapVisiblePlan,
} from './cameraPlanGeometry';
import { groundDistanceAndBearing, isPointInCityBoundary } from './crossingSimulator';

test('clampZoom constrains zoom strictly to Finland overview minimum and street maximum', () => {
  assert.equal(clampZoom(2), MIN_ZOOM);
  assert.equal(clampZoom(4.5), MIN_ZOOM);
  assert.equal(clampZoom(25), MAX_ZOOM);
  assert.equal(clampZoom(8.25), 8.25);
  assert.equal(clampZoom(Number.NaN), DEFAULT_FINLAND_CAMERA.zoom);
});

test('clampCamera constrains coordinates strictly within Finland bounds', () => {
  const fromWest = clampCamera({
    center: { lat: 59.33, lng: 18.06 },
    zoom: 9,
  });
  assert.equal(fromWest.center.lat, FINLAND_GEOGRAPHIC_BOUNDS.south);
  assert.equal(fromWest.center.lng, FINLAND_GEOGRAPHIC_BOUNDS.west);

  const fromNorthEast = clampCamera({
    center: { lat: 74.0, lng: 36.0 },
    zoom: 22,
  });
  assert.equal(fromNorthEast.zoom, MAX_ZOOM);
  assert.equal(fromNorthEast.center.lat, FINLAND_GEOGRAPHIC_BOUNDS.north);
  assert.equal(fromNorthEast.center.lng, FINLAND_GEOGRAPHIC_BOUNDS.east);
});

test('clampCamera with viewport locks overview center to Finland and prevents panning outside bounds', () => {
  const desktopViewport = { width: 1120, height: 844 };
  const overviewAttempt = clampCamera(
    { center: { lat: 60.0, lng: 19.2 }, zoom: MIN_ZOOM },
    desktopViewport
  );
  assert.ok(Math.abs(overviewAttempt.center.lng - 25.35) < 0.2);
  assert.ok(Math.abs(overviewAttempt.center.lat - 65.35) < 0.25);

  assert.equal(isPointWithinFinlandBounds(overviewAttempt.center), true);
  assert.equal(isPointWithinFinlandBounds({ lat: 58.9, lng: 25.0 }), false);
});

test('resolveGoogleMapTypeId maps Base Map and Satellite modes accurately', () => {
  assert.equal(resolveGoogleMapTypeId('base', { showLabels: true, showTerrain: false }), 'roadmap');
  assert.equal(resolveGoogleMapTypeId('base', { showLabels: true, showTerrain: true }), 'terrain');
  assert.equal(
    resolveGoogleMapTypeId('satellite', { showLabels: false, showTerrain: false }),
    'satellite'
  );
  assert.equal(
    resolveGoogleMapTypeId('satellite', { showLabels: true, showTerrain: false }),
    'hybrid'
  );
});

test('Web Mercator projection round-trips Finland coordinates accurately', () => {
  const original = { lat: 60.1699, lng: 24.9384 };
  const worldPx = latLngToWorldPixel(original, 10);
  const roundTripped = worldPixelToLatLng(worldPx, 10);

  assert.ok(Math.abs(roundTripped.lat - original.lat) < 1e-6);
  assert.ok(Math.abs(roundTripped.lng - original.lng) < 1e-6);
});

test('zoomAroundScreenPoint preserves center when zooming with zero cursor offset', () => {
  const start = { center: { lat: 64.5, lng: 26.0 }, zoom: 6 };
  const next = zoomAroundScreenPoint(start, 8, { dx: 0, dy: 0 });

  assert.equal(next.zoom, 8);
  assert.ok(Math.abs(next.center.lat - start.center.lat) < 1e-4);
  assert.ok(Math.abs(next.center.lng - start.center.lng) < 1e-4);
});

test('calculateScaleBar scales down distance label as zoom increases', () => {
  const countryScale = calculateScaleBar(65.31, 5.3);
  const cityScale = calculateScaleBar(60.17, 13);

  assert.ok(countryScale.distanceMeters > cityScale.distanceMeters);
  assert.ok(countryScale.label.endsWith('km'));
  assert.ok(cityScale.pixelWidth >= 28 && cityScale.pixelWidth <= 125);
});

test('formatLat and formatLng render clean hemisphere coordinates', () => {
  assert.equal(formatLat(66.55), '66.5500° N');
  assert.equal(formatLng(25.85), '25.8500° E');
});

test('validateCoordinateInput rejects empty and out-of-Finland values and accepts valid Finnish coordinates', () => {
  assert.equal(validateCoordinateInput('', '25.0').valid, false);
  assert.equal(validateCoordinateInput('abc', '25.0').valid, false);
  assert.equal(validateCoordinateInput('48.8566', '2.3522').valid, false);

  const valid = validateCoordinateInput('61.0950', '22.0850');
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.point, { lat: 61.095, lng: 22.085 });
});

test('TOP_5_WILDLIFE_ACCIDENT_CITIES defines 100 permanent road-aligned cameras per city (500 total) at historically prominent collision sites', () => {
  assert.equal(TOP_5_WILDLIFE_ACCIDENT_CITIES.length, 5);
  assert.equal(CAMERAS_PER_CITY, 100);
  assert.equal(PHYSICAL_CAMERAS_TOTAL, 500);
  assert.equal(ALL_PLANNED_CAMERAS.length, 500);
  assert.equal(TOTAL_TOP5_ACCIDENTS, 9663);
  assert.deepEqual(
    TOP_5_WILDLIFE_ACCIDENT_CITIES.map((c) => c.name),
    ['Salo', 'Raasepori', 'Pori', 'Hämeenlinna', 'Sastamala']
  );

  const seenIds = new Set<string>();
  for (let i = 0; i < TOP_5_WILDLIFE_ACCIDENT_CITIES.length; i++) {
    const city = TOP_5_WILDLIFE_ACCIDENT_CITIES[i];
    assert.equal(city.cameras.length, 100, `${city.name} must have 100 permanent cameras`);
    if (i > 0) {
      assert.ok(city.totalAccidents <= TOP_5_WILDLIFE_ACCIDENT_CITIES[i - 1].totalAccidents);
    }

    city.cameras.forEach((cam, idx) => {
      assert.equal(seenIds.has(cam.id), false, `Duplicate camera ID ${cam.id}`);
      seenIds.add(cam.id);
      assert.equal(cam.id, `${city.prefix}-${String(idx + 1).padStart(3, '0')}`);
      assert.equal(cam.unitNumber, idx + 1);
      assert.equal(cam.rankInCity, idx + 1);
      assert.equal(isPointWithinFinlandBounds({ lat: cam.lat, lng: cam.lng }), true);
      assert.equal(
        isPointInCityBoundary(cam.lat, cam.lng, city),
        true,
        `${cam.id} must lie inside ${city.name} municipal boundary`
      );
      assert.equal(Number.isInteger(cam.bearingDeg), true);
      assert.ok(cam.bearingDeg >= 0 && cam.bearingDeg < 360);
      assert.ok(cam.roadLabel.length >= 2);
      assert.ok(
        cam.historicalAccidents >= 4,
        `Expected historically prominent collision site for ${cam.id}, got ${cam.historicalAccidents}`
      );
      assert.equal(
        cam.whiteTailedDeer + cam.roeDeer + cam.moose,
        cam.historicalAccidents
      );
    });

    // Verify top-ranked cameras sit on higher-collision stretches than lower-ranked cameras
    const top20Acc =
      city.cameras.slice(0, 20).reduce((s, c) => s + c.historicalAccidents, 0) / 20;
    const bottom20Acc =
      city.cameras.slice(80, 100).reduce((s, c) => s + c.historicalAccidents, 0) / 20;
    assert.ok(
      top20Acc > bottom20Acc * 1.5,
      `Expected top-20 prominent sites in ${city.name} to exceed tail sites (${top20Acc} vs ${bottom20Acc})`
    );

    // Verify citywide prominent scatter spans >= 8 km across each municipality
    let maxPairSpanKm = 0;
    for (let a = 0; a < city.cameras.length; a++) {
      for (let b = a + 1; b < city.cameras.length; b++) {
        const dKm =
          groundDistanceAndBearing(
            city.cameras[a].lat,
            city.cameras[a].lng,
            city.cameras[b].lat,
            city.cameras[b].lng
          ).distanceM / 1000;
        if (dKm > maxPairSpanKm) maxPairSpanKm = dKm;
      }
    }
    assert.ok(
      maxPairSpanKm >= 8,
      `Expected municipal-wide scatter >= 8 km in ${city.name}, got ${maxPairSpanKm.toFixed(1)} km`
    );
  }
});

test('cameraPlanGeometry enforces 5-100m range bounds, city filtering, summary metrics, and CSV export', () => {
  assert.equal(MIN_CAMERA_RANGE_M, 5);
  assert.equal(MAX_CAMERA_RANGE_M, 100);

  const clampedMax = clampCoverageConfig({
    ...DEFAULT_COVERAGE_CONFIG,
    rangeMeters: 9999,
    fovDeg: 10,
  });
  assert.equal(clampedMax.rangeMeters, 100);
  assert.equal(clampedMax.fovDeg, MIN_CAMERA_FOV_DEG);

  const clampedMin = clampCoverageConfig({
    ...DEFAULT_COVERAGE_CONFIG,
    rangeMeters: 1,
    fovDeg: 65,
  });
  assert.equal(clampedMin.rangeMeters, 5);

  const origin5m = { lat: 60.38, lng: 23.13, bearingDeg: 90 };
  const sector5m = computeCameraSectorPolygon(origin5m, 5, 65, 10);
  const midArcPt = sector5m[6];
  const dist5m = Math.hypot(
    (midArcPt.lng - origin5m.lng) * 111_320 * Math.cos((origin5m.lat * Math.PI) / 180),
    (midArcPt.lat - origin5m.lat) * 111_132
  );
  assert.ok(Math.abs(dist5m - 5) < 0.25, `Expected 5m arc radius, got ${dist5m.toFixed(2)}m`);

  const dualPolys30 = computeCameraCoveragePolygons(origin5m, 60, 30, 12);
  assert.equal(dualPolys30.length, 2, '30° bidirectional camera renders 2 opposing road cones');
  const mergedPoly180 = computeCameraCoveragePolygons(origin5m, 60, 180, 12);
  assert.equal(mergedPoly180.length, 1, '180° bidirectional camera merges cleanly into 1 full circle');

  assert.equal(formatAreaCompact(calculateSingleCameraAreaSqMeters(5, 65)), '28.4 m²');
  assert.equal(formatAreaCompact(calculateSingleCameraAreaSqMeters(50, 65)), '2,836 m²');
  assert.equal(formatAreaCompact(calculateSingleCameraAreaSqMeters(60, 30)), '1,885 m²');

  const expectedArea = (190 / 360) * Math.PI * 220 * 220;
  assert.ok(Math.abs(calculateSingleCameraAreaSqMeters(220, 95) - expectedArea) < 1e-6);
  assert.ok(Math.abs(computeSingleCameraAreaHa(220, 95) - expectedArea / 10_000) < 1e-8);
  assert.ok(
    Math.abs(computeTotalPlanAreaKm2(500, 220, 95) - (500 * expectedArea) / 1_000_000) < 1e-6
  );
  // Capped at full 360° circle when 2 * fovDeg >= 360°
  assert.ok(
    Math.abs(calculateSingleCameraAreaSqMeters(60, 210) - Math.PI * 60 * 60) < 1e-6
  );

  const poriCameras = filterCamerasByCityAndSearch(ALL_PLANNED_CAMERAS, 'pori', '');
  assert.equal(poriCameras.length, 100);

  const allMetrics = calculatePlanSummaryMetrics(
    TOP_5_WILDLIFE_ACCIDENT_CITIES,
    DEFAULT_COVERAGE_CONFIG,
    'all'
  );
  assert.equal(allMetrics.cameraCount, 500);

  const saloMetrics = calculatePlanSummaryMetrics(
    TOP_5_WILDLIFE_ACCIDENT_CITIES,
    DEFAULT_COVERAGE_CONFIG,
    'salo'
  );
  assert.equal(saloMetrics.cameraCount, 100);

  const searchSalo1 = filterCamerasByCityAndSearch(ALL_PLANNED_CAMERAS, 'all', 'SAL-001');
  assert.equal(searchSalo1.length, 1);
  assert.equal(searchSalo1[0].cityName, 'Salo');

  const searchUnit1 = filterCamerasByCityAndSearch(ALL_PLANNED_CAMERAS, 'salo', 'Unit #1');
  assert.equal(searchUnit1.length, 1);
  assert.equal(searchUnit1[0].id, 'SAL-001');

  const csv = buildCameraPlanCsv(poriCameras.slice(0, 2), DEFAULT_COVERAGE_CONFIG);
  const lines = csv.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('camera_id,city,unit_number,rank_in_city'));
  assert.ok(lines[0].includes('bearing_deg,reverse_bearing_deg'));
  assert.equal(lines[0].includes('sector_index'), false);
  assert.ok(lines[1].startsWith('POR-001'));
});

test('selecting a camera or city never hides other cities on the map (all 500 permanent cameras stay visible)', () => {
  const sal1 = ALL_PLANNED_CAMERAS.find((c) => c.id === 'SAL-001')!;
  const raa1 = ALL_PLANNED_CAMERAS.find((c) => c.id === 'RAA-001')!;

  assert.equal(resolveCityIdOnCameraSelect('all', sal1), 'all');
  assert.equal(resolveCityIdOnCameraSelect('salo', sal1), 'salo');
  assert.equal(resolveCityIdOnCameraSelect('salo', raa1), 'all');

  for (const cityScope of ['all', 'salo', 'raasepori', 'pori', 'hameenlinna', 'sastamala']) {
    const visibleAll = resolveMapVisiblePlan(cityScope, sal1.id);
    assert.equal(visibleAll.cities.length, 5);
    assert.equal(visibleAll.cameras.length, 500);
  }
});

test('default camera optics are 30 degrees FOV and 60 meters range, and polygon geometry + offline Ramboll dataset work deterministically', async () => {
  assert.equal(DEFAULT_COVERAGE_CONFIG.fovDeg, 30);
  assert.equal(DEFAULT_COVERAGE_CONFIG.rangeMeters, 60);
  assert.equal(MIN_CAMERA_FOV_DEG, 10);

  const {
    computePolygonAreaKm2,
    isPointInLatLngPolygon,
    polygonsApproximatelyEqual,
    simplifyLatLngRing,
  } = await import('./polygonGeometry');
  const {
    getLocalRambollDatasetStats,
    queryLocalAccidentsForPolygon,
  } = await import('../server/rambollLocalStore');
  const { buildPolygonAreaCameraPlan } = await import('../server/rambollCustomPlanner');

  const box = [
    { lat: 60.22, lng: 24.0 },
    { lat: 60.22, lng: 24.14 },
    { lat: 60.29, lng: 24.14 },
    { lat: 60.29, lng: 24.0 },
  ];
  const areaKm2 = computePolygonAreaKm2(box);
  assert.ok(areaKm2 > 50 && areaKm2 < 70, `Expected ~60 km², got ${areaKm2.toFixed(1)} km²`);
  assert.equal(isPointInLatLngPolygon(60.255, 24.07, box), true);
  assert.equal(isPointInLatLngPolygon(60.45, 24.07, box), false);
  assert.equal(polygonsApproximatelyEqual(box, [...box]), true);

  const denseRing = Array.from({ length: 120 }, (_, idx) => {
    const angle = (idx / 120) * Math.PI * 2;
    return {
      lat: 60.25 + Math.sin(angle) * 0.04,
      lng: 24.07 + Math.cos(angle) * 0.08,
    };
  });
  const simplified = simplifyLatLngRing(denseRing);
  assert.ok(simplified.length >= 8 && simplified.length <= 80);

  const stats = getLocalRambollDatasetStats();
  assert.equal(stats.offlineReady, true);
  assert.equal(stats.nationwideAccidents, 67081);
  assert.equal(stats.warningSegments, 27599);

  const localQuery = queryLocalAccidentsForPolygon(box, 500);
  assert.ok(localQuery.insideAccidents.length > 20);

  const area1 = await buildPolygonAreaCameraPlan({
    polygon: box,
    cameraCount: 24,
    rangeMeters: 60,
    fovDeg: 30,
    label: 'Area of Interest 1',
    areaId: 'area-1',
    cameraPrefix: 'A01',
  });
  assert.equal(area1.id, 'area-1');
  assert.equal(area1.cameras.length, 24);
  assert.equal(area1.cameras[0].id, 'A01-001');
  assert.equal(area1.cameras[0].cityId, 'area-1');
  assert.ok(Array.isArray(area1.roadPolylines) && area1.roadPolylines.length > 5);
  assert.ok(
    area1.cameras.every((c) => isPointInLatLngPolygon(c.lat, c.lng, box)),
    'Every roadside camera must lie strictly inside the drawn Area of Interest polygon'
  );
  assert.ok(
    area1.cameras.every((c) => {
      const [b1, b2] = getCameraBearings(c);
      const sep = Math.abs(((((b1 - b2) % 360) + 540) % 360) - 180);
      return typeof c.reverseBearingDeg === 'number' && sep >= 135;
    }),
    'Every plotted roadside camera must define opposing forward and reverse road bearings'
  );

  // Verify orange-road ("large") prioritization & distribution across `box`:
  // All 24 cameras must land on orange-hued corridors (Vt, Kt, St, Yt, or main municipal arterials),
  // spread across multiple distinct orange roads (not solely Vt 1 / Vt 25) and all 4 geographic quadrants!
  const { groundDistanceM } = await import('../server/rambollCustomPlanner');
  const distinctOrangeRoads = new Set(area1.cameras.map((c) => c.roadLabel));
  assert.ok(
    distinctOrangeRoads.size >= 3,
    `Expected cameras distributed across multiple orange corridors (Vt, St, Yt), got: ${[...distinctOrangeRoads].join(', ')}`
  );
  assert.equal(
    area1.cameras.some((c) => c.roadLabel === 'Vt 25' || c.roadLabel === 'Vt 1'),
    true,
    'Major orange highways (Vt 1 / Vt 25) must receive cameras'
  );
  assert.equal(
    area1.cameras.some((c) => c.roadLabel.startsWith('St ') || c.roadLabel.startsWith('Yt ')),
    true,
    'Other orange-hued regional/connecting roads (St / Yt) must also receive cameras'
  );

  const midLat = 60.255;
  const midLng = 24.07;
  const quadrantsHit = new Set<string>();
  const nearestNeighborDistances: number[] = [];

  for (let i = 0; i < area1.cameras.length; i++) {
    const c = area1.cameras[i];
    quadrantsHit.add(`${c.lat >= midLat ? 'N' : 'S'}${c.lng >= midLng ? 'E' : 'W'}`);
    let minD = Infinity;
    for (let j = 0; j < area1.cameras.length; j++) {
      if (i === j) continue;
      const d = groundDistanceM(c.lat, c.lng, area1.cameras[j].lat, area1.cameras[j].lng);
      if (d < minD) minD = d;
    }
    nearestNeighborDistances.push(minD);
  }

  nearestNeighborDistances.sort((a, b) => a - b);
  const medianNearestM = nearestNeighborDistances[Math.floor(nearestNeighborDistances.length / 2)];
  assert.equal(
    quadrantsHit.size,
    4,
    'Cameras should distribute across orange roads in all 4 quadrants of the area'
  );
  assert.ok(
    medianNearestM >= 550,
    `Expected even spacing across orange roads (median nearest-neighbor >= 550m), got ${Math.round(medianNearestM)}m`
  );

  // Verify city centre exclusion: zero cameras in Lohja downtown core (Market Square / Laurinkatu / Suurlohjankatu / downtown Vt 25),
  // even when placing 80 cameras across the Lohja corridor box!
  const lohja80 = await buildPolygonAreaCameraPlan({
    polygon: box,
    cameraCount: 80,
    rangeMeters: 60,
    fovDeg: 30,
    label: 'Lohja 80 Check',
    areaId: 'area-lohja-80',
    cameraPrefix: 'LHJ',
  });
  assert.equal(lohja80.cameras.length, 80);
  for (const cam of [...area1.cameras, ...lohja80.cameras]) {
    const distMarketSquareM = groundDistanceM(cam.lat, cam.lng, 60.2508, 24.0658);
    const insideDowntownCore =
      cam.lat > 60.2425 && cam.lat < 60.2565 && cam.lng > 24.054 && cam.lng < 24.088;
    assert.ok(
      distMarketSquareM > 680 && !insideDowntownCore,
      `No camera may be placed in Lohja city centre; found ${cam.id} (${cam.roadLabel}) at (${cam.lat}, ${cam.lng}), ${Math.round(distMarketSquareM)}m from Lohja Market Square`
    );
  }

  // Verify a polygon drawn strictly inside Lohja city centre rejects cleanly instead of placing cameras downtown
  const pureDowntownBox = [
    { lat: 60.247, lng: 24.060 },
    { lat: 60.247, lng: 24.071 },
    { lat: 60.252, lng: 24.071 },
    { lat: 60.252, lng: 24.060 },
  ];
  await assert.rejects(
    () =>
      buildPolygonAreaCameraPlan({
        polygon: pureDowntownBox,
        cameraCount: 5,
        rangeMeters: 60,
        fovDeg: 30,
        label: 'Downtown Only',
        areaId: 'area-downtown',
        cameraPrefix: 'DTN',
      }),
    /city centre area/i
  );

  // Focused local sub-box around orange roads (Vt 25 & Yt 11121) + white local streets (Braskintie / Pailantie / Siirtoväentie):
  // - At 8 cameras (< full orange-road coverage): 100% land on orange roads (Vt 25 / Yt 11121), 0 on white local streets.
  // - At 32 cameras (> full orange-road coverage): orange roads are covered first, and surplus spills onto white local streets!
  const localMixBox = [
    { lat: 60.201, lng: 24.012 },
    { lat: 60.201, lng: 24.035 },
    { lat: 60.214, lng: 24.035 },
    { lat: 60.214, lng: 24.012 },
  ];
  const isOrangeRoadLabel = (label: string) => /^(Vt|Kt|St|Yt) \d+$/.test(label);

  const localUnderBudget = await buildPolygonAreaCameraPlan({
    polygon: localMixBox,
    cameraCount: 8,
    rangeMeters: 60,
    fovDeg: 30,
    label: 'Local Mix Under',
    areaId: 'area-under',
    cameraPrefix: 'UND',
  });
  assert.equal(localUnderBudget.cameras.length, 8);
  assert.equal(
    localUnderBudget.cameras.every((c) => isOrangeRoadLabel(c.roadLabel)),
    true,
    `Expected all 8 cameras on orange roads (Vt 25 / Yt 11121) and 0 on white local streets, got: ${localUnderBudget.cameras.map((c) => c.roadLabel).join(', ')}`
  );

  const localOverflow = await buildPolygonAreaCameraPlan({
    polygon: localMixBox,
    cameraCount: 32,
    rangeMeters: 60,
    fovDeg: 30,
    label: 'Local Mix Overflow',
    areaId: 'area-over',
    cameraPrefix: 'OVR',
  });
  assert.equal(localOverflow.cameras.length, 32);
  const orangeCount = localOverflow.cameras.filter((c) => isOrangeRoadLabel(c.roadLabel)).length;
  const whiteLocalCount = localOverflow.cameras.length - orangeCount;
  assert.ok(
    orangeCount >= 14,
    `Expected orange corridors properly covered first (>= 14 cameras), got ${orangeCount}`
  );
  assert.ok(
    whiteLocalCount >= 5,
    `Expected surplus cameras to spill onto white local streets once orange roads are properly covered, got ${whiteLocalCount}`
  );

  // Verify Ramer-Douglas-Peucker road simplification preserves 3-point 90-degree corners while dropping collinear vertices
  const { simplifyRoadCoordsMeters } = await import('../server/rambollCustomPlanner');
  const rightAngleBend: Array<[number, number]> = [
    [24.05, 60.25],
    [24.055, 60.25], // ~275m East -> 90° bend corner!
    [24.055, 60.253], // ~333m North
  ];
  const simplifiedCorner = simplifyRoadCoordsMeters(rightAngleBend, 1.8);
  assert.equal(
    simplifiedCorner.length,
    3,
    '3-point 90-degree road bend must preserve its middle corner vertex'
  );

  const straightCollinear: Array<[number, number]> = [
    [24.05, 60.25],
    [24.051, 60.25],
    [24.052, 60.25],
    [24.053, 60.25], // ~166m total (< 320m segment cap)
  ];
  const simplifiedStraight = simplifyRoadCoordsMeters(straightCollinear, 1.8);
  assert.equal(
    simplifiedStraight.length,
    2,
    'Collinear straight road vertices (< 320m) within tolerance should simplify to endpoints'
  );

  const longCollinear: Array<[number, number]> = [
    [24.05, 60.25],
    [24.052, 60.25],
    [24.054, 60.25],
    [24.056, 60.25], // ~331m total (> 320m segment cap)
  ];
  assert.equal(simplifyRoadCoordsMeters(longCollinear, 1.8).length, 3);
});

test('classifyStateRoad treats all orange-hued state corridors (Vt, Kt, St, Yt) as large (Tier 1) and selectRoadStationsByHierarchy blocks small roads until orange roads are covered', async () => {
  const {
    classifyStateRoad,
    projectPointMeters,
    selectRoadStationsByHierarchy,
  } = await import('../server/rambollCustomPlanner');

  assert.deepEqual(classifyStateRoad(1), { label: 'Vt 1', roadTier: 1, weight: 1.55 });
  assert.deepEqual(classifyStateRoad(51), { label: 'Kt 51', roadTier: 1, weight: 1.42 });
  assert.deepEqual(classifyStateRoad(116), { label: 'St 116', roadTier: 1, weight: 1.3 });
  assert.deepEqual(classifyStateRoad(1070), { label: 'Yt 1070', roadTier: 1, weight: 1.18 });
  assert.deepEqual(classifyStateRoad(11257), { label: 'Yt 11257', roadTier: 1, weight: 1.0 });
  assert.equal(classifyStateRoad(0), null);
  assert.equal(classifyStateRoad(20105), null, 'Interchange ramps (tie >= 20000) must be excluded');
  assert.equal(classifyStateRoad(70025), null, 'Pedestrian/cycle paths (tie >= 70000) must be excluded');

  // Synthetic 1,000 m Tier 1 orange road (chain 0) + 4,000 m Tier 2 small white road 2 km north (chain 1)
  // Even give the small white road higher raw wildlife scores to verify strict hierarchy gating!
  const candidates: Array<{
    id: string;
    chainIdx: number;
    stationDistM: number;
    lat: number;
    lng: number;
    roadTier: 1 | 2;
    hierarchyWeight: number;
    score: number;
    accidents500m: number;
  }> = [];

  for (let d = 30; d <= 970; d += 25) {
    const pt = projectPointMeters(60.3, 24.0, d, 90);
    candidates.push({
      id: `orange-${d}`,
      chainIdx: 0,
      stationDistM: d,
      lat: pt.lat,
      lng: pt.lng,
      roadTier: 1,
      hierarchyWeight: 1.3,
      score: 10,
      accidents500m: 5,
    });
  }

  for (let d = 30; d <= 3970; d += 50) {
    const pt = projectPointMeters(60.32, 24.0, d, 90);
    candidates.push({
      id: `white-${d}`,
      chainIdx: 1,
      stationDistM: d,
      lat: pt.lat,
      lng: pt.lng,
      roadTier: 2,
      hierarchyWeight: 0.5,
      score: 99, // intentionally higher raw score on the small road
      accidents500m: 40,
    });
  }

  const chainLengths = new Map<number, number>([
    [0, 1000],
    [1, 4000],
  ]);

  // Case A: 5 cameras (< ~9 cameras needed to cover 1,000 m at 60 m bidirectional range) -> 0 on small road!
  const pick5 = selectRoadStationsByHierarchy(candidates, chainLengths, 5, 60);
  assert.equal(pick5.length, 5);
  assert.equal(
    pick5.every((c) => c.roadTier === 1),
    true,
    'Zero cameras may be placed on small non-orange roads before large orange roads are properly covered'
  );

  // Case B: 15 cameras (> ~9–10 cameras needed to properly cover 1,000 m orange road) -> saturates orange road first, then spills to small road
  const pick15 = selectRoadStationsByHierarchy(candidates, chainLengths, 15, 60);
  assert.equal(pick15.length, 15);
  const orangePicked = pick15.filter((c) => c.roadTier === 1);
  const smallPicked = pick15.filter((c) => c.roadTier === 2);
  assert.ok(
    orangePicked.length >= 8 && orangePicked.length <= 12,
    `Expected ~9-10 cameras to properly cover 1,000m orange road at 60m bidirectional sightRange, got ${orangePicked.length}`
  );
  assert.equal(orangePicked.length + smallPicked.length, 15);
  assert.ok(smallPicked.length >= 3, 'Remaining cameras must spill onto smaller roads once orange roads are covered');

  // Verify every station on the 1,000 m orange road is within < 75 m (1.25 * 60 m) of a placed camera
  for (const cand of candidates.filter((c) => c.roadTier === 1)) {
    const minDistToPlaced = Math.min(
      ...orangePicked.map((p) => Math.abs(p.stationDistM - cand.stationDistM))
    );
    assert.ok(
      minDistToPlaced < 75,
      `Every station on the orange road must be properly covered (< 75m to nearest camera), got ${minDistToPlaced}m`
    );
  }
});

test('isPointInCityCentreArea detects downtown cores via crosswalks, traffic lights, or dense addressed street grids while keeping suburbs/highways open', async () => {
  const {
    buildUrbanCentreIndex,
    isPointInCityCentreArea,
    projectPointMeters,
  } = await import('../server/rambollCustomPlanner');

  const centerLat = 60.45;
  const centerLng = 22.27;

  // 1. Crosswalk signal: 28 pedestrian crosswalks within 600 m -> city centre, 27 -> false
  const cw27: Array<[number, number]> = Array.from({ length: 27 }, (_, i) => {
    const pt = projectPointMeters(centerLat, centerLng, 60 + (i % 12) * 40, (i * 37) % 360);
    return [pt.lng, pt.lat];
  });
  const idxCw27 = buildUrbanCentreIndex({ crosswalks: cw27, trafficLights: [], municipalStreets: [] });
  assert.equal(isPointInCityCentreArea(centerLat, centerLng, idxCw27), false);

  const cw28: Array<[number, number]> = [...cw27, [centerLng, centerLat]];
  const idxCw28 = buildUrbanCentreIndex({ crosswalks: cw28, trafficLights: [], municipalStreets: [] });
  assert.equal(isPointInCityCentreArea(centerLat, centerLng, idxCw28), true);
  const twoKmEast = projectPointMeters(centerLat, centerLng, 2000, 90);
  assert.equal(isPointInCityCentreArea(twoKmEast.lat, twoKmEast.lng, idxCw28), false);

  // 2. Traffic light signal: >= 10 signals within 550 m inside an addressed urban street grid (>= 45 addressed blocks) -> true,
  // whereas a signalized highway interchange with sparse addresses (< 45) stays false!
  const tl12: Array<[number, number]> = Array.from({ length: 12 }, (_, i) => {
    const pt = projectPointMeters(centerLat, centerLng, 60 + i * 35, (i * 30) % 360);
    return [pt.lng, pt.lat];
  });
  const sparseHighwayAddresses = Array.from({ length: 24 }, (_, i) => {
    const pt = projectPointMeters(centerLat, centerLng, 80 + i * 15, (i * 18) % 360);
    return { lat: pt.lat, lng: pt.lng, lengthM: 120, hasAddress: true };
  });
  assert.equal(
    isPointInCityCentreArea(
      centerLat,
      centerLng,
      buildUrbanCentreIndex({ crosswalks: [], trafficLights: tl12, municipalStreets: sparseHighwayAddresses })
    ),
    false,
    'Signalized motorway ramp interchange outside downtown street grid should remain eligible'
  );

  const downtownSignalGrid = Array.from({ length: 50 }, (_, i) => {
    const pt = projectPointMeters(centerLat, centerLng, 50 + (i % 10) * 40, (i * 23) % 360);
    return { lat: pt.lat, lng: pt.lng, lengthM: 110, hasAddress: true }; // 5,500 m (< 10,800 m street-only threshold)
  });
  assert.equal(
    isPointInCityCentreArea(
      centerLat,
      centerLng,
      buildUrbanCentreIndex({ crosswalks: [], trafficLights: tl12.slice(0, 10), municipalStreets: downtownSignalGrid })
    ),
    true
  );

  // 3. Addressed municipal street-grid signal: >= 10,800 m total length AND >= 80 addressed blocks within 600 m
  const denseGrid = Array.from({ length: 84 }, (_, i) => {
    const pt = projectPointMeters(centerLat, centerLng, 40 + (i % 12) * 40, (i * 29) % 360);
    return {
      lat: pt.lat,
      lng: pt.lng,
      lengthM: 135, // 84 * 135 m = 11,340 m
      hasAddress: true,
    };
  });
  const idxGrid = buildUrbanCentreIndex({ crosswalks: [], trafficLights: [], municipalStreets: denseGrid });
  assert.equal(isPointInCityCentreArea(centerLat, centerLng, idxGrid), true);
  assert.equal(isPointInCityCentreArea(twoKmEast.lat, twoKmEast.lng, idxGrid), false);

  // Same street length without street addresses (e.g. unaddressed park/industrial paths) does NOT trigger city centre
  const unaddressedGrid = denseGrid.map((s) => ({ ...s, hasAddress: false }));
  assert.equal(
    isPointInCityCentreArea(
      centerLat,
      centerLng,
      buildUrbanCentreIndex({ crosswalks: [], trafficLights: [], municipalStreets: unaddressedGrid })
    ),
    false
  );
});

