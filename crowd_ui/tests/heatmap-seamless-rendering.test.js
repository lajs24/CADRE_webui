const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

let putCount = 0;
let fillCount = 0;
const context2d = {
  clearRect() {},
  strokeRect() {},
  fillRect() { fillCount += 1; },
  createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
  putImageData(image, x, y) {
    putCount += 1;
    assert.strictEqual(x, 0);
    assert.strictEqual(y, 0);
    assert(image.data.some((value) => value !== 0), "heatmap bitmap should contain rendered pixels");
  },
};
const canvas = { width: 0, height: 0, hidden: false, getContext() { return context2d; } };
const context = { window: {}, Uint8ClampedArray };
vm.createContext(context);
vm.runInContext(fs.readFileSync("crowd_ui/js/heatmap.js", "utf8"), context);

const height = 196;
const width = 308;
const field = { values: new Float32Array(height * width).fill(1), width, height };
const heatmap = context.window.CrowdFieldHeatmap.create(canvas);
const options = { matrix: field, visible: true, grid: false, mode: "prediction", maximum: 2, width, height, cacheKey: "sample:prediction:0" };
heatmap.render(options);

assert.strictEqual(putCount, 1, "a frame should be committed with one bitmap operation");
assert.strictEqual(fillCount, 0, "grid-off rendering should not issue one fill call per source cell");
assert(canvas.width <= 2048 && canvas.height <= 2048, "backing bitmap must remain bounded");

heatmap.render(options);
assert.strictEqual(putCount, 2, "cached frames should remain renderable without rebuilding source data");

console.log("bitmap heatmap rendering passes");
