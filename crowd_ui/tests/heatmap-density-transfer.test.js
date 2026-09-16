const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

let lastImage = null;
const context2d = {
  clearRect() {},
  strokeRect() {},
  createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) }; },
  putImageData(image) { lastImage = image; },
};
const canvas = {
  width: 0,
  height: 0,
  hidden: false,
  getContext() { return context2d; },
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; },
};
const context = { window: {}, Uint8ClampedArray, Uint32Array, Array, Number, Math, Map };
vm.createContext(context);
vm.runInContext(fs.readFileSync("crowd_ui/js/heatmap.js", "utf8"), context);

const values = new Float32Array([0, .001, .02, .1, .6, 2]);
const heatmap = context.window.CrowdFieldHeatmap.create(canvas);
heatmap.render({
  matrix: { values },
  visible: true,
  grid: false,
  mode: "prediction",
  maximum: 2,
  width: 6,
  height: 1,
  cacheKey: "density-transfer"
});

function colorAt(index) {
  const start = index * 32 * 4;
  return Array.from(lastImage.data.slice(start, start + 3));
}

const background = [239, 247, 245];
assert.deepStrictEqual(colorAt(0), background, "zero density must use the canvas background");
assert.notDeepStrictEqual(colorAt(1), background, "positive density must remain encoded");
assert.notDeepStrictEqual(colorAt(2), background, "small positive density must remain encoded");
assert.notDeepStrictEqual(colorAt(3), background, "low density must remain visible");
assert.notDeepStrictEqual(colorAt(4), colorAt(3), "mid density must differ from low density");
assert.deepStrictEqual(colorAt(5), [102, 85, 142], "the maximum must use the blue-violet peak color");
assert(colorAt(5)[2] > colorAt(5)[0], "the density palette should end on the blue-violet side");

console.log("density visual transfer passes");
