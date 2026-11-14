#include <Arduino_Modulino.h>
#include <Arduino_LED_Matrix.h>
#include <Arduino_RouterBridge.h>

ModulinoThermo thermo;
Arduino_LED_Matrix matrix;

const int ROWS = 8;
const int COLS = 13;
uint8_t frame[ROWS * COLS] = {0};

// 3x5 pixel font for the digits 0-9
const uint8_t DIGITS[10][5] = {
    {0b111, 0b101, 0b101, 0b101, 0b111}, // 0
    {0b010, 0b110, 0b010, 0b010, 0b111}, // 1
    {0b111, 0b001, 0b111, 0b100, 0b111}, // 2
    {0b111, 0b001, 0b111, 0b001, 0b111}, // 3
    {0b101, 0b101, 0b111, 0b001, 0b001}, // 4
    {0b111, 0b100, 0b111, 0b001, 0b111}, // 5
    {0b111, 0b100, 0b111, 0b101, 0b111}, // 6
    {0b111, 0b001, 0b001, 0b001, 0b001}, // 7
    {0b111, 0b101, 0b111, 0b101, 0b111}, // 8
    {0b111, 0b101, 0b111, 0b001, 0b111}, // 9
};

const uint8_t MINUS[5] = {0b000, 0b000, 0b111, 0b000, 0b000};

void plot(int row, int col, uint8_t value) {
  if (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
    frame[row * COLS + col] = value;
  }
}

void drawGlyph(const uint8_t glyph[5], int x, int y) {
  for (int r = 0; r < 5; r++) {
    for (int c = 0; c < 3; c++) {
      if (glyph[r] & (1 << (2 - c))) {
        plot(y + r, x + c, 7);
      }
    }
  }
}

// Small degree marker in the top-right corner
void drawDegree() {
  plot(0, 11, 7);
  plot(0, 12, 7);
  plot(1, 11, 7);
  plot(1, 12, 7);
}

// Renders the temperature as a whole number of degrees on the 8x13 matrix
void renderTemperature(float celsius) {
  memset(frame, 0, sizeof(frame));

  char buf[8];
  snprintf(buf, sizeof(buf), "%d", (int)roundf(celsius));
  int n = strlen(buf);

  int width = n * 3 + (n - 1); // 3px per glyph, 1px gap
  int x = (COLS - width) / 2;
  if (x < 0) {
    x = 0;
  }
  int y = 1; // glyphs span rows 1..5

  for (int i = 0; i < n; i++) {
    if (buf[i] == '-') {
      drawGlyph(MINUS, x, y);
    } else if (buf[i] >= '0' && buf[i] <= '9') {
      drawGlyph(DIGITS[buf[i] - '0'], x, y);
    }
    x += 4;
  }

  drawDegree();
}

void setup() {
  Bridge.begin();

  Modulino.begin(Wire1);
  thermo.begin();

  matrix.begin();
  matrix.setGrayscaleBits(3);
  matrix.clear();

  renderTemperature(thermo.getTemperature());
}

void loop() {
  static unsigned long previousMillis = 0;

  if (millis() - previousMillis >= 1000) {
    previousMillis = millis();

    float celsius = thermo.getTemperature();
    renderTemperature(celsius);
    Bridge.notify("on_temperature", celsius);
  }

  matrix.draw(frame);
  delay(20);
}
