(function (global) {
  "use strict";

  function createDataModule() {
    var MAX_DENSITY_VALUES = 15000000;
    var VALID_ROLES = { first: true, best: true, worst: true, random: true, fixed: true };

    function assert(condition, message) {
      if (!condition) throw new Error(message);
    }

    function finitePositive(value, label) {
      assert(Number.isFinite(Number(value)) && Number(value) > 0, label + "必须是有限正数。");
      return Number(value);
    }

    function validateShared(payload) {
      var grid = payload.grid || {};
      var temporal = payload.temporal || {};
      var height = Number(grid.height);
      var width = Number(grid.width);
      var observed = Number(temporal.observed_frames);
      var future = Number(temporal.predicted_frames);
      assert(payload.units && payload.units.density === "people/m^2", "密度单位必须是 people/m^2。");
      assert(Number.isInteger(height) && height > 0 && Number.isInteger(width) && width > 0, "JSON 中没有有效的空间网格尺寸。");
      assert(Number.isInteger(observed) && observed > 0 && Number.isInteger(future) && future > 0, "JSON 中没有有效的时间帧数。");
      grid.height = height;
      grid.width = width;
      grid.cell_size_m = finitePositive(grid.cell_size_m, "网格尺寸");
      grid.time_step_seconds = finitePositive(grid.time_step_seconds, "帧间隔");
      assert(Array.isArray(temporal.observed_offsets_frames) && temporal.observed_offsets_frames.length === observed, "观测帧偏移数量不匹配。");
      assert(Array.isArray(temporal.future_offsets_frames) && temporal.future_offsets_frames.length === future, "预测帧偏移数量不匹配。");
      temporal.observed_offsets_frames.forEach(function (value) { assert(Number.isFinite(Number(value)), "观测帧偏移必须是数值。"); });
      temporal.future_offsets_frames.forEach(function (value) { assert(Number.isFinite(Number(value)), "预测帧偏移必须是数值。"); });
      return { height: height, width: width, observed: observed, future: future };
    }

    function flattenFrames(frames, count, height, width, label, allowNegative) {
      assert(Array.isArray(frames) && frames.length === count, label + "必须包含 " + count + " 帧。");
      return frames.map(function (frame, frameIndex) {
        if (frame instanceof Float32Array) {
          assert(frame.length === height * width, label + "第 " + (frameIndex + 1) + " 帧的尺寸与网格不匹配。");
          return frame;
        }
        assert(Array.isArray(frame) && frame.length === height, label + "第 " + (frameIndex + 1) + " 帧的行数与网格不匹配。");
        var values = new Float32Array(height * width);
        var position = 0;
        frame.forEach(function (row) {
          assert(Array.isArray(row) && row.length === width, label + "中存在尺寸不匹配的网格。");
          row.forEach(function (value) {
            assert(Number.isFinite(value), label + "中存在非数值网格。");
            assert(allowNegative || value >= 0, label + "不能包含负密度。");
            values[position] = value;
            position += 1;
          });
        });
        return values;
      });
    }

    function normalizeDensity(density, shared) {
      density = density || {};
      var prediction = flattenFrames(density.prediction, shared.future, shared.height, shared.width, "预测密度", true);
      var negativePredictionValues = 0;
      prediction.forEach(function (values) {
        for (var index = 0; index < values.length; index += 1) if (values[index] < 0) negativePredictionValues += 1;
      });
      return {
        observed: flattenFrames(density.observed, shared.observed, shared.height, shared.width, "观测密度", false),
        prediction: prediction,
        ground_truth: flattenFrames(density.ground_truth, shared.future, shared.height, shared.width, "真值密度", false),
        negative_prediction_values: negativePredictionValues
      };
    }

    function validateMetrics(metrics, required) {
      var result = metrics || {};
      ["density_mae", "density_rmse", "density_max_absolute_error"].forEach(function (key) {
        if (required || result[key] != null) assert(Number.isFinite(Number(result[key])) && Number(result[key]) >= 0, "样本指标 " + key + " 无效。");
      });
      return result;
    }

    function normalizeLegacy(payload, shared) {
      var sampleIndex = Number(payload.sample_index);
      assert(Number.isInteger(sampleIndex) && sampleIndex >= 0, "单样本文件缺少有效的样本索引。");
      var normalized = {
        schema: "cadre-density-collection/v1",
        source_schema: payload.schema,
        generated_at: payload.generated_at,
        generator: payload.generator || null,
        dataset: payload.dataset,
        split: payload.split,
        model: payload.model || {},
        provenance: payload.provenance || {},
        normalization: payload.normalization || {},
        units: payload.units,
        grid: payload.grid,
        temporal: payload.temporal,
        selection: { mode: "single", metric: "density_physical_mae", scanned_windows: 0, random_seed: null },
        samples: [{
          id: String(payload.split || "sample") + "-" + String(sampleIndex).padStart(3, "0"),
          sample_index: sampleIndex,
          roles: ["fixed"],
          label: "固定窗口",
          metrics: validateMetrics(payload.metrics, false),
          density: normalizeDensity(payload.density, shared)
        }]
      };
      normalized.quality = { negative_prediction_values: normalized.samples[0].density.negative_prediction_values };
      return normalized;
    }

    function normalizeCollection(payload, shared) {
      assert(payload.selection && payload.selection.metric === "density_physical_mae", "集合文件缺少 density_physical_mae 筛选信息。");
      assert(Number.isInteger(Number(payload.selection.scanned_windows)) && Number(payload.selection.scanned_windows) >= 0, "集合扫描窗口数量无效。");
      assert(Array.isArray(payload.samples) && payload.samples.length > 0, "集合文件至少需要一个样本。");
      var ids = {};
      var samples = payload.samples.map(function (sample) {
        assert(sample && typeof sample.id === "string" && sample.id, "集合样本缺少 ID。");
        assert(!ids[sample.id], "集合样本 ID 不能重复：" + sample.id);
        ids[sample.id] = true;
        var sampleIndex = Number(sample.sample_index);
        assert(Number.isInteger(sampleIndex) && sampleIndex >= 0, "集合样本索引无效。");
        assert(Array.isArray(sample.roles) && sample.roles.length > 0, "集合样本必须至少包含一个角色。");
        sample.roles.forEach(function (role) { assert(VALID_ROLES[role], "集合样本包含未知角色：" + role); });
        assert(typeof sample.label === "string" && sample.label, "集合样本缺少显示名称。");
        return {
          id: sample.id,
          sample_index: sampleIndex,
          roles: sample.roles.slice(),
          label: sample.label,
          metrics: validateMetrics(sample.metrics, true),
          density: normalizeDensity(sample.density, shared)
        };
      });
      payload.samples = samples;
      payload.quality = {
        negative_prediction_values: samples.reduce(function (total, sample) { return total + sample.density.negative_prediction_values; }, 0)
      };
      return payload;
    }

    function normalize(payload) {
      assert(payload && (payload.schema === "cadre-density/v1" || payload.schema === "cadre-density-collection/v1"), "文件格式不受支持。请使用 generate_cadre_density.py 生成的 JSON。");
      var shared = validateShared(payload);
      var sampleCount = payload.schema === "cadre-density/v1" ? 1 : Array.isArray(payload.samples) ? payload.samples.length : 0;
      var totalValues = sampleCount * (shared.observed + shared.future * 2) * shared.height * shared.width;
      assert(totalValues <= MAX_DENSITY_VALUES, "数据包含超过 1,500 万个密度值，请降低插值倍率或减少窗口数量。");
      return payload.schema === "cadre-density/v1" ? normalizeLegacy(payload, shared) : normalizeCollection(payload, shared);
    }

    function parseText(text) {
      return normalize(JSON.parse(text));
    }

    function timeline(collection) {
      var offsets = collection.temporal.observed_offsets_frames.concat(collection.temporal.future_offsets_frames);
      return offsets.map(function (offset) {
        if (offset === 0) return "t0";
        return "t " + (offset < 0 ? "−" : "+") + String(Math.abs(offset)).padStart(2, "0");
      });
    }

    function frame(collection, sampleIndex, frameIndex, mode) {
      var sample = collection.samples[sampleIndex];
      if (!sample) return null;
      var observed = collection.temporal.observed_frames;
      var width = collection.grid.width;
      var height = collection.grid.height;
      if (frameIndex < observed) {
        return mode === "difference" ? null : { values: sample.density.observed[frameIndex], width: width, height: height };
      }
      var futureIndex = frameIndex - observed;
      if (mode === "ground") return { values: sample.density.ground_truth[futureIndex], width: width, height: height };
      if (mode === "difference") {
        var prediction = sample.density.prediction[futureIndex];
        var truth = sample.density.ground_truth[futureIndex];
        if (!prediction || !truth) return null;
        var values = new Float32Array(prediction.length);
        for (var index = 0; index < prediction.length; index += 1) values[index] = prediction[index] - truth[index];
        return { values: values, width: width, height: height };
      }
      return { values: sample.density.prediction[futureIndex], width: width, height: height };
    }

    function valuesOf(matrix) {
      if (matrix && matrix.values && typeof matrix.values !== "function") return matrix.values;
      var flattened = [];
      (matrix || []).forEach(function (row) { row.forEach(function (value) { flattened.push(value); }); });
      return flattened;
    }

    function summary(matrix, cellSize, difference) {
      if (!matrix) return null;
      var values = valuesOf(matrix);
      var count = values.length;
      var sum = 0;
      var maximum = -Infinity;
      var absoluteSum = 0;
      var maximumAbsolute = 0;
      for (var index = 0; index < count; index += 1) {
        var value = values[index];
        if (difference) {
          var absoluteValue = Math.abs(value);
          absoluteSum += absoluteValue;
          maximumAbsolute = Math.max(maximumAbsolute, absoluteValue);
        } else {
          sum += value;
          maximum = Math.max(maximum, value);
        }
      }
      if (difference) return { averageAbsoluteError: absoluteSum / count, maximumAbsoluteError: maximumAbsolute };
      return { estimatedPeople: sum * cellSize * cellSize, mean: sum / count, maximum: maximum };
    }

    function displayScales(collection) {
      var densityMaximum = 0;
      var errorMaximum = 0;
      collection.samples.forEach(function (sample) {
        [sample.density.observed, sample.density.prediction, sample.density.ground_truth].forEach(function (frames) {
          frames.forEach(function (values) {
            for (var index = 0; index < values.length; index += 1) densityMaximum = Math.max(densityMaximum, values[index]);
          });
        });
        sample.density.prediction.forEach(function (prediction, frameIndex) {
          var truth = sample.density.ground_truth[frameIndex];
          for (var index = 0; index < prediction.length; index += 1) errorMaximum = Math.max(errorMaximum, Math.abs(prediction[index] - truth[index]));
        });
      });
      return { density: Math.max(1, Math.ceil(densityMaximum)), error: Math.max(1, Math.ceil(errorMaximum)) };
    }

    function transferableBuffers(collection) {
      var buffers = [];
      collection.samples.forEach(function (sample) {
        [sample.density.observed, sample.density.prediction, sample.density.ground_truth].forEach(function (frames) {
          frames.forEach(function (values) { buffers.push(values.buffer); });
        });
      });
      return buffers;
    }

    function workerSource() {
      return '"use strict";var Data=(' + createDataModule.toString() + ')();self.onmessage=function(event){self.postMessage({type:"status",message:"正在读取数据…"});var source=event.data.file?event.data.file.text():Promise.resolve(event.data.text);source.then(function(text){self.postMessage({type:"status",message:"正在解析和校验数据…"});var data=Data.parseText(text);self.postMessage({type:"result",data:data},Data.transferableBuffers(data));}).catch(function(error){self.postMessage({type:"error",message:error&&error.message?error.message:"无法解析数据文件。"});});};';
    }

    return {
      validate: normalize,
      parseText: parseText,
      timeline: timeline,
      frame: frame,
      summary: summary,
      displayScales: displayScales,
      transferableBuffers: transferableBuffers,
      workerSource: workerSource
    };
  }

  global.CrowdFieldData = createDataModule();
})(window);
