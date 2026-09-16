const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const fills = [];
const context2d = {
  clearRect() {},
  strokeRect() {},
  fillRect(x, y, width, height) { fills.push({ x, y, width, height }); },
};
const canvas = {
  width: 0,
  height: 0,
  hidden: false,
  getContext() { return context2d; },
};
const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync("crowd_ui/js/heatmap.js", "utf8"), context);

const height = 196;
const width = 308;
const matrix = Array.from({ length: height }, () => Array.from({ length: width }, () => 1));
context.window.CrowdFieldHeatmap.create(canvas).render({
  matrix,
  visible: true,
  grid: false,
  mode: "prediction",
  maximum: 2,
  width,
  height,
});

assert.strictEqual(fills.length, height * width);
assert(fills.every((fill) => [fill.x, fill.y, fill.width, fill.height].every(Number.isInteger)), "grid-off cells must align to whole bitmap pixels");
assert.strictEqual(fills[0].x, 0);
assert.strictEqual(fills[width - 1].x + fills[width - 1].width, canvas.width);
for (let row = 0; row < height; row += 1) {
  const rowFills = fills.slice(row * width, (row + 1) * width);
  assert.strictEqual(rowFills[0].x, 0);
  assert.strictEqual(rowFills[rowFills.length - 1].x + rowFills[rowFills.length - 1].width, canvas.width);
  for (let column = 1; column < rowFills.length; column += 1) {
    assert.strictEqual(rowFills[column - 1].x + rowFills[column - 1].width, rowFills[column].x, "adjacent cells must share an edge");
  }
}

console.log("seamless high-resolution heatmap rendering passes");
