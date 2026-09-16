const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync("crowd_ui/js/data-contract.js", "utf8"), context);
const Data = context.window.CrowdFieldData;

function shared() {
  return {
    dataset: "Madras",
    split: "test",
    model: { name: "CADRE" },
    units: { density: "people/m^2" },
    grid: { height: 1, width: 2, cell_size_m: 0.5, time_step_seconds: 0.4 },
    temporal: {
      observed_frames: 1,
      predicted_frames: 1,
      observed_offsets_frames: [0],
      future_offsets_frames: [1],
    },
  };
}

function density(observed, prediction, truth) {
  return { observed: [[observed]], prediction: [[prediction]], ground_truth: [[truth]] };
}

const legacy = {
  schema: "cadre-density/v1",
  ...shared(),
  sample_index: 7,
  scene_name: "Legacy sample",
  density: density([1, 2], [3, 4], [2, 2]),
};
const wrapped = Data.parseText(JSON.stringify(legacy));
assert.strictEqual(wrapped.schema, "cadre-density-collection/v1");
assert.strictEqual(wrapped.samples.length, 1);
assert.strictEqual(wrapped.samples[0].sample_index, 7);
assert.strictEqual(Object.prototype.toString.call(wrapped.samples[0].density.prediction[0]), "[object Float32Array]");
assert.deepStrictEqual(Array.from(wrapped.samples[0].density.prediction[0]), [3, 4]);

const collection = {
  schema: "cadre-density-collection/v1",
  ...shared(),
  selection: { metric: "density_physical_mae", scanned_windows: 8, random_seed: 1337 },
  samples: [
    { id: "test-000", sample_index: 0, roles: ["first", "best"], label: "起始 / 最佳窗口", metrics: { density_mae: 1, density_rmse: 1, density_max_absolute_error: 1 }, density: density([0, 1], [2, 3], [1, 2]) },
    { id: "test-005", sample_index: 5, roles: ["worst"], label: "最差窗口", metrics: { density_mae: 3.1, density_rmse: 3.101612, density_max_absolute_error: 3.2 }, density: density([1, 2], [4.2, 0], [1, 3]) },
  ],
};
const parsed = Data.parseText(JSON.stringify(collection));
assert.strictEqual(parsed.samples.length, 2);
const scales = Data.displayScales(parsed);
assert.strictEqual(scales.density, 5);
assert.strictEqual(scales.error, 4);
assert.strictEqual(Array.from(Data.timeline(parsed)).join("|"), "t0|t +01");
const difference = Data.frame(parsed, 1, 1, "difference");
assert(Math.abs(difference.values[0] - 3.2) < 1e-6);
assert.strictEqual(difference.values[1], -3);

const invalidUnits = { ...legacy, units: { density: "normalized" } };
assert.throws(() => Data.parseText(JSON.stringify(invalidUnits)), /people\/m\^2/);

const negativePrediction = { ...legacy, density: density([1, 1], [-0.25, 1], [0, 1]) };
const negativeParsed = Data.parseText(JSON.stringify(negativePrediction));
assert.strictEqual(negativeParsed.quality.negative_prediction_values, 1);
assert(Math.abs(negativeParsed.samples[0].density.prediction[0][0] + 0.25) < 1e-6, "raw negative predictions should be preserved");

const inconsistentMetrics = JSON.parse(JSON.stringify(collection));
inconsistentMetrics.samples[0].metrics.density_mae = 99;
assert.throws(() => Data.parseText(JSON.stringify(inconsistentMetrics)), /与密度数据不一致/);

console.log("collection and legacy data contracts pass");
