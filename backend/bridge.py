from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import os
import random
import time
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np
import serial
import websockets
from scipy.io import loadmat
from websockets.server import WebSocketServerProtocol


Telemetry = dict[str, Any]

PREDICTION_SIZE = 10
CONTEXT_SIZE = 200
WARN_THRESHOLD = 2.5
MSE_THRESHOLD = 4.7

# The Next.js AI logistics webhook. Bridge calls it on a stable->critical trip.
AGENT_API_URL = os.environ.get("AGENT_API_URL", "http://127.0.0.1:3000/api/agent")


def log(message: str) -> None:
    """Timestamped stdout logger (flushed so it scrolls live)."""
    line = f"{time.strftime('%H:%M:%S')} {message}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        # Windows cp1252 console can't render some chars (e.g. Llama output) — degrade gracefully.
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)


def classify_status(mse: float) -> str:
    if mse > MSE_THRESHOLD:
        return "critical"
    if mse > WARN_THRESHOLD:
        return "warning"
    return "stable"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bit-Forge serial to WebSocket bridge")
    parser.add_argument("--port", help="CP2102 serial port, for example COM3 or /dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=921600)
    parser.add_argument("--data", type=Path, help="CWRU normal .mat/.csv file or directory")
    parser.add_argument("--csv", type=Path, help="Deprecated alias for --data")
    parser.add_argument("--ws-host", default="0.0.0.0")
    parser.add_argument("--ws-port", type=int, default=8000)
    parser.add_argument("--sample-rate", type=float, default=250.0, help="Samples per second sent to ESP32")
    parser.add_argument("--fault-seconds", type=float, default=4.0)
    parser.add_argument("--simulate-esp", action="store_true", help="Run without serial hardware")
    args = parser.parse_args()
    args.data = args.data or args.csv
    return args


def load_mat_de_signal(path: Path) -> np.ndarray:
    mat = loadmat(path)
    candidates = []
    for key, value in mat.items():
        compact = key.lower().replace("_", "")
        if key.startswith("__") or "detime" not in compact:
            continue
        array = np.asarray(value, dtype=np.float32).reshape(-1)
        if len(array) >= CONTEXT_SIZE + PREDICTION_SIZE:
            candidates.append(array)

    if not candidates:
        raise ValueError(f"No Drive End '*DE_time' vector found in {path}")
    return max(candidates, key=len)


def load_csv_signal(path: Path) -> np.ndarray:
    values: list[float] = []

    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        sample = handle.read(4096)
        handle.seek(0)
        dialect = csv.Sniffer().sniff(sample) if sample.strip() else csv.excel
        reader = csv.reader(handle, dialect)
        for row in reader:
            numeric = []
            for cell in row:
                try:
                    numeric.append(float(cell.strip()))
                except ValueError:
                    pass
            if numeric:
                values.append(numeric[-1])

    return np.asarray(values, dtype=np.float32)


def discover_data_files(path: Path | None) -> list[Path]:
    if path is None:
        return []
    if path.is_file():
        return [path]
    if path.is_dir():
        normal_ids = {"97", "98", "99", "100"}
        return sorted(
            candidate
            for candidate in path.rglob("*")
            if candidate.suffix.lower() in {".mat", ".csv", ".txt"}
            and ("normal" in str(candidate).lower() or "baseline" in str(candidate).lower() or candidate.stem in normal_ids)
        )
    raise FileNotFoundError(f"Data path does not exist: {path}")


def load_wave_data(path: Path | None) -> np.ndarray:
    waves = []

    for file_path in discover_data_files(path):
        if file_path.suffix.lower() == ".mat":
            waves.append(load_mat_de_signal(file_path))
        elif file_path.suffix.lower() in {".csv", ".txt"}:
            waves.append(load_csv_signal(file_path))

    if waves:
        wave = np.concatenate([np.asarray(w, dtype=np.float32).reshape(-1) for w in waves])
    else:
        wave = np.asarray(
            [
            math.sin(i * 0.15) * 0.42
            + math.sin(i * 0.041) * 0.2
            + math.sin(i * 0.7) * 0.015
            for i in range(6000)
            ],
            dtype=np.float32,
        )

    wave = wave - float(wave.mean())
    peak = float(np.max(np.abs(wave)))
    if peak > 0:
        wave = wave / peak
    return wave


def inject_fault_sample(sample: float, index: int) -> float:
    burst = math.sin(index * 2.35) * 1.25 + math.cos(index * 0.77) * 0.9
    spike = 2.8 if index % 23 == 0 else -2.2 if index % 31 == 0 else 0.0
    return sample + burst + spike + random.uniform(-0.75, 0.75)


def normalize_telemetry(payload: Telemetry) -> Telemetry | None:
    status = payload.get("status")
    actual_wave = payload.get("actual_wave")
    predicted_wave = payload.get("predicted_wave")
    mse = payload.get("mse")

    if status not in {"stable", "warning", "critical"}:
        return None
    if not isinstance(predicted_wave, list):
        return None

    telemetry = {
        "status": status,
        "mse": float(mse),
        "predicted_wave": [float(v) for v in predicted_wave[:PREDICTION_SIZE]],
    }

    if isinstance(actual_wave, list):
        telemetry["actual_wave"] = [float(v) for v in actual_wave[:PREDICTION_SIZE]]

    return telemetry


class Bridge:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.wave = load_wave_data(args.data)
        self.clients: set[WebSocketServerProtocol] = set()
        self.serial_conn: serial.Serial | None = None
        self.sample_index = 0
        self.fault_until = 0.0
        self.warn_until = 0.0
        self.last_prediction = [0.0] * PREDICTION_SIZE
        self.context: list[float] = []
        self.sent_count = 0
        self.current_actual_window: list[float] = []
        self.pending_actual_windows: deque[list[float]] = deque(maxlen=256)
        # Agent orchestration: fire the logistics webhook once per critical episode.
        self.last_status = "stable"
        self.agent_inflight = False

    @property
    def fault_active(self) -> bool:
        return time.monotonic() < self.fault_until

    @property
    def warn_active(self) -> bool:
        return time.monotonic() < self.warn_until and not self.fault_active

    async def connect_serial(self) -> None:
        if self.args.simulate_esp:
            return
        if not self.args.port:
            raise SystemExit("Pass --port COMx for hardware, or --simulate-esp for local testing.")

        self.serial_conn = serial.Serial(
            self.args.port,
            self.args.baud,
            timeout=0.02,
            write_timeout=0.1,
        )
        await asyncio.sleep(2.0)
        self.serial_conn.reset_input_buffer()
        self.serial_conn.reset_output_buffer()

    async def broadcast(self, payload: Telemetry) -> None:
        message = json.dumps(payload, separators=(",", ":"))
        stale: set[WebSocketServerProtocol] = set()

        for client in self.clients:
            try:
                await client.send(message)
            except websockets.ConnectionClosed:
                stale.add(client)

        self.clients.difference_update(stale)

    async def handle_client(self, websocket: WebSocketServerProtocol) -> None:
        self.clients.add(websocket)
        peer = getattr(websocket, "remote_address", None)
        log(f"[CONNECT] New client connected from {peer} (total clients: {len(self.clients)})")
        try:
            async for message in websocket:
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    continue

                command = payload.get("command")
                if command in {"inject_fault", "inject_warning", "stream_normal"}:
                    if command == "inject_fault":
                        self.fault_until = time.monotonic() + self.args.fault_seconds
                        self.warn_until = 0.0
                    elif command == "inject_warning":
                        self.warn_until = time.monotonic() + self.args.fault_seconds
                        self.fault_until = 0.0
                    else:
                        self.fault_until = 0.0
                        self.warn_until = 0.0
                    log(f"[COMMAND] {command} from {peer}")
                    # Relay to any WiFi ESP32 clients so hardware reacts too.
                    await self.broadcast({"command": command})
                elif "status" in payload and "mse" in payload:
                    # WiFi firmware path: ESP32 pushes telemetry JSON straight in.
                    telemetry = normalize_telemetry(payload)
                    if telemetry:
                        await self.publish(self.merge_actual_wave(telemetry), source=f"WiFi-ESP {peer}")
        except websockets.ConnectionClosed:
            # Client (browser/ESP) dropped without a close handshake — benign.
            pass
        finally:
            self.clients.discard(websocket)
            log(f"[DISCONNECT] Client {peer} left (total clients: {len(self.clients)})")

    async def publish(self, telemetry: Telemetry, source: str = "sim") -> None:
        """Broadcast telemetry and fire the logistics agent once per critical trip."""
        await self.broadcast(telemetry)

        status = telemetry.get("status", "stable")
        mse = float(telemetry.get("mse", 0.0))
        log(f"[TELEMETRY] Status: {status:<8} | MSE: {mse:8.4f} | src: {source} | clients: {len(self.clients)}")

        if status == "critical" and self.last_status != "critical":
            self.trigger_agent(mse)
        self.last_status = status

    def trigger_agent(self, mse: float) -> None:
        if self.agent_inflight:
            log("[AGENT] critical trip detected but a request is already in flight — skipping")
            return
        self.agent_inflight = True
        log(f"[AGENT] Critical trip (MSE {mse:.4f}) -> calling logistics webhook {AGENT_API_URL}")
        asyncio.create_task(self._run_agent(mse))

    async def _run_agent(self, mse: float) -> None:
        # Tell the dashboard the agent is thinking, then deliver the AI decision.
        await self.broadcast({"type": "agent_status", "state": "thinking", "mse": mse})
        try:
            report = await asyncio.to_thread(self.call_agent_api, mse)
        except Exception as exc:  # noqa: BLE001 - never let the agent crash the stream
            report = {"error": str(exc)}

        if report.get("error"):
            log(f"[AGENT] ERROR: {report['error']}")
        else:
            vendor = report.get("vendor", "?")
            src = report.get("source", "?")
            log(f"[AGENT] Report ready (source: {src}, vendor: {vendor}) -> broadcasting to {len(self.clients)} client(s)")
            snippet = str(report.get("report", "")).replace("\n", " ")
            log(f"[AGENT] {snippet[:160]}{'...' if len(snippet) > 160 else ''}")

        await self.broadcast({"type": "agent_report", "mse": mse, **report})
        self.agent_inflight = False

    def call_agent_api(self, mse: float) -> dict[str, Any]:
        body = json.dumps({"mse": mse, "status": "critical"}).encode("utf-8")
        request = urllib.request.Request(
            AGENT_API_URL,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            return {"report": f"Agent webhook unreachable ({exc}).", "source": "bridge-error"}

    async def serial_tx_loop(self) -> None:
        interval = 1.0 / max(1.0, self.args.sample_rate)
        assert self.serial_conn is not None

        while True:
            sample = float(self.wave[self.sample_index % len(self.wave)])
            if self.fault_active:
                sample = inject_fault_sample(sample, self.sample_index)

            line = f"{sample:.7f}\n".encode("ascii")
            await asyncio.to_thread(self.serial_conn.write, line)
            self.record_sent_sample(sample)
            self.sample_index += 1
            await asyncio.sleep(interval)

    def record_sent_sample(self, sample: float) -> None:
        self.sent_count += 1
        if self.sent_count <= CONTEXT_SIZE:
            return

        self.current_actual_window.append(sample)
        if len(self.current_actual_window) == PREDICTION_SIZE:
            self.pending_actual_windows.append(self.current_actual_window)
            self.current_actual_window = []

    def merge_actual_wave(self, telemetry: Telemetry) -> Telemetry:
        if "actual_wave" in telemetry:
            return telemetry

        if self.pending_actual_windows:
            actual_wave = self.pending_actual_windows.popleft()
        elif self.current_actual_window:
            actual_wave = self.current_actual_window[-PREDICTION_SIZE:]
        else:
            actual_wave = [0.0] * PREDICTION_SIZE

        return {**telemetry, "actual_wave": actual_wave}

    async def serial_rx_loop(self) -> None:
        assert self.serial_conn is not None

        while True:
            line = await asyncio.to_thread(self.serial_conn.readline)
            if not line:
                await asyncio.sleep(0.001)
                continue

            try:
                payload = json.loads(line.decode("utf-8", errors="replace").strip())
            except json.JSONDecodeError:
                continue

            telemetry = normalize_telemetry(payload)
            if telemetry:
                await self.publish(self.merge_actual_wave(telemetry), source="serial-ESP")

    def simulated_inference(self, context: list[float]) -> list[float]:
        last = context[-1]
        slope = context[-1] - context[-2]
        prediction = []
        for i in range(PREDICTION_SIZE):
            seasonal = context[-10 + i] - context[-20 + i]
            prediction.append(last + slope * (i + 1) + seasonal * 0.18)
        return prediction

    def sim_perturb(self, sample: float, index: int) -> float:
        """Visually-bounded synthetic perturbation for the simulator broadcast.

        Kept gentle so the dashboard chart stays in range. The status/MSE is set
        explicitly per mode below, so amplitude here is purely cosmetic.
        """
        if self.fault_active:
            spike = 0.6 if index % 23 == 0 else -0.5 if index % 31 == 0 else 0.0
            return sample + math.sin(index * 1.7) * 0.5 + math.cos(index * 0.73) * 0.28 + spike + random.uniform(-0.1, 0.1)
        if self.warn_active:
            return sample + math.sin(index * 0.9) * 0.14 + random.uniform(-0.04, 0.04)
        return sample

    async def simulate_esp_loop(self) -> None:
        # Throttle to a realistic hardware poll rate (~25 Hz) so we never flood
        # the WebSocket regardless of --sample-rate.
        interval = max(1.0 / max(1.0, self.args.sample_rate), 0.04)

        # Pre-fill the context so broadcasting starts immediately (no ~8s warmup).
        self.context = [float(self.wave[i % len(self.wave)]) for i in range(CONTEXT_SIZE)]
        self.sample_index = CONTEXT_SIZE

        while True:
            sample = self.sim_perturb(float(self.wave[self.sample_index % len(self.wave)]), self.sample_index)

            self.context.append(sample)
            self.context = self.context[-CONTEXT_SIZE:]
            self.sample_index += 1

            actual = [
                self.sim_perturb(float(self.wave[(self.sample_index + offset) % len(self.wave)]), self.sample_index + offset)
                for offset in range(PREDICTION_SIZE)
            ]
            predicted = self.simulated_inference(self.context)

            if self.fault_active:
                limit = 2.0
                mse = 18.0 + (math.sin(self.sample_index * 0.11) + 1.0) * 3.5 + random.uniform(-0.4, 0.4)
            elif self.warn_active:
                limit = 0.8
                mse = 2.8 + (math.sin(self.sample_index * 0.07) + 1.0) * 0.7 + random.uniform(-0.15, 0.15)
            else:
                limit = 0.7
                mse = 0.15 + (math.sin(self.sample_index * 0.05) + 1.0) * 0.45 + random.uniform(-0.05, 0.05)

            # Bound both waves to a visual range so the chart never flat-tops/distorts.
            clamp = lambda values: [max(-limit, min(limit, v)) for v in values]

            await self.publish(
                {
                    "status": classify_status(mse),
                    "mse": mse,
                    "actual_wave": clamp(actual),
                    "predicted_wave": clamp(predicted),
                }
            )

            await asyncio.sleep(interval)

    async def run(self) -> None:
        #await self.connect_serial()
        server = await websockets.serve(self.handle_client, self.args.ws_host, self.args.ws_port)
        print(f"WebSocket bridge listening on ws://{self.args.ws_host}:{self.args.ws_port}")

        tasks = [asyncio.create_task(server.wait_closed())]
        if self.args.simulate_esp:
            print("Running in simulated ESP32 mode.")
            tasks.append(asyncio.create_task(self.simulate_esp_loop()))
        else:
            print(f"Streaming serial telemetry on {self.args.port} @ {self.args.baud}.")
            # tasks.append(asyncio.create_task(self.serial_tx_loop()))
            # tasks.append(asyncio.create_task(self.serial_rx_loop()))

        await asyncio.gather(*tasks)


async def main() -> None:
    bridge = Bridge(parse_args())
    await bridge.run()


if __name__ == "__main__":
    asyncio.run(main())
