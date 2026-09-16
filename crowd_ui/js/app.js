(function () {
  "use strict";

  var Data = window.CrowdFieldData;
  var Heatmap = window.CrowdFieldHeatmap;
  var $ = function (selector) { return document.querySelector(selector); };
  var $$ = function (selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); };
  var SPLITS = { train: "训练集", val: "验证集", test: "测试集" };
  var state = { data: null, fileName: "", selectedFile: null, frame: 7, mode: "prediction", playing: false, showDensity: true, showGrid: true, scales: { density: 4, error: 2 } };
  var canvas = $("#heatmap-canvas"), viewport = $("#viewport"), fileInput = $("#file-input"), heatmap = Heatmap.create(canvas);
  var playTimer, toastTimer;

  function number(value, digits) { return Number(value).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
  function labels() { return state.data ? Data.timeline(state.data) : ["t −04", "t −03", "t −02", "t −01", "t0", "t +01", "t +02", "t +03", "t +04", "t +05"]; }
  function matrix() { return state.data ? Data.frame(state.data, state.frame, state.mode) : null; }
  function splitName(data) { return SPLITS[data.split] || data.split || "数据集"; }
  function stopPlayback() {
    state.playing = false; window.clearInterval(playTimer); playTimer = null;
    $("#play-button").setAttribute("aria-pressed", "false"); $("#play-button").setAttribute("aria-label", "播放帧");
    $("#play-icon").innerHTML = '<path d="m5 3.5 7 4.5-7 4.5v-9Z" fill="currentColor"/>';
  }
  function toast(message, error) {
    var node = $("#toast"); node.textContent = message; node.style.borderColor = error ? "#8f5c50" : ""; node.classList.add("show");
    window.clearTimeout(toastTimer); toastTimer = window.setTimeout(function () { node.classList.remove("show"); }, 3800);
  }
  function dialogError(message) { var node = $("#import-error"); node.textContent = message || ""; node.hidden = !message; }
  function closeMenus(except) {
    [["dataset", "#dataset-menu", "#dataset-button"], ["layers", "#layers-menu", "#layers-button"]].forEach(function (item) {
      if (item[0] !== except) { $(item[1]).classList.remove("open"); $(item[2]).setAttribute("aria-expanded", "false"); }
    });
  }
  function renderAxes() {
    if (!state.data) { $("#axis-y").replaceChildren(); $("#axis-x").replaceChildren(); return; }
    var grid = state.data.grid, size = Number(grid.cell_size_m) || 1, width = grid.width * size, height = grid.height * size;
    var yCount = Math.min(5, Math.max(3, Math.round(height / 1.5) + 1)), xCount = Math.min(7, Math.max(4, Math.round(width / 2) + 1));
    var y = Array.from({ length: yCount }, function (_, index) { return number(height - height * index / (yCount - 1), height % 1 ? 1 : 0); });
    var x = Array.from({ length: xCount }, function (_, index) { return number(width * index / (xCount - 1), width % 1 ? 1 : 0); });
    $("#axis-y").replaceChildren.apply($("#axis-y"), y.map(function (value) { var node = document.createElement("span"); node.textContent = value; return node; }));
    var axis = $("#axis-x"); axis.style.gridTemplateColumns = "repeat(" + x.length + ", minmax(0, 1fr))";
    axis.replaceChildren.apply(axis, x.map(function (value) { var node = document.createElement("span"); node.textContent = value; return node; }));
  }
  function renderTicks() {
    var timeline = labels();
    $("#ticks").replaceChildren.apply($("#ticks"), timeline.map(function (label, index) {
      var tick = document.createElement("button"); tick.className = "tick" + (state.data && index >= state.data.temporal.observed_frames ? " future" : index > 4 ? " future" : "");
      tick.type = "button"; tick.dataset.frame = String(index); tick.textContent = label; tick.disabled = !state.data; tick.setAttribute("aria-current", String(index === state.frame));
      tick.setAttribute("aria-label", (state.data && index < state.data.temporal.observed_frames ? "观测帧 " : "预测帧 ") + label); return tick;
    }));
  }
  function updateTime() {
    var timeline = labels(), label = timeline[state.frame] || "t0", observed = state.data ? state.data.temporal.observed_frames : 5;
    $("#current-time").textContent = label; $("#canvas-time").textContent = label;
    $("#canvas-mode").textContent = state.mode === "difference" ? "预测 − 真值" : state.mode === "ground" ? "真值密度" : "预测密度";
    $("#frame-readout").textContent = (state.data ? (state.mode === "difference" ? "误差" : state.mode === "ground" ? "真值" : state.frame < observed ? "观测" : "预测") : "等待数据") + " · " + label;
  }
  function updateLegend() {
    var difference = state.mode === "difference";
    var maximum = difference ? state.scales.error : state.scales.density;
    $("#legend-title").textContent = difference ? "密度误差 · 预测减真值" : "人群密度";
    $("#legend-gradient").classList.toggle("difference", difference);
    $("#legend-footnote").textContent = difference ? "蓝色表示低估，橙色表示高估；本样本误差范围为 ±" + number(maximum, 0) + " 人/平方米。" : "本样本全时段密度范围为 0–" + number(maximum, 0) + " 人/平方米。";
    var values = difference ? [-maximum, -maximum / 2, 0, maximum / 2, maximum].map(function (value) { return (value > 0 ? "+" : "") + number(value, value % 1 ? 1 : 0); }) : [0, maximum / 4, maximum / 2, maximum * .75, maximum].map(function (value) { return number(value, value % 1 ? 1 : 0); });
    $("#legend-scale").replaceChildren.apply($("#legend-scale"), values.map(function (value) { var node = document.createElement("span"); node.textContent = value; return node; }));
  }
  function updateMetrics() {
    var current = matrix();
    if (!state.data || !current) {
      $("#metric-title").textContent = "当前帧统计"; $("#metric-one-label").textContent = "估计人数"; $("#metric-one").textContent = "—"; $("#metric-one-unit").textContent = "人";
      $("#metric-two-label").textContent = "最高密度"; $("#metric-two").textContent = "—"; $("#metric-two-unit").textContent = "人/平方米"; return;
    }
    var summary = Data.summary(current, Number(state.data.grid.cell_size_m) || 1, state.mode === "difference");
    if (state.mode === "difference") {
      $("#metric-title").textContent = "预测误差统计"; $("#metric-one-label").textContent = "平均绝对误差"; $("#metric-one").textContent = number(summary.averageAbsoluteError, 2); $("#metric-one-unit").textContent = "人/平方米";
      $("#metric-two-label").textContent = "最大绝对误差"; $("#metric-two").textContent = number(summary.maximumAbsoluteError, 2); $("#metric-two-unit").textContent = "人/平方米";
    } else {
      $("#metric-title").textContent = "当前帧统计"; $("#metric-one-label").textContent = "估计人数"; $("#metric-one").textContent = number(summary.estimatedPeople, 0); $("#metric-one-unit").textContent = "人";
      $("#metric-two-label").textContent = "平均 / 最高"; $("#metric-two").textContent = number(summary.mean, 2) + " / " + number(summary.maximum, 2); $("#metric-two-unit").textContent = "人/平方米";
    }
  }
  function renderHeatmap() {
    var current = matrix(), unavailable = !current;
    $("#compare-note").hidden = !unavailable;
    heatmap.render({ matrix: current, visible: state.showDensity && !unavailable, grid: state.showGrid, mode: state.mode, maximum: state.mode === "difference" ? state.scales.error : state.scales.density, width: state.data ? state.data.grid.width : 0, height: state.data ? state.data.grid.height : 0 });
    canvas.setAttribute("aria-label", state.data && current ? $("#canvas-mode").textContent + "，" + $("#canvas-time").textContent : "尚未加载密度数据");
  }
  function render() {
    renderTicks(); updateTime(); updateLegend(); renderHeatmap(); updateMetrics();
    $("#canvas-status").textContent = state.mode === "difference" ? "本样本误差范围 ±" + number(state.scales.error, 0) + " 人/平方米" : "本样本密度范围 0–" + number(state.scales.density, 0) + " 人/平方米";
  }
  function setMode(mode) { state.mode = mode; $$(".mode-tab").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.mode === mode)); }); render(); }
  function setFrame(index) { if (!state.data) return; state.frame = Math.max(0, Math.min(labels().length - 1, index)); render(); }
  function togglePlayback() {
    if (!state.data) return;
    if (state.playing) { stopPlayback(); return; }
    state.playing = true; $("#play-button").setAttribute("aria-pressed", "true"); $("#play-button").setAttribute("aria-label", "暂停播放");
    $("#play-icon").innerHTML = '<path d="M4.5 3.5h2.8v9H4.5zm4.8 0h2.8v9H9.3z" fill="currentColor"/>';
    playTimer = window.setInterval(function () { setFrame((state.frame + 1) % labels().length); }, 700);
  }
  function setMetadata(data, fileName) {
    var model = data.model || {}, grid = data.grid || {};
    $("#dataset-name").textContent = fileName; $("#dataset-state").textContent = "已加载 · " + splitName(data) + " · 样本 " + data.sample_index;
    $("#menu-file").textContent = fileName; $("#menu-meta").textContent = data.dataset + " / " + splitName(data) + " / 样本 " + data.sample_index;
    $("#stage-title").textContent = data.scene_name || data.dataset || "人群密度场"; $("#stage-subtitle").textContent = "CADRE · " + splitName(data) + " · 样本 " + data.sample_index;
    $("#scene-title").textContent = data.scene_name || data.dataset || "CADRE 场景"; $("#scene-subtitle").textContent = fileName; $("#scene-status").classList.add("loaded"); $("#scene-status-text").textContent = "数据已加载 · 本地 JSON"; $("#load-state").textContent = "已加载";
    $("#model-value").textContent = model.name || "CADRE"; $("#checkpoint-value").textContent = model.checkpoint || "—"; $("#epoch-value").textContent = model.epoch == null ? "—" : String(model.epoch); $("#prediction-kind").textContent = model.debiased ? "去偏预测" : "直接预测";
    $("#grid-value").textContent = grid.width + " × " + grid.height + " · " + number(grid.cell_size_m || 1, 2) + " m"; $("#dt-value").textContent = number(grid.time_step_seconds || 0, 2) + " s";
  }
  function setLoaded(data, fileName) {
    stopPlayback(); state.data = data; state.fileName = fileName; state.frame = data.temporal.observed_frames; state.mode = "prediction"; state.scales = Data.displayScales(data);
    viewport.classList.remove("empty"); $("#empty-state").hidden = true; $("#timeline").classList.remove("disabled"); ["#play-button", "#step-back", "#step-forward", "#unload-button"].forEach(function (id) { $(id).disabled = false; });
    $$(".mode-tab").forEach(function (button) { button.disabled = false; }); $("#inspector-empty").hidden = true; setMetadata(data, fileName); renderAxes(); render();
  }
  function unload() {
    stopPlayback(); state.data = null; state.fileName = ""; state.frame = 7; state.mode = "prediction"; state.scales = { density: 4, error: 2 }; viewport.classList.add("empty"); $("#empty-state").hidden = false; $("#timeline").classList.add("disabled");
    ["#play-button", "#step-back", "#step-forward", "#unload-button"].forEach(function (id) { $(id).disabled = true; }); $$(".mode-tab").forEach(function (button) { button.disabled = true; button.setAttribute("aria-pressed", String(button.dataset.mode === "prediction")); });
    $("#dataset-name").textContent = "未加载数据"; $("#dataset-state").textContent = "导入数据以开始查看"; $("#menu-file").textContent = "尚未导入 JSON 数据"; $("#menu-meta").textContent = "等待加载"; $("#stage-title").textContent = "密度场概览"; $("#stage-subtitle").textContent = "导入 CADRE 密度 JSON 后查看时空预测结果";
    $("#scene-title").textContent = "等待导入数据"; $("#scene-subtitle").textContent = "导入 CADRE 生成的密度 JSON 文件"; $("#scene-status").classList.remove("loaded"); $("#scene-status-text").textContent = "未加载数据"; $("#load-state").textContent = "未加载";
    ["#model-value", "#checkpoint-value", "#epoch-value", "#prediction-kind", "#grid-value", "#dt-value"].forEach(function (id) { $(id).textContent = "—"; }); $("#inspector-empty").hidden = false; renderAxes(); render();
  }
  function openImport() { closeMenus(); state.selectedFile = null; fileInput.value = ""; $("#selected-file").classList.remove("visible"); $("#apply-import").disabled = true; $("#apply-import").textContent = "加载数据"; dialogError(""); $("#import-dialog").showModal(); }
  function selectFile(file) { if (!file) return; state.selectedFile = file; $("#selected-filename").textContent = file.name; $("#selected-file").classList.add("visible"); $("#apply-import").disabled = false; dialogError(""); }
  function loadSelectedFile() {
    if (!state.selectedFile) return; var file = state.selectedFile; $("#apply-import").disabled = true; $("#apply-import").textContent = "正在读取…"; dialogError("");
    file.text().then(function (text) { setLoaded(Data.validate(JSON.parse(text)), file.name); $("#import-dialog").close(); toast("已加载 " + file.name); }).catch(function (error) { dialogError(error && error.message ? error.message : "无法读取此 JSON 文件。"); $("#apply-import").disabled = false; $("#apply-import").textContent = "重试加载"; });
  }
  function toggleMenu(name) { var menu = $(name === "dataset" ? "#dataset-menu" : "#layers-menu"), button = $(name === "dataset" ? "#dataset-button" : "#layers-button"), open = !menu.classList.contains("open"); closeMenus(open ? name : undefined); menu.classList.toggle("open", open); button.setAttribute("aria-expanded", String(open)); }
  function tooltip(event) {
    var cell = heatmap.cellAt(event); if (!cell || !state.data || !state.showDensity) return;
    var size = Number(state.data.grid.cell_size_m) || 1, rect = viewport.getBoundingClientRect(), node = $("#tooltip");
    node.textContent = "x " + number((cell.column + .5) * size, 1) + " m · y " + number((state.data.grid.height - cell.row - .5) * size, 1) + " m · " + number(cell.value, 2) + " 人/平方米";
    node.style.left = Math.min(event.clientX - rect.left + 13, rect.width - 190) + "px"; node.style.top = Math.min(event.clientY - rect.top + 13, rect.height - 48) + "px"; node.classList.add("visible");
  }

  $("#import-button").addEventListener("click", openImport); $("#empty-import-button").addEventListener("click", openImport); $("#replace-button").addEventListener("click", openImport); $("#dataset-button").addEventListener("click", function () { toggleMenu("dataset"); }); $("#layers-button").addEventListener("click", function () { toggleMenu("layers"); });
  $("#unload-button").addEventListener("click", function () { unload(); closeMenus(); toast("已卸载当前数据"); }); $("#dialog-close").addEventListener("click", function () { $("#import-dialog").close(); }); $("#cancel-import").addEventListener("click", function () { $("#import-dialog").close(); }); $("#apply-import").addEventListener("click", loadSelectedFile);
  $("#dialog-dropzone").addEventListener("click", function () { fileInput.click(); }); $("#dialog-dropzone").addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fileInput.click(); } }); fileInput.addEventListener("change", function () { selectFile(fileInput.files[0]); });
  $$(".mode-tab").forEach(function (button) { button.addEventListener("click", function () { setMode(button.dataset.mode); }); }); $("#ticks").addEventListener("click", function (event) { var tick = event.target.closest("[data-frame]"); if (tick) setFrame(Number(tick.dataset.frame)); }); $("#play-button").addEventListener("click", togglePlayback); $("#step-back").addEventListener("click", function () { setFrame(state.frame - 1); }); $("#step-forward").addEventListener("click", function () { setFrame(state.frame + 1); });
  $("#density-toggle").addEventListener("change", function (event) { state.showDensity = event.target.checked; renderHeatmap(); }); $("#grid-toggle").addEventListener("change", function (event) { state.showGrid = event.target.checked; viewport.classList.toggle("hide-grid", !state.showGrid); renderHeatmap(); }); canvas.addEventListener("pointermove", tooltip); canvas.addEventListener("pointerleave", function () { $("#tooltip").classList.remove("visible"); });
  ["dragenter", "dragover"].forEach(function (type) { $("#dialog-dropzone").addEventListener(type, function (event) { event.preventDefault(); $("#dialog-dropzone").classList.add("dragging"); }); viewport.addEventListener(type, function (event) { event.preventDefault(); viewport.classList.add("dragging-file"); }); });
  ["dragleave", "drop"].forEach(function (type) { $("#dialog-dropzone").addEventListener(type, function (event) { event.preventDefault(); $("#dialog-dropzone").classList.remove("dragging"); }); viewport.addEventListener(type, function (event) { event.preventDefault(); viewport.classList.remove("dragging-file"); }); });
  $("#dialog-dropzone").addEventListener("drop", function (event) { selectFile(event.dataTransfer.files[0]); }); viewport.addEventListener("drop", function (event) { var file = event.dataTransfer.files[0]; if (file) { openImport(); selectFile(file); } });
  document.addEventListener("click", function (event) { if (!event.target.closest(".dataset-wrap") && !event.target.closest(".layers-wrap")) closeMenus(); }); document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeMenus(); if (event.target.matches("input,textarea,[contenteditable=true]")) return; if (event.key === "ArrowLeft") setFrame(state.frame - 1); if (event.key === "ArrowRight") setFrame(state.frame + 1); if (event.key === " " && !$("#import-dialog").open && !event.target.closest("button,a,[role=button]")) { event.preventDefault(); togglePlayback(); } });
  render();
})();
