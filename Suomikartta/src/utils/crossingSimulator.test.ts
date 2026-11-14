import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  buildEvaluatedResultsWorkbook,
  buildSampleTemplateWorkbook,
  CAMERA_ARRANGEMENTS,
  DEFAULT_SIMULATOR_CONFIG,
  doesCameraDetectEvent,
  evaluateCrossingEvents,
  extractAvailableYears,
  findCameraCoveredCity,
  getCamerasForArrangement,
  getDemoSyntheticEvents,
  parseCrossingSpreadsheetBuffer,
  parseEventDateDetails,
  type CrossingEvent,
} from './crossingSimulator';
import { destinationPoint } from './cameraPlanGeometry';
import { isPointWithinFinlandBounds } from './mapMath';

test('all 3 camera arrangements return valid road-aligned cameras strictly inside covered municipality boundaries', () => {
  assert.equal(CAMERA_ARRANGEMENTS.length, 3);
  for (const spec of CAMERA_ARRANGEMENTS) {
    const cams = getCamerasForArrangement(spec.id);
    const expectedCount = spec.isRotational ? 2500 : 500;
    assert.equal(cams.length, expectedCount, `Expected ${expectedCount} cameras for ${spec.id}`);
    for (const c of cams) {
      assert.equal(isPointWithinFinlandBounds({ lat: c.lat, lng: c.lng }), true);
      assert.ok(c.bearingDeg >= 0 && c.bearingDeg < 360);
      assert.equal(findCameraCoveredCity(c.lat, c.lng)?.id, c.cityId);
    }
  }
});

test('parseEventDateDetails maps 1-year mapping cycle into five 1/5th-year (73-day) rotation sectors accurately', () => {
  assert.equal(parseEventDateDetails('2026-01-01').activeSector, 1);
  assert.equal(parseEventDateDetails('2026-03-14').activeSector, 1);
  assert.equal(parseEventDateDetails('2026-03-15').activeSector, 2);
  assert.equal(parseEventDateDetails('2026-05-26').activeSector, 2);
  assert.equal(parseEventDateDetails('2026-05-27').activeSector, 3);
  assert.equal(parseEventDateDetails('2026-08-07').activeSector, 3);
  assert.equal(parseEventDateDetails('2026-08-08').activeSector, 4);
  assert.equal(parseEventDateDetails('2026-10-19').activeSector, 4);
  assert.equal(parseEventDateDetails('2026-10-20').activeSector, 5);
  assert.equal(parseEventDateDetails('2026-12-31').activeSector, 5);

  // Leap year 2024 & European DD.MM.YYYY formatting
  const leapEnd = parseEventDateDetails('31.12.2024');
  assert.equal(leapEnd.year, 2024);
  assert.equal(leapEnd.daysInYear, 366);
  assert.equal(leapEnd.activeSector, 5);
});

test('doesCameraDetectEvent respects directional FOV cone, max range, and small-animal 70% range factor', () => {
  const cam = { lat: 60.4397, lng: 23.1871, bearingDeg: 50 };

  const pt40mAhead = destinationPoint({ lat: cam.lat, lng: cam.lng }, 40, 50);
  assert.equal(
    doesCameraDetectEvent(
      cam,
      { ...pt40mAhead, animalSize: 'large' },
      50,
      65,
      true
    ).detected,
    true
  );
  assert.equal(
    doesCameraDetectEvent(
      cam,
      { ...pt40mAhead, animalSize: 'small' },
      50,
      65,
      true
    ).detected,
    false
  );
  assert.equal(
    doesCameraDetectEvent(
      cam,
      { ...pt40mAhead, animalSize: 'small' },
      50,
      65,
      false
    ).detected,
    true
  );

  const pt25mBehind = destinationPoint({ lat: cam.lat, lng: cam.lng }, 25, 230);
  assert.equal(
    doesCameraDetectEvent(
      cam,
      { ...pt25mBehind, animalSize: 'large' },
      50,
      65,
      true
    ).detected,
    false
  );
});

test('spatio-temporal 1/5th-year rotation detects crossing when sector is active and misses when cameras rotate to another sector', () => {
  const rotationalCams = getCamerasForArrangement('sector-maximal');
  const saloS1Cam = rotationalCams.find((c) => c.id === 'SAL-S1-001')!;
  assert.ok(saloS1Cam);

  // Place two identical crossings 20m directly down-road from SAL-S1-001:
  // 1) Feb 10, 2026 (Days 1–73 -> Sector 1 active) -> MUST BE DETECTED
  // 2) Jul 15, 2026 (Days 147–219 -> Sector 3 active, cameras moved out of S1) -> MUST BE MISSED
  const targetPt = destinationPoint(
    { lat: saloS1Cam.lat, lng: saloS1Cam.lng },
    20,
    saloS1Cam.bearingDeg
  );

  const testEvents: CrossingEvent[] = [
    {
      eventId: 'ROT-IN-WINDOW',
      date: '2026-02-10',
      lat: targetPt.lat,
      lng: targetPt.lng,
      animalSize: 'large',
    },
    {
      eventId: 'ROT-OUT-OF-WINDOW',
      date: '2026-07-15',
      lat: targetPt.lat,
      lng: targetPt.lng,
      animalSize: 'large',
    },
  ];

  const result = evaluateCrossingEvents(
    testEvents,
    rotationalCams,
    { rangeMeters: 50, fovDeg: 65 },
    { ...DEFAULT_SIMULATOR_CONFIG, arrangementId: 'sector-maximal', selectedYear: 2026 }
  );

  assert.equal(result.evaluated.length, 2);
  const febEv = result.evaluated.find((e) => e.eventId === 'ROT-IN-WINDOW')!;
  const julEv = result.evaluated.find((e) => e.eventId === 'ROT-OUT-OF-WINDOW')!;

  assert.equal(febEv.activeRotationSector, 1);
  assert.equal(febEv.camerasPresentInEventSector, true);
  assert.equal(febEv.detected, true);
  assert.equal(febEv.detectedByCameraId, 'SAL-S1-001');

  assert.equal(julEv.activeRotationSector, 3);
  assert.equal(julEv.camerasPresentInEventSector, false);
  assert.equal(julEv.detected, false);
});

test('parseCrossingSpreadsheetBuffer parses real .xlsx workbooks, handles comma decimals & Excel dates, and rejects invalid schemas', () => {
  const templateBuffer = buildSampleTemplateWorkbook();
  const parsedTemplate = parseCrossingSpreadsheetBuffer(templateBuffer);
  assert.equal(parsedTemplate.valid, true);
  assert.equal(parsedTemplate.events.length, 30);

  const customRows = [
    {
      'Event ID': 'XLS-101',
      Date: 46340,
      Latitude: '60,43972',
      Longitude: '23,18714',
      'Category of Animal Size': 'Large',
    },
    {
      'Event ID': 'XLS-102',
      Date: '2025-10-21',
      Latitude: 61.3412,
      Longitude: 22.9815,
      'Category of Animal Size': 'Small',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(customRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

  const parsedCustom = parseCrossingSpreadsheetBuffer(xlsxBuffer);
  assert.equal(parsedCustom.valid, true);
  assert.equal(parsedCustom.events.length, 2);
  assert.deepEqual(extractAvailableYears(parsedCustom.events), [2025, 2026]);

  const badWs = XLSX.utils.json_to_sheet([{ foo: 1, bar: 2 }]);
  const badWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(badWb, badWs, 'Bad');
  const badBuffer = XLSX.write(badWb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const badResult = parseCrossingSpreadsheetBuffer(badBuffer);
  assert.equal(badResult.valid, false);
  assert.ok(badResult.error?.includes('Missing required column'));
});

test('evaluateCrossingEvents enforces Year Selector (2024, 2025, 2026, All), sector isolation, and covered-city clipping', () => {
  assert.equal(DEFAULT_SIMULATOR_CONFIG.arrangementId, 'sector-maximal');
  const demo = getDemoSyntheticEvents();
  assert.equal(demo.length, 1500);

  const cams = getCamerasForArrangement('sector-maximal');

  // All 3 years combined: 1,320 in covered cities (440/yr), 180 outside covered cities excluded
  const evalAllYears = evaluateCrossingEvents(
    demo,
    cams,
    { rangeMeters: 50, fovDeg: 65 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 'all' }
  );
  assert.equal(evalAllYears.summary.uploadedEventsCount, 1500);
  assert.equal(evalAllYears.summary.excludedOutsideCitiesCount, 180);
  assert.deepEqual(evalAllYears.summary.availableYears, [2024, 2025, 2026]);
  assert.equal(evalAllYears.summary.totalEvents, 1320);

  // Year Selector = 2025: strictly 440 events in covered cities for 2025 (880 from 2024 & 2026 filtered out)
  const eval2025 = evaluateCrossingEvents(
    demo,
    cams,
    { rangeMeters: 50, fovDeg: 65 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2025 }
  );
  assert.equal(eval2025.summary.selectedYear, 2025);
  assert.equal(eval2025.summary.yearFilteredOutCount, 880);
  assert.equal(eval2025.summary.totalEvents, 440);
  assert.ok(eval2025.evaluated.every((e) => e.year === 2025));

  // Range sensitivity on 2026 mapping cycle
  const eval2026At5m = evaluateCrossingEvents(
    demo,
    cams,
    { rangeMeters: 5, fovDeg: 65 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2026 }
  );
  const eval2026At100m = evaluateCrossingEvents(
    demo,
    cams,
    { rangeMeters: 100, fovDeg: 65 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2026 }
  );
  assert.equal(eval2026At5m.summary.totalEvents, 440);
  assert.ok(eval2026At5m.summary.detectedCount < eval2026At100m.summary.detectedCount);

  // Sector filter inside Simulator isolates spatial sector events cleanly
  const sumOfSectors2025 = ([1, 2, 3, 4, 5] as const).reduce((acc, sId) => {
    const secRes = evaluateCrossingEvents(
      demo,
      cams,
      { rangeMeters: 50, fovDeg: 65 },
      { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2025 },
      sId
    );
    return acc + secRes.summary.totalEvents;
  }, 0);
  assert.equal(sumOfSectors2025, 440);

  // Adding 200 extra crossings in uncovered cities (Helsinki, Tampere, Turku, Oulu, Rovaniemi)
  // must NOT change evaluated heatmap events or detection rate at all
  const uncoveredEvents: CrossingEvent[] = Array.from({ length: 200 }, (_, idx) => {
    const coords = [
      [60.1699, 24.9384],
      [61.4978, 23.761],
      [60.4518, 22.2666],
      [65.0121, 25.4651],
      [66.5039, 25.7294],
    ][idx % 5];
    return {
      eventId: `OUT-${idx + 1}`,
      date: '2025-11-01',
      lat: coords[0],
      lng: coords[1],
      animalSize: idx % 2 === 0 ? 'large' : 'small',
    };
  });

  const eval2025WithExtraUncovered = evaluateCrossingEvents(
    [...demo, ...uncoveredEvents],
    cams,
    { rangeMeters: 50, fovDeg: 65 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2025 }
  );
  assert.equal(eval2025WithExtraUncovered.summary.excludedOutsideCitiesCount, 380);
  assert.equal(eval2025WithExtraUncovered.summary.totalEvents, eval2025.summary.totalEvents);
  assert.equal(eval2025WithExtraUncovered.summary.detectedCount, eval2025.summary.detectedCount);
  assert.equal(
    eval2025WithExtraUncovered.summary.detectionRatePct,
    eval2025.summary.detectionRatePct
  );

  const outBytes = buildEvaluatedResultsWorkbook(
    eval2025.evaluated.slice(0, 5),
    '5-Sector Maximal Coverage (100 cam/sector · 73 d)',
    50,
    65
  );
  assert.ok(outBytes.byteLength > 500);
});

test('custom circular location & radius scope clips crossing heatmaps and evaluates 100-camera detection rates accurately', async () => {
  const { buildGeographicCircleRing } = await import('./cameraPlanGeometry');
  const { generateCustomAreaDemoCrossings } = await import('./crossingSimulator');
  const typeCenter = { lat: 60.2486, lng: 24.0653 };
  const circleRing = buildGeographicCircleRing(typeCenter, 12_000, 72);
  assert.equal(circleRing.length, 73);

  const mockCustomCameras = Array.from({ length: 100 }, (_, idx) => {
    const pt = destinationPoint(typeCenter, 500 + idx * 95, (idx * 37) % 360);
    return {
      id: `CUS-${String(idx + 1).padStart(3, '0')}`,
      cityId: 'custom-area',
      cityName: 'Lohja',
      sectorIndex: (((idx % 5) + 1) as 1 | 2 | 3 | 4 | 5),
      sectorName: 'Lohja (12 km Radius)',
      sectorPeriod: 'Jan 1 – Dec 31',
      unitNumber: idx + 1,
      rankInSector: idx + 1,
      rankInCity: idx + 1,
      clusterIndex: idx + 1,
      clusterSize: 1,
      roadLabel: 'Vt 1',
      clusterLabel: `Hotspot #${idx + 1} · Vt 1`,
      lat: pt.lat,
      lng: pt.lng,
      bearingDeg: (idx * 53) % 360,
      historicalAccidents: 18 - Math.min(16, Math.floor(idx / 6)),
      whiteTailedDeer: 12,
      roeDeer: 4,
      moose: 2,
    };
  });

  const mockPlan = {
    id: 'custom-area',
    label: 'Lohja',
    center: typeCenter,
    radiusKm: 12,
    areaKm2: 452.4,
    roadNetworkKm: 280.5,
    targetCameraCount: 100,
    dataSourceUrl: 'https://mobilityanalytics.ramboll.com/onn/hirvielain/',
    dataPeriod: '2021–2025',
    totalAccidentsInRadius: 890,
    corridorAccidentsNearCameras: 510,
    speciesTotals: {
      whiteTailedDeer: 620,
      roeDeer: 190,
      moose: 75,
      fallowDeer: 5,
      forestReindeer: 0,
    },
    byYear: { '2021': 170, '2022': 180, '2023': 185, '2024': 180, '2025': 175 },
    primaryRoads: 'Vt 1 · Kt 25',
    hotspots: [[24.0653, 60.2486, 18]] as Array<[number, number, number]>,
    cameras: mockCustomCameras,
  };

  const demoCrossings = generateCustomAreaDemoCrossings(mockPlan);
  assert.ok(demoCrossings.length > 600);

  const customEval = evaluateCrossingEvents(
    demoCrossings,
    mockCustomCameras,
    { rangeMeters: 50, fovDeg: 65 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2026 },
    'all',
    { center: typeCenter, radiusKm: 12, label: 'Lohja' }
  );

  assert.equal(customEval.summary.excludedOutsideCitiesCount, 75);
  assert.ok(customEval.summary.totalEvents > 150);
  assert.ok(customEval.summary.detectedCount > 20);
  assert.ok(customEval.evaluated.every((ev) => ev.camerasPresentInEventSector === true));
  assert.ok(customEval.evaluated.every((ev) => ev.cityName === 'Lohja'));
});

test('5-city zones are compact (< 5.5 km radius) inside municipal borders and place cameras more densely on high-priority stretches', async () => {
  const { TOP_5_WILDLIFE_ACCIDENT_CITIES } = await import('../data/finlandWildlifePlan');
  const { groundDistanceAndBearing, isPointInCityBoundary, isPointInPolygonRing } = await import(
    './crossingSimulator'
  );

  for (const city of TOP_5_WILDLIFE_ACCIDENT_CITIES) {
    assert.equal(city.sectors.length, 5);
    for (const sec of city.sectors) {
      assert.ok(sec.voronoiRing.length >= 12);
      assert.ok(sec.zoom >= 11.4, `Expected compact sector zoom >= 11.4 for ${sec.code}`);

      // Every zone ring vertex must stay compact (< 5.5 km from zone center, down from 30–60 km) and inside municipal border
      let maxVertexRadiusKm = 0;
      for (const [lng, lat] of sec.voronoiRing) {
        const dKm =
          groundDistanceAndBearing(sec.center.lat, sec.center.lng, lat, lng).distanceM / 1000;
        if (dKm > maxVertexRadiusKm) maxVertexRadiusKm = dKm;
        assert.equal(
          isPointInCityBoundary(lat, lng, city),
          true,
          `Vertex (${lat},${lng}) of ${sec.code} fell outside ${city.name} municipal boundary`
        );
      }
      assert.ok(
        maxVertexRadiusKm <= 5.5,
        `Expected compact zone radius <= 5.5 km for ${sec.code}, got ${maxVertexRadiusKm.toFixed(2)} km`
      );

      // Cameras in this zone lie strictly inside the compact zone and pack tighter on top-priority hotspots
      const secCams = city.cameras.filter((c) => c.sectorIndex === sec.sectorIndex);
      assert.equal(secCams.length, 100);
      for (const cam of secCams) {
        assert.equal(
          isPointInPolygonRing(cam.lng, cam.lat, sec.voronoiRing),
          true,
          `Camera ${cam.id} fell outside compact zone ${sec.code}`
        );
      }

      const nearestNeighborM = (cam: (typeof secCams)[number]): number => {
        let best = Infinity;
        for (const other of secCams) {
          if (other.id === cam.id) continue;
          const d = groundDistanceAndBearing(cam.lat, cam.lng, other.lat, other.lng).distanceM;
          if (d < best) best = d;
        }
        return best;
      };

      const top20 = secCams.slice(0, 20);
      const bottom20 = secCams.slice(80, 100);
      const top20MeanAcc = top20.reduce((a, c) => a + c.historicalAccidents, 0) / top20.length;
      const bottom20MeanAcc =
        bottom20.reduce((a, c) => a + c.historicalAccidents, 0) / bottom20.length;
      const top20MeanSpacingM = top20.reduce((a, c) => a + nearestNeighborM(c), 0) / top20.length;
      const bottom20MeanSpacingM =
        bottom20.reduce((a, c) => a + nearestNeighborM(c), 0) / bottom20.length;

      assert.ok(
        top20MeanAcc > bottom20MeanAcc * 1.8,
        `Expected top-20 hotspot cameras in ${sec.code} to have much higher collision counts (${top20MeanAcc} vs ${bottom20MeanAcc})`
      );
      assert.ok(
        top20MeanSpacingM < bottom20MeanSpacingM,
        `Expected denser spacing on top-20 priority cameras in ${sec.code} (${top20MeanSpacingM.toFixed(1)}m vs ${bottom20MeanSpacingM.toFixed(1)}m)`
      );
    }
  }
});



