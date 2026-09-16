# CADRE WebUI

用于展示 CADRE 人群密度场预测结果的中文科研可视化界面。前端是无需构建步骤的静态页面，入口为 [`crowd_ui/index.html`](crowd_ui/index.html)。

## 快速开始

1. 双击打开 `crowd_ui/index.html`。
2. 在“导入数据”中选择 `generated_heatmaps/cadre_test_000.json`，或选择 `generated_heatmaps/interpolated/` 下的插值结果。
3. 使用时间轴查看观测、预测、真值和误差视图。

生成 CADRE 密度 JSON：

```powershell
conda run -n crowd-diffusion python D:\webui\generate_cadre_density.py
```

生成四种空间插值结果：

```powershell
conda run -n crowd-diffusion python D:\webui\interpolate_density_json.py
```

CADRE 模型仓库、权重和原始数据作为本机旁车目录使用，不属于这个 WebUI 仓库；默认生成脚本会从同级 `CADRE/` 目录读取它们。仓库只保留小型示例 `generated_heatmaps/cadre_test_000.json`，插值实验结果可以随时重新生成。前端实现与数据契约说明见 [`crowd_ui/README.md`](crowd_ui/README.md)。
