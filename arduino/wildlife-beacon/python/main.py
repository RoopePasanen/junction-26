# Wildlife Beacon: Linux (Python) side of the App Lab app.
#
# What it does, in plain words:
#   1. Every half second, take a camera picture and ask the Edge Impulse object
#      detection model (Aarne's) to box the animals in it. A "Warn" box (deer, moose...)
#      counts as warn_animal, a "Small" box (fox, hare...) as small_animal, no box as
#      no_animal -> classify()
#   2. Turn the beacon on if a warn animal was boxed with at least 50% confidence
#      in at least 2 of the last 3 checks.
#   3. Keep the beacon on for 30 s after the last sighting.
#   4. Write every sighting as one JSON line in data/events.jsonl (format B1 in PLAN.md)
#      and send it to the dashboard (DASHBOARD_URL): once when it starts, once when
#      the beacon turns on, and once when it ends.
#
# Demo: a photo uploaded on the web page (http://<board-ip>:7000) is classified by the
# same model and "shown" to the beacon for a few seconds, as if the camera saw it.
# The boxes are drawn on the live view and on the thumbnail sent to the dashboard.
#
# The model is set in app.yaml (arduino:object_detection, model ei-model-1164426-3,
# i.e. ~/.arduino-bricks/models/custom-ei/ei-model-1164426-3/model.eim on the board).
# Camera pictures are never saved: frames only live in memory. Uploaded photos are
# only kept as a small thumbnail in the event, so the dashboard can show them.
#
# Demo fallback: pressing the Modulino Knob still counts as "deer in view",
# turning it as "fox in view", in case the camera or model misbehaves on stage.
#
# The microcontroller side (sketch) flashes the LED matrix and beeps the buzzer.

import base64
import json
import threading
import time
import urllib.request
from collections import OrderedDict, deque
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from fastapi import Body
from fastapi.responses import JSONResponse, StreamingResponse

from arduino.app_utils import App, Bridge, Logger
from arduino.app_bricks.object_detection import ObjectDetection
from arduino.app_bricks.web_ui import WebUI
from arduino.app_peripherals.camera import Camera

logger = Logger("wildlife-beacon")

# ---- Settings: tune these -------------------------------------------------------
# All tuning happens here. After a change, restart the app; the sketch doesn't
# need to be recompiled.
DEVICE_ID = "sign-001"

# Where this unit stands (drawn on the dashboard map). Default: the Kirkkonummi · Masala
# pilot site, one of the worst collision hotspots in Uusimaa (Suomikartta customerSites.ts).
DEVICE_LAT = 60.16662
DEVICE_LNG = 24.54689

# Dashboard receiver (Suomikartta server on the laptop). Use the laptop's IP on the
# same Wi-Fi / hotspot, e.g. "http://172.20.10.5:3000/api/events". "" = don't send
# (the dashboard can still pull from http://<board-ip>:7000/events).
DASHBOARD_URL = ""

# When does the light start flashing?
MIN_CONFIDENCE = 0.50     # a Warn box must be at least this sure (0.50 = 50%)...
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

# Uploaded photos (demo)
UPLOAD_SIGHTING_S = 3.0   # an uploaded photo is "in view" this long (6 checks -> beacon fires)
UPLOAD_EVENT_GAP_S = 5.0  # an upload event ends this long after the photo leaves the view
UPLOAD_MAX_BYTES = 15 * 1024 * 1024
THUMB_WIDTH = 400         # thumbnail sent to the dashboard (big enough to read the boxes)

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

BOX_MIN = 0.30            # boxes below this are ignored (and not drawn)
# Model class -> our class names (the dashboard and the event format use these).
CLASS_MAP = {"warn": "warn_animal", "small": "small_animal"}
BOX_COLORS = {"warn_animal": (40, 40, 230), "small_animal": (60, 170, 240)}   # BGR: red, amber

model = ObjectDetection(confidence=BOX_MIN)
camera = None


def detect(img) -> tuple[dict, list, bytes, np.ndarray]:
    """Box the animals in one picture (BGR array).

    Returns (scores, boxes, jpg, drawn): scores per class 0..1 (best box of each class,
    no_animal = 1 - best box), the boxes as (class, conf, x1, y1, x2, y2) in image
    pixels, and the picture with the boxes drawn on it (as JPG and as an array).
    """
    ok, jpg = cv2.imencode(".jpg", img)
    if not ok:
        raise ValueError("could not encode the picture")
    out = model.detect(jpg.tobytes(), image_type="jpg", confidence=BOX_MIN) or {}
    boxes = []
    for d in out.get("detection") or []:
        cls = CLASS_MAP.get(str(d.get("class_name", "")).lower())
        if cls is None:
            continue
        conf = float(d.get("confidence") or 0) / 100.0   # the brick reports a percentage string
        x1, y1, x2, y2 = (int(round(v)) for v in d.get("bounding_box_xyxy") or (0, 0, 0, 0))
        boxes.append((cls, conf, x1, y1, x2, y2))
    scores = {c: max([b[1] for b in boxes if b[0] == c] or [0.0]) for c in ("warn_animal", "small_animal")}
    scores["no_animal"] = 1.0 - max(scores.values())
    if boxes:
        img = img.copy()
        for cls, conf, x1, y1, x2, y2 in boxes:
            color = BOX_COLORS[cls]
            thick = max(2, img.shape[1] // 200)
            cv2.rectangle(img, (x1, y1), (x2, y2), color, thick)
            text = f"{'Warn' if cls == 'warn_animal' else 'Small'} {conf:.0%}"
            scale = max(0.5, img.shape[1] / 900)
            (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)
            ty = max(y1, th + 6)
            cv2.rectangle(img, (x1, ty - th - 6), (x1 + tw + 6, ty), color, -1)
            cv2.putText(img, text, (x1 + 3, ty - 4), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 2)
        ok, jpg = cv2.imencode(".jpg", img)
    return scores, boxes, jpg.tobytes(), img

# ---- Live web page (http://<board-ip>:7000) -------------------------------------
# Shows the frame the model just classified, its scores and the beacon state.
# Camera frames stay in memory only; nothing is written to disk.
ui = WebUI()
live = {"jpg": None, "scores": {}, "label": "no_animal", "conf": 0.0, "source": "camera"}


def stream_route() -> StreamingResponse:
    # Browsers only draw a frame once the boundary after it arrives, so each frame is
    # followed by the next boundary right away (otherwise a single uploaded photo, with
    # no camera running, would never show). The frame is also re-sent every 2 s.
    def frames():
        last, sent = None, 0.0
        yield b"--frame\r\n"
        while True:
            jpg = live["jpg"]
            if jpg is not None and (jpg is not last or time.time() - sent > 2.0):
                last, sent = jpg, time.time()
                yield b"Content-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n--frame\r\n"
            time.sleep(0.1)
    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame")


def status_route() -> dict:
    return {"label": live["label"], "conf": round(live["conf"], 3),
            "scores": {k: round(v, 3) for k, v in live["scores"].items()},
            "source": live["source"], "camera": camera is not None,
            "beacon": beacon_on, "recent": list(recent),
            "min_confidence": MIN_CONFIDENCE, "needed": NEEDED, "window": WINDOW,
            "dashboard": DASHBOARD_URL or None, "unsent": len(outbox)}


# ---- Photo upload (demo) ---------------------------------------------------------
# The web page POSTs the raw image file to /upload. The web server runs in its own
# thread, so it only hands the photo over; the main loop classifies it (the model
# is only ever used from one thread) and the answer goes back to the page.
upload_lock = threading.Lock()
pending_upload = None     # {"img": ndarray, "done": Event, "result": dict} waiting for the loop
upload_view = {"until": 0.0, "label": "no_animal", "conf": 0.0, "scores": {}, "jpg": None, "thumb": None}
new_upload = False        # tells track_event to start a fresh event for this photo


def upload_route(data: bytes = Body(..., media_type="image/jpeg")):
    global pending_upload
    if not data:
        return JSONResponse({"error": "empty upload"}, status_code=400)
    if len(data) > UPLOAD_MAX_BYTES:
        return JSONResponse({"error": "photo too big (max 15 MB)"}, status_code=413)
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return JSONResponse({"error": "not an image (use JPG or PNG)"}, status_code=400)
    job = {"img": img, "done": threading.Event(), "result": None}
    with upload_lock:
        pending_upload = job
    if not job["done"].wait(15):
        return JSONResponse({"error": "board busy, try again"}, status_code=504)
    return job["result"]


def take_pending_upload():
    global pending_upload
    with upload_lock:
        job, pending_upload = pending_upload, None
    return job


def fit_width(img, width: int):
    h, w = img.shape[:2]
    if w <= width:
        return img
    return cv2.resize(img, (width, int(h * width / w)), interpolation=cv2.INTER_AREA)


def run_upload(job: dict):
    """Classify an uploaded photo and put it 'in view' for UPLOAD_SIGHTING_S."""
    global new_upload, last_warn
    try:
        img = fit_width(job["img"], CAMERA_RESOLUTION[0])
        scores, boxes, jpg, drawn = detect(img)
        label = max(scores, key=scores.get)
        ok, thumb = cv2.imencode(".jpg", fit_width(drawn, THUMB_WIDTH), [cv2.IMWRITE_JPEG_QUALITY, 70])
        upload_view.update(until=time.time() + UPLOAD_SIGHTING_S, label=label, conf=scores[label],
                           scores=scores, jpg=jpg,
                           thumb="data:image/jpeg;base64," + base64.b64encode(thumb.tobytes()).decode() if ok else None)
        # Each photo is a fresh scene: forget earlier frames, so a photo with no animal
        # turns the beacon off right away and a deer photo starts its own event.
        recent.clear()
        last_warn = 0.0
        new_upload = True
        warn = label == "warn_animal" and scores[label] >= MIN_CONFIDENCE
        logger.info(f"uploaded photo -> {label} {scores[label]:.2f}, {len(boxes)} box(es)")
        job["result"] = {"label": label, "conf": round(scores[label], 3),
                         "scores": {k: round(v, 3) for k, v in scores.items()},
                         "boxes": [{"class": b[0], "conf": round(b[1], 3), "xyxy": b[2:]} for b in boxes],
                         "beacon": warn, "min_confidence": MIN_CONFIDENCE}
    except Exception as e:
        logger.warning(f"upload failed: {e}")
        job["result"] = JSONResponse({"error": str(e)}, status_code=500)
    finally:
        job["done"].set()


ui.expose_api("GET", "/stream", stream_route)
ui.expose_api("GET", "/status", status_route)
ui.expose_api("POST", "/upload", upload_route)
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
    """Take one picture and return (class, confidence 0..1) from the model, or None."""
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
    scores, _boxes, jpg, _ = detect(frame)
    live["jpg"] = jpg   # live view with boxes, for the web page (memory only)
    label = max(scores, key=scores.get)
    last_logged["scores"] = scores
    live["scores"] = scores
    return label, scores[label]


def current_source() -> str:
    return live["source"]


def classify() -> tuple[str, float]:
    """Return (class, confidence) for the current view.

    Classes: "warn_animal", "small_animal", "no_animal".
    An uploaded photo, then the knob, override the camera for a moment (demo).
    """
    job = take_pending_upload()
    if job is not None:
        run_upload(job)

    t = time.time()
    if t < upload_view["until"]:
        live.update(label=upload_view["label"], conf=upload_view["conf"], scores=upload_view["scores"],
                    jpg=upload_view["jpg"], source="upload")
        return upload_view["label"], upload_view["conf"]
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
        live["source"] = "camera"
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


# ---- Sending events to the dashboard -------------------------------------------------
# A small background thread POSTs each event record to DASHBOARD_URL. If the laptop
# isn't reachable, records wait in the outbox and are retried, so nothing blocks the
# beacon. The latest version of each event is also kept for GET /events (pull mode).
outbox = deque(maxlen=500)
recent_events = OrderedDict()   # event_id -> latest record, newest last
RECENT_EVENTS_MAX = 50


def publish(record: dict):
    recent_events[record["event_id"]] = record
    recent_events.move_to_end(record["event_id"])
    while len(recent_events) > RECENT_EVENTS_MAX:
        recent_events.popitem(last=False)
    if DASHBOARD_URL:
        outbox.append(record)


def sender():
    failing_since = None
    while True:
        if not outbox:
            time.sleep(0.2)
            continue
        record = outbox[0]
        try:
            req = urllib.request.Request(DASHBOARD_URL, data=json.dumps(record).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=3) as resp:
                resp.read()
            outbox.popleft()
            if failing_since is not None:
                logger.info("dashboard reachable again")
                failing_since = None
        except Exception as e:
            if failing_since is None:
                logger.warning(f"dashboard not reachable at {DASHBOARD_URL} ({e}); will keep retrying")
                failing_since = time.time()
            time.sleep(3)


def events_route() -> list:
    """Latest version of the last events, oldest first (for the dashboard's pull mode)."""
    return list(recent_events.values())


ui.expose_api("GET", "/events", events_route)
threading.Thread(target=sender, name="dashboard-sender", daemon=True).start()


# ---- Event record (B1) --------------------------------------------------------------
event = None   # the sighting in progress, or None


def track_event(label: str, conf: float, warned: bool, beacon_turned_on: bool = False):
    """Group frames into one event per sighting, publish it live, write it when it ends."""
    global event, new_upload
    t = time.time()
    seen = label != "no_animal" and conf >= MIN_CONFIDENCE
    source = current_source()

    if new_upload:   # a new photo was uploaded: close what was going on, start fresh
        new_upload = False
        if event is not None:
            finish_event(event)
            event = None

    # The beacon came back on after going dark: that's a new warning, so a new event
    # (and a new alert on the dashboard), even if animals kept being seen in between.
    if beacon_turned_on and event is not None and event["warning"]:
        finish_event(event)
        event = None

    if seen:
        started = event is None
        if started:
            from_upload = source == "upload"
            event = {"id": f"{DEVICE_ID}-{int(t * 1000)}", "start": t, "ts": now_iso(), "last": t,
                     "frames": 0, "best": {}, "warning": False, "source": source,
                     "gap": UPLOAD_EVENT_GAP_S if from_upload else EVENT_GAP_S,
                     "thumb": upload_view["thumb"] if from_upload else None}
        event["last"] = t
        event["frames"] += 1
        event["best"][label] = max(conf, event["best"].get(label, 0.0))
        if started:
            publish(make_record(event, "active"))   # the dashboard sees it right away
    if event is not None and warned and not event["warning"]:
        event["warning"] = True
        publish(make_record(event, "active"))   # instant alert: the beacon just turned on

    if event is not None and t - event["last"] > event["gap"]:
        finish_event(event)
        event = None


def make_record(ev: dict, status: str) -> dict:
    # warn_animal wins if it was seen at all, otherwise the most confident class.
    best = ev["best"]
    label = "warn_animal" if "warn_animal" in best else max(best, key=best.get)
    record = {
        "event_id": ev["id"],
        "device_id": DEVICE_ID,
        "ts": ev["ts"],
        "class": label,
        "confidence": round(best[label], 2),
        "frames": ev["frames"],
        "duration_s": round(ev["last"] - ev["start"], 1),
        "warning": ev["warning"],
        "status": status,            # "active" while the animal is in view, "done" after
        "source": ev["source"],      # camera / upload / knob
        "lat": DEVICE_LAT,
        "lng": DEVICE_LNG,
    }
    if ev.get("thumb"):
        record["thumb"] = ev["thumb"]
    return record


def finish_event(ev: dict):
    record = make_record(ev, "done")
    publish(record)
    log_line = {k: v for k, v in record.items() if k != "thumb"}   # keep the log small
    try:
        EVENT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with EVENT_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(log_line) + "\n")
    except Exception as e:
        logger.warning(f"could not write the event log: {e}")
    logger.info("EVENT " + json.dumps(log_line))


# ---- Main loop ------------------------------------------------------------------------
def loop():
    global last_warn
    label, conf = classify()
    recent.append(label == "warn_animal" and conf >= MIN_CONFIDENCE)

    confirmed = sum(recent) >= NEEDED
    if confirmed:
        last_warn = time.time()

    was_on = beacon_on
    set_beacon(time.time() - last_warn < HOLD_S)
    track_event(label, conf, confirmed, beacon_turned_on=beacon_on and not was_on)
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


logger.info(f"wildlife-beacon started, events go to {EVENT_LOG}"
            + (f" and {DASHBOARD_URL}" if DASHBOARD_URL else " (no DASHBOARD_URL set)"))
App.run(user_loop=main_loop)
