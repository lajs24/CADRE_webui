import unittest

import numpy as np

from cadre_density_core import compute_density_metrics, select_showcase


class DensityMetricsTests(unittest.TestCase):
    def test_metrics_are_reported_in_physical_density_units(self):
        prediction = np.array([[[1.0, 2.0], [3.0, 4.0]]], dtype=np.float32)
        ground_truth = np.array([[[0.0, 2.0], [5.0, 1.0]]], dtype=np.float32)

        metrics = compute_density_metrics(prediction, ground_truth)

        self.assertAlmostEqual(metrics["density_mae"], 1.5)
        self.assertAlmostEqual(metrics["density_rmse"], np.sqrt(3.5))
        self.assertAlmostEqual(metrics["density_max_absolute_error"], 3.0)


class ShowcaseSelectionTests(unittest.TestCase):
    def test_selects_first_best_worst_and_repeatable_unique_random_windows(self):
        errors = np.array([0.4, 0.1, 0.9, 0.5, 0.3, 0.2], dtype=np.float64)

        first = select_showcase(errors, random_count=2, seed=17)
        second = select_showcase(errors, random_count=2, seed=17)

        self.assertEqual(first, second)
        self.assertEqual(first[0], {"sample_index": 0, "roles": ["first"]})
        self.assertIn({"sample_index": 1, "roles": ["best"]}, first)
        self.assertIn({"sample_index": 2, "roles": ["worst"]}, first)
        self.assertEqual(len(first), 5)
        self.assertEqual(len({item["sample_index"] for item in first}), len(first))

    def test_merges_roles_when_one_window_has_multiple_meanings(self):
        selection = select_showcase(np.array([0.1, 0.8]), random_count=3, seed=1)

        self.assertEqual(selection, [
            {"sample_index": 0, "roles": ["first", "best"]},
            {"sample_index": 1, "roles": ["worst"]},
        ])

    def test_rejects_empty_metric_arrays(self):
        with self.assertRaisesRegex(ValueError, "empty"):
            select_showcase(np.array([], dtype=np.float64), random_count=3, seed=1)


if __name__ == "__main__":
    unittest.main()
