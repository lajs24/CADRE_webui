(function () {
  "use strict";

  var Data = window.CrowdFieldData;
  var Heatmap = window.CrowdFieldHeatmap;
  var $ = function (selector) { return document.querySelector(selector); };
  var $$ = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
  var SPLITS = { train: "训练集", val: "验证集", test: "测试集" };
  var ROLE_NAMES = { first: "起始", best: "最佳", worst: "最差", random: "随机", fixed: "固定" };
  var LARGE_FILE_BYTES = 50 * 1024 * 1024;
  var MAX_FILE_BYTES = 256 * 1024 * 1024;
  var state = {
    collection: null,
    activeSample: 0,
    fileName: "",
    selectedFile: null,
    frame: 4,
    mode: "prediction",
    playing: false,
    showDensity: true,
    showGrid: true,
    scales: { density: 4, error: 2 }
  };
  var canvas = $("#heatmap-canvas");
  var viewport = $("#viewport");
  var fileInput = $("#file-input");
  var heatmap = Heatmap.create(canvas);
  var matrixCache = new Map();
  var playTimer;
  var toastTimer;
  var loadWorker;

  function number(value, digits) {
    return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function fileSize(bytes) {
    if (bytes < 1024 * 1024) return number(bytes / 1024, 0) + " KiB";
    return number(bytes / (1024 * 1024), 1) + " MiB";
  }

  function collection() { return state.collection; }
  function sample() { return state.collection ? state.collection.samples[state.activeSample] : null; }
  function labels() { return state.collection ? Data.timeline(state.collection) : ["t −04", "t −03", "t −02", "t −01", "t0", "t +01", "t +02", "t +03", "t +04", "t +05"]; }
  function splitName(data) { return SPLITS[data.split] || data.split || "数据集"; }
  function roleText(roles) { return roles.map(function (role) { return ROLE_NAMES[role] || role; }).join(" / "); }

  function currentMatrix() {
    if (!state.collection) return null;
    var currentSample = sample();
    var key = [currentSample.id, state.mode, state.frame].join(":");
    if (matrixCache.has(key)) return matrixCache.get(key);
    var value = Data.frame(state.collection, state.activeSample, state.frame, state.mode);
    matrixCache.set(key, value);
    while (matrixCache.size > 40) matrixCache.delete(matrixCache.keys().next().value);
    return value;
  }

  function stopPlayback() {
    state.playing = false;
    window.clearInterval(playTimer);
    playTimer = null;
    $("#play-button").setAttribute("aria-pressed", "false");
    $("#play-button").setAttribute("aria-label", "播放帧");
    $("#play-icon").innerHTML = '<path d="m5 3.5 7 4.5-7 4.5v-9Z" fill="currentColor"/>';
  }

  function toast(message, error) {
    var node = $("#toast");
    node.textContent = message;
    node.style.borderColor = error ? "#8f5c50" : "";
    node.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { node.classList.remove("show"); }, 3800);
  }

  function dialogError(message) {
    var node = $("#import-error");
    node.textContent = message || "";
    node.hidden = !message;
  }

  function closeMenus(except) {
    [["dataset", "#dataset-menu", "#dataset-button"], ["layers", "#layers-menu", "#layers-button"]].forEach(function (item) {
      if (item[0] !== except) {
        $(item[1]).classList.remove("open");
        $(item[2]).setAttribute("aria-expanded", "false");
      }
    });
  }

  function renderAxes() {
    if (!state.collection) {
      $("#axis-y").replaceChildren();
      $("#axis-x").replaceChildren();
      return;
    }
    var grid = state.collection.grid;
    var size = Number(grid.cell_size_m);
    var width = grid.width * size;
    var height = grid.height * size;
    var yCount = Math.min(5, Math.max(3, Math.round(height / 1.5) + 1));
    var xCount = Math.min(7, Math.max(4, Math.round(width / 2) + 1));
    var y = Array.from({ length: yCount }, function (_, index) { return number(height - height * index / (yCount - 1), height % 1 ? 1 : 0); });
    var x = Array.from({ length: xCount }, function (_, index) { return number(width * index / (xCount - 1), width % 1 ? 1 : 0); });
    $("#axis-y").replaceChildren.apply($("#axis-y"), y.map(function (value) {
      var node = document.createElement("span"); node.textContent = value; return node;
    }));
    var axis = $("#axis-x");
    axis.style.gridTemplateColumns = "repeat(" + x.length + ", minmax(0, 1fr))";
    axis.replaceChildren.apply(axis, x.map(function (value) {
      var node = document.createElement("span"); node.textContent = value; return node;
    }));
  }

  function buildTicks() {
    var timeline = labels();
    var observed = state.collection ? state.collection.temporal.observed_frames : 5;
    var ticks = timeline.map(function (label, index) {
      var tick = document.createElement("button");
      tick.className = "tick" + (index >= observed ? " future" : "");
      tick.type = "button";
      tick.dataset.frame = String(index);
      tick.textContent = label;
      tick.disabled = !state.collection;
      tick.setAttribute("aria-label", (index < observed ? "观测帧 " : "预测帧 ") + label);
      return tick;
    });
    $("#ticks").style.gridTemplateColumns = "repeat(" + timeline.length + ", minmax(0, 1fr))";
    $("#ticks").replaceChildren.apply($("#ticks"), ticks);
    var boundary = observed / timeline.length * 100;
    $("#timeline").style.setProperty("--observed-boundary", boundary + "%");
  }

  function updateTickSelection() {
    $$("#ticks .tick").forEach(function (tick, index) { tick.setAttribute("aria-current", String(index === state.frame)); });
  }

  function updateTime() {
    var timeline = labels();
    var label = timeline[state.frame] || "t0";
    var observed = state.collection ? state.collection.temporal.observed_frames : 5;
    var historical = Boolean(state.collection && state.frame < observed);
    $("#current-time").textContent = label;
    $("#canvas-time").textContent = label;
    if (historical) $("#canvas-mode").textContent = "观测密度";
    else if (state.mode === "difference") $("#canvas-mode").textContent = "预测 − 真值";
    else $("#canvas-mode").textContent = state.mode === "ground" ? "真值密度" : "预测密度";
    var modeName = historical ? "观测" : state.mode === "difference" ? "误差" : state.mode === "ground" ? "真值" : "预测";
    $("#frame-readout").textContent = (state.collection ? modeName : "等待数据") + (state.collection ? " · " + label : "");
  }

  function updateLegend() {
    var difference = state.mode === "difference";
    var maximum = difference ? state.scales.error : state.scales.density;
    $("#legend-title").textContent = difference ? "密度误差 · 预测减真值" : "人群密度";
    $("#legend-gradient").classList.toggle("difference", difference);
    $("#legend-footnote").textContent = difference
      ? "集合统一误差色标为 ±" + number(maximum, 0) + " 人/平方米。"
      : "集合统一密度色标为 0–" + number(maximum, 0) + " 人/平方米。";
    var values = difference
      ? [-maximum, -maximum / 2, 0, maximum / 2, maximum].map(function (value) { return (value > 0 ? "+" : "") + number(value, value % 1 ? 1 : 0); })
      : [0, maximum / 4, maximum / 2, maximum * .75, maximum].map(function (value) { return number(value, value % 1 ? 1 : 0); });
    $("#legend-scale").replaceChildren.apply($("#legend-scale"), values.map(function (value) {
      var node = document.createElement("span"); node.textContent = value; return node;
    }));
  }

  function updateMetrics(current) {
    if (!state.collection || !current) {
      $("#metric-title").textContent = "当前帧统计";
      $("#metric-one-label").textContent = "估计人数";
      $("#metric-one").textContent = "—";
      $("#metric-one-unit").textContent = "人";
      $("#metric-two-label").textContent = "最高密度";
      $("#metric-two").textContent = "—";
      $("#metric-two-unit").textContent = "人/平方米";
      return;
    }
    var result = Data.summary(current, Number(state.collection.grid.cell_size_m), state.mode === "difference");
    if (state.mode === "difference") {
      $("#metric-title").textContent = "预测误差统计";
      $("#metric-one-label").textContent = "平均绝对误差";
      $("#metric-one").textContent = number(result.averageAbsoluteError, 2);
      $("#metric-one-unit").textContent = "人/平方米";
      $("#metric-two-label").textContent = "最大绝对误差";
      $("#metric-two").textContent = number(result.maximumAbsoluteError, 2);
      $("#metric-two-unit").textContent = "人/平方米";
    } else {
      $("#metric-title").textContent = "当前帧统计";
      $("#metric-one-label").textContent = "估计人数";
      $("#metric-one").textContent = number(result.estimatedPeople, 0);
      $("#metric-one-unit").textContent = "人";
      $("#metric-two-label").textContent = "平均 / 最高";
      $("#metric-two").textContent = number(result.mean, 2) + " / " + number(result.maximum, 2);
      $("#metric-two-unit").textContent = "人/平方米";
    }
  }

  function renderHeatmap(current) {
    var unavailable = !current;
    $("#compare-note").hidden = !unavailable;
    var currentSample = sample();
    heatmap.render({
      matrix: current,
      visible: state.showDensity && !unavailable,
      grid: state.showGrid,
      mode: state.mode,
      maximum: state.mode === "difference" ? state.scales.error : state.scales.density,
      width: state.collection ? state.collection.grid.width : 0,
      height: state.collection ? state.collection.grid.height : 0,
      cacheKey: currentSample ? [currentSample.id, state.mode, state.frame].join(":") : ""
    });
    canvas.setAttribute("aria-label", state.collection && current ? $("#canvas-mode").textContent + "，" + $("#canvas-time").textContent : "尚未加载密度数据");
  }

  function render() {
    updateTickSelection();
    updateTime();
    updateLegend();
    var current = currentMatrix();
    renderHeatmap(current);
    updateMetrics(current);
    $("#canvas-status").textContent = state.mode === "difference"
      ? "集合统一误差范围 ±" + number(state.scales.error, 0) + " 人/平方米"
      : "集合统一密度范围 0–" + number(state.scales.density, 0) + " 人/平方米";
  }

  function setMode(mode) {
    if (!state.collection) return;
    state.mode = mode;
    if (mode === "difference" && state.frame < state.collection.temporal.observed_frames) state.frame = state.collection.temporal.observed_frames;
    $$(".mode-tab").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.mode === mode)); });
    render();
  }

  function setFrame(index) {
    if (!state.collection) return;
    var minimum = state.mode === "difference" ? state.collection.temporal.observed_frames : 0;
    state.frame = Math.max(minimum, Math.min(labels().length - 1, index));
    render();
  }

  function togglePlayback() {
    if (!state.collection) return;
    if (state.playing) { stopPlayback(); return; }
    state.playing = true;
    $("#play-button").setAttribute("aria-pressed", "true");
    $("#play-button").setAttribute("aria-label", "暂停播放");
    $("#play-icon").innerHTML = '<path d="M4.5 3.5h2.8v9H4.5zm4.8 0h2.8v9H9.3z" fill="currentColor"/>';
    playTimer = window.setInterval(function () {
      var first = state.mode === "difference" ? state.collection.temporal.observed_frames : 0;
      var next = state.frame + 1;
      setFrame(next >= labels().length ? first : next);
    }, 700);
  }

  function sampleOptionText(item) {
    return item.label + " · #" + String(item.sample_index).padStart(3, "0");
  }

  function populateSampleSelect() {
    var select = $("#sample-select");
    var options = state.collection.samples.map(function (item, index) {
      var option = document.createElement("option");
      option.value = String(index);
      option.textContent = sampleOptionText(item);
      return option;
    });
    select.replaceChildren.apply(select, options);
    select.value = String(state.activeSample);
    select.disabled = options.length < 2;
    $("#sample-switch").hidden = options.length < 2;
  }

  function setMetadata() {
    var data = collection();
    var item = sample();
    var model = data.model || {};
    var grid = data.grid;
    var count = data.samples.length;
    $("#dataset-name").textContent = state.fileName;
    $("#dataset-state").textContent = "已加载 · " + splitName(data) + " · " + count + " 个窗口";
    $("#menu-file").textContent = state.fileName;
    $("#menu-meta").textContent = data.dataset + " / " + splitName(data) + " / " + count + " 个窗口 / " + (data.selection.metric || "密度数据");
    $("#stage-title").textContent = item.label + " · #" + String(item.sample_index).padStart(3, "0");
    $("#stage-subtitle").textContent = "CADRE · " + data.dataset + " · " + splitName(data);
    $("#scene-title").textContent = data.dataset + " · #" + String(item.sample_index).padStart(3, "0");
    $("#scene-subtitle").textContent = state.fileName;
    $("#sample-meta").hidden = false;
    $("#sample-role-value").textContent = roleText(item.roles);
    $("#sample-mae-value").textContent = item.metrics && Number.isFinite(Number(item.metrics.density_mae)) ? number(item.metrics.density_mae, 4) + " 人/平方米" : "—";
    $("#scene-status").classList.add("loaded");
    var negativeCount = data.quality ? Number(data.quality.negative_prediction_values) || 0 : 0;
    $("#scene-status").classList.toggle("warning", negativeCount > 0);
    $("#scene-status-text").textContent = negativeCount > 0 ? "含 " + negativeCount + " 个负预测值 · 绘图按 0 截断" : "集合已加载 · 本地 JSON";
    $("#load-state").textContent = (state.activeSample + 1) + " / " + count;
    $("#model-value").textContent = model.name || "CADRE";
    $("#checkpoint-value").textContent = model.checkpoint || "—";
    $("#epoch-value").textContent = model.epoch == null ? "—" : String(model.epoch);
    $("#prediction-kind").textContent = model.debiased ? "去偏预测" : "直接预测";
    $("#grid-value").textContent = grid.width + " × " + grid.height + " · " + number(grid.cell_size_m, 2) + " m";
    $("#dt-value").textContent = number(grid.time_step_seconds, 2) + " s";
    $("#top-frame-summary").textContent = "观测 " + data.temporal.observed_frames + " 帧 / 预测 " + data.temporal.predicted_frames + " 帧";
  }

  function setSample(index) {
    if (!state.collection || index < 0 || index >= state.collection.samples.length) return;
    stopPlayback();
    state.activeSample = index;
    state.frame = state.collection.temporal.observed_frames;
    $("#sample-select").value = String(index);
    setMetadata();
    render();
  }

  function setLoaded(data, name) {
    stopPlayback();
    matrixCache.clear();
    heatmap.clearCache();
    state.collection = data;
    state.activeSample = 0;
    state.fileName = name;
    state.frame = data.temporal.observed_frames;
    state.mode = "prediction";
    state.scales = data.display_scales || Data.displayScales(data);
    viewport.classList.remove("empty");
    $("#empty-state").hidden = true;
    $("#timeline").classList.remove("disabled");
    ["#play-button", "#step-back", "#step-forward", "#unload-button"].forEach(function (id) { $(id).disabled = false; });
    $$(".mode-tab").forEach(function (button) { button.disabled = false; button.setAttribute("aria-pressed", String(button.dataset.mode === "prediction")); });
    $("#inspector-empty").hidden = true;
    populateSampleSelect();
    setMetadata();
    renderAxes();
    buildTicks();
    render();
  }

  function unload() {
    stopPlayback();
    if (loadWorker) { loadWorker.terminate(); loadWorker = null; }
    matrixCache.clear();
    heatmap.clearCache();
    state.collection = null;
    state.activeSample = 0;
    state.fileName = "";
    state.selectedFile = null;
    fileInput.value = "";
    state.frame = 4;
    state.mode = "prediction";
    state.scales = { density: 4, error: 2 };
    viewport.classList.add("empty");
    $("#empty-state").hidden = false;
    $("#timeline").classList.add("disabled");
    ["#play-button", "#step-back", "#step-forward", "#unload-button"].forEach(function (id) { $(id).disabled = true; });
    $$(".mode-tab").forEach(function (button) { button.disabled = true; button.setAttribute("aria-pressed", String(button.dataset.mode === "prediction")); });
    $("#sample-switch").hidden = true;
    $("#sample-select").replaceChildren();
    $("#sample-meta").hidden = true;
    $("#dataset-name").textContent = "未加载数据";
    $("#dataset-state").textContent = "导入数据以开始查看";
    $("#menu-file").textContent = "尚未导入 JSON 数据";
    $("#menu-meta").textContent = "等待加载";
    $("#stage-title").textContent = "密度场概览";
    $("#stage-subtitle").textContent = "导入 CADRE 密度 JSON 后查看时空预测结果";
    $("#scene-title").textContent = "等待导入数据";
    $("#scene-subtitle").textContent = "导入 CADRE 生成的密度 JSON 文件";
    $("#scene-status").classList.remove("loaded");
    $("#scene-status").classList.remove("warning");
    $("#scene-status-text").textContent = "未加载数据";
    $("#load-state").textContent = "未加载";
    $("#top-frame-summary").textContent = "等待数据";
    ["#model-value", "#checkpoint-value", "#epoch-value", "#prediction-kind", "#grid-value", "#dt-value"].forEach(function (id) { $(id).textContent = "—"; });
    $("#inspector-empty").hidden = false;
    renderAxes();
    buildTicks();
    render();
  }

  function openImport() {
    closeMenus();
    state.selectedFile = null;
    fileInput.value = "";
    $("#selected-file").classList.remove("visible");
    $("#apply-import").disabled = true;
    $("#apply-import").textContent = "加载数据";
    dialogError("");
    $("#import-dialog").showModal();
  }

  function selectFile(file) {
    if (!file) return;
    state.selectedFile = file;
    $("#selected-filename").textContent = file.name;
    $("#selected-file-meta").textContent = fileSize(file.size) + (file.size > LARGE_FILE_BYTES ? " · 大文件将在后台解析" : " · 本地读取");
    $("#selected-file").classList.add("visible");
    $("#apply-import").disabled = file.size > MAX_FILE_BYTES;
    dialogError(file.size > MAX_FILE_BYTES ? "文件超过 256 MiB。请降低插值倍率或减少集合窗口数量。" : "");
  }

  function parseFile(file, status) {
    if (!window.Worker || !window.Blob || !window.URL) {
      status("正在解析和校验数据…");
      return file.text().then(function (text) { return Data.parseText(text); });
    }
    return new Promise(function (resolve, reject) {
      var url = window.URL.createObjectURL(new Blob([Data.workerSource()], { type: "text/javascript" }));
      loadWorker = new Worker(url);
      window.URL.revokeObjectURL(url);
      loadWorker.onmessage = function (event) {
        if (event.data.type === "status") status(event.data.message);
        if (event.data.type === "result") {
          var result = event.data.data;
          loadWorker.terminate();
          loadWorker = null;
          resolve(result);
        }
        if (event.data.type === "error") {
          loadWorker.terminate();
          loadWorker = null;
          reject(new Error(event.data.message));
        }
      };
      loadWorker.onerror = function () {
        loadWorker.terminate();
        loadWorker = null;
        reject(new Error("后台数据解析失败。"));
      };
      loadWorker.postMessage({ file: file });
    });
  }

  function loadSelectedFile() {
    if (!state.selectedFile) return;
    var file = state.selectedFile;
    var button = $("#apply-import");
    button.disabled = true;
    dialogError("");
    parseFile(file, function (message) { button.textContent = message; }).then(function (data) {
      button.textContent = "正在准备画布…";
      setLoaded(data, file.name);
      $("#import-dialog").close();
      toast("已加载 " + data.samples.length + " 个窗口");
    }).catch(function (error) {
      dialogError(error && error.message ? error.message : "无法读取此 JSON 文件。");
      button.disabled = false;
      button.textContent = "重试加载";
    });
  }

  function toggleMenu(name) {
    var menu = $(name === "dataset" ? "#dataset-menu" : "#layers-menu");
    var button = $(name === "dataset" ? "#dataset-button" : "#layers-button");
    var open = !menu.classList.contains("open");
    closeMenus(open ? name : undefined);
    menu.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
  }

  function tooltip(event) {
    var cell = heatmap.cellAt(event);
    if (!cell || !state.collection || !state.showDensity) return;
    var size = Number(state.collection.grid.cell_size_m);
    var rect = viewport.getBoundingClientRect();
    var node = $("#tooltip");
    node.textContent = "x " + number((cell.column + .5) * size, 1) + " m · y " + number((state.collection.grid.height - cell.row - .5) * size, 1) + " m · " + number(cell.value, 2) + " 人/平方米";
    node.style.left = Math.min(event.clientX - rect.left + 13, rect.width - 190) + "px";
    node.style.top = Math.min(event.clientY - rect.top + 13, rect.height - 48) + "px";
    node.classList.add("visible");
  }

  $("#import-button").addEventListener("click", openImport);
  $("#empty-import-button").addEventListener("click", openImport);
  $("#replace-button").addEventListener("click", openImport);
  $("#dataset-button").addEventListener("click", function () { toggleMenu("dataset"); });
  $("#layers-button").addEventListener("click", function () { toggleMenu("layers"); });
  $("#unload-button").addEventListener("click", function () { unload(); closeMenus(); toast("已卸载当前数据"); });
  $("#dialog-close").addEventListener("click", function () { $("#import-dialog").close(); });
  $("#cancel-import").addEventListener("click", function () { $("#import-dialog").close(); });
  $("#apply-import").addEventListener("click", loadSelectedFile);
  $("#dialog-dropzone").addEventListener("click", function () { fileInput.click(); });
  $("#dialog-dropzone").addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", function () { selectFile(fileInput.files[0]); });
  $("#sample-select").addEventListener("change", function (event) { setSample(Number(event.target.value)); });
  $$(".mode-tab").forEach(function (button) { button.addEventListener("click", function () { setMode(button.dataset.mode); }); });
  $("#ticks").addEventListener("click", function (event) {
    var tick = event.target.closest("[data-frame]"); if (tick) setFrame(Number(tick.dataset.frame));
  });
  $("#play-button").addEventListener("click", togglePlayback);
  $("#step-back").addEventListener("click", function () { setFrame(state.frame - 1); });
  $("#step-forward").addEventListener("click", function () { setFrame(state.frame + 1); });
  $("#density-toggle").addEventListener("change", function (event) { state.showDensity = event.target.checked; renderHeatmap(currentMatrix()); });
  $("#grid-toggle").addEventListener("change", function (event) {
    state.showGrid = event.target.checked;
    viewport.classList.toggle("hide-grid", !state.showGrid);
    renderHeatmap(currentMatrix());
  });
  canvas.addEventListener("pointermove", tooltip);
  canvas.addEventListener("pointerleave", function () { $("#tooltip").classList.remove("visible"); });
  ["dragenter", "dragover"].forEach(function (type) {
    $("#dialog-dropzone").addEventListener(type, function (event) { event.preventDefault(); $("#dialog-dropzone").classList.add("dragging"); });
    viewport.addEventListener(type, function (event) { event.preventDefault(); viewport.classList.add("dragging-file"); });
  });
  ["dragleave", "drop"].forEach(function (type) {
    $("#dialog-dropzone").addEventListener(type, function (event) { event.preventDefault(); $("#dialog-dropzone").classList.remove("dragging"); });
    viewport.addEventListener(type, function (event) { event.preventDefault(); viewport.classList.remove("dragging-file"); });
  });
  $("#dialog-dropzone").addEventListener("drop", function (event) { selectFile(event.dataTransfer.files[0]); });
  viewport.addEventListener("drop", function (event) {
    var file = event.dataTransfer.files[0]; if (file) { openImport(); selectFile(file); }
  });
  document.addEventListener("click", function (event) {
    if (!event.target.closest(".dataset-wrap") && !event.target.closest(".layers-wrap")) closeMenus();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeMenus();
    if (event.target.matches("input,textarea,select,[contenteditable=true]")) return;
    if (event.key === "ArrowLeft") setFrame(state.frame - 1);
    if (event.key === "ArrowRight") setFrame(state.frame + 1);
    if (event.key === " " && !$("#import-dialog").open && !event.target.closest("button,a,[role=button]")) { event.preventDefault(); togglePlayback(); }
  });

  buildTicks();
  render();
})();
