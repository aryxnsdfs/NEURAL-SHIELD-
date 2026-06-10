from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch

from train_predictor import (
    CONTEXT_SIZE,
    PREDICTION_SIZE,
    BitForgePredictor,
    load_normal_signal,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local PC test for trained Bit-Forge predictor")
    parser.add_argument("--checkpoint", type=Path, required=True, help="Path to bit_forge_predictor.pt")
    parser.add_argument("--data", type=Path, required=True, help="Normal CWRU .mat/.csv file or directory")
    parser.add_argument("--out", type=Path, default=Path("artifacts/local_test_report.json"))
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--windows", type=int, default=2500, help="Number of windows to evaluate")
    parser.add_argument("--stride", type=int, default=25)
    parser.add_argument("--fault-start", type=int, default=700)
    parser.add_argument("--fault-windows", type=int, default=180)
    parser.add_argument("--threshold", type=float, default=None, help="Optional fixed MSE threshold")
    return parser.parse_args()


def inject_synthetic_fault(target: np.ndarray, window_index: int) -> np.ndarray:
    faulted = target.astype(np.float32).copy()
    for i in range(len(faulted)):
        phase = window_index * 0.73 + i * 2.15
        burst = math.sin(phase) * 4.5 + math.cos(phase * 0.37) * 2.6
        spike = 7.5 if (window_index + i) % 17 == 0 else -6.0 if (window_index + i) % 23 == 0 else 0.0
        faulted[i] += burst + spike
    return faulted


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values, dtype=np.float32), q))


def summarize(values: list[float]) -> dict[str, float]:
    if not values:
        return {"count": 0, "mean": 0.0, "p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0}

    arr = np.asarray(values, dtype=np.float32)
    return {
        "count": int(len(arr)),
        "mean": float(arr.mean()),
        "p50": float(np.percentile(arr, 50)),
        "p95": float(np.percentile(arr, 95)),
        "p99": float(np.percentile(arr, 99)),
        "max": float(arr.max()),
    }


def load_model(checkpoint_path: Path, device: str) -> BitForgePredictor:
    checkpoint = torch.load(checkpoint_path, map_location=device)
    model = BitForgePredictor().to(device)
    state = checkpoint.get("model", checkpoint)
    model.load_state_dict(state)
    model.eval()
    return model


def evaluate() -> None:
    args = parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)

    wave = load_normal_signal(args.data)
    max_start = len(wave) - CONTEXT_SIZE - PREDICTION_SIZE
    if max_start <= 0:
        raise ValueError("Not enough samples for local testing.")

    model = load_model(args.checkpoint, args.device)
    healthy_mse: list[float] = []
    fault_mse: list[float] = []
    trace = []

    starts = np.arange(0, max_start, args.stride, dtype=np.int64)
    if len(starts) > args.windows:
        starts = np.linspace(0, starts[-1], args.windows, dtype=np.int64)

    with torch.inference_mode():
        for window_index, start in enumerate(starts):
            context = wave[start : start + CONTEXT_SIZE]
            actual = wave[start + CONTEXT_SIZE : start + CONTEXT_SIZE + PREDICTION_SIZE]
            fault_active = args.fault_start <= window_index < args.fault_start + args.fault_windows
            if fault_active:
                actual = inject_synthetic_fault(actual, window_index)

            tensor = torch.from_numpy(context).view(1, 1, CONTEXT_SIZE).to(args.device)
            predicted = model(tensor).detach().cpu().numpy().reshape(-1).astype(np.float32)
            mse = float(np.mean((actual.astype(np.float32) - predicted) ** 2))

            if fault_active:
                fault_mse.append(mse)
            else:
                healthy_mse.append(mse)

            if window_index % max(1, len(starts) // 600) == 0 or fault_active:
                trace.append(
                    {
                        "index": int(window_index),
                        "status": "critical" if fault_active else "stable",
                        "mse": mse,
                        "actual_wave": [float(v) for v in actual],
                        "predicted_wave": [float(v) for v in predicted],
                    }
                )

    recommended_threshold = args.threshold
    if recommended_threshold is None:
        recommended_threshold = max(percentile(healthy_mse, 99.5) * 3.0, percentile(healthy_mse, 99.9) + 1e-6)

    false_positive_count = sum(1 for value in healthy_mse if value > recommended_threshold)
    detection_count = sum(1 for value in fault_mse if value > recommended_threshold)
    report = {
        "checkpoint": str(args.checkpoint),
        "data": str(args.data),
        "device": args.device,
        "window_count": int(len(starts)),
        "context_size": CONTEXT_SIZE,
        "prediction_size": PREDICTION_SIZE,
        "threshold": float(recommended_threshold),
        "healthy_mse": summarize(healthy_mse),
        "fault_mse": summarize(fault_mse),
        "false_positive_rate": false_positive_count / max(1, len(healthy_mse)),
        "fault_detection_rate": detection_count / max(1, len(fault_mse)),
        "trace": trace,
    }

    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "trace"}, indent=2))
    print(f"Saved local test trace: {args.out}")


if __name__ == "__main__":
    evaluate()
