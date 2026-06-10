# Bit-Forge Local Testing Runbook

Use this path before touching ESP32 hardware.

## 1. Train the 100-epoch model

```powershell
cd C:\Users\aryan\Downloads\machine
python training\train_predictor.py --data data\cwru_normal --out-dir artifacts\bitforge_v1 --epochs 100 --batch-size 256 --stride 2 --device cuda
```

If CUDA runs out of memory, use `--batch-size 128`.

## 2. Test the trained checkpoint locally

```powershell
python training\test_local.py --checkpoint artifacts\bitforge_v1\bit_forge_predictor.pt --data data\cwru_normal --out artifacts\bitforge_v1\local_test_report.json --device cuda --windows 2500 --stride 25 --fault-start 700 --fault-windows 180
```

The script prints:

- healthy MSE distribution
- injected fault MSE distribution
- recommended threshold
- false positive rate
- fault detection rate

It also writes a trace file:

```text
artifacts\bitforge_v1\local_test_report.json
```

## 3. How to read the result

Good local result:

- `false_positive_rate` close to `0.0`
- `fault_detection_rate` close to `1.0`
- `fault_mse.p50` much larger than `healthy_mse.p99`

If healthy and fault MSE overlap heavily, train longer or lower the synthetic fault difficulty.

## 4. Run the dashboard without hardware

```powershell
python backend\bridge.py --simulate-esp --data data\cwru_normal
```

In another terminal:

```powershell
npm run dev
```

Open:

```text
http://127.0.0.1:3000
```

Click `Inject Bearing Fault` to verify the dashboard critical state.
