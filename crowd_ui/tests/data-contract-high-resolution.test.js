const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync("crowd_ui/js/data-contract.js", "utf8"), context);

const height = 672;
const width = 1056;
const matrix = Array.from({ length: height }, (_, row) =>
  Array.from({ length: width }, (_, column) => (row + column) % 23 / 10)
);

assert.doesNotThrow(() => {
  const result = context.window.CrowdFieldData.summary(matrix, 0.5 / 48, false);
  assert.strictEqual(result.maximum, 2.2);
});

console.log("high-resolution summary passes");
