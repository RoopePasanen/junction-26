// Wildlife Beacon: microcontroller (Arduino sketch) side of the App Lab app.
//
// - The Python side calls set_beacon(true/false) over the Bridge.
//   Python turns it on when a Warn animal (deer, moose, boar...) is confirmed.
//   While on, the two RGB LEDs (LED3, LED4) flash orange together with an
//   antler shape on the LED matrix, and the buzzer beeps 3 times when the
//   beacon turns on.
// - Flash speed and buzzer on/off come from Python (set_flash_ms, set_buzzer),
//   so all settings live in python/main.py and you don't have to recompile
//   this sketch to tune them.
// - The Modulino Knob is the stand-in "camera" for testing:
//   press it  -> Python treats it as "warn animal in view"
//   turn it   -> Python treats it as "small animal in view"
//   If the knob or buzzer isn't plugged in, the rest still works.

#include <Arduino_RouterBridge.h>
#include <Arduino_LED_Matrix.h>
#include <Arduino_Modulino.h>

const int LED_LIT = LOW;    // the UNO Q's RGB LEDs are "active low"
const int LED_DARK = HIGH;

// Orange = red fully on + a little green. The LEDs are on/off only, so green
// is dimmed by lighting it on 1 of every GREEN_EVERY loop passes (about 1 ms
// each). 2 = yellowish, 3 = orange, 5 = red-orange. Pure red: set it to 0.
const int GREEN_EVERY = 3;
const int RED_PINS[] = {LED3_R, LED4_R};
const int GREEN_PINS[] = {LED3_G, LED4_G};
const int BLUE_PINS[] = {LED3_B, LED4_B};
int greenTick = 0;
const unsigned long KNOB_POLL_MS = 50;
const int KNOB_STEP = 2;    // ignore tiny knob wiggles

const int BEEPS = 3;
const unsigned long BEEP_MS = 150;
const unsigned long BEEP_GAP_MS = 300;
const int BEEP_HZ = 2000;

const int ROWS = 8;
const int COLS = 13;

// The shape on the LED matrix: 8 rows x 13 columns, X = lit.
// Edit the X's to change the picture.
const char* ANTLERS[ROWS] = {   // a deer head with branching antlers
  "X...........X",
  "X.X.......X.X",
  "X.X.X...X.X.X",
  ".XX.X...X.XX.",
  "..XX.....XX..",
  "...XX...XX...",
  "....XXXXX....",
  ".....XXX.....",
};

uint8_t shapeOn[ROWS * COLS];
uint8_t allOff[ROWS * COLS] = {0};

Arduino_LED_Matrix matrix;
ModulinoKnob knob;
ModulinoBuzzer buzzer;
bool knobOk = false;
bool buzzerOk = false;

// Set from the Bridge (another thread): only store values here, no I2C.
volatile bool warning = false;
volatile unsigned long flashMs = 250;
volatile bool buzzerOn = true;

bool beaconLit = false;
bool wasWarning = false;
unsigned long lastToggle = 0;

int beepsLeft = 0;
unsigned long nextBeepAt = 0;

unsigned long lastKnobPoll = 0;
int16_t lastKnobPos = 0;
bool lastPressed = false;

void set_beacon(bool on) {
  warning = on;
}

void set_flash_ms(int ms) {
  if (ms >= 50) {
    flashMs = ms;
  }
}

void set_buzzer(bool on) {
  buzzerOn = on;
}

void showBeacon(bool lit) {
  beaconLit = lit;
  for (int pin : RED_PINS) {
    digitalWrite(pin, lit ? LED_LIT : LED_DARK);
  }
  matrix.draw(lit ? shapeOn : allOff);
}

// Runs every loop pass: mixes the dimmed green into the red while lit.
void updateOrange() {
  greenTick = (greenTick + 1) % (GREEN_EVERY > 0 ? GREEN_EVERY : 1);
  bool green = beaconLit && GREEN_EVERY > 0 && greenTick == 0;
  for (int pin : GREEN_PINS) {
    digitalWrite(pin, green ? LED_LIT : LED_DARK);
  }
}

void updateBeacon() {
  bool on = warning;

  if (on && !wasWarning) {        // just turned on: start the beeps
    beepsLeft = BEEPS;
    nextBeepAt = millis();
  }
  wasWarning = on;

  if (on) {
    if (millis() - lastToggle >= flashMs) {
      lastToggle = millis();
      showBeacon(!beaconLit);
    }
  } else {
    beepsLeft = 0;
    if (beaconLit) {
      showBeacon(false);
    }
  }

  if (buzzerOk && buzzerOn && beepsLeft > 0 && (long)(millis() - nextBeepAt) >= 0) {
    buzzer.tone(BEEP_HZ, BEEP_MS);
    beepsLeft--;
    nextBeepAt = millis() + BEEP_MS + BEEP_GAP_MS;
  }
}

void updateKnob() {
  if (!knobOk || millis() - lastKnobPoll < KNOB_POLL_MS) {
    return;
  }
  lastKnobPoll = millis();

  int16_t pos = knob.get();          // also reads the button state
  bool pressed = knob.isPressed();

  if (pressed && !lastPressed) {
    Bridge.notify("on_knob_pressed");
  }
  lastPressed = pressed;

  if (abs(pos - lastKnobPos) >= KNOB_STEP) {
    lastKnobPos = pos;
    Bridge.notify("on_knob_turned", (int)pos);
  }
}

void setup() {
  for (int pin : RED_PINS) { pinMode(pin, OUTPUT); digitalWrite(pin, LED_DARK); }
  for (int pin : GREEN_PINS) { pinMode(pin, OUTPUT); digitalWrite(pin, LED_DARK); }
  for (int pin : BLUE_PINS) { pinMode(pin, OUTPUT); digitalWrite(pin, LED_DARK); }

  // Turn the ANTLERS picture into matrix pixels (7 = full brightness).
  for (int r = 0; r < ROWS; r++) {
    for (int c = 0; c < COLS; c++) {
      shapeOn[r * COLS + c] = (ANTLERS[r][c] == 'X') ? 7 : 0;
    }
  }
  matrix.begin();
  matrix.setGrayscaleBits(3);
  matrix.clear();

  Bridge.begin();
  Bridge.provide("set_beacon", set_beacon);
  Bridge.provide("set_flash_ms", set_flash_ms);
  Bridge.provide("set_buzzer", set_buzzer);

  Modulino.begin(Wire1);
  knobOk = knob.begin();
  buzzerOk = buzzer.begin();
  if (knobOk) {
    lastKnobPos = knob.get();
  }
}

void loop() {
  updateBeacon();
  updateOrange();
  updateKnob();
  delay(1);   // short, so the green mix doesn't flicker
}
