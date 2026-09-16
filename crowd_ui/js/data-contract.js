(function (global) {
  "use strict";

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function validateFrames(frames, count, height, width, label) {
    assert(Array.isArray(frames) && frames.length === count, label + "必须包含 " + count + " 帧。");
    frames.forEach(function (frame, frameIndex) {
      assert(Array.isArray(frame) && frame.length === height, label + "第 " + (frameIndex + 1) + " 帧的行数与网格不匹配。");
      frame.forEach(function (row) {
        assert(Array.isArray(row) && row.length === width && row.every(Number.isFinite), label + "中存在尺寸不匹配或非数值网格。");
      });
    });
  }

  function validate(payload) {
    assert(payload && payload.schema === "cadre-density/v1", "文件格式不受支持。请使用 generate_cadre_density.py 生成的 JSON。");
    var grid = payload.grid || {};
    var temporal = payload.temporal || {};
    var density = payload.density || {};
    var height = Number(grid.height), width = Number(grid.width);
    var observed = Number(temporal.observed_frames), future = Number(temporal.predicted_frames);
    assert(Number.isInteger(height) && height > 0 && Number.isInteger(width) && width > 0, "JSON 中没有有效的空间网格尺寸。");
    assert(Number.isInteger(observed) && observed > 0 && Number.isInteger(future) && future > 0, "JSON 中没有有效的时间帧数。");
    validateFrames(density.observed, observed, height, width, "观测密度");
    validateFrames(density.prediction, future, height, width, "预测密度");
    validateFrames(density.ground_truth, future, height, width, "真值密度");
    return payload;
  }

  function timeline(data) {
    var past = data.temporal.observed_frames;
    var future = data.temporal.predicted_frames;
    var labels = [];
    for (var index = -(past - 1); index <= 0; index += 1) labels.push(index === 0 ? "t0" : "t −" + String(Math.abs(index)).padStart(2, "0"));
    for (var step = 1; step <= future; step += 1) labels.push("t +" + String(step).padStart(2, "0"));
    return labels;
  }

  function frame(data, index, mode) {
    var observed = data.temporal.observed_frames;
    if (index < observed) return mode === "difference" ? null : data.density.observed[index];
    var futureIndex = index - observed;
    if (mode === "ground") return data.density.ground_truth[futureIndex];
    if (mode === "difference") return data.density.prediction[futureIndex].map(function (row, rowIndex) {
      return row.map(function (value, columnIndex) { return value - data.density.ground_truth[futureIndex][rowIndex][columnIndex]; });
    });
    return data.density.prediction[futureIndex];
  }

  function summary(matrix, cellSize, difference) {
    if (!matrix) return null;
    var count = 0, sum = 0, maximum = -Infinity, absoluteSum = 0, maximumAbsolute = 0;
    matrix.forEach(function (row) {
      row.forEach(function (value) {
        count += 1;
        if (difference) {
          var absoluteValue = Math.abs(value);
          absoluteSum += absoluteValue;
          maximumAbsolute = Math.max(maximumAbsolute, absoluteValue);
        } else {
          sum += value;
          maximum = Math.max(maximum, value);
        }
      });
    });
    if (difference) {
      return {
        averageAbsoluteError: absoluteSum / count,
        maximumAbsoluteError: maximumAbsolute
      };
    }
    return {
      estimatedPeople: sum * cellSize * cellSize,
      mean: sum / count,
      maximum: maximum
    };
  }

  function displayScales(data) {
    var densityMaximum = 0;
    [data.density.observed, data.density.prediction, data.density.ground_truth].forEach(function (frames) {
      frames.forEach(function (frame) { frame.forEach(function (row) { row.forEach(function (value) { densityMaximum = Math.max(densityMaximum, value); }); }); });
    });
    var errorMaximum = 0;
    data.density.prediction.forEach(function (frame, frameIndex) {
      frame.forEach(function (row, rowIndex) {
        row.forEach(function (value, columnIndex) { errorMaximum = Math.max(errorMaximum, Math.abs(value - data.density.ground_truth[frameIndex][rowIndex][columnIndex])); });
      });
    });
    return { density: Math.max(1, Math.ceil(densityMaximum)), error: Math.max(1, Math.ceil(errorMaximum)) };
  }

  global.CrowdFieldData = { validate: validate, timeline: timeline, frame: frame, summary: summary, displayScales: displayScales };
})(window);
