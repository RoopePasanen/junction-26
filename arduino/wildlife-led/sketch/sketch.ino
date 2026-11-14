// Wildlife LED: microcontroller (Arduino sketch) side of the App Lab app.
//
// The Python side calls set_led(true/false) over the Bridge.
// While "on", the built-in LED and the whole LED matrix flash like a warning beacon.
//
// The UNO Q's built-in LED is "active low": LOW = lit (same as Arduino's blink example).

#include <Arduino_RouterBridge.h>
#include <Arduino_LED_Matrix.h>

const int LED_LIT = LOW;
const int LED_DARK = HIGH;
const unsigned long FLASH_MS = 250;   // beacon flash speed

const int ROWS = 8;
const int COLS = 13;
uint8_t allOn[ROWS * COLS];
uint8_t allOff[ROWS * COLS] = {0};

Arduino_LED_Matrix matrix;

volatile bool warning = false;
bool beaconLit = false;
unsigned long lastToggle = 0;

void set_led(bool on) {
  warning = on;
}

void showBeacon(bool lit) {
  beaconLit = lit;
  digitalWrite(LED_BUILTIN, lit ? LED_LIT : LED_DARK);
  matrix.draw(lit ? allOn : allOff);
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LED_DARK);

  memset(allOn, 7, sizeof(allOn));   // 7 = full brightness with 3 grayscale bits
  matrix.begin();
  matrix.setGrayscaleBits(3);
  matrix.clear();

  Bridge.begin();
  Bridge.provide("set_led", set_led);
}

void loop() {
  if (warning) {
    // Flash while a warn animal is in view.
    if (millis() - lastToggle >= FLASH_MS) {
      lastToggle = millis();
      showBeacon(!beaconLit);
    }
  } else if (beaconLit) {
    showBeacon(false);
  }
  delay(10);
}
