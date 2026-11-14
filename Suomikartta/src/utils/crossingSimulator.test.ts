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

test('all 3 camera arrangements return 500 permanent road-aligned cameras (100/city) strictly inside covered municipality boundaries', () => {
  assert.equal(CAMERA_ARRANGEMENTS.length, 3);
  assert.deepEqual(
    CAMERA_ARRANGEMENTS.map((a) => a.id),
    ['prominent-scatter', 'hotspot-clusters', 'corridor-spread']
  );

  for (const spec of CAMERA_ARRANGEMENTS) {
    const cams = getCamerasForArrangement(spec.id);
    assert.equal(cams.length, 500, `Expected 500 cameras for ${spec.id}`);
    for (const c of cams) {
      assert.equal(isPointWithinFinlandBounds({ lat: c.lat, lng: c.lng }), true);
      assert.ok(c.bearingDeg >= 0 && c.bearingDeg < 360);
      assert.equal(findCameraCoveredCity(c.lat, c.lng)?.id, c.cityId);
    }
  }
});

test('parseEventDateDetails parses ISO and European DD.MM.YYYY dates and leap years accurately', () => {
  const jan1 = parseEventDateDetails('2026-01-01');
  assert.equal(jan1.year, 2026);
  assert.equal(jan1.dayOfYear, 1);
  assert.equal(jan1.daysInYear, 365);

  const leapEnd = parseEventDateDetails('31.12.2024');
  assert.equal(leapEnd.year, 2024);
  assert.equal(leapEnd.dayOfYear, 366);
  assert.equal(leapEnd.daysInYear, 366);
});

test('doesCameraDetectEvent respects bidirectional FOV cones, max range, and small-animal 70% range factor', () => {
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

  // Opposite road direction (230° = 50° + 180°) IS detected because every camera looks into both directions
  const pt25mOpposite = destinationPoint({ lat: cam.lat, lng: cam.lng }, 25, 230);
  assert.equal(
    doesCameraDetectEvent(
      cam,
      { ...pt25mOpposite, animalSize: 'large' },
      50,
      65,
      true
    ).detected,
    true
  );

  // Perpendicular lateral point (140°, 90° off both 50° and 230° cones) is missed
  const pt25mLateral = destinationPoint({ lat: cam.lat, lng: cam.lng }, 25, 140);
  assert.equal(
    doesCameraDetectEvent(
      cam,
      { ...pt25mLateral, animalSize: 'large' },
      50,
      65,
      true
    ).detected,
    false
  );
});

test('year-round 100-camera prominent scatter detects crossings in every season of the year', () => {
  const cams = getCamerasForArrangement('prominent-scatter');
  const saloCam = cams.find((c) => c.id === 'SAL-001')!;
  assert.ok(saloCam);

  const targetPt = destinationPoint(
    { lat: saloCam.lat, lng: saloCam.lng },
    20,
    saloCam.bearingDeg
  );

  const testEvents: CrossingEvent[] = [
    {
      eventId: 'WINTER-FEB',
      date: '2026-02-10',
      lat: targetPt.lat,
      lng: targetPt.lng,
      animalSize: 'large',
    },
    {
      eventId: 'SUMMER-JUL',
      date: '2026-07-15',
      lat: targetPt.lat,
      lng: targetPt.lng,
      animalSize: 'large',
    },
    {
      eventId: 'AUTUMN-NOV',
      date: '2026-11-18',
      lat: targetPt.lat,
      lng: targetPt.lng,
      animalSize: 'large',
    },
  ];

  const result = evaluateCrossingEvents(
    testEvents,
    cams,
    { rangeMeters: 50, fovDeg: 65 },
    { ...DEFAULT_SIMULATOR_CONFIG, arrangementId: 'prominent-scatter', selectedYear: 2026 }
  );

  assert.equal(result.evaluated.length, 3);
  for (const ev of result.evaluated) {
    assert.equal(ev.detected, true, `Expected ${ev.eventId} to be detected year-round`);
    assert.equal(ev.detectedByCameraId, 'SAL-001');
  }
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

test('evaluateCrossingEvents enforces Year Selector (2024, 2025, 2026, All), range sensitivity, and covered-city clipping', () => {
  assert.equal(DEFAULT_SIMULATOR_CONFIG.arrangementId, 'prominent-scatter');
  const demo = getDemoSyntheticEvents();
  assert.equal(demo.length, 1500);

  const cams = getCamerasForArrangement('prominent-scatter');

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

  // Range sensitivity on 2026 dataset
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
    'Prominent Hotspot Scatter (100 cam/city · 365 d)',
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
      unitNumber: idx + 1,
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

  const polygonRing = circleRing.slice(0, -1);
  const mockPlan = {
    id: 'area-1',
    label: 'Lohja',
    center: typeCenter,
    radiusKm: 12,
    polygon: polygonRing,
    areaKm2: 452.4,
    roadNetworkKm: 280.5,
    targetCameraCount: 100,
    dataSourceUrl: 'https://mobilityanalytics.ramboll.com/onn/hirvielain/',
    dataPeriod: '2021–2025',
    offlineDatasetRecords: 67081,
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
    { rangeMeters: 60, fovDeg: 30 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2026 },
    [{ id: 'area-1', center: typeCenter, radiusKm: 12, label: 'Lohja', polygon: polygonRing }]
  );

  assert.equal(customEval.summary.excludedOutsideCitiesCount, 75);
  assert.ok(customEval.summary.totalEvents > 150);
  assert.ok(customEval.summary.detectedCount > 15);
  assert.ok(customEval.evaluated.every((ev) => ev.cityName === 'Lohja'));

  // Empty map (0 Areas of Interest) excludes all crossing events cleanly
  const emptyMapEval = evaluateCrossingEvents(
    demoCrossings,
    [],
    { rangeMeters: 60, fovDeg: 30 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 'all' },
    []
  );
  assert.equal(emptyMapEval.summary.totalEvents, 0);
  assert.equal(emptyMapEval.summary.excludedOutsideCitiesCount, demoCrossings.length);
});

test('normal-incidence animal road-crossing line detects off-road animals crossing through a camera line of sight and misses out-of-range or behind-camera crossings', async () => {
  const {
    buildRoadSegmentIndex,
    computeNormalRoadCrossingSegment,
    doesCameraDetectCrossingLine,
    doesCameraDetectEvent,
    groundDistanceAndBearing,
  } = await import('./crossingSimulator');

  // Straight East-West road along lat = 60.2500 from lng = 24.0400 to lng = 24.0800
  const roadPolylines: Array<Array<[number, number]>> = [
    [
      [24.04, 60.25],
      [24.08, 60.25],
    ],
  ];
  const roadIndex = buildRoadSegmentIndex(roadPolylines);

  // Roadside camera mounted 2.5 m south of the road centerline at lng = 24.0500, aimed East (90°) along the road (30° FOV, 60 m range)
  const camOrigin = destinationPoint({ lat: 60.25, lng: 24.05 }, 2.5, 180);
  const eastCamera = {
    id: 'A01-001',
    cityId: 'area-1',
    cityName: 'Test Corridor',
    unitNumber: 1,
    rankInCity: 1,
    clusterIndex: 1,
    clusterSize: 1,
    roadLabel: 'Vt 1',
    clusterLabel: 'Roadside #1 · Vt 1',
    lat: camOrigin.lat,
    lng: camOrigin.lng,
    bearingDeg: 90,
    historicalAccidents: 10,
    whiteTailedDeer: 8,
    roeDeer: 2,
    moose: 0,
  };

  // 1) Animal positioned 32 m North of the road (in the forest), 38 m East of the camera:
  //    Static point is ~42° off camera boresight (well OUTSIDE the 30° FOV cone!),
  //    but its normal-incidence (due South, 180°) crossing line through the closest road passes straight through the camera's 30° / 60 m sightline!
  const roadPoint38mEast = destinationPoint({ lat: 60.25, lng: 24.05 }, 38, 90);
  const animalInWoods38mEast = destinationPoint(roadPoint38mEast, 32, 0); // 32 m North of road

  // Confirm static point alone would NOT be inside the narrow 30° road cone
  assert.equal(
    doesCameraDetectEvent(
      eastCamera,
      { ...animalInWoods38mEast, animalSize: 'large' },
      60,
      30,
      true
    ).detected,
    false
  );

  // Confirm normal-incidence crossing segment hits road orthogonally (bearing ~180° South, 90° to East-West road)
  const seg1 = computeNormalRoadCrossingSegment(
    animalInWoods38mEast.lat,
    animalInWoods38mEast.lng,
    roadIndex
  );
  assert.equal(seg1.hasRoadCrossingLine, true);
  assert.ok(Math.abs(seg1.distanceToRoadM - 32) < 0.5);
  const crossingVec = groundDistanceAndBearing(
    seg1.startLat,
    seg1.startLng,
    seg1.endLat,
    seg1.endLng
  );
  assert.ok(
    Math.abs(crossingVec.bearingDeg - 180) < 1.0,
    `Expected due-South (180°) normal incidence across East-West road, got ${crossingVec.bearingDeg.toFixed(2)}°`
  );

  // Confirm crossing line IS detected by the camera's 30° / 60 m line of sight!
  const hitCheck = doesCameraDetectCrossingLine(
    eastCamera,
    seg1.startLat,
    seg1.startLng,
    seg1.endLat,
    seg1.endLng,
    'large',
    60,
    30,
    true
  );
  assert.equal(hitCheck.detected, true);
  assert.ok(hitCheck.distanceM >= 36 && hitCheck.distanceM <= 40);

  // 2) Animal 25 m North of the road, 25 m West (opposite direction) of the bidirectional road camera -> DETECTED!
  const roadPoint25mWest = destinationPoint({ lat: 60.25, lng: 24.05 }, 25, 270);
  const animalOppositeDir = destinationPoint(roadPoint25mWest, 25, 0);

  // 3) Animal 30 m North of the road, 78 m East of the camera (beyond 60 m capture distance) -> MISSED
  const roadPoint78mEast = destinationPoint({ lat: 60.25, lng: 24.05 }, 78, 90);
  const animalBeyondRangeEast = destinationPoint(roadPoint78mEast, 30, 0);

  // 4) Animal 30 m North of the road, 78 m West of the camera (beyond 60 m capture distance in reverse direction) -> MISSED
  const roadPoint78mWest = destinationPoint({ lat: 60.25, lng: 24.05 }, 78, 270);
  const animalBeyondRangeWest = destinationPoint(roadPoint78mWest, 30, 0);

  const areaBox = [
    { lat: 60.24, lng: 24.035 },
    { lat: 60.24, lng: 24.085 },
    { lat: 60.26, lng: 24.085 },
    { lat: 60.26, lng: 24.035 },
  ];

  const simRes = evaluateCrossingEvents(
    [
      {
        eventId: 'CROSS-HIT-FWD',
        date: '2026-10-12',
        lat: animalInWoods38mEast.lat,
        lng: animalInWoods38mEast.lng,
        animalSize: 'large',
      },
      {
        eventId: 'CROSS-HIT-REV',
        date: '2026-10-13',
        lat: animalOppositeDir.lat,
        lng: animalOppositeDir.lng,
        animalSize: 'large',
      },
      {
        eventId: 'CROSS-TOO-FAR-EAST',
        date: '2026-10-14',
        lat: animalBeyondRangeEast.lat,
        lng: animalBeyondRangeEast.lng,
        animalSize: 'large',
      },
      {
        eventId: 'CROSS-TOO-FAR-WEST',
        date: '2026-10-15',
        lat: animalBeyondRangeWest.lat,
        lng: animalBeyondRangeWest.lng,
        animalSize: 'large',
      },
    ],
    [eastCamera],
    { rangeMeters: 60, fovDeg: 30 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2026 },
    [
      {
        id: 'area-1',
        center: { lat: 60.25, lng: 24.06 },
        radiusKm: 3,
        label: 'Test Corridor',
        polygon: areaBox,
        roadPolylines,
      },
    ]
  );

  assert.equal(simRes.summary.totalEvents, 4);
  assert.equal(simRes.summary.detectedCount, 2);
  assert.equal(simRes.summary.missedCount, 2);
  assert.equal(simRes.evaluated.find((e) => e.eventId === 'CROSS-HIT-FWD')?.detected, true);
  assert.equal(simRes.evaluated.find((e) => e.eventId === 'CROSS-HIT-FWD')?.detectedByCameraId, 'A01-001');
  assert.equal(simRes.evaluated.find((e) => e.eventId === 'CROSS-HIT-REV')?.detected, true);
  assert.equal(simRes.evaluated.find((e) => e.eventId === 'CROSS-HIT-REV')?.detectedByCameraId, 'A01-001');
  assert.equal(simRes.evaluated.find((e) => e.eventId === 'CROSS-TOO-FAR-EAST')?.detected, false);
  assert.equal(simRes.evaluated.find((e) => e.eventId === 'CROSS-TOO-FAR-WEST')?.detected, false);
});

test('on-pavement coordinates (< 3.5m from road) extend across both lanes, and detectedDistanceM reports exact distance to detecting camera', async () => {
  const {
    buildRoadSegmentIndex,
    computeNormalRoadCrossingSegment,
  } = await import('./crossingSimulator');

  const roadPolylines: Array<Array<[number, number]>> = [
    [
      [24.04, 60.25],
      [24.08, 60.25],
    ],
  ];
  const roadIndex = buildRoadSegmentIndex(roadPolylines);

  // Animal recorded 1.2 m North of road centerline (on pavement) at 45 m East of bidirectional East-West camera
  const roadPt45mEast = destinationPoint({ lat: 60.25, lng: 24.05 }, 45, 90);
  const onPavementPt = destinationPoint(roadPt45mEast, 1.2, 0);
  const seg = computeNormalRoadCrossingSegment(onPavementPt.lat, onPavementPt.lng, roadIndex);
  assert.equal(seg.hasRoadCrossingLine, true);
  assert.ok(seg.startLat > 60.25 && seg.endLat < 60.25, 'Expected symmetric crossing segment spanning North to South across road');

  // Place a closer off-corridor camera 18 m North of the road aimed East-West (90°/270°), so the crossing 18 m South is perpendicular (outside both ±15° cones)
  // and place the detecting roadside camera 45 m West on the road aimed 90°/270°!
  const camDetectingOrigin = destinationPoint({ lat: 60.25, lng: 24.05 }, 2.5, 180);
  const camCloserOffCorridor = destinationPoint(roadPt45mEast, 18, 0);

  const cameras = [
    {
      id: 'A01-DETECT',
      cityId: 'area-1',
      cityName: 'Test Corridor',
      unitNumber: 1,
      rankInCity: 1,
      clusterIndex: 1,
      clusterSize: 1,
      roadLabel: 'Vt 1',
      clusterLabel: 'Hit Cam',
      lat: camDetectingOrigin.lat,
      lng: camDetectingOrigin.lng,
      bearingDeg: 90,
      reverseBearingDeg: 270,
      historicalAccidents: 12,
      whiteTailedDeer: 10,
      roeDeer: 2,
      moose: 0,
    },
    {
      id: 'A01-CLOSER-OFF-AXIS',
      cityId: 'area-1',
      cityName: 'Test Corridor',
      unitNumber: 2,
      rankInCity: 2,
      clusterIndex: 2,
      clusterSize: 1,
      roadLabel: 'Parallel Track',
      clusterLabel: 'Off-Axis Cam',
      lat: camCloserOffCorridor.lat,
      lng: camCloserOffCorridor.lng,
      bearingDeg: 90,
      reverseBearingDeg: 270,
      historicalAccidents: 8,
      whiteTailedDeer: 6,
      roeDeer: 2,
      moose: 0,
    },
  ];

  const areaBox = [
    { lat: 60.24, lng: 24.035 },
    { lat: 60.24, lng: 24.085 },
    { lat: 60.26, lng: 24.085 },
    { lat: 60.26, lng: 24.035 },
  ];

  const evalRes = evaluateCrossingEvents(
    [
      {
        eventId: 'PAVEMENT-SMALL',
        date: '2026-09-15',
        lat: onPavementPt.lat,
        lng: onPavementPt.lng,
        animalSize: 'small',
      },
    ],
    cameras,
    { rangeMeters: 60, fovDeg: 30 },
    { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 2026 },
    [
      {
        id: 'area-1',
        center: { lat: 60.25, lng: 24.06 },
        radiusKm: 3,
        label: 'Test Corridor',
        polygon: areaBox,
        roadPolylines,
      },
    ]
  );

  // Default scaleRangeByAnimalSize is false -> small animal at 45 m inside 60 m cone MUST be detected!
  assert.equal(DEFAULT_SIMULATOR_CONFIG.scaleRangeByAnimalSize, false);
  const hitEv = evalRes.evaluated[0];
  assert.equal(hitEv.detected, true);
  assert.equal(hitEv.detectedByCameraId, 'A01-DETECT');
  assert.ok(hitEv.nearestDistanceM <= 15, 'Closer off-corridor camera is ~10-14m from crossing endpoint');
  assert.ok(
    hitEv.detectedDistanceM !== null && hitEv.detectedDistanceM >= 43 && hitEv.detectedDistanceM <= 47,
    `Expected detectedDistanceM (~45m) to match A01-DETECT rather than off-axis camera (${hitEv.nearestDistanceM}m), got ${hitEv.detectedDistanceM}`
  );
});

test('100% geometric parity between rendered camera coverage cones and crossing-line detections across Lohja deployment', async () => {
  const { buildGeographicCircleRing, computeCameraCoveragePolygons } = await import(
    './cameraPlanGeometry'
  );
  const { buildPolygonAreaCameraPlan } = await import('../server/rambollCustomPlanner');
  const { generateCustomAreaDemoCrossings } = await import('./crossingSimulator');
  const { isPointInLatLngPolygon } = await import('./polygonGeometry');
  const { latLngToWorldPixel } = await import('./mapMath');

  const center = { lat: 60.2486, lng: 24.0653 };
  const polygon = buildGeographicCircleRing(center, 7_500, 20).slice(0, -1);

  const areaPlan = await buildPolygonAreaCameraPlan({
    polygon,
    cameraCount: 80,
    rangeMeters: 60,
    fovDeg: 30,
    label: 'Lohja Parity Check',
    areaId: 'area-lohja',
    cameraPrefix: 'A01',
  });

  // Verify area-scoped sample template generates 30 valid rows inside the active Area of Interest
  const areaTemplateBuf = buildSampleTemplateWorkbook([areaPlan]);
  const parsedAreaTemplate = parseCrossingSpreadsheetBuffer(areaTemplateBuf);
  assert.equal(parsedAreaTemplate.valid, true);
  assert.equal(parsedAreaTemplate.events.length, 30);
  const insideCount = parsedAreaTemplate.events.filter((ev) =>
    isPointInLatLngPolygon(ev.lat, ev.lng, areaPlan.polygon)
  ).length;
  assert.equal(insideCount, 30, 'All 30 sample template events should fall inside the active Area of Interest');

  const demoCrossings = generateCustomAreaDemoCrossings(areaPlan);

  const segmentsIntersect2D = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
    dx: number,
    dy: number
  ): boolean => {
    const orient = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
      (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const o1 = orient(ax, ay, bx, by, cx, cy);
    const o2 = orient(ax, ay, bx, by, dx, dy);
    const o3 = orient(cx, cy, dx, dy, ax, ay);
    const o4 = orient(cx, cy, dx, dy, bx, by);
    return o1 * o2 <= 0 && o3 * o4 <= 0;
  };

  const pointStrictlyInsideScreenPoly = (
    px: number,
    py: number,
    pts: Array<{ x: number; y: number }>
  ): boolean => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x;
      const yi = pts[i].y;
      const xj = pts[j].x;
      const yj = pts[j].y;
      const intersect =
        yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  };

  for (const cfg of [
    { rangeMeters: 60, fovDeg: 30 },
    { rangeMeters: 85, fovDeg: 90 },
    { rangeMeters: 60, fovDeg: 180 },
    { rangeMeters: 60, fovDeg: 360 },
  ]) {
    const res = evaluateCrossingEvents(
      demoCrossings,
      areaPlan.cameras,
      cfg,
      { ...DEFAULT_SIMULATOR_CONFIG, selectedYear: 'all', scaleRangeByAnimalSize: false },
      [
        {
          id: areaPlan.id,
          center: areaPlan.center,
          radiusKm: areaPlan.radiusKm,
          label: areaPlan.label,
          polygon: areaPlan.polygon,
          roadPolylines: areaPlan.roadPolylines,
        },
      ]
    );

    assert.ok(res.summary.detectedCount > 0, `Expected positive detections for ${JSON.stringify(cfg)}`);

    // Project slightly-shrunk (-0.12m) bidirectional visual sector polygons at zoom 15.2 to verify ZERO un-detected crossings cut inside ANY drawn cone
    const testZoom = 15.2;
    const camScreenSectors = areaPlan.cameras.flatMap((cam) => {
      const polys = computeCameraCoveragePolygons(
        cam,
        cfg.rangeMeters - 0.12,
        Math.max(10, cfg.fovDeg - 0.1),
        18
      );
      return polys.map((poly) => poly.map((pt) => latLngToWorldPixel(pt, testZoom)));
    });

    let falseNegativesInsideDrawnCone = 0;
    for (const ev of res.evaluated) {
      if (ev.detected) continue;
      const a = latLngToWorldPixel({ lat: ev.crossingStartLat, lng: ev.crossingStartLng }, testZoom);
      const b = latLngToWorldPixel({ lat: ev.crossingEndLat, lng: ev.crossingEndLng }, testZoom);

      for (const poly of camScreenSectors) {
        let hitsPoly =
          pointStrictlyInsideScreenPoly(a.x, a.y, poly) ||
          pointStrictlyInsideScreenPoly(b.x, b.y, poly);
        if (!hitsPoly) {
          for (let i = 0; i < poly.length; i++) {
            const c = poly[i];
            const d = poly[(i + 1) % poly.length];
            if (segmentsIntersect2D(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y)) {
              hitsPoly = true;
              break;
            }
          }
        }
        if (hitsPoly) {
          falseNegativesInsideDrawnCone++;
          break;
        }
      }
    }

    assert.equal(
      falseNegativesInsideDrawnCone,
      0,
      `Expected 0 missed crossing lines inside drawn ${cfg.rangeMeters}m/${cfg.fovDeg}° camera cones, got ${falseNegativesInsideDrawnCone}`
    );
  }
});

