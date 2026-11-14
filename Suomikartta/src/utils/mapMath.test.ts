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
  ANNUAL_PLACEMENTS_TOTAL,
  CAMERAS_PER_SECTOR,
  PHYSICAL_CAMERAS_TOTAL,
  SECTOR_IDS,
  SECTOR_ROTATION_SCHEDULE,
  SECTORS_PER_CITY,
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  TOTAL_TOP5_ACCIDENTS,
} from '../data/finlandWildlifePlan';
import {
  buildCameraPlanCsv,
  calculatePlanSummaryMetrics,
  calculateSingleCameraAreaSqMeters,
  clampCoverageConfig,
  computeCameraSectorPolygon,
  computeSingleCameraAreaHa,
  computeTotalPlanAreaKm2,
  DEFAULT_COVERAGE_CONFIG,
  filterCamerasByCityAndSearch,
  formatAreaCompact,
  MAX_CAMERA_RANGE_M,
  MIN_CAMERA_FOV_DEG,
  MIN_CAMERA_RANGE_M,
  resolveCityIdOnCameraSelect,
  resolveMapVisiblePlan,
} from './cameraPlanGeometry';
import { isPointInCityBoundary } from './crossingSimulator';

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

test('TOP_5_WILDLIFE_ACCIDENT_CITIES defines 5 sectors per city × 100 cameras = 500 annual placements per city (2,500 total)', () => {
  assert.equal(TOP_5_WILDLIFE_ACCIDENT_CITIES.length, 5);
  assert.equal(SECTORS_PER_CITY, 5);
  assert.equal(CAMERAS_PER_SECTOR, 100);
  assert.equal(PHYSICAL_CAMERAS_TOTAL, 500);
  assert.equal(ANNUAL_PLACEMENTS_TOTAL, 2500);
  assert.equal(ALL_PLANNED_CAMERAS.length, 2500);
  assert.equal(TOTAL_TOP5_ACCIDENTS, 9663);
  assert.deepEqual(
    TOP_5_WILDLIFE_ACCIDENT_CITIES.map((c) => c.name),
    ['Salo', 'Raasepori', 'Pori', 'Hämeenlinna', 'Sastamala']
  );

  for (let i = 0; i < TOP_5_WILDLIFE_ACCIDENT_CITIES.length; i++) {
    const city = TOP_5_WILDLIFE_ACCIDENT_CITIES[i];
    assert.equal(city.sectors.length, 5, `${city.name} must have 5 sectors`);
    assert.equal(city.cameras.length, 500, `${city.name} must have 500 annual camera placements`);
    if (i > 0) {
      assert.ok(city.totalAccidents <= TOP_5_WILDLIFE_ACCIDENT_CITIES[i - 1].totalAccidents);
    }

    for (const sId of SECTOR_IDS) {
      const sec = city.sectors.find((s) => s.sectorIndex === sId);
      assert.ok(sec, `Missing sector ${sId} in ${city.name}`);
      assert.equal(sec.cameraCount, 100);
      assert.equal(sec.shortPeriod, SECTOR_ROTATION_SCHEDULE[sId].shortPeriod);
      assert.ok(sec.voronoiRing.length >= 3, `Sector ${sId} in ${city.name} needs Voronoi polygon`);

      const secCams = city.cameras.filter((c) => c.sectorIndex === sId);
      assert.equal(secCams.length, 100, `Sector ${sId} in ${city.name} must have 100 cameras`);
      secCams.forEach((cam, idx) => {
        assert.equal(cam.unitNumber, idx + 1);
        assert.equal(cam.rankInSector, idx + 1);
        assert.equal(isPointWithinFinlandBounds({ lat: cam.lat, lng: cam.lng }), true);
        assert.equal(
          isPointInCityBoundary(cam.lat, cam.lng, city),
          true,
          `${cam.id} must lie inside ${city.name} municipal boundary`
        );
        assert.equal(Number.isInteger(cam.bearingDeg), true);
        assert.ok(cam.bearingDeg >= 0 && cam.bearingDeg < 360);
        assert.ok(cam.roadLabel.length >= 2);
        assert.ok(cam.historicalAccidents >= 1);
        assert.equal(
          cam.whiteTailedDeer + cam.roeDeer + cam.moose,
          cam.historicalAccidents
        );
      });
    }
  }
});

test('cameraPlanGeometry enforces 5-100m range bounds, separate sector inspection (S1-S5 vs All 5), and CSV export', () => {
  assert.equal(MIN_CAMERA_RANGE_M, 5);
  assert.equal(MAX_CAMERA_RANGE_M, 100);
  assert.equal(DEFAULT_COVERAGE_CONFIG.showDeploymentSectors, true);

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

  assert.equal(formatAreaCompact(calculateSingleCameraAreaSqMeters(5, 65)), '14.2 m²');
  assert.equal(formatAreaCompact(calculateSingleCameraAreaSqMeters(50, 65)), '1,418 m²');

  const expectedArea = (95 / 360) * Math.PI * 220 * 220;
  assert.ok(Math.abs(calculateSingleCameraAreaSqMeters(220, 95) - expectedArea) < 1e-6);
  assert.ok(Math.abs(computeSingleCameraAreaHa(220, 95) - expectedArea / 10_000) < 1e-8);
  assert.ok(
    Math.abs(computeTotalPlanAreaKm2(500, 220, 95) - (500 * expectedArea) / 1_000_000) < 1e-6
  );

  // Separate sector inspection in sidebar & summary metrics
  const poriAllSectors = filterCamerasByCityAndSearch(ALL_PLANNED_CAMERAS, 'pori', '', 'all');
  assert.equal(poriAllSectors.length, 500);

  for (const sId of SECTOR_IDS) {
    const poriSingleSector = filterCamerasByCityAndSearch(ALL_PLANNED_CAMERAS, 'pori', '', sId);
    assert.equal(poriSingleSector.length, 100);
    assert.ok(poriSingleSector.every((c) => c.sectorIndex === sId));
  }

  const saloAllMetrics = calculatePlanSummaryMetrics(
    TOP_5_WILDLIFE_ACCIDENT_CITIES,
    DEFAULT_COVERAGE_CONFIG,
    'salo',
    'all'
  );
  assert.equal(saloAllMetrics.cameraCount, 500);

  const saloS2Metrics = calculatePlanSummaryMetrics(
    TOP_5_WILDLIFE_ACCIDENT_CITIES,
    DEFAULT_COVERAGE_CONFIG,
    'salo',
    2
  );
  assert.equal(saloS2Metrics.cameraCount, 100);

  const searchSaloS1 = filterCamerasByCityAndSearch(ALL_PLANNED_CAMERAS, 'all', 'SAL-S1-001');
  assert.equal(searchSaloS1.length, 1);
  assert.equal(searchSaloS1[0].cityName, 'Salo');
  assert.equal(searchSaloS1[0].sectorIndex, 1);

  const searchUnit1 = filterCamerasByCityAndSearch(ALL_PLANNED_CAMERAS, 'salo', 'Unit #1', 3);
  assert.equal(searchUnit1.length, 1);
  assert.equal(searchUnit1[0].id, 'SAL-S3-001');

  const csv = buildCameraPlanCsv(poriAllSectors.slice(0, 2), DEFAULT_COVERAGE_CONFIG);
  const lines = csv.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes('sector_index,sector_name,rotation_period,unit_number'));
  assert.ok(lines[1].startsWith('POR-S1-001'));
});

test('selecting a camera or city never hides other cities on the map, while sector inspector isolates active 500-camera rotation window', () => {
  const salS1 = ALL_PLANNED_CAMERAS.find((c) => c.id === 'SAL-S1-001')!;
  const raaS1 = ALL_PLANNED_CAMERAS.find((c) => c.id === 'RAA-S1-001')!;

  assert.equal(resolveCityIdOnCameraSelect('all', salS1), 'all');
  assert.equal(resolveCityIdOnCameraSelect('salo', salS1), 'salo');
  assert.equal(resolveCityIdOnCameraSelect('salo', raaS1), 'all');

  for (const cityScope of ['all', 'salo', 'raasepori', 'pori', 'hameenlinna', 'sastamala']) {
    const visibleAll = resolveMapVisiblePlan(cityScope, salS1.id, 'all');
    assert.equal(visibleAll.cities.length, 5);
    assert.equal(visibleAll.cameras.length, 2500);

    const visibleS2 = resolveMapVisiblePlan(cityScope, salS1.id, 2);
    assert.equal(visibleS2.cities.length, 5);
    assert.equal(visibleS2.cameras.length, 500);
    assert.ok(visibleS2.cameras.every((c) => c.sectorIndex === 2));
  }
});
