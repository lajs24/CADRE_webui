"""Pure density-selection helpers shared by the CADRE export CLI and tests."""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np


ROLE_LABELS = {
    "first": "起始",
    "best": "最佳",
    "worst": "最差",
    "random": "随机",
    "fixed": "固定",
}


def compute_density_metrics(prediction: np.ndarray, ground_truth: np.ndarray) -> dict[str, float]:
    """Return physical-density errors for matching ``[T, H, W]`` arrays."""
    prediction_array = np.asarray(prediction, dtype=np.float64)
    ground_truth_array = np.asarray(ground_truth, dtype=np.float64)
    if prediction_array.shape != ground_truth_array.shape or prediction_array.ndim != 3:
        raise ValueError("prediction and ground truth must have matching [T, H, W] shapes")
    if prediction_array.size == 0:
        raise ValueError("density arrays cannot be empty")
    error = prediction_array - ground_truth_array
    return {
        "density_mae": float(np.mean(np.abs(error))),
        "density_rmse": float(np.sqrt(np.mean(np.square(error)))),
        "density_max_absolute_error": float(np.max(np.abs(error))),
    }


def _add_role(selection: list[dict[str, object]], positions: dict[int, int], sample_index: int, role: str) -> None:
    if sample_index in positions:
        roles = selection[positions[sample_index]]["roles"]
        assert isinstance(roles, list)
        if role not in roles:
            roles.append(role)
        return
    positions[sample_index] = len(selection)
    selection.append({"sample_index": int(sample_index), "roles": [role]})


def select_showcase(errors: Sequence[float] | np.ndarray, random_count: int = 3, seed: int = 1337) -> list[dict[str, object]]:
    """Select first, exact best/worst, then unique random windows."""
    values = np.asarray(errors, dtype=np.float64)
    if values.ndim != 1 or values.size == 0:
        raise ValueError("cannot select showcase windows from an empty metric array")
    if not np.all(np.isfinite(values)):
        raise ValueError("window metrics must all be finite")
    if random_count < 0:
        raise ValueError("random_count must be non-negative")

    selection: list[dict[str, object]] = []
    positions: dict[int, int] = {}
    _add_role(selection, positions, 0, "first")
    _add_role(selection, positions, int(np.argmin(values)), "best")
    _add_role(selection, positions, int(np.argmax(values)), "worst")

    candidates = np.array([index for index in range(values.size) if index not in positions], dtype=np.int64)
    if candidates.size:
        rng = np.random.default_rng(seed)
        for sample_index in rng.choice(candidates, size=min(random_count, candidates.size), replace=False).tolist():
            _add_role(selection, positions, int(sample_index), "random")
    return selection


def select_fixed(indices: Sequence[int], dataset_size: int) -> list[dict[str, object]]:
    """Validate and de-duplicate fixed indices while preserving input order."""
    if dataset_size <= 0:
        raise ValueError("dataset is empty")
    selection: list[dict[str, object]] = []
    positions: dict[int, int] = {}
    for sample_index in indices:
        value = int(sample_index)
        if value < 0 or value >= dataset_size:
            raise IndexError(f"sample index {value} is out of range (valid: 0-{dataset_size - 1})")
        _add_role(selection, positions, value, "fixed")
    if not selection:
        raise ValueError("at least one sample index is required")
    return selection


def sample_label(roles: Sequence[str], random_ordinal: int | None = None) -> str:
    if list(roles) == ["random"] and random_ordinal is not None:
        return f"随机窗口 {random_ordinal}"
    labels = []
    for role in roles:
        label = ROLE_LABELS.get(role, role)
        labels.append(label)
    return " / ".join(labels) + "窗口"
