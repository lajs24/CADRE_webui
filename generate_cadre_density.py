"""Generate a single CADRE sample as a frontend-ready density JSON file.

Run from any directory with the crowd-diffusion Conda environment, for example:

    conda run -n crowd-diffusion python D:\webui\generate_cadre_density.py

Only density channel 0 is exported. The other two CADRE channels remain inputs
to the model but are not included in the output.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import torch
import yaml


PROJECT_DIR = Path(__file__).resolve().parent
CADRE_DIR = PROJECT_DIR / "CADRE"
DEFAULT_CONFIG = CADRE_DIR / "config" / "Madras_direct.yaml"
DEFAULT_CHECKPOINT = CADRE_DIR / "model_best.pth"
DEFAULT_OUTPUT = PROJECT_DIR / "generated_heatmaps" / "cadre_test_000.json"

# The evaluation script imports CADRE modules as top-level packages.
sys.path.insert(0, str(CADRE_DIR))

from datasets import get_dataset_dir, get_dataset_from_cfg, _load_stats  # noqa: E402
from model import CondDecoder, getEncoder, getPredictor  # noqa: E402
from model.cDecoder import LatentDebiasUNet  # noqa: E402
from train_direct import DirectModel, from_model_space, parse_input_ranges  # noqa: E402
from utils import Config, init_seeds  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export one CADRE window as density-only JSON for the web UI."
    )
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--split", choices=("train", "val", "test"), default="test")
    parser.add_argument("--sample-index", type=int, default=0)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--device", default="cuda", help="Inference device; CUDA falls back to CPU when unavailable.")
    return parser.parse_args()


def read_config(path: Path) -> Config:
    with path.open("r", encoding="utf-8") as source:
        return Config(yaml.full_load(source))


def build_model(cfg: Config, device: torch.device, checkpoint_path: Path):
    cond_frames = int(cfg.multiscale.get("cond_frames", 1))
    horizon = int(cfg.multiscale["horizon"])
    channels, height, width = (int(value) for value in cfg.network["image_shape"])
    latent_dim = int(cfg.network["cond_latent_dim"])

    downsample_times = int(cfg.network.get("downsample_times", cfg.network.get("n_blocks", 2)))
    divisor = 2**downsample_times if downsample_times > 0 else 1
    latent_height = (height + divisor - 1) // divisor
    latent_width = (width + divisor - 1) // divisor

    # Keep the same architecture construction and normalization path as eval_direct.py.
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
    debias_unet = None
    use_debias = bool(getattr(cfg, "use_debias", False))
    if use_debias:
        debias_unet = LatentDebiasUNet(latent_dim=latent_dim, cond_dim=latent_dim, h_dim=128)

    predictor_type = "LSTM" if "LSTM" in str(cfg.model_type) else str(cfg.model_type)
    model = DirectModel(
        encoder,
        predictor,
        decoder,
        predictor_type=predictor_type,
        latent_dim=latent_dim,
        debias_unet=debias_unet,
    )
    model._cond_frames = cond_frames
    model._use_debias = use_debias
    model._diff_steps = int(getattr(cfg, "diff_steps", 0))
    model._diff_n_T = int(getattr(cfg, "diff_n_T", 1000))
    model._diff_start_t = int(getattr(cfg, "diff_start_t", 0))
    model._z_noise_std = 0.0
    model._diff_train_std = 0.0
    model._input_ranges = parse_input_ranges(cfg, channels)
    model.to(device)

    checkpoint = torch.load(checkpoint_path, map_location=device)
    state = checkpoint["model"] if isinstance(checkpoint, dict) and "model" in checkpoint else checkpoint
    has_debias_weights = isinstance(state, dict) and any("debias_unet" in key for key in state)
    model.load_state_dict(state, strict=False)
    use_trained_debias = has_debias_weights and getattr(model, "debias_unet", None) is not None
    model.eval()

    if isinstance(checkpoint, dict):
        checkpoint_diff_std = float(checkpoint.get("diff_train_std", 0.0) or 0.0)
        if checkpoint_diff_std > 0:
            model._diff_train_std = checkpoint_diff_std
        checkpoint_ranges = checkpoint.get("input_ranges")
        if checkpoint_ranges is not None:
            model._input_ranges = checkpoint_ranges
        for key, attribute in (
            ("diff_start_t", "_diff_start_t"),
            ("diff_steps", "_diff_steps"),
            ("diff_n_T", "_diff_n_T"),
        ):
            if checkpoint.get(key) is not None:
                setattr(model, attribute, int(checkpoint[key]))
        if checkpoint.get("diff_fixed_t") is not None:
            model._diff_fixed_t = int(checkpoint["diff_fixed_t"])

    model_info = {
        "epoch": checkpoint.get("epoch") if isinstance(checkpoint, dict) else None,
        "uses_debias": bool(use_trained_debias),
        "checkpoint": checkpoint_path.name,
    }
    return model, model_info, (cond_frames, horizon, channels, height, width)


def density_transform(cfg: Config, data_dir: Path, channels: int) -> tuple[float, float]:
    """Match eval_direct.py's storage-to-physical conversion for channel 0."""
    normalization = getattr(cfg, "normalization", None) or {}
    has_explicit_contract = (
        isinstance(normalization, dict)
        and normalization.get("mode")
        and normalization.get("norm_min") is not None
        and normalization.get("norm_max") is not None
        and normalization.get("storage_scale") is not None
        and normalization.get("storage_offset") is not None
    )
    if has_explicit_contract:
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
        rho_scale = next(
            (anchors.get(key) for key in ("rho", "density_scale", "density_anchor") if anchors.get(key) is not None),
            None,
        )
        if rho_scale is None:
            for key in ("channel_physical_scales", "physical_scales", "channel_scales"):
                values = stats.get(key)
                if isinstance(values, (list, tuple)) and len(values) == channels:
                    rho_scale = values[0]
                    break
        if rho_scale is None:
            rho_scale = next(
                (normalization_info.get(key) for key in ("rho_scale", "rho_anchor", "density_scale", "density_anchor")
                 if normalization_info.get(key) is not None),
                value_range,
            )
        return float(rho_scale), 0.0

    scale = normalization_info.get("scale")
    if isinstance(scale, (list, tuple)):
        return float(scale[0]), 0.0
    return value_range, float(norm_min[0])


def physical_density(storage_density: np.ndarray, scale: float, offset: float) -> list[list[float]]:
    density = np.asarray(storage_density, dtype=np.float32) * scale + offset
    return np.round(density, 6).tolist()


def main() -> None:
    args = parse_args()
    config_path = args.config.resolve()
    checkpoint_path = args.checkpoint.resolve()
    if not config_path.is_file():
        raise FileNotFoundError(f"CADRE config not found: {config_path}")
    if not checkpoint_path.is_file():
        raise FileNotFoundError(f"CADRE checkpoint not found: {checkpoint_path}")

    cfg = read_config(config_path)
    requested_device = args.device
    if requested_device.startswith("cuda") and not torch.cuda.is_available():
        device = torch.device("cpu")
    else:
        device = torch.device(requested_device)
    init_seeds()

    model, model_info, shape = build_model(cfg, device, checkpoint_path)
    cond_frames, horizon, channels, height, width = shape

    dataset = get_dataset_from_cfg(
        cfg,
        split=args.split,
        horizon=horizon,
        noise=0.0,
        ratio=1.0,
        augment=False,
    )
    if args.sample_index < 0 or args.sample_index >= len(dataset):
        raise IndexError(
            f"Sample index {args.sample_index} is out of range for {args.split} split "
            f"(valid: 0-{len(dataset) - 1})."
        )

    window = dataset[args.sample_index]
    if tuple(window.shape) != (cond_frames + horizon, channels, height, width):
        raise ValueError(
            "Dataset window shape does not match the model config: "
            f"got {tuple(window.shape)}, expected "
            f"({cond_frames + horizon}, {channels}, {height}, {width})."
        )

    model_input = window.unsqueeze(0).to(device)
    with torch.inference_mode():
        prediction_model_space = model(
            model_input,
            return_latent=False,
            phase="predict",
            use_debias=model_info["uses_debias"],
        )
        prediction_storage = from_model_space(prediction_model_space, model._input_ranges)

    observed = window[:cond_frames, 0].cpu().numpy()
    ground_truth = window[cond_frames:, 0].cpu().numpy()
    prediction = prediction_storage.reshape(horizon, channels, height, width)[:, 0].cpu().numpy()

    # Use the same dataset directory resolution as CADRE's evaluator.
    data_cfg = getattr(cfg, "data", None) or {}
    configured_data_dir = data_cfg.get("dir") if isinstance(data_cfg, dict) else None
    data_dir = Path(configured_data_dir).resolve() if configured_data_dir else Path(get_dataset_dir(cfg.dataset)).resolve()
    density_scale, density_offset = density_transform(cfg, data_dir, channels)
    stats = _load_stats(str(data_dir)) or {}
    grid_size = float(stats.get("grid_size", 1.0))
    dt = float(stats.get("dt", 1.0))

    split_name = {"train": "训练集", "val": "验证集", "test": "测试集"}[args.split]
    result: dict[str, Any] = {
        "schema": "cadre-density/v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset": str(cfg.dataset),
        "scene_name": f"{cfg.dataset} · {split_name} #{args.sample_index:03d}",
        "split": args.split,
        "sample_index": int(args.sample_index),
        "model": {
            "name": "CADRE",
            "checkpoint": model_info["checkpoint"],
            "epoch": model_info["epoch"],
            "debiased": model_info["uses_debias"],
        },
        "units": {"density": "people/m^2"},
        "grid": {
            "height": height,
            "width": width,
            "cell_size_m": grid_size,
            "time_step_seconds": dt,
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
        "density": {
            "observed": [physical_density(frame, density_scale, density_offset) for frame in observed],
            "prediction": [physical_density(frame, density_scale, density_offset) for frame in prediction],
            "ground_truth": [physical_density(frame, density_scale, density_offset) for frame in ground_truth],
        },
    }

    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as destination:
        json.dump(result, destination, ensure_ascii=False, indent=2, allow_nan=False)
        destination.write("\n")

    print(f"Device: {device}")
    print(f"Sample: {args.split}[{args.sample_index}] | grid {height}x{width}")
    print(f"Density scale: storage * {density_scale:g} + {density_offset:g} people/m^2")
    print(f"Prediction: {'debiased' if model_info['uses_debias'] else 'direct'}")
    print(f"JSON saved to: {output_path}")


if __name__ == "__main__":
    main()
