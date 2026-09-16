(function (global) {
  "use strict";

  var MAX_CELL_PIXELS = 32;
  var MAX_CANVAS_SIDE = 2048;
  var CACHE_LIMIT = 12;
  var DENSITY_STOPS = [[0, [244, 247, 243]], [.18, [218, 233, 219]], [.42, [157, 191, 159]], [.65, [83, 137, 99]], [.83, [213, 154, 69]], [1, [200, 106, 63]]];

  function interpolate(stops, position) {
    var value = Math.max(0, Math.min(1, position));
    for (var index = 1; index < stops.length; index += 1) {
      if (value <= stops[index][0]) {
        var before = stops[index - 1];
        var after = stops[index];
        var mix = (value - before[0]) / (after[0] - before[0]);
        return before[1].map(function (channel, channelIndex) {
          return Math.round(channel + (after[1][channelIndex] - channel) * mix);
        });
      }
    }
    return stops[stops.length - 1][1];
  }

  function densityPalette(size) {
    return Array.from({ length: size }, function (_, index) { return interpolate(DENSITY_STOPS, index / (size - 1)); });
  }

  function errorPalette(size) {
    var zero = [241, 243, 242];
    return Array.from({ length: size }, function (_, index) {
      var normalized = index / (size - 1) * 2 - 1;
      var endpoint = normalized < 0 ? [75, 135, 177] : [199, 99, 62];
      var amount = Math.abs(normalized);
      return zero.map(function (channel, channelIndex) { return Math.round(channel + (endpoint[channelIndex] - channel) * amount); });
    });
  }

  function create(canvas) {
    var context = canvas.getContext("2d", { alpha: true });
    var latest = null;
    var cache = new Map();
    var densityColors = densityPalette(512);
    var differenceColors = errorPalette(1025);

    function remember(key, image) {
      if (!key) return;
      if (cache.has(key)) cache.delete(key);
      cache.set(key, image);
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    }

    function dimensions(width, height) {
      var largestDimension = Math.max(width, height);
      var cellPixels = Math.min(MAX_CELL_PIXELS, MAX_CANVAS_SIDE / largestDimension);
      return {
        width: Math.max(1, Math.round(width * cellPixels)),
        height: Math.max(1, Math.round(height * cellPixels))
      };
    }

    function createBitmap(options, bitmapWidth, bitmapHeight) {
      var image = context.createImageData(bitmapWidth, bitmapHeight);
      var pixels = image.data;
      var values = options.matrix.values;
      var sourceWidth = options.width;
      var sourceHeight = options.height;
      var palette = options.mode === "difference" ? differenceColors : densityColors;
      var paletteLast = palette.length - 1;
      var safeMaximum = Math.max(Number(options.maximum) || 0, 1e-12);
      var xSource = new Uint32Array(bitmapWidth);
      for (var x = 0; x < bitmapWidth; x += 1) xSource[x] = Math.min(sourceWidth - 1, Math.floor(x / bitmapWidth * sourceWidth));
      var pixelIndex = 0;
      for (var y = 0; y < bitmapHeight; y += 1) {
        var sourceRow = Math.min(sourceHeight - 1, Math.floor(y / bitmapHeight * sourceHeight));
        var rowOffset = sourceRow * sourceWidth;
        for (x = 0; x < bitmapWidth; x += 1) {
          var value = values[rowOffset + xSource[x]];
          var normalized = options.mode === "difference" ? (value / safeMaximum + 1) / 2 : Math.max(0, value) / safeMaximum;
          var color = palette[Math.max(0, Math.min(paletteLast, Math.round(normalized * paletteLast)))];
          pixels[pixelIndex] = color[0];
          pixels[pixelIndex + 1] = color[1];
          pixels[pixelIndex + 2] = color[2];
          pixels[pixelIndex + 3] = 255;
          pixelIndex += 4;
        }
      }
      return image;
    }

    function render(options) {
      latest = options;
      if (!options.matrix || !options.visible) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        canvas.hidden = true;
        return;
      }
      canvas.hidden = false;
      var target = dimensions(options.width, options.height);
      if (canvas.width !== target.width) canvas.width = target.width;
      if (canvas.height !== target.height) canvas.height = target.height;
      var cellWidth = canvas.width / options.width;
      var cellHeight = canvas.height / options.height;
      var drawCellGrid = options.grid && Math.min(cellWidth, cellHeight) >= 3;
      var cacheKey = options.cacheKey ? [options.cacheKey, canvas.width, canvas.height, options.mode, options.maximum].join(":") : "";
      var image = cache.get(cacheKey);
      if (!image) {
        image = createBitmap(options, canvas.width, canvas.height);
        remember(cacheKey, image);
      }
      context.putImageData(image, 0, 0);
      if (drawCellGrid) {
        context.strokeStyle = "rgba(255,255,255,.72)";
        for (var row = 0; row < options.height; row += 1) {
          for (var column = 0; column < options.width; column += 1) {
            context.strokeRect(column * cellWidth + .5, row * cellHeight + .5, Math.max(0, cellWidth - 1), Math.max(0, cellHeight - 1));
          }
        }
      }
    }

    function cellAt(event) {
      if (!latest || !latest.matrix) return null;
      var rect = canvas.getBoundingClientRect();
      var column = Math.min(latest.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * latest.width)));
      var row = Math.min(latest.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * latest.height)));
      return { row: row, column: column, value: latest.matrix.values[row * latest.width + column] };
    }

    function clearCache() {
      cache.clear();
      latest = null;
    }

    return { render: render, cellAt: cellAt, clearCache: clearCache };
  }

  global.CrowdFieldHeatmap = { create: create };
})(window);
