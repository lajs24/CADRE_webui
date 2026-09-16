"""Upsample CADRE density JSON fields for visual interpolation experiments.

The CADRE export stores physical density in people per square metre.  This
script interpolates that field onto a finer grid while reducing the cell size
by the same factor.  Each non-empty frame is then rescaled so that
``sum(density * cell_area)`` is retained.  This makes the generated grids safe
for the UI's estimated-people statistic as well as for visual comparison.

Example:

    conda run -n crowd-diffusion python D:\\webui\\interpolate_density_json.py

The default creates  (48x) files for nearest, bilinear, bicubic, and
Lanczos interpolation under ``generated_heatmaps/interpolated``.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image


PROJECT_DIR = Path(__file__).resolve().parent
DEFAULT_INPUT = PROJECT_DIR / "generated_heatmaps" / "cadre_test_000.json"
DEFAULT_OUTPUT_DIR = PROJECT_DIR / "generated_heatmaps" / "interpolated"
METHODS = ("lanczos",)
PIL_RESAMPLING = {
    "nearest": Image.Resampling.NEAREST,
    "bilinear": Image.Resampling.BILINEAR,
    "bicubic": Image.Resampling.BICUBIC,
    "lanczos": Image.Resampling.LANCZOS,
}
DENSITY_GROUPS = ("observed", "prediction", "ground_truth")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create mass-preserving, interpolated CADRE density JSON files."
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Source cadre-density/v1 JSON file.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Directory for the generated JSON files.")
    parser.add_argument("--factor", type=int, default=24, help="Integer spatial upsampling factor (default: 48).")
    parser.add_argument(
        "--methods",
        nargs="+",
        choices=METHODS,
        default=list(METHODS),
        help="Interpolation methods to export (default: all four).",
    )
    return parser.parse_args()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def read_payload(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as source:
        payload = json.load(source)
    require(payload.get("schema") == "cadre-density/v1", "Only cadre-density/v1 JSON files are supported.")
    grid = payload.get("grid") or {}
    temporal = payload.get("temporal") or {}
    density = payload.get("density") or {}
    height, width = grid.get("height"), grid.get("width")
    require(isinstance(height, int) and height > 0 and isinstance(width, int) and width > 0, "Source grid dimensions are invalid.")
    require(isinstance(grid.get("cell_size_m"), (int, float)) and grid["cell_size_m"] > 0, "Source cell_size_m is invalid.")
    expected_frames = {
        "observed": temporal.get("observed_frames"),
        "prediction": temporal.get("predicted_frames"),
        "ground_truth": temporal.get("predicted_frames"),
    }
    for name, count in expected_frames.items():
        frames = density.get(name)
        require(isinstance(count, int) and count > 0, f"Temporal count for {name} is invalid.")
        require(isinstance(frames, list) and len(frames) == count, f"{name} must contain {count} frames.")
        for index, frame in enumerate(frames):
            array = np.asarray(frame, dtype=np.float64)
            require(array.shape == (height, width), f"{name}[{index}] has shape {array.shape}, expected {(height, width)}.")
            require(np.isfinite(array).all(), f"{name}[{index}] contains non-finite values.")
            require((array >= 0).all(), f"{name}[{index}] contains negative density values.")
    return payload


def people_count(matrix: np.ndarray, cell_size_m: float) -> float:
    return float(np.sum(matrix, dtype=np.float64) * cell_size_m * cell_size_m)


def interpolate_frame(frame: np.ndarray, factor: int, method: str) -> np.ndarray:
    """Resize one physical density field and preserve its integrated population."""
    source = np.asarray(frame, dtype=np.float32)
    target_height, target_width = source.shape[0] * factor, source.shape[1] * factor
    image = Image.fromarray(source, mode="F")
    interpolated = np.asarray(
        image.resize((target_width, target_height), resample=PIL_RESAMPLING[method]),
        dtype=np.float64,
    )

    # Higher-order filters can ring below zero around sharp peaks.  Negative
    # density is physically invalid, so clamp before restoring the total mass.
    np.maximum(interpolated, 0.0, out=interpolated)
    source_sum = float(np.sum(source, dtype=np.float64))
    interpolated_sum = float(np.sum(interpolated, dtype=np.float64))
    if source_sum == 0.0:
        interpolated.fill(0.0)
    elif interpolated_sum <= 0.0:
        raise ValueError(f"{method} interpolation removed all positive density.")
    else:
        # Cell area is smaller by factor², therefore equal density sums must
        # increase by factor² for the estimated number of people to match.
        interpolated *= source_sum * factor * factor / interpolated_sum
    return interpolated


def rounded_matrix(matrix: np.ndarray) -> list[list[float]]:
    return np.round(matrix, decimals=6).tolist()


def validate_output(payload: dict[str, Any], factor: int) -> dict[str, float]:
    """Validate dimensions, finite/non-negative values, and framewise mass error."""
    grid = payload["grid"]
    density = payload["density"]
    source_grid = payload["interpolation"]["source_grid"]
    height, width = int(grid["height"]), int(grid["width"])
    source_height, source_width = int(source_grid["height"]), int(source_grid["width"])
    cell_size = float(grid["cell_size_m"])
    source_cell_size = float(source_grid["cell_size_m"])
    require((height, width) == (source_height * factor, source_width * factor), "Interpolated grid size is inconsistent with factor.")
    require(math.isclose(cell_size, source_cell_size / factor, rel_tol=0.0, abs_tol=1e-12), "Interpolated cell size is inconsistent with factor.")

    max_population_error = 0.0
    for name in DENSITY_GROUPS:
        source_totals = payload["interpolation"]["source_people_by_group"][name]
        frames = density[name]
        require(len(frames) == len(source_totals), f"{name} frame count changed during interpolation.")
        for index, frame in enumerate(frames):
            array = np.asarray(frame, dtype=np.float64)
            require(array.shape == (height, width), f"{name}[{index}] target dimensions are invalid.")
            require(np.isfinite(array).all(), f"{name}[{index}] contains non-finite output values.")
            require((array >= 0).all(), f"{name}[{index}] contains negative output density.")
            max_population_error = max(max_population_error, abs(people_count(array, cell_size) - float(source_totals[index])))
    return {"max_population_error_people": max_population_error}


def iter_frames(payload: dict[str, Any], name: str) -> Iterable[np.ndarray]:
    for frame in payload["density"][name]:
        yield np.asarray(frame, dtype=np.float64)


def interpolate_payload(source: dict[str, Any], factor: int, method: str) -> tuple[dict[str, Any], dict[str, float]]:
    grid = source["grid"]
    source_height, source_width = int(grid["height"]), int(grid["width"])
    source_cell_size = float(grid["cell_size_m"])
    result = copy.deepcopy(source)
    result["scene_name"] = f"{source.get('scene_name', source.get('dataset', 'CADRE'))} · {factor}× {method} 插值"
    result["grid"]["height"] = source_height * factor
    result["grid"]["width"] = source_width * factor
    result["grid"]["cell_size_m"] = source_cell_size / factor
    result["interpolation"] = {
        "method": method,
        "factor": factor,
        "source_grid": {"height": source_height, "width": source_width, "cell_size_m": source_cell_size},
        "density_semantics": "people/m^2",
        "population_conservation": "Framewise population is restored after interpolation; values are clamped to non-negative density before restoration.",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_people_by_group": {},
    }
    for name in DENSITY_GROUPS:
        source_frames = list(iter_frames(source, name))
        result["interpolation"]["source_people_by_group"][name] = [people_count(frame, source_cell_size) for frame in source_frames]
        result["density"][name] = [rounded_matrix(interpolate_frame(frame, factor, method)) for frame in source_frames]
    return result, validate_output(result, factor)


def output_path_for(input_path: Path, output_dir: Path, factor: int, method: str) -> Path:
    return output_dir / f"{input_path.stem}_x{factor}_{method}.json"


def main() -> None:
    args = parse_args()
    require(args.factor > 0, "--factor must be a positive integer.")
    input_path = args.input.resolve()
    output_dir = args.output_dir.resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"Source JSON not found: {input_path}")
    source = read_payload(input_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Source: {input_path}")
    print(f"Grid: {source['grid']['height']}x{source['grid']['width']} -> {source['grid']['height'] * args.factor}x{source['grid']['width'] * args.factor}")
    for method in args.methods:
        payload, report = interpolate_payload(source, args.factor, method)
        destination = output_path_for(input_path, output_dir, args.factor, method)
        with destination.open("w", encoding="utf-8", newline="\n") as target:
            json.dump(payload, target, ensure_ascii=False, indent=2, allow_nan=False)
            target.write("\n")
        print(f"{method:9} {destination} | max frame population error: {report['max_population_error_people']:.6g} people")


if __name__ == "__main__":
    main()
