# Capture app: collect training photos for our Edge Impulse model through the
# board's own camera (so training images look like the demo).
#
# Open http://<board-ip>:7000, pick a class button, show pictures of that class
# to the camera (e.g. on a laptop screen), press Stop. Photos are saved to
# ~/ArduinoApps/capture/captures/<class>/ on the board.

import os
import time

import cv2

from arduino.app_utils import App, Logger
from arduino.app_bricks.web_ui import WebUI
from arduino.app_peripherals.camera import Camera

logger = Logger("capture")

CLASSES = ["warn_animal", "small_animal", "person", "vehicle", "empty"]
SAVE_EVERY_S = 0.35            # about 3 photos per second
OUT_DIR = "/app/captures"

camera = Camera(resolution=(640, 480), fps=15)
ui = WebUI()

state = {"label": "off", "last_save": 0.0}


def counts():
    result = {}
    for c in CLASSES:
        d = os.path.join(OUT_DIR, c)
        result[c] = len(os.listdir(d)) if os.path.isdir(d) else 0
    return result


def set_label(name: str):
    state["label"] = name if name in CLASSES else "off"
    logger.info(f"label -> {state['label']}")
    return {"label": state["label"], "counts": counts()}


def get_status():
    return {"label": state["label"], "counts": counts()}


ui.expose_api("GET", "/label/{name}", set_label)
ui.expose_api("GET", "/status", get_status)
ui.expose_camera("/stream", camera)


def loop():
    frame = camera.capture()
    label = state["label"]
    if frame is None or label == "off":
        time.sleep(0.05)
        return
    now = time.time()
    if now - state["last_save"] < SAVE_EVERY_S:
        return
    state["last_save"] = now
    d = os.path.join(OUT_DIR, label)
    os.makedirs(d, exist_ok=True)
    cv2.imwrite(os.path.join(d, f"{label}_{int(now * 1000)}.jpg"), frame)


App.run(user_loop=loop)
