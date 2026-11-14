# Wildlife Beacon: Linux (Python) side of the App Lab app.
#
# What it does, in plain words:
#   1. Every half second, take a camera picture and ask our Edge Impulse model
#      what it shows -> classify()  (warn_animal / small_animal / no_animal)
#   2. Turn the beacon on if a warn animal (deer, moose...) was seen with
#      more than 70% confidence in at least 2 of the last 3 checks.
#   3. Keep the beacon on for 30 s after the last sighting.
#   4. Write every sighting as one JSON line in data/events.jsonl (format B1 in PLAN.md).
#
# The model file is set in app.yaml (brick variable EI_CLASSIFICATION_MODEL),
# currently ~/.arduino-bricks/ei-models/wildlife-3class-v1.eim on the board.
# No pictures are ever saved: frames only live in memory.
#
# Demo fallback: pressing the Modulino Knob still counts as "deer in view",
# turning it as "fox in view", in case the camera or model misbehaves on stage.
#
# The microcontroller side (sketch) flashes the LED matrix and beeps the buzzer.

import json
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import cv2

from fastapi.responses import StreamingResponse

from arduino.app_utils import App, Bridge, Logger
from arduino.app_bricks.image_classification import ImageClassification
from arduino.app_bricks.web_ui import WebUI
from arduino.app_peripherals.camera import Camera

logger = Logger("wildlife-beacon")

# ---- Settings: tune these -------------------------------------------------------
# All tuning happens here. After a change, restart the app; the sketch doesn't
# need to be recompiled.
DEVICE_ID = "sign-001"

# When does the light start flashing?
MIN_CONFIDENCE = 0.70     # the model must be at least this sure (0.70 = 70%)...
NEEDED = 2                # ...in at least this many pictures...
WINDOW = 3                # ...out of the last this many pictures
CHECK_EVERY_S = 0.5       # how often a picture is checked (0.5 = twice a second)

# How does the light behave?
HOLD_S = 30.0             # light stays on this long after the last sighting
FLASH_MS = 250            # flash speed: on 250 ms, off 250 ms (minimum 50)
BUZZER = True             # beep 3 times when the light turns on (False = silent)

# Camera
CAMERA_RESOLUTION = (640, 480)
LOG_EVERY_S = 2.0         # also log the current scores this often (proves it's alive)

# Event log and knob fallback
EVENT_GAP_S = 30.0        # an event ends after this long with nothing seen
STANDIN_SIGHTING_S = 1.5  # a knob press/turn "shows" an animal this long

EVENT_LOG = Path(__file__).resolve().parent.parent / "data" / "events.jsonl"

try:
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo("Europe/Helsinki")
except Exception:  # tz database missing in the container: fall back to UTC
    LOCAL_TZ = timezone.utc


def now_iso() -> str:
    return datetime.now(LOCAL_TZ).isoformat(timespec="seconds")


# ---- Knob fallback ------------------------------------------------------------
# The sketch tells us when the knob is pressed or turned.
last_press = 0.0
last_turn = 0.0


def on_knob_pressed():
    global last_press
    last_press = time.time()
    logger.info("knob pressed -> stand-in sees a warn animal")


def on_knob_turned(position: int):
    global last_turn
    if time.time() - last_turn > STANDIN_SIGHTING_S:   # log once per turn, not per click
        logger.info("knob turned -> stand-in sees a small animal")
    last_turn = time.time()


Bridge.provide("on_knob_pressed", on_knob_pressed)
Bridge.provide("on_knob_turned", on_knob_turned)


# ---- Camera + Edge Impulse model ------------------------------------------------
CAMERA_RETRY_S = 5.0      # no camera yet? try again this often (knob still works meanwhile)

model = ImageClassification(confidence=0.0)   # return all scores; we apply MIN_CONFIDENCE ourselves
camera = None

# ---- Live web page (http://<board-ip>:7000) -------------------------------------
# Shows the frame the model just classified, its scores and the beacon state.
# Frames stay in memory only; nothing is written to disk.
ui = WebUI()
live = {"jpg": None, "scores": {}, "label": "no_animal", "conf": 0.0, "source": "camera"}


def stream_route() -> StreamingResponse:
    def frames():
        last = None
        while True:
            jpg = live["jpg"]
            if jpg is not None and jpg is not last:
                last = jpg
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
            time.sleep(0.1)
    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame")


def status_route() -> dict:
    return {"label": live["label"], "conf": round(live["conf"], 3),
            "scores": {k: round(v, 3) for k, v in live["scores"].items()},
            "source": live["source"], "camera": camera is not None,
            "beacon": beacon_on, "recent": list(recent),
            "min_confidence": MIN_CONFIDENCE, "needed": NEEDED, "window": WINDOW}


ui.expose_api("GET", "/stream", stream_route)
ui.expose_api("GET", "/status", status_route)
camera_tried = 0.0
last_logged = {"label": None, "t": 0.0}


def get_camera():
    """Open the USB camera, or return None if it isn't plugged in (retried every few seconds)."""
    global camera, camera_tried
    if camera is not None or time.time() - camera_tried < CAMERA_RETRY_S:
        return camera
    camera_tried = time.time()
    try:
        camera = Camera(resolution=CAMERA_RESOLUTION, fps=15)
        if hasattr(camera, "start"):
            camera.start()
        logger.info("camera opened")
    except Exception as e:
        camera = None
        logger.warning(f"no camera yet ({e}); knob fallback only, retrying in {CAMERA_RETRY_S:.0f} s")
    return camera


def classify_camera() -> tuple[str, float] | None:
    """Take one picture and return (class, confidence 0..1) from our model, or None."""
    global camera
    cam = get_camera()
    if cam is None:
        return None
    try:
        frame = cam.capture()
    except Exception as e:
        logger.warning(f"camera lost ({e}); will reopen")
        camera = None
        return None
    if frame is None:
        return None
    ok, jpg = cv2.imencode(".jpg", frame)
    if not ok:
        return None
    live["jpg"] = jpg.tobytes()   # for the live view on the web page (memory only)
    out = model.classify(live["jpg"], image_type="jpg", confidence=0.0)
    results = (out or {}).get("classification") or []
    if not results:
        return None
    # The brick reports confidence as a percentage string, e.g. "97.35".
    scores = {r.get("class_name"): float(r.get("confidence") or 0) / 100.0 for r in results}
    label = max(scores, key=scores.get)
    last_logged["scores"] = scores
    live["scores"] = scores
    return label, scores[label]


def classify() -> tuple[str, float]:
    """Return (class, confidence) for the current view.

    Classes: "warn_animal", "small_animal", "no_animal".
    The knob overrides the camera for a moment (demo fallback).
    """
    t = time.time()
    if t - last_press < STANDIN_SIGHTING_S:
        live.update(label="warn_animal", conf=0.90, source="knob")
        return "warn_animal", 0.90
    if t - last_turn < STANDIN_SIGHTING_S:
        live.update(label="small_animal", conf=0.85, source="knob")
        return "small_animal", 0.85

    try:
        result = classify_camera()
    except Exception as e:
        logger.warning(f"camera/model error: {e}")
        result = None
    if result is None:
        return "no_animal", 0.0

    label, conf = result
    live.update(label=label, conf=conf, source="camera")
    if label != last_logged["label"] or t - last_logged["t"] > LOG_EVERY_S:
        scores = last_logged.get("scores", {})
        detail = " ".join(f"{k}={v:.2f}" for k, v in sorted(scores.items()))
        logger.info(f"camera sees {label} {conf:.2f}  ({detail})")
        last_logged.update(label=label, t=t)
    return label, conf


# ---- Beacon decision -------------------------------------------------------------
recent = deque(maxlen=WINDOW)   # True/False: was each recent frame a sure warn animal?
last_warn = 0.0                 # time of the last confirmed warn-animal sighting
beacon_on = False


def set_beacon(on: bool):
    global beacon_on
    if on == beacon_on:
        return
    beacon_on = on
    try:
        Bridge.call("set_beacon", on)
    except Exception as e:
        logger.warning(f"could not reach the sketch: {e}")
    logger.info("BEACON ON" if on else "beacon off")


# ---- Event record (B1) --------------------------------------------------------------
event = None   # the sighting in progress, or None


def track_event(label: str, conf: float, warned: bool):
    """Group frames into one event per sighting and write it when the sighting ends."""
    global event
    t = time.time()
    seen = label != "no_animal" and conf >= MIN_CONFIDENCE

    if seen:
        if event is None:
            event = {"start": t, "ts": now_iso(), "last": t, "frames": 0,
                     "best": {}, "warning": False}
        event["last"] = t
        event["frames"] += 1
        event["best"][label] = max(conf, event["best"].get(label, 0.0))
    if event is not None and warned:
        event["warning"] = True

    if event is not None and t - event["last"] > EVENT_GAP_S:
        write_event(event)
        event = None


def write_event(ev: dict):
    # warn_animal wins if it was seen at all, otherwise the most confident class.
    best = ev["best"]
    label = "warn_animal" if "warn_animal" in best else max(best, key=best.get)
    record = {
        "device_id": DEVICE_ID,
        "ts": ev["ts"],
        "class": label,
        "confidence": round(best[label], 2),
        "frames": ev["frames"],
        "duration_s": round(ev["last"] - ev["start"], 1),
        "warning": ev["warning"],
    }
    try:
        EVENT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with EVENT_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except Exception as e:
        logger.warning(f"could not write the event log: {e}")
    logger.info("EVENT " + json.dumps(record))


# ---- Main loop ------------------------------------------------------------------------
def loop():
    global last_warn
    label, conf = classify()
    recent.append(label == "warn_animal" and conf >= MIN_CONFIDENCE)

    confirmed = sum(recent) >= NEEDED
    if confirmed:
        last_warn = time.time()

    set_beacon(time.time() - last_warn < HOLD_S)
    track_event(label, conf, confirmed)
    time.sleep(CHECK_EVERY_S)


sent_flash_ms = False


def setup_sketch():
    """Send FLASH_MS and BUZZER to the sketch once it answers (it may start after Python)."""
    global sent_flash_ms
    if sent_flash_ms:
        return
    try:
        Bridge.call("set_flash_ms", FLASH_MS)
        Bridge.call("set_buzzer", BUZZER)
        sent_flash_ms = True
        logger.info(f"flash speed {FLASH_MS} ms, buzzer {'on' if BUZZER else 'off'}")
    except Exception as e:
        logger.warning(f"sketch not ready yet: {e}")


def main_loop():
    setup_sketch()
    loop()


logger.info(f"wildlife-beacon started, events go to {EVENT_LOG}")
App.run(user_loop=main_loop)
