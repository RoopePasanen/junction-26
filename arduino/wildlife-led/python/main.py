# Wildlife LED: Linux (Python) side of the App Lab app.
#
# Pipeline: camera -> object detection (Video Object Detection brick)
#           -> "is it a warn animal?" -> Bridge.call("set_led", ...) -> sketch flashes LED + matrix.
#
# The brick's default model is a general-purpose one. It has no "deer", "elk" or
# "moose" class, so for now large-mammal labels like "horse" and "cow" stand in for
# them. Watch the logs to see which labels your pictures get, and edit
# WARN_LABELS. Later we swap in our own Edge Impulse model with a real
# "warn_animal" class.
#
# The web UI (camera feed + detections) is on the board's web page, like the
# "Detect Objects on Camera" example.

import time
from datetime import datetime, UTC

from arduino.app_utils import App, Bridge, Logger
from arduino.app_bricks.web_ui import WebUI
from arduino.app_bricks.video_objectdetection import VideoObjectDetection

logger = Logger("wildlife-led")

# Labels that count as "warn animal" for now (edit after watching the logs).
WARN_LABELS = {"horse", "cow", "sheep", "bear", "elephant", "zebra", "giraffe", "dog"}

# The default model (YOLOX nano, COCO classes) is unsure about animals on a screen,
# so let weak guesses through the brick and decide here.
DETECT_CONFIDENCE = 0.25  # brick passes everything above this to us (logged)
MIN_CONFIDENCE = 0.30     # a warn label must reach this to trigger the beacon
HOLD_SECONDS = 3.0        # keep the beacon on this long after the last sighting

last_seen = 0.0        # time of the last warn-animal detection
led_on = False

ui = WebUI()
detection = VideoObjectDetection(confidence=DETECT_CONFIDENCE, debounce_sec=0.0)
ui.on_message("override_th", lambda sid, threshold: detection.override_threshold(threshold))


def on_detections(detections: dict):
    """detections looks like {"horse": [{"confidence": 0.71, ...}, ...], ...}"""
    global last_seen
    seen = []
    for label, values in detections.items():
        for value in values:
            conf = float(value.get("confidence") or 0.0)
            seen.append(f"{label} {conf:.2f}")
            ui.send_message("detection", message={
                "content": label,
                "confidence": conf,
                "timestamp": datetime.now(UTC).isoformat(),
            })
            if label.lower() in WARN_LABELS and conf >= MIN_CONFIDENCE:
                last_seen = time.time()
    if seen:
        logger.info("seen: " + ", ".join(seen))


detection.on_detect_all(on_detections)


def set_led(on: bool):
    global led_on
    if on != led_on:
        led_on = on
        Bridge.call("set_led", on)
        logger.info("BEACON ON: warn animal" if on else "beacon off")


def loop():
    # Runs over and over: beacon on while an animal was seen in the last HOLD_SECONDS.
    set_led(time.time() - last_seen < HOLD_SECONDS)
    time.sleep(0.1)


App.run(user_loop=loop)
