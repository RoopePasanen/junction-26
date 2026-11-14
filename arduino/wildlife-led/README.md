# Wildlife LED (first pipeline)

Show a picture of an elk or deer to the camera, and the LED on the UNO Q flashes.

```
camera ─► Video Object Detection brick (Python, Linux side)
       ─► "is the label a warn animal?" ─► Bridge.call("set_led", true/false)
       ─► sketch (microcontroller) flashes LED_BUILTIN
```

## Set it up in Arduino App Lab
1. **Get the camera working first.** It must be plugged into the USB-C hub (with the power supply on the hub), not the laptop. On the board, `ls /dev/video*` should show a device.
2. In App Lab: **create a new app** (call it `wildlife-led`). App Lab generates the config files (`app.yaml`, `sketch.yaml`) correctly for your board version.
3. **Add the brick "Video Object Detection"** to the app (App Lab's brick list).
4. Replace the app's `python/main.py` with [python/main.py](python/main.py).
5. Replace the app's `sketch/sketch.ino` with [sketch/sketch.ino](sketch/sketch.ino).
6. Press **Run**. Hold a picture of an elk or deer (on a phone) in front of the camera.

## Tuning
- The default model has **no deer or elk class**. Watch the console: it prints every label it sees, e.g. `seen: horse (0.71)`. Add the labels your animal pictures get to `WARN_LABELS` in `main.py`.
- The built-in LED is active low (LOW = lit). The whole LED matrix flashes too.
- Deploy from the laptop over SSH: copy `python/main.py` and `sketch/sketch.ino` to `~/ArduinoApps/wildlife-led/` on the board, then run `arduino-app-cli app restart ~/ArduinoApps/wildlife-led`. Watch it with `arduino-app-cli app logs ~/ArduinoApps/wildlife-led --follow`.
- Camera view and live labels: http://172.20.10.12:7000 (board IP on the phone hotspot).
- If App Lab reports an import or brick name error, open App Lab's own camera object-detection example and copy its import line and setup. Brick names can differ between App Lab versions.

## Next steps
- Replace the default model with our own Edge Impulse model (classes in `PLAN.md`: warn_animal, small_animal, person, vehicle, empty).
- Add the buzzer and the LED matrix as the beacon.
- Write an event record for every detection (format in `PLAN.md`, section B1).
