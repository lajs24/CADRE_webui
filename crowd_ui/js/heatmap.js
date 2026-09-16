(function (global) {
  "use strict";

  // Low-resolution fields benefit from generous cells.  For interpolated fields,
  // keep the backing bitmap bounded while retaining every source-grid value.
  var MAX_CELL_PIXELS = 32;
  var MAX_CANVAS_SIDE = 2048;

  function densityColor(value) {
    var stops = [[0, [244, 247, 243]], [.18, [218, 233, 219]], [.42, [157, 191, 159]], [.65, [83, 137, 99]], [.83, [213, 154, 69]], [1, [200, 106, 63]]];
    var position = Math.max(0, Math.min(1, value));
    for (var index = 1; index < stops.length; index += 1) {
      if (position <= stops[index][0]) {
        var before = stops[index - 1], after = stops[index], mix = (position - before[0]) / (after[0] - before[0]);
        return "rgb(" + before[1].map(function (channel, channelIndex) { return Math.round(channel + (after[1][channelIndex] - channel) * mix); }).join(",") + ")";
      }
    }
    return "rgb(200,106,63)";
  }

  function errorColor(value, maximum) {
    var zero = [241, 243, 242], endpoint = value < 0 ? [75, 135, 177] : [199, 99, 62], amount = Math.min(1, Math.abs(value) / maximum);
    return "rgb(" + zero.map(function (channel, index) { return Math.round(channel + (endpoint[index] - channel) * amount); }).join(",") + ")";
  }

  function create(canvas) {
    var context = canvas.getContext("2d", { alpha: true });
    var latest = null;

    function render(options) {
      latest = options;
      if (!options.matrix || !options.visible) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.hidden = true;
        return;
      }
      canvas.hidden = false;
      var largestDimension = Math.max(options.width, options.height);
      var cellPixels = Math.min(MAX_CELL_PIXELS, MAX_CANVAS_SIDE / largestDimension);
      canvas.width = Math.max(1, Math.round(options.width * cellPixels));
      canvas.height = Math.max(1, Math.round(options.height * cellPixels));
      var cellWidth = canvas.width / options.width, cellHeight = canvas.height / options.height;
      var drawCellGrid = options.grid && Math.min(cellWidth, cellHeight) >= 3;
      context.clearRect(0, 0, canvas.width, canvas.height);
      for (var row = 0; row < options.height; row += 1) for (var column = 0; column < options.width; column += 1) {
        var value = options.matrix[row][column], inset = drawCellGrid ? Math.min(1, cellWidth / 5, cellHeight / 5) : 0;
        var left = drawCellGrid ? column * cellWidth + inset : Math.round(column * cellWidth);
        var top = drawCellGrid ? row * cellHeight + inset : Math.round(row * cellHeight);
        var right = drawCellGrid ? (column + 1) * cellWidth - inset : Math.round((column + 1) * cellWidth);
        var bottom = drawCellGrid ? (row + 1) * cellHeight - inset : Math.round((row + 1) * cellHeight);
        context.fillStyle = options.mode === "difference" ? errorColor(value, options.maximum) : densityColor(value / options.maximum);
        context.fillRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
        if (drawCellGrid) {
          context.strokeStyle = "rgba(255,255,255,.72)";
          context.strokeRect(column * cellWidth + .5, row * cellHeight + .5, cellWidth - 1, cellHeight - 1);
        }
      }
    }

    function cellAt(event) {
      if (!latest || !latest.matrix) return null;
      var rect = canvas.getBoundingClientRect();
      var column = Math.min(latest.width - 1, Math.floor((event.clientX - rect.left) / rect.width * latest.width));
      var row = Math.min(latest.height - 1, Math.floor((event.clientY - rect.top) / rect.height * latest.height));
      return { row: row, column: column, value: latest.matrix[row][column] };
    }

    return { render: render, cellAt: cellAt };
  }

  global.CrowdFieldHeatmap = { create: create };
})(window);
