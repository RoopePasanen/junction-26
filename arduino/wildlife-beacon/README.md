# 🚨 wildlife-beacon

Beacon logic for the roadside unit (PLAN.md, step A5).

- Beacon on when `warn_animal` is above 0.7 confidence in 2 of the last 3 frames.
- Stays on 30 s after the last sighting. LED matrix flashes, buzzer beeps 3 times.
- Each sighting is written as one JSON line (format B1) to `data/events.jsonl`.

**Model:** USB camera picture every 0.5 s → our Edge Impulse classifier
(`~/.arduino-bricks/ei-models/wildlife-3class-v1.eim` on the board, set in `app.yaml`).
No pictures are saved. If no camera is plugged in, the app keeps running and retries every 5 s.

**New model version:** copy the new `.eim` to the board, then
`arduino-app-cli app brick config . arduino:image_classification EI_CLASSIFICATION_MODEL=<path>`
in `~/ArduinoApps/wildlife-beacon`, and restart the app.

**Demo fallback:** press the Modulino Knob = warn animal in view, turn it = small animal in view.
