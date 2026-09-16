"""Export one or several CADRE density windows for the static Web UI.

The default ``showcase`` selection scans the requested split using physical
density MAE, then exports the first, exact best/worst, and three repeatable
random windows in one ``cadre-density-collection/v1`` JSON file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import torch
import yaml
from torch.utils.data import DataLoader

from cadre_density_core import compute_density_metrics, sample_label, select_fixed, select_showcase


PROJECT_DIR = Path(__file__).resolve().parent
CADRE_DIR = PROJECT_DIR / "CADRE"
DEFAULT_CONFIG = CADRE_DIR / "config" / "Madras_direct.yaml"
DEFAULT_CHECKPOINT = CADRE_DIR / "model_best.pth"
GENERATOR_VERSION = "2.0"

sys.path.insert(0, str(CADRE_DIR))

from datasets import _load_stats, get_dataset_dir, get_dataset_from_cfg  # noqa: E402
from model import CondDecoder, getEncoder, getPredictor  # noqa: E402
from model.cDecoder import LatentDebiasUNet  # noqa: E402
from train_direct import DirectModel, from_model_space, parse_input_ranges  # noqa: E402
from utils import Config, init_seeds  # noqa: E402


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export CADRE density windows for the Web UI.")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--split", choices=("train", "val", "test"), default="test")
    parser.add_argument("--selection", choices=("showcase", "single", "indices"), default="showcase")
    parser.add_argument("--sample-index", type=int, default=0, help="Window used by --selection single.")
    parser.add_argument("--sample-indices", type=int, nargs="+", default=None, help="Windows used by --selection indices.")
    parser.add_argument("--random-count", type=int, default=3)
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--device", default="cuda", help="Inference device; CUDA falls back to CPU when unavailable.")
    parser.add_argument("--pretty", action="store_true", help="Indent JSON for manual inspection (larger file).")
    return parser.parse_args(argv)


def read_config(path: Path) -> Config:
    with path.open("r", encoding="utf-8") as source:
        return Config(yaml.safe_load(source))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cadre_commit(cadre_dir: Path) -> str | None:
    try:
        return subprocess.check_output(
            ["git", "-c", f"safe.directory={cadre_dir.as_posix()}", "-C", str(cadre_dir), "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def build_model(cfg: Config, device: torch.device, checkpoint_path: Path):
    cond_frames = int(cfg.multiscale.get("cond_frames", 1))
    horizon = int(cfg.multiscale["horizon"])
    channels, height, width = (int(value) for value in cfg.network["image_shape"])
    latent_dim = int(cfg.network["cond_latent_dim"])
    downsample_times = int(cfg.network.get("downsample_times", cfg.network.get("n_blocks", 2)))
    divisor = 2**downsample_times if downsample_times > 0 else 1
    latent_height = (height + divisor - 1) // divisor
    latent_width = (width + divisor - 1) // divisor
    network_cfg = {key: value for key, value in cfg.network.items() if key != "downsample_times"}
    encoder = getEncoder(**network_cfg)
    predictor = getPredictor(
        **network_cfg,
        model_type=cfg.model_type,
        cond_frames=cond_frames,
        max_scale=1,
        spatial_h=latent_height,
        spatial_w=latent_width,
    )
    decoder = CondDecoder(
        cond_latent_dim=latent_dim,
        out_channels=channels,
        input_spatial_h=latent_height,
        input_spatial_w=latent_width,
        target_h=height,
        target_w=width,
    )
    use_debias = bool(getattr(cfg, "use_debias", False))
    debias_unet = LatentDebiasUNet(latent_dim=latent_dim, cond_dim=latent_dim, h_dim=128) if use_debias else None
    predictor_type = "LSTM" if "LSTM" in str(cfg.model_type) else str(cfg.model_type)
    model = DirectModel(encoder, predictor, decoder, predictor_type=predictor_type, latent_dim=latent_dim, debias_unet=debias_unet)
    model._cond_frames = cond_frames
    model._use_debias = use_debias
    model._diff_steps = int(getattr(cfg, "diff_steps", 0))
    model._diff_n_T = int(getattr(cfg, "diff_n_T", 1000))
    model._diff_start_t = int(getattr(cfg, "diff_start_t", 0))
    model._z_noise_std = 0.0
    model._diff_train_std = 0.0
    model._input_ranges = parse_input_ranges(cfg, channels)
    model.to(device)

    try:
        checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=False)
    except TypeError:
        checkpoint = torch.load(checkpoint_path, map_location=device)
    state = checkpoint["model"] if isinstance(checkpoint, dict) and "model" in checkpoint else checkpoint
    if not isinstance(state, dict):
        raise TypeError("checkpoint does not contain a model state dictionary")
    has_debias_weights = any("debias_unet" in key for key in state)
    incompatible = model.load_state_dict(state, strict=False)
    allowed_missing = {key for key in incompatible.missing_keys if key.startswith("debias_unet.") and not has_debias_weights}
    invalid_missing = sorted(set(incompatible.missing_keys) - allowed_missing)
    invalid_unexpected = sorted(incompatible.unexpected_keys)
    if invalid_missing or invalid_unexpected:
        raise RuntimeError(
            "checkpoint is incompatible with the configured model: "
            f"missing={invalid_missing or 'none'}, unexpected={invalid_unexpected or 'none'}"
        )
    use_trained_debias = has_debias_weights and getattr(model, "debias_unet", None) is not None
    model.eval()

    if isinstance(checkpoint, dict):
        checkpoint_diff_std = float(checkpoint.get("diff_train_std", 0.0) or 0.0)
        if checkpoint_diff_std > 0:
            model._diff_train_std = checkpoint_diff_std
        if checkpoint.get("input_ranges") is not None:
            model._input_ranges = checkpoint["input_ranges"]
        for key, attribute in (("diff_start_t", "_diff_start_t"), ("diff_steps", "_diff_steps"), ("diff_n_T", "_diff_n_T")):
            if checkpoint.get(key) is not None:
                setattr(model, attribute, int(checkpoint[key]))
        if checkpoint.get("diff_fixed_t") is not None:
            model._diff_fixed_t = int(checkpoint["diff_fixed_t"])

    model_info = {
        "name": "CADRE",
        "checkpoint": checkpoint_path.name,
        "checkpoint_sha256": file_sha256(checkpoint_path),
        "epoch": checkpoint.get("epoch") if isinstance(checkpoint, dict) else None,
        "debiased": bool(use_trained_debias),
    }
    return model, model_info, (cond_frames, horizon, channels, height, width)


def density_transform(cfg: Config, data_dir: Path, channels: int) -> tuple[float, float]:
    """Match eval_direct.py's storage-to-physical conversion for channel 0."""
    normalization = getattr(cfg, "normalization", None) or {}
    explicit = (
        isinstance(normalization, dict)
        and normalization.get("mode")
        and normalization.get("norm_min") is not None
        and normalization.get("norm_max") is not None
        and normalization.get("storage_scale") is not None
        and normalization.get("storage_offset") is not None
    )
    if explicit:
        return float(normalization["storage_scale"][0]), float(normalization["storage_offset"][0])
    stats = _load_stats(str(data_dir))
    if not isinstance(stats, dict):
        raise FileNotFoundError(f"Missing stats.json in dataset directory: {data_dir}")
    norm_min = stats.get("norm_min")
    norm_max = stats.get("norm_max")
    normalization_info = stats.get("normalization") or {}
    mode = str(stats.get("normalization_mode", "minmax")).lower()
    if norm_min is None or norm_max is None:
        scale = normalization_info.get("scale")
        if isinstance(scale, (list, tuple)):
            norm_min = [0.0] + [-float(item) for item in scale[1:]]
            norm_max = [float(item) for item in scale]
            mode = "scale"
        else:
            norm_min = [0.0] * channels
            norm_max = [1.0] * channels
    value_range = float(norm_max[0]) - float(norm_min[0])
    if mode == "physical_anchor":
        anchors = stats.get("anchors") or {}
        rho_scale = next((anchors.get(key) for key in ("rho", "density_scale", "density_anchor") if anchors.get(key) is not None), None)
        if rho_scale is None:
            for key in ("channel_physical_scales", "physical_scales", "channel_scales"):
                values = stats.get(key)
                if isinstance(values, (list, tuple)) and len(values) == channels:
                    rho_scale = values[0]
                    break
        if rho_scale is None:
            rho_scale = next(
                (normalization_info.get(key) for key in ("rho_scale", "rho_anchor", "density_scale", "density_anchor") if normalization_info.get(key) is not None),
                value_range,
            )
        return float(rho_scale), 0.0
    scale = normalization_info.get("scale")
    if isinstance(scale, (list, tuple)):
        return float(scale[0]), 0.0
    return value_range, float(norm_min[0])


def resolve_data_dir(cfg: Config, config_path: Path) -> Path:
    data_cfg = getattr(cfg, "data", None) or {}
    configured = data_cfg.get("dir") if isinstance(data_cfg, dict) else None
    if configured:
        path = Path(configured)
        return (config_path.parent / path).resolve() if not path.is_absolute() else path.resolve()
    return Path(get_dataset_dir(cfg.dataset)).resolve()


def physical_array(storage_density: np.ndarray, scale: float, offset: float) -> np.ndarray:
    return np.asarray(storage_density, dtype=np.float64) * scale + offset


def json_density(density: np.ndarray) -> list[Any]:
    return np.round(np.asarray(density, dtype=np.float64), 6).tolist()


def predict_storage(model: DirectModel, windows: torch.Tensor, shape, device: torch.device, use_debias: bool) -> np.ndarray:
    _, horizon, channels, height, width = shape
    with torch.inference_mode():
        output = model(windows.to(device), return_latent=False, phase="predict", use_debias=use_debias)
        storage = from_model_space(output, model._input_ranges)
    return storage.reshape(windows.shape[0], horizon, channels, height, width).detach().cpu().numpy()


def scan_density_mae(model, dataset, shape, device, use_debias, density_scale, density_offset, batch_size: int) -> np.ndarray:
    cond_frames, _, _, _, _ = shape
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)
    errors: list[np.ndarray] = []
    completed = 0
    for windows in loader:
        prediction = predict_storage(model, windows, shape, device, use_debias)[:, :, 0]
        truth = windows[:, cond_frames:, 0].cpu().numpy()
        prediction_physical = physical_array(prediction, density_scale, density_offset)
        truth_physical = physical_array(truth, density_scale, density_offset)
        errors.append(np.mean(np.abs(prediction_physical - truth_physical), axis=(1, 2, 3)))
        completed += windows.shape[0]
        print(f"Scanned {completed}/{len(dataset)} windows", end="\r", flush=True)
    print()
    return np.concatenate(errors).astype(np.float64, copy=False)


def export_sample(model, dataset, selection_item, shape, device, model_info, density_scale, density_offset, split: str):
    cond_frames, horizon, channels, height, width = shape
    sample_index = int(selection_item["sample_index"])
    window = dataset[sample_index]
    expected = (cond_frames + horizon, channels, height, width)
    if tuple(window.shape) != expected:
        raise ValueError(f"dataset window {sample_index} has shape {tuple(window.shape)}, expected {expected}")
    prediction_storage = predict_storage(model, window.unsqueeze(0), shape, device, model_info["debiased"])[0, :, 0]
    observed = physical_array(window[:cond_frames, 0].cpu().numpy(), density_scale, density_offset)
    ground_truth = physical_array(window[cond_frames:, 0].cpu().numpy(), density_scale, density_offset)
    prediction = physical_array(prediction_storage, density_scale, density_offset)
    metrics = compute_density_metrics(prediction, ground_truth)
    roles = list(selection_item["roles"])
    return {
        "id": f"{split}-{sample_index:03d}",
        "sample_index": sample_index,
        "roles": roles,
        "label": sample_label(roles, selection_item.get("random_ordinal")),
        "metrics": {key: round(value, 8) for key, value in metrics.items()},
        "density": {
            "observed": json_density(observed),
            "prediction": json_density(prediction),
            "ground_truth": json_density(ground_truth),
        },
    }


def shared_metadata(cfg, config_path, model_info, shape, stats, split, seed, density_scale, density_offset):
    cond_frames, horizon, _, height, width = shape
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator": {"name": Path(__file__).name, "version": GENERATOR_VERSION},
        "dataset": str(cfg.dataset),
        "split": split,
        "model": {**model_info, "config": config_path.name, "config_sha256": file_sha256(config_path)},
        "provenance": {"cadre_commit": cadre_commit(CADRE_DIR), "random_seed": seed},
        "normalization": {"density_storage_scale": density_scale, "density_storage_offset": density_offset},
        "units": {"density": "people/m^2"},
        "grid": {
            "height": height,
            "width": width,
            "cell_size_m": float(stats.get("grid_size", 1.0)),
            "time_step_seconds": float(stats.get("dt", 1.0)),
            "row_order": "top-to-bottom",
            "x_axis": "column",
            "y_axis": "row",
        },
        "temporal": {
            "observed_frames": cond_frames,
            "predicted_frames": horizon,
            "observed_offsets_frames": list(range(-(cond_frames - 1), 1)),
            "future_offsets_frames": list(range(1, horizon + 1)),
        },
    }


def default_output(selection: str, split: str, sample_index: int) -> Path:
    if selection == "single":
        return PROJECT_DIR / "generated_heatmaps" / f"cadre_{split}_{sample_index:03d}.json"
    suffix = "showcase" if selection == "showcase" else "selection"
    return PROJECT_DIR / "generated_heatmaps" / f"cadre_{split}_{suffix}.json"


def write_json_atomic(payload: dict[str, Any], output_path: Path, pretty: bool) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as destination:
        json.dump(payload, destination, ensure_ascii=False, indent=2 if pretty else None, separators=None if pretty else (",", ":"), allow_nan=False)
        destination.write("\n")
    temporary.replace(output_path)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    config_path = args.config.resolve()
    checkpoint_path = args.checkpoint.resolve()
    if not config_path.is_file():
        raise FileNotFoundError(f"CADRE config not found: {config_path}")
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"CADRE checkpoint not found: {checkpoint_path}")
    if args.random_count < 0:
        raise ValueError("--random-count must be non-negative")
    if args.batch_size is not None and args.batch_size <= 0:
        raise ValueError("--batch-size must be positive")

    cfg = read_config(config_path)
    device = torch.device("cpu" if args.device.startswith("cuda") and not torch.cuda.is_available() else args.device)
    init_seeds(args.seed)
    model, model_info, shape = build_model(cfg, device, checkpoint_path)
    _, horizon, channels, height, width = shape
    dataset = get_dataset_from_cfg(cfg, split=args.split, horizon=horizon, noise=0.0, ratio=1.0, augment=False)
    if len(dataset) == 0:
        raise ValueError(f"{args.split} split is empty")
    data_dir = resolve_data_dir(cfg, config_path)
    density_scale, density_offset = density_transform(cfg, data_dir, channels)
    stats = _load_stats(str(data_dir)) or {}
    batch_size = args.batch_size or int(getattr(cfg, "batch_size", 16) or 16)

    scanned_windows = 0
    if args.selection == "showcase":
        errors = scan_density_mae(model, dataset, shape, device, model_info["debiased"], density_scale, density_offset, batch_size)
        selection = select_showcase(errors, random_count=args.random_count, seed=args.seed)
        scanned_windows = len(dataset)
    elif args.selection == "single":
        selection = select_fixed([args.sample_index], len(dataset))
    else:
        if not args.sample_indices:
            raise ValueError("--selection indices requires --sample-indices")
        selection = select_fixed(args.sample_indices, len(dataset))

    random_ordinal = 0
    for item in selection:
        if "random" in item["roles"]:
            random_ordinal += 1
            item["random_ordinal"] = random_ordinal
    samples = [export_sample(model, dataset, item, shape, device, model_info, density_scale, density_offset, args.split) for item in selection]
    shared = shared_metadata(cfg, config_path, model_info, shape, stats, args.split, args.seed, density_scale, density_offset)

    if args.selection == "single":
        sample = samples[0]
        split_name = {"train": "训练集", "val": "验证集", "test": "测试集"}[args.split]
        payload = {
            "schema": "cadre-density/v1",
            **shared,
            "scene_name": f"{cfg.dataset} · {split_name} #{sample['sample_index']:03d}",
            "sample_index": sample["sample_index"],
            "metrics": sample["metrics"],
            "density": sample["density"],
        }
    else:
        payload = {
            "schema": "cadre-density-collection/v1",
            **shared,
            "selection": {
                "mode": args.selection,
                "metric": "density_physical_mae",
                "scanned_windows": scanned_windows,
                "random_seed": args.seed,
                "random_count": args.random_count if args.selection == "showcase" else 0,
            },
            "samples": samples,
        }

    output_path = (args.output or default_output(args.selection, args.split, args.sample_index)).resolve()
    write_json_atomic(payload, output_path, args.pretty)
    print(f"Device: {device}")
    print(f"Dataset: {args.split} | {len(dataset)} windows | grid {height}x{width}")
    print(f"Density scale: storage * {density_scale:g} + {density_offset:g} people/m^2")
    print(f"Prediction: {'debiased' if model_info['debiased'] else 'direct'}")
    print("Selected: " + ", ".join(f"#{sample['sample_index']:03d} ({'/'.join(sample['roles'])})" for sample in samples))
    print(f"JSON saved to: {output_path}")


if __name__ == "__main__":
    main()
