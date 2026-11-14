# 🚨 wildlife-beacon

Beacon logic for the roadside unit (PLAN.md, step A5).

- Beacon on when a "Warn" box (deer, moose...) is above 0.5 confidence in 2 of the last 3 frames.
- Stays on 30 s after the last sighting. The RGB LEDs (LED3, LED4) flash orange with the
  LED matrix, buzzer beeps 3 times. Tune the orange with `GREEN_EVERY` in `sketch/sketch.ino`.
- Each sighting is written as one JSON line (format B1) to `data/events.jsonl`.

**Model:** USB camera picture every 0.5 s → Aarne's Edge Impulse object detection model
(project 1164426, classes `Small` / `Warn`, 320 px, about 340 ms per frame), set in `app.yaml`
as `arduino:object_detection` with `model: ei-model-1164426-3`. `Warn` maps to `warn_animal`,
`Small` to `small_animal`, no box to `no_animal`, so the event format didn't change. The boxes
are drawn on the live view and on the photo sent to the dashboard.
No pictures are saved. If no camera is plugged in, the app keeps running and retries every 5 s.

**New model version:** deploy it from Edge Impulse / App Lab to the board (it lands in
`~/.arduino-bricks/models/custom-ei/ei-model-<project>-<version>/`), change `model:` in
`app.yaml`, and redeploy. The previous classifier (ours, project 1164473) is still on the board
at `~/.arduino-bricks/ei-models/wildlife-3class-v1.eim`; the comparison is in
`dataset/model_test/RESULTS.md`.

**Demo fallback:** press the Modulino Knob = warn animal in view, turn it = small animal in view.

**Photo upload (demo):** on the board's page (port 7000), click or drop a photo. The model
boxes the animals, the photo is "in view" for 3 s (so the beacon fires on a deer), and a fresh
event starts with a thumbnail of the photo with the boxes drawn on it.

**Dashboard link:** every event is sent to `DASHBOARD_URL` (the `Suomikartta` server,
`POST /api/events`) when it starts, when the beacon turns on, and when it ends. Records are
format B1 plus `event_id`, `status` (`active`/`done`), `source` (`camera`/`upload`/`knob`),
`lat`, `lng` and, for uploads, `thumb`. The unit's position is `DEVICE_LAT`/`DEVICE_LNG`.
If the board can't reach the laptop, start the dashboard with `BOARD_URL=http://<board-ip>:7000`
and it pulls `GET /events` from the board instead.

**Deploy from the laptop:** `./deploy.sh <board-ip> http://<laptop-ip>:3000/api/events`
