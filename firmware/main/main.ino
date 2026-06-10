// ============================================================
//  Bit-Forge ESP32 edge inference node  (WiFi / WebSocket build)
// ------------------------------------------------------------
//  - Vibration data lives in flash (flash_signal.h) — no PC feed needed.
//  - Runs the 1.58-bit ternary predictor and computes MSE on-device.
//  - Streams telemetry JSON over WiFi to the bridge WebSocket server
//    (which relays to the Next.js dashboard and the logistics agent).
//  - Reacts to inject_warning / inject_fault / stream_normal commands
//    relayed by the bridge.
//
//  NOTE: This file targets a physical ESP32 and has NOT been compiled in
//  this environment (no toolchain/hardware here). Flash with Arduino IDE
//  after installing: WiFi (core), arduinoWebSockets (Markus Sattler).
// ============================================================

#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "flash_signal.h"

#if __has_include("ternary_weights.h")
#include "ternary_weights.h"
#define BIT_FORGE_HAS_TERNARY_WEIGHTS 1
#else
#define BIT_FORGE_HAS_TERNARY_WEIGHTS 0
#endif

// ---- Network config (edit these) ----
static const char *WIFI_SSID_1 = "optilink";
static const char *WIFI_PASS_1 = "aryangupta";

static const char *WIFI_SSID_2 = "aryangupta";     
static const char *WIFI_PASS_2 = "iosiphone"; 
// ---- Network config (edit these) ----

static const char *BRIDGE_HOST = "172.20.10.5";
static const uint16_t BRIDGE_PORT = 8000;
static const char *BRIDGE_PATH = "/";

// ---- Model / runtime config ----
static const uint32_t BAUD_RATE = 921600;
// Clean 2-pin setup. External 12V lamp dropped (internal rectifier broke the
// single-channel polarity trick); visuals moved to the ESP32 onboard LED.
//   Motor: MX1508 Channel A, IN1 -> GPIO13, IN2 tied to GND (HIGH = spin, LOW = coast).
//   Lamp:  built-in onboard LED on GPIO2 (HIGH = on, LOW = off).
static const int MOTOR_PIN = 13; // MX1508 IN1: spindle (HIGH = spin, LOW = coast/stop)
static const int LAMP_PIN = 2;   // onboard ESP32 LED (HIGH = on, LOW = off)
static const int CONTEXT_SIZE = 200;
static const int PREDICTION_SIZE = 10;
static const int HIDDEN_1 = 1024;
static const int HIDDEN_2 = 512;
static const int HIDDEN_3 = 256;
static const uint32_t SAMPLE_INTERVAL_MS = 4; // ~250 Hz feed from flash

// ---- Industrial predictor tuning ----
static const float EMA_ALPHA = 0.15f;          // EMA smoothing factor
static const uint32_t CALIB_MS = 5000;         // 5s auto-calibration warm-up
static const int CRIT_PERSIST_WINDOWS = 5;     // consecutive windows to confirm a fault
static const float WARN_SIGMA = 3.0f;          // warning = mean + 3 sigma
static const float CRIT_SIGMA = 6.0f;          // critical = mean + 6 sigma

// Fault mode driven by relayed dashboard commands: 0 normal, 1 warning, 2 critical.
static int faultMode = 0;

WebSocketsClient ws;

float contextWindow[CONTEXT_SIZE];
float actualWave[PREDICTION_SIZE];
float predictedWave[PREDICTION_SIZE];
float hidden1[HIDDEN_1];
float hidden2[HIDDEN_2];
float hidden3[HIDDEN_3];
int contextCount = 0;
int futureCount = 0;
bool predictionArmed = false;
long sampleClock = 0;
uint32_t flashIndex = 0;
uint32_t lastSampleMs = 0;
float lastMse = 0.0f;       // smoothed MSE published to the dashboard
float lastRawMse = 0.0f;    // most recent raw window MSE
const char *lastStatus = "stable";

// ---- Pillar 1: auto-calibrated statistical baseline ----
float baselineMean = 0.0f;
float baselineStd = 0.0f;
float warnThreshold = 2.5f; // overwritten by calibration
float critThreshold = 4.7f; // overwritten by calibration
bool calibrated = false;

// ---- Pillar 2: EMA smoother ----
float emaMse = 0.0f;
bool emaInit = false;

// ---- Pillar 3: persistence gatekeeper ----
int critRunCount = 0;

// ---- Pillar 4: hardware latch (cleared only by physical reset) ----
bool isFaultLocked = false;

void updateStatusHardware() {
  // Motor and lamp now on independent pins, so each state controls them directly.
  // Log the motor power transition (spin<->stop) so the serial proves the ESP
  // is actually driving the pin. (Lamp blink would spam, so only motor here.)
  static int prevMotorLevel = -1;
  int motorLevel = isFaultLocked ? LOW : HIGH;
  if (motorLevel != prevMotorLevel) {
    Serial.printf("[HW] MOTOR_PIN(%d) -> %s | LAMP follows status=%s latched=%d\n",
                  MOTOR_PIN, motorLevel == HIGH ? "HIGH(spin)" : "LOW(coast)", lastStatus, isFaultLocked);
    prevMotorLevel = motorLevel;
  }

  if (isFaultLocked) {
    // CRITICAL (latched): hardware latch severs motor power -> spindle coasts to
    // a stop; onboard LED locks SOLID ON. Cleared only by reset or stream_normal.
    digitalWrite(MOTOR_PIN, LOW);
    digitalWrite(LAMP_PIN, HIGH);
    return;
  }

  // Not latched -> spindle keeps running (safe to finish the production run).
  digitalWrite(MOTOR_PIN, HIGH);

  if (strcmp(lastStatus, "warning") == 0) {
    // WARNING: onboard LED flashes ~5 Hz.
    bool on = ((millis() / 100) % 2) == 0;
    digitalWrite(LAMP_PIN, on ? HIGH : LOW);
  } else {
    // STABLE: onboard LED completely off.
    digitalWrite(LAMP_PIN, LOW);
  }
}

void pushContext(float sample) {
  if (contextCount < CONTEXT_SIZE) {
    contextWindow[contextCount++] = sample;
    return;
  }
  memmove(contextWindow, contextWindow + 1, sizeof(float) * (CONTEXT_SIZE - 1));
  contextWindow[CONTEXT_SIZE - 1] = sample;
}

int8_t unpackTernary2Bit(const uint8_t *packed, uint32_t index) {
  uint8_t code = (packed[index >> 2] >> ((index & 0x03) * 2)) & 0x03;
  if (code == 1) return -1;
  if (code == 2) return 1;
  return 0;
}

float fastGelu(float x) {
  return 0.5f * x * (1.0f + tanhf(0.79788456f * (x + 0.044715f * x * x * x)));
}

void ternaryDense(const float *input, int inputSize, float *output, int outputSize,
                  const uint8_t *packedWeights, float weightScale, const float *bias, bool applyGelu) {
  for (int out = 0; out < outputSize; out++) {
    float acc = bias ? bias[out] : 0.0f;
    uint32_t rowOffset = (uint32_t)out * (uint32_t)inputSize;
    for (int in = 0; in < inputSize; in++) {
      int8_t weight = unpackTernary2Bit(packedWeights, rowOffset + (uint32_t)in);
      if (weight > 0) {
        acc += input[in] * weightScale;
      } else if (weight < 0) {
        acc -= input[in] * weightScale;
      }
    }
    output[out] = applyGelu ? fastGelu(acc) : acc;
  }
}

void fallback_inference(const float *context, float *prediction) {
  float last = context[CONTEXT_SIZE - 1];
  float prev = context[CONTEXT_SIZE - 2];
  float slope = last - prev;
  for (int i = 0; i < PREDICTION_SIZE; i++) {
    float seasonal = context[CONTEXT_SIZE - 10 + i] - context[CONTEXT_SIZE - 20 + i];
    prediction[i] = last + slope * (i + 1) + seasonal * 0.18f;
  }
}

void run_ternary_inference(const float *context, float *prediction) {
#if BIT_FORGE_HAS_TERNARY_WEIGHTS
  ternaryDense(context, CONTEXT_SIZE, hidden1, HIDDEN_1, net_0_weight_packed, net_0_weight_scale, net_0_bias, true);
  ternaryDense(hidden1, HIDDEN_1, hidden2, HIDDEN_2, net_2_weight_packed, net_2_weight_scale, net_2_bias, true);
  ternaryDense(hidden2, HIDDEN_2, hidden3, HIDDEN_3, net_4_weight_packed, net_4_weight_scale, net_4_bias, true);
  ternaryDense(hidden3, HIDDEN_3, prediction, PREDICTION_SIZE, net_6_weight_packed, net_6_weight_scale, net_6_bias, false);
#else
  fallback_inference(context, prediction);
#endif
}

float calculateMse() {
  float sum = 0.0f;
  for (int i = 0; i < PREDICTION_SIZE; i++) {
    float err = actualWave[i] - predictedWave[i];
    sum += err * err;
  }
  return sum / (float)PREDICTION_SIZE;
}

float perturbSample(float sample, long i) {
  if (faultMode == 2) {
    float burst = sin(i * 2.35f) * 1.25f + cos(i * 0.77f) * 0.9f;
    float spike = (i % 23 == 0) ? 2.8f : (i % 31 == 0) ? -2.2f : 0.0f;
    float noise = ((float)random(-75, 75)) / 100.0f;
    return sample + burst + spike + noise;
  }
  if (faultMode == 1) {
    return sample + sin(i * 0.9f) * 0.22f;
  }
  return sample;
}

void publishTelemetry() {
  char buf[420];
  int n = snprintf(buf, sizeof(buf), "{\"status\":\"%s\",\"mse\":%.6f,\"predicted_wave\":[", lastStatus, lastMse);
  for (int i = 0; i < PREDICTION_SIZE && n < (int)sizeof(buf) - 24; i++) {
    n += snprintf(buf + n, sizeof(buf) - n, "%s%.6f", i ? "," : "", predictedWave[i]);
  }
  n += snprintf(buf + n, sizeof(buf) - n, "],\"actual_wave\":[");
  for (int i = 0; i < PREDICTION_SIZE && n < (int)sizeof(buf) - 16; i++) {
    n += snprintf(buf + n, sizeof(buf) - n, "%s%.6f", i ? "," : "", actualWave[i]);
  }
  snprintf(buf + n, sizeof(buf) - n, "]}");

  if (ws.isConnected()) {
    ws.sendTXT(buf);
  }
}

// Advances the model one sample. Returns true when a fresh 10-sample prediction
// window completed (lastRawMse updated). No classification/publishing here.
bool handleSample(float sample) {
  pushContext(sample);
  if (contextCount < CONTEXT_SIZE) return false;

  if (!predictionArmed) {
    run_ternary_inference(contextWindow, predictedWave);
    futureCount = 0;
    predictionArmed = true;
    return false;
  }

  actualWave[futureCount++] = sample;
  if (futureCount < PREDICTION_SIZE) return false;

  lastRawMse = calculateMse();

  run_ternary_inference(contextWindow, predictedWave);
  futureCount = 0;
  predictionArmed = true;
  return true;
}

// Pillars 2-4: smooth the raw MSE, gate on persistence, latch the hardware.
void processWindow(float rawMse) {
  if (faultMode == 2) {
    // DEMO FAULT: instant + deterministic. Skip EMA/persistence so judges see an
    // immediate reaction. Latch this window -> updateStatusHardware cuts the motor.
    emaMse = critThreshold + 5.0f;
    if (!isFaultLocked) {
      isFaultLocked = true;
      Serial.println("[LATCH] DEMO fault injected -> motor cut + lamp solid (instant).");
    }
  } else if (faultMode == 1) {
    // DEMO WARNING: hold the yellow band immediately. Motor keeps running, no latch.
    emaMse = (warnThreshold + critThreshold) * 0.5f;
    emaInit = true;
  } else {
    // REAL DATA PATH (faultMode 0): EMA smoother + persistence gatekeeper + latch.
    if (!emaInit) {
      emaMse = rawMse;
      emaInit = true;
    } else {
      emaMse = EMA_ALPHA * rawMse + (1.0f - EMA_ALPHA) * emaMse;
    }
    if (!isFaultLocked) {
      if (emaMse > critThreshold) {
        critRunCount++;
        if (critRunCount >= CRIT_PERSIST_WINDOWS) {
          isFaultLocked = true;
          Serial.printf("[LATCH] Fault CONFIRMED (smoothed MSE %.4f > crit %.4f for %d windows). Motor cut.\n",
                        emaMse, critThreshold, CRIT_PERSIST_WINDOWS);
        }
      } else {
        critRunCount = 0; // fault vanished -> reset gatekeeper
      }
    }
  }
  lastMse = emaMse;

  // Status reported to the dashboard. Critical is sticky once latched, so the
  // bridge fires the logistics agent exactly once (no flicker / re-triggering).
  const char *prevStatus = lastStatus;
  if (isFaultLocked) {
    lastStatus = "critical";
  } else if (emaMse > warnThreshold) {
    lastStatus = "warning";
  } else {
    lastStatus = "stable";
  }

  if (strcmp(prevStatus, lastStatus) != 0) {
    Serial.printf("[STATE] %s -> %s (ema=%.3f warn=%.3f crit=%.3f mode=%d)\n",
                  prevStatus, lastStatus, emaMse, warnThreshold, critThreshold, faultMode);
  }

  publishTelemetry();
}

// Pillar 1 — blocking 5s warm-up: learn this motor's normal MSE distribution and
// set thresholds at mean+3 sigma (warning) and mean+6 sigma (critical).
void runCalibration() {
  Serial.println("[calib] Warm-up: learning baseline vibration signature (5s)...");

  // Fresh pipeline; faultMode stays 0 (motor running normally).
  contextCount = 0;
  predictionArmed = false;
  futureCount = 0;
  flashIndex = 0;
  sampleClock = 0;

  double sum = 0.0, sumSq = 0.0;
  long count = 0;
  uint32_t start = millis();

  while (millis() - start < CALIB_MS) {
    float raw = pgm_read_float(&FLASH_SIGNAL[flashIndex]);
    flashIndex = (flashIndex + 1) % FLASH_SIGNAL_LEN;
    float sample = perturbSample(raw, sampleClock++);
    if (handleSample(sample)) {
      sum += lastRawMse;
      sumSq += (double)lastRawMse * lastRawMse;
      count++;
    }
    delay(SAMPLE_INTERVAL_MS); // pace + feed the watchdog
  }

  if (count > 1) {
    baselineMean = (float)(sum / count);
    double var = (sumSq - sum * sum / count) / (count - 1);
    if (var < 0.0) var = 0.0;
    baselineStd = (float)sqrt(var);
  } else {
    baselineMean = 1.0f;
    baselineStd = 0.5f;
  }

  warnThreshold = baselineMean + WARN_SIGMA * baselineStd;
  critThreshold = baselineMean + CRIT_SIGMA * baselineStd;

  // Seed the EMA at the learned mean so it starts settled.
  emaMse = baselineMean;
  emaInit = true;
  critRunCount = 0;
  calibrated = true;

  Serial.printf("[calib] Done. mean=%.4f sigma=%.4f -> WARN=%.4f CRIT=%.4f (n=%ld windows)\n",
                baselineMean, baselineStd, warnThreshold, critThreshold, count);
}

void applyCommand(const String &line) {
  if (line.indexOf("inject_fault") >= 0) {
    faultMode = 2;
  } else if (line.indexOf("inject_warning") >= 0) {
    faultMode = 1;
  } else if (line.indexOf("stream_normal") >= 0) {
    // Remote Supervisor Override: clear the latch + reset the gatekeeper so the
    // demo can be re-armed from the dashboard without a physical reset.
    faultMode = 0;
    isFaultLocked = false;
    critRunCount = 0;
    emaMse = baselineMean;
    emaInit = true;
    Serial.println("[OVERRIDE] stream_normal -> latch cleared, motor re-armed, MSE reset to baseline.");
  }
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[ws] connected to bridge");
      break;
    case WStype_DISCONNECTED:
      Serial.println("[ws] disconnected");
      break;
    case WStype_TEXT: {
      String line = String((char *)payload).substring(0, length);
      applyCommand(line);
      break;
    }
    default:
      break;
  }
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setTxPower(WIFI_POWER_8_5dBm); // <-- ADD THIS LINE to stop the brownout
  const char* ssids[] = {WIFI_SSID_1, WIFI_SSID_2};
  const char* passes[] = {WIFI_PASS_1, WIFI_PASS_2};
  
  int currentNetwork = 0;

  while (WiFi.status() != WL_CONNECTED) {
    // Clear the previous connection state to prevent the "cannot set config" crash
    WiFi.disconnect();
    delay(100);

    Serial.print("\n[wifi] connecting to ");
    Serial.print(ssids[currentNetwork]);
    
    WiFi.begin(ssids[currentNetwork], passes[currentNetwork]);
    uint32_t start = millis();
    
    // Wait up to 15 seconds per network attempt
    while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
      delay(500);
      Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.print("\n[wifi] ip ");
      Serial.println(WiFi.localIP());
      return; 
    }

    Serial.print("\n[wifi] failed. Switching to alternative network...");
    // Swap index between 0 and 1
    currentNetwork = (currentNetwork + 1) % 2; 
  }
}
void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
  pinMode(MOTOR_PIN, OUTPUT);
  pinMode(LAMP_PIN, OUTPUT);
  // Default to stable state: spindle spinning, onboard LED off.
  digitalWrite(MOTOR_PIN, HIGH);
  digitalWrite(LAMP_PIN, LOW);

  Serial.begin(BAUD_RATE);
  Serial.setTimeout(4);

  if (!BIT_FORGE_HAS_TERNARY_WEIGHTS) {
    Serial.println("{\"status\":\"stable\",\"mse\":0,\"predicted_wave\":[0,0,0,0,0,0,0,0,0,0],\"warning\":\"ternary_weights.h missing; using fallback predictor\"}");
  }

  // Pillar 1 — learn this motor's baseline before going live (motor running normally).
  runCalibration();

  connectWifi();

  ws.begin(BRIDGE_HOST, BRIDGE_PORT, BRIDGE_PATH);
  ws.onEvent(webSocketEvent);
  ws.setReconnectInterval(2000);
}

void loop() {
  // Automatically reconnect if Wi-Fi drops while the machine is running
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n[wifi] connection lost! Attempting to reconnect...");
    connectWifi();
  }

  ws.loop();
  updateStatusHardware();

  uint32_t now = millis();
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    float raw = pgm_read_float(&FLASH_SIGNAL[flashIndex]);
    flashIndex = (flashIndex + 1) % FLASH_SIGNAL_LEN;
    float sample = perturbSample(raw, sampleClock++);
    if (handleSample(sample)) {
      processWindow(lastRawMse); // EMA -> persistence -> latch -> publish
    }
  }
}