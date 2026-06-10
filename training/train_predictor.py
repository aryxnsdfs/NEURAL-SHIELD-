from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset


CONTEXT_SIZE = 200
PREDICTION_SIZE = 10
WINDOW_SIZE = CONTEXT_SIZE + PREDICTION_SIZE
HIDDEN_1 = 1024
HIDDEN_2 = 512
HIDDEN_3 = 256
NORMAL_MAT_IDS = {"97", "98", "99", "100"}
FAULT_TOKENS = {
    "ball",
    "b007",
    "b014",
    "b021",
    "defect",
    "fault",
    "inner",
    "ir007",
    "ir014",
    "ir021",
    "outer",
    "or007",
    "or014",
    "or021",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train Bit-Forge normal-only wave predictor")
    parser.add_argument("--data", type=Path, help="Normal baseline CWRU .mat/.csv file or directory")
    parser.add_argument("--csv", type=Path, help="Deprecated alias for --data")
    parser.add_argument("--out-dir", type=Path, default=Path("artifacts"))
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--stride", type=int, default=2)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--max-windows", type=int, default=200000)
    args = parser.parse_args()
    args.data = args.data or args.csv
    if args.data is None:
        parser.error("pass --data C:\\path\\to\\normal_baseline.mat_or_csv")
    return args


def looks_like_normal_baseline(path: Path) -> bool:
    text = " ".join(part.lower() for part in path.parts)
    if any(token in text for token in FAULT_TOKENS):
        return False
    if "normal" in text or "baseline" in text:
        return True
    return path.stem in NORMAL_MAT_IDS


def discover_normal_files(path: Path) -> list[Path]:
    if not path.exists():
        raise FileNotFoundError(
            f"Dataset path does not exist: {path}\n"
            "Replace the example path with your real CWRU normal baseline file/folder, "
            "for example --data C:\\Users\\aryan\\Downloads\\CWRU\\97.mat"
        )

    if path.is_file():
        if any(token in path.name.lower() for token in FAULT_TOKENS):
            raise ValueError(f"Refusing fault-looking file for normal-only training: {path}")
        return [path]

    files = [
        candidate
        for candidate in path.rglob("*")
        if candidate.suffix.lower() in {".mat", ".csv", ".txt"} and looks_like_normal_baseline(candidate)
    ]
    if not files:
        raise ValueError(
            "No normal baseline .mat/.csv files found. Point --data at a normal file, "
            "a folder named Normal/Baseline, or CWRU normal IDs 97.mat-100.mat."
        )
    return sorted(files)


def zscore_normalize(wave: np.ndarray) -> np.ndarray:
    wave = wave.astype(np.float32, copy=False)
    wave = wave - np.float32(wave.mean())
    std = np.float32(wave.std())
    if std <= 0:
        raise ValueError("Drive End signal has zero variance; cannot Z-score normalize.")
    return (wave / std).astype(np.float32)


def numeric_column_from_rows(rows: list[list[str]], path: Path) -> np.ndarray:
    if not rows:
        raise ValueError(f"{path} is empty.")

    header = [cell.strip().lower() for cell in rows[0]]
    has_header = any(any(ch.isalpha() for ch in cell) for cell in header)
    data_rows = rows[1:] if has_header else rows

    preferred_index: int | None = None
    if has_header:
        for index, name in enumerate(header):
            compact = name.replace(" ", "").replace("_", "")
            if "de" in compact or "driveend" in compact:
                preferred_index = index
                break

    columns: dict[int, list[float]] = {}
    for row in data_rows:
        for index, cell in enumerate(row):
            try:
                columns.setdefault(index, []).append(float(cell.strip()))
            except ValueError:
                pass

    if preferred_index is not None and len(columns.get(preferred_index, [])) >= WINDOW_SIZE + 1:
        return np.asarray(columns[preferred_index], dtype=np.float32)

    if has_header:
        raise ValueError(f"No usable Drive End/DE numeric column found in {path}.")

    best_index, best_values = max(columns.items(), key=lambda item: len(item[1]))
    if len(best_values) < WINDOW_SIZE + 1:
        raise ValueError(f"Column {best_index} in {path} does not contain enough samples.")
    return np.asarray(best_values, dtype=np.float32)


def load_csv_de_signal(path: Path) -> np.ndarray:
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        sample = handle.read(4096)
        handle.seek(0)
        dialect = csv.Sniffer().sniff(sample) if sample.strip() else csv.excel
        rows = list(csv.reader(handle, dialect))
    return numeric_column_from_rows(rows, path)


def load_mat_de_signal(path: Path) -> np.ndarray:
    try:
        from scipy.io import loadmat
    except ImportError as exc:
        raise RuntimeError("Install training requirements first: python -m pip install -r training\\requirements.txt") from exc

    mat = loadmat(path)
    candidates: list[tuple[str, np.ndarray]] = []
    for key, value in mat.items():
        compact = key.lower().replace("_", "")
        if key.startswith("__") or "detime" not in compact:
            continue
        array = np.asarray(value, dtype=np.float32).reshape(-1)
        if len(array) >= WINDOW_SIZE + 1:
            candidates.append((key, array))

    if not candidates:
        available = ", ".join(key for key in mat.keys() if not key.startswith("__"))
        raise ValueError(f"No CWRU Drive End '*DE_time' vector found in {path}. Available keys: {available}")

    candidates.sort(key=lambda item: len(item[1]), reverse=True)
    return candidates[0][1]


def load_normal_signal(path: Path) -> np.ndarray:
    files = discover_normal_files(path)
    waves = []

    for file_path in files:
        suffix = file_path.suffix.lower()
        if suffix == ".mat":
            wave = load_mat_de_signal(file_path)
        elif suffix in {".csv", ".txt"}:
            wave = load_csv_de_signal(file_path)
        else:
            continue

        waves.append(np.asarray(wave, dtype=np.float32).reshape(-1))
        print(f"Loaded normal Drive End signal: {file_path} ({len(wave)} samples)")

    if not waves:
        raise ValueError("No usable normal baseline Drive End signals were loaded.")

    merged = np.concatenate(waves)
    if len(merged) < WINDOW_SIZE + 1:
        raise ValueError("Normal baseline data does not contain enough sequential samples.")
    return zscore_normalize(merged)


class WaveWindowDataset(Dataset[tuple[torch.Tensor, torch.Tensor]]):
    def __init__(self, wave: np.ndarray, stride: int, max_windows: int) -> None:
        self.wave = wave
        self.starts = np.arange(0, len(wave) - WINDOW_SIZE, stride)
        if len(self.starts) > max_windows:
            self.starts = np.linspace(0, self.starts[-1], max_windows, dtype=np.int64)

    def __len__(self) -> int:
        return len(self.starts)

    def __getitem__(self, index: int) -> tuple[torch.Tensor, torch.Tensor]:
        start = int(self.starts[index])
        context = self.wave[start : start + CONTEXT_SIZE]
        target = self.wave[start + CONTEXT_SIZE : start + CONTEXT_SIZE + PREDICTION_SIZE]
        return torch.from_numpy(context).unsqueeze(0), torch.from_numpy(target)


class TernaryWeightFn(torch.autograd.Function):
    @staticmethod
    def forward(ctx, weight: torch.Tensor, threshold: float) -> torch.Tensor:
        scale = weight.detach().abs().mean().clamp_min(1e-6)
        ternary = torch.where(
            weight > threshold * scale,
            torch.ones_like(weight),
            torch.where(weight < -threshold * scale, -torch.ones_like(weight), torch.zeros_like(weight)),
        )
        return ternary * scale

    @staticmethod
    def backward(ctx, grad_output: torch.Tensor) -> tuple[torch.Tensor, None]:
        return grad_output, None


class TernaryLinear(nn.Linear):
    def __init__(self, in_features: int, out_features: int, bias: bool = True, threshold: float = 0.7) -> None:
        super().__init__(in_features, out_features, bias)
        self.threshold = threshold

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        weight = TernaryWeightFn.apply(self.weight, self.threshold)
        return nn.functional.linear(x, weight, self.bias)


class BitForgePredictor(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.net = nn.Sequential(
            TernaryLinear(CONTEXT_SIZE, HIDDEN_1),
            nn.GELU(),
            TernaryLinear(HIDDEN_1, HIDDEN_2),
            nn.GELU(),
            TernaryLinear(HIDDEN_2, HIDDEN_3),
            nn.GELU(),
            TernaryLinear(HIDDEN_3, PREDICTION_SIZE),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x.flatten(1))


def mse_to_trip_loss(prediction: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    return nn.functional.mse_loss(prediction, target)


def ternarize_tensor(weight: torch.Tensor, threshold: float = 0.7) -> tuple[np.ndarray, float]:
    detached = weight.detach().cpu()
    scale = float(detached.abs().mean().clamp_min(1e-6))
    ternary = torch.where(
        detached > threshold * scale,
        torch.ones_like(detached, dtype=torch.int8),
        torch.where(detached < -threshold * scale, -torch.ones_like(detached, dtype=torch.int8), torch.zeros_like(detached, dtype=torch.int8)),
    )
    return ternary.numpy(), scale


def pack_ternary_2bit(values: np.ndarray) -> np.ndarray:
    flat = values.reshape(-1).astype(np.int8)
    codes = np.zeros(len(flat), dtype=np.uint8)
    codes[flat < 0] = 1
    codes[flat > 0] = 2

    packed = np.zeros((len(codes) + 3) // 4, dtype=np.uint8)
    for index, code in enumerate(codes):
        packed[index // 4] |= np.uint8(code << ((index % 4) * 2))
    return packed


def export_ternary_header(model: nn.Module, out_path: Path) -> None:
    lines = [
        "#pragma once",
        "#include <stdint.h>",
        "",
        "// Generated by training/train_predictor.py",
        "// Packed 2-bit ternary weights: 0=zero, 1=-1, 2=+1, 3=reserved.",
        "// ESP32 inference should unpack each code and use add/subtract/skip.",
        "",
    ]

    manifest = []
    total_params = 0
    total_packed_bytes = 0
    params = dict(model.named_parameters())
    for name, param in params.items():
        if not name.endswith("weight") or param.ndim != 2:
            continue
        ternary, scale = ternarize_tensor(param)
        symbol = name.replace(".", "_")
        packed = pack_ternary_2bit(ternary)
        bias_name = name[:-6] + "bias"
        bias = params.get(bias_name)
        bias_values = bias.detach().cpu().numpy().reshape(-1).astype(np.float32) if bias is not None else np.zeros(ternary.shape[0], dtype=np.float32)
        param_count = int(ternary.size)
        total_params += param_count
        total_packed_bytes += int(packed.size)
        manifest.append(
            {
                "name": name,
                "symbol": symbol,
                "shape": list(ternary.shape),
                "scale": scale,
                "params": param_count,
                "packed_bytes": int(packed.size),
                "bias": symbol.replace("_weight", "_bias"),
                "encoding": "2bit:0=zero,1=neg,2=pos,3=reserved",
            }
        )
        lines.append(f"static const float {symbol}_scale = {scale:.9f}f;")
        lines.append(f"static const uint32_t {symbol}_params = {param_count}u;")
        lines.append(f"static const uint32_t {symbol}_packed_bytes = {int(packed.size)}u;")
        lines.append(f"static const uint8_t {symbol}_packed[] = {{")
        for start in range(0, len(packed), 20):
            chunk = ", ".join(f"0x{int(v):02x}" for v in packed[start : start + 20])
            lines.append(f"  {chunk},")
        lines.append("};")
        bias_symbol = symbol.replace("_weight", "_bias")
        lines.append(f"static const float {bias_symbol}[] = {{")
        for start in range(0, len(bias_values), 8):
            chunk = ", ".join(f"{float(v):.9g}f" for v in bias_values[start : start + 8])
            lines.append(f"  {chunk},")
        lines.append("};")
        lines.append("")

    lines.append(f"static const uint32_t BIT_FORGE_TOTAL_TERNARY_PARAMS = {total_params}u;")
    lines.append(f"static const uint32_t BIT_FORGE_TOTAL_PACKED_BYTES = {total_packed_bytes}u;")
    lines.append("")
    lines.append("static const char *BIT_FORGE_TERNARY_MANIFEST = R\"json(")
    lines.append(json.dumps(manifest, separators=(",", ":")))
    lines.append(")json\";")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def train() -> None:
    args = parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    wave = load_normal_signal(args.data)
    dataset = WaveWindowDataset(wave, args.stride, args.max_windows)
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=True, num_workers=0, drop_last=True)

    model = BitForgePredictor().to(args.device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    parameter_count = sum(p.numel() for p in model.parameters())
    print(f"Training Bit-Forge predictor with {parameter_count / 1_000_000:.2f}M parameters on {args.device}")

    history = []
    for epoch in range(1, args.epochs + 1):
        model.train()
        total = 0.0
        batches = 0

        for context, target in loader:
            context = context.to(args.device, non_blocking=True)
            target = target.to(args.device, non_blocking=True)
            prediction = model(context)
            loss = mse_to_trip_loss(prediction, target)

            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            total += float(loss.detach().cpu())
            batches += 1

        train_mse = total / max(1, batches)
        history.append({"epoch": epoch, "train_mse": train_mse})
        print(f"epoch={epoch:03d} train_mse={train_mse:.7f}")

    checkpoint_path = args.out_dir / "bit_forge_predictor.pt"
    torch.save(
        {
            "model": model.state_dict(),
            "context_size": CONTEXT_SIZE,
            "prediction_size": PREDICTION_SIZE,
            "parameter_count": parameter_count,
            "history": history,
        },
        checkpoint_path,
    )

    export_ternary_header(model, args.out_dir / "ternary_weights.h")
    (args.out_dir / "training_history.json").write_text(json.dumps(history, indent=2), encoding="utf-8")
    print(f"Saved {checkpoint_path}")
    print(f"Saved {args.out_dir / 'ternary_weights.h'}")


if __name__ == "__main__":
    train()
