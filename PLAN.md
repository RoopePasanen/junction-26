# Junction 2026: Arduino challenge plan

**Challenge:** "The Green European Renaissance" by Arduino (Hardware Track). Edge AI on the Arduino UNO Q.
**Deadline:** final submission Sunday 15 Nov 2026, 10:00 (Junction Platform). Also publish on the Arduino Project Hub with the tag `Junction Finland 2026`, or we're not eligible for prizes.
**Judging:** on-device AI and use of the UNO Q 30%, environmental and social impact 30%, creativity 20%, working physical prototype 20%.

## The problem
- Statistics Finland: **13,291 wildlife collisions in 2025**: white-tailed deer 6,364, **roe deer 4,948**, moose 1,814, others 165. So **about 86% are deer, not moose.** Liikenneturva: 5 deaths, 133 injured. Car damage up to about €10,000 per collision.
- **Systems that work do exist.** InnoTrafik's radar warning signs took one site from 12 accidents to 0. But they cost about €40,000 per site (scope unclear), and they sit only at **moose fence gaps on main roads**.
- **So the problem isn't "no working system". It's coverage.** Most collisions involve deer on smaller roads, where nothing is installed.

## Key insights (don't lose these)
1. **Roe deer cause 37% of collisions** (4,948 in 2025), even though they're small (about 25 kg). A "small vs large animal" split would miss over a third of all accidents, so **roe deer are a warn animal**.
2. **Agree on the event format first** (B1). Then the device and dashboard people work in parallel without waiting for each other.
3. **People and vehicles must be in the training data** (inside `no_animal`). Without them, every jogger and car triggers the beacon, and drivers learn to ignore it.
4. **Headline: "About 86% of collisions are deer, and the existing systems guard moose fences."** It's the sharpest pitch line, and it comes straight from real data.

## Our solution
A **cheap, battery-powered roadside unit** that mounts on an existing wildlife warning sign and can be moved each season to wherever the data shows the risk is.

1. **Motion sensor** (low power, always on, microcontroller side) wakes the camera.
2. **Camera + AI on the device** (Linux side) classifies each event.
3. **Warn-class animal**: amber beacon on. Anything else: no warning.
4. **Logs every event** on the device. No images are stored, only event records.
5. **Daily upload** of events plus a health report. **Instant alert** only for critical events.
6. **Dashboard:** real collision heat map, per-site "when" heat map, live events, device health, and a "where to place the next units" ranking.

### Classes (decided)
| Class | Examples | Warning? |
|---|---|---|
| `warn_animal` | moose, white-tailed deer, **roe deer**, reindeer, wild boar | ✅ Yes |
| `small_animal` | fox, hare, cat, badger | ❌ No |
| `no_animal` | empty road/forest, wind, snow, **pedestrians, cyclists, cars, trucks** | ❌ No |

**Decided Sat 14 Nov: start with these 3 classes.** `no_animal` must contain **people and vehicles** (aim for about a third each of empty scenes, people and vehicles), not just empty scenes. Otherwise a jogger or a car gets classified as `warn_animal` and the beacon fires constantly. If there's time on Sunday, split `no_animal` into `person` / `vehicle` / `empty` with the same images and retrain.

**Roe deer must be in `warn_animal`.** They're small (about 25 kg), but they cause 37% of collisions. A pure "large vs small by size" split would miss them.

**Privacy:** with no `person` class we can't pick out frames with people, so **the device stores no frames at all**, only the event record.

---

## Workstream A: capture and detect (on the device)

**Goal:** motion → wake → camera → classify → beacon → event record.

| Step | Task | Details |
|---|---|---|
| A1 | Hardware setup | **Our kit:** UNO Q, power supply, USB-C hub, USB camera, Modulino Knob, Modulino Thermo, Modulino Buzzer. **No motion sensor and no LEDs in the kit.** Beacon = the UNO Q's built-in LED matrix + the buzzer. Ask the Hardware Lab for a Modulino Distance/Movement or a PIR sensor. Install Arduino App Lab |
| A2 | Wake logic | **Plan A:** distance/PIR sensor from the lab, read in the sketch, sends "motion" to Python over App Lab's Bridge. **Plan B (start now):** motion detection from the camera itself in Python (compare frames, only run the AI when the picture changes). **Demo fallback:** the knob or a button acts as "radar triggered". Python sends "beacon on/off" back to the sketch |
| A3 | Capture (Python, Linux side) | On wake, grab frames for about 5 s at a few frames per second |
| A4 | Model | **Image classifier** (simpler and more reliable than object detection) trained in Edge Impulse (MobileNetV2) on the 3 classes. About 200+ images per class, balanced. Use dataset images as a base (LILA camera traps, iNaturalist/GBIF, Kaggle, COCO for people/cars; check licences), plus **30–50 frames per class shot through our own camera**, so training matches the demo |
| A5 | Decision | `warn_animal` with confidence above 0.7 in at least 2 of the last 3 frames → beacon on. Keep it on **30 s after the last detection** ("another one may follow"). Graded flashing is a stretch goal |
| A6 | Event record | Write the JSON event below to the local log. No frames are stored |
| A7 | Measure | Wake-to-warning delay, power use idle vs active, and accuracy (a confusion matrix on a held-out set of frames). **Real numbers for the pitch** |

**Training data sources** (check each licence):
- Our own frames of night videos played on a screen. Use **fixed-camera footage** (trail-camera or roadside style), not dashcam: our unit stands still, and a moving dashcam view would trigger camera-based motion detection constantly.
- Public camera-trap image collections on lila.science (North American sets include white-tailed deer, foxes and moose; check the class lists).
- Night videos are often infrared, i.e. black and white. Train on the same kind of images the demo shows.

**Model decision (Sat 14 Nov, agreed with the Arduino mentors):** our own **Edge Impulse MobileNetV2 image classifier** on the 3 classes, deployed as a `.eim` and run through the `image_classification` brick. Optional helper: the board's built-in COCO detector (`video_object_detection`) as a filter (`person` / `car` / `truck` seen → no warning), and as a demo fallback (any big COCO animal such as cow, horse, sheep or bear → beacon on, since a moose reads as "cow").

**Fallback (4 h rule):** if the 3-class model isn't working, drop to 2 classes: `warn_animal` vs `other`.

**Optional stretch (only after motion → classify → beacon works):** export DeepFaune to ONNX, quantize to int8 and benchmark it on the board. Under about 5 s per image: it could be the detector. 5–20 s: use it as a second stage that confirms the exact species for the event record. Over 20 s: use it only on a laptop to label training images. Check that it recognises white-tailed deer.

---

## Workstream B: data and dashboard

**Goal:** turn events into decisions: where to put units, when the risk peaks, whether the units work.

### B1. Event format (agree on this first, so both workstreams can work in parallel)
```json
{"device_id": "sign-001", "ts": "2026-11-14T21:14:05+02:00",
 "class": "warn_animal", "confidence": 0.86, "frames": 12,
 "duration_s": 7.5, "warning": true}
```
Daily heartbeat:
```json
{"device_id": "sign-001", "ts": "2026-11-15T06:00:00+02:00",
 "battery_pct": 81, "temp_c": -4.5, "camera_ok": true,
 "events_today": 14, "uptime_s": 86400}
```

### B2. On the device
- Append events to a local file (JSON lines) or SQLite.
- **Daily upload** of the batch plus the heartbeat over Wi-Fi (mobile data in the real version). **Instant upload** for critical events.
- **Demo mode:** upload every minute, so the dashboard updates live on stage.

### B3. Receiver
- A small Python web server (Flask or FastAPI) on a laptop, storing events in SQLite. It also serves the dashboard.

### B4. Dashboard: one web page
1. **Map of Finland with a real collision heat map** from Statistics Finland's open data, filterable by species and road type. Our units are drawn on top.
2. **"When" heat map** (hour of day by month): from the real data per region, plus a site's own events.
3. **"Where to place the next 10 units":** split Finland into 1 km squares, count collisions over the last 3 years, and rank the worst squares that have no unit. **This is our "data → decision" feature for road authorities.**
4. **Live event feed** from the real demo unit.
5. **Device health:** battery, temperature, camera OK, last seen.

### B5. Data: real vs synthetic
- **Real:** Statistics Finland's experimental wildlife-accident statistics (open data, CC BY 4.0, attribution "Lähde: Tilastokeskus").
  - Per-accident CSV with **coordinates, exact timestamp, municipality, road type, road number and species**.
  - 2022–2025: https://stat.fi/media/uploads/tup/kokeellisettilastot/koeti_riista_2025_tau_002_fi.csv
  - 2017–2021: https://stat.fi/media/uploads/tup/kokeellisettilastot/koeti_riista_2025_tau_001_fi.csv
  - Gotchas: probably **not UTF-8** (try `cp1252`). x/y look like **ETRS-TM35FIN (EPSG:3067)**: convert to lat/lon with `pyproj` and check that a few Espoo rows land in Espoo. **2024–2025 are missing some municipalities.** Mainland Finland only.
- **Real:** the events from our own demo unit this weekend.
- **Simulated (clearly labelled):** a "fleet" of virtual units at the top-ranked hotspots, with events generated from the **real** time and species patterns at those spots. Label it "simulated" on the dashboard and in the pitch.

---

## Also needed (easy to forget)
- [ ] Agree on the event format (B1) **first**.
- [ ] Device ID and location config, plus a correct clock (the Linux side syncs time when online).
- [ ] A privacy line: AI on the device, no images stored at all, only event records sent.
- [ ] Accuracy and false-alarm numbers from A7 for the pitch.
- [ ] Licences: the code must be open source (MIT, a Junction rule); attribute Statistics Finland; check dataset licences.
- [ ] A 3D-printed sign or beacon housing for the demo.
- [ ] **A backup demo video**, recorded Saturday evening.
- [ ] Arduino Project Hub post (tag `Junction Finland 2026`) and the Junction submission.
- [ ] Pitch: problem (real map) → coverage gap → our unit → live demo → "where to place the next 10" → business model (insurers, ELY centres) → next steps (IR night camera, radar wake-up, pilot with an ELY centre).

## Team split (4 people)
| Person | Workstream |
|---|---|
| Roope | A1–A2, A5: hardware, Arduino sketch, wake sensor, beacon, Bridge to Python, housing |
| 2 | A3–A4, A7: camera, model training, accuracy numbers |
| 3 | B2–B3: device log, upload, receiver |
| 4 | B4–B5: data processing, dashboard, pitch |

## Timeline
| When | Milestone |
|---|---|
| +1 h | Event format agreed. Camera image on the UNO Q. Collision CSV loaded and plotted |
| +4 h | First model classifies the demo videos. Beacon reacts to the sensor. Real heat map on a web page |
| +8 h | End to end: motion → classify → beacon → event → dashboard |
| Evening | "Where to place the next 10", "when" heat map, device health. **Backup video** |
| Sunday morning | Project Hub post, Junction submission, rehearse the pitch twice |

**Rule:** no new features until Sunday. Ideas go on a "next steps" slide.

## Status (Sat 14 Nov, 02:30) and first thing in the morning
**Working:** SSH to the board (`ssh -i ~/.ssh/unoq arduino@172.20.10.12`, hostname QB1, phone hotspot). Camera on the hub. App `wildlife-led` (built-in COCO model → beacon on LED + LED matrix) works with stand-in labels (moose read as "sheep"/"cow"). App `capture` (photo collection at :7000) is running.
**Learned:** the built-in model has no moose/deer. The board's Gemma 3 1B is text only, and the vision brick doesn't support the UNO Q, so detection must be our own Edge Impulse model (`.eim` in `~/.arduino-bricks/ei-models`). Camera shots of a phone screen are blurry. Copies of the 101 warn_animal shots are in `dataset/warn_animal`; about 70 are usable, and frames 38–40, 47–52, 67–69 and 95–100 (by sorted filename) are junk.
**Morning plan:**
1. Training images straight from files (AI-generated + real CC-licensed photos), not through the camera. **At least 2 classes** (warn_animal vs other: empty road/forest, people, cars, fox/hare), ideally 50+ each.
2. Edge Impulse: image classification, MobileNetV2, deploy as a Linux AARCH64 `.eim` (or the UNO Q target).
3. Test by feeding image files straight to the model on the board (the `arduino:image_classification` brick takes images, no camera needed), then drive the beacon.
4. For the live demo, still show the camera once (a sharp printed photo works better than a phone screen), because the judges score a working physical prototype.

## Open questions for the Hardware Lab
- A USB camera and a powered USB-C hub?
- An infrared camera or IR illuminator for night (even if only for the pitch)?
- Fastest way to run a custom Edge Impulse model on the UNO Q?
