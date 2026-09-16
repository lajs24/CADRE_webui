# CADRE WebUI

用于展示 CADRE 人群密度场预测结果的中文科研可视化界面。前端是无需构建步骤的静态页面，入口为 [`crowd_ui/index.html`](crowd_ui/index.html)。

## 快速开始

1. 双击打开 `crowd_ui/index.html`。
2. 在“导入数据”中选择 `generated_heatmaps/cadre_test_showcase.json`。
3. 使用“窗口”选择器切换起始、最佳、最差和随机样本，再通过时间轴查看观测、预测、真值和误差。

生成 CADRE 密度 JSON：

```powershell
conda run -n crowd-diffusion python D:\webui\generate_cadre_density.py
```

默认命令会扫描完整 test split，以未来密度物理 MAE 选出起始、最佳、最差和三个可重复的随机窗口，并生成一个集合 JSON。仍可生成单窗口或指定窗口：

```powershell
conda run -n crowd-diffusion python D:\webui\generate_cadre_density.py --selection single --sample-index 0
conda run -n crowd-diffusion python D:\webui\generate_cadre_density.py --selection indices --sample-indices 0 12 24
```

生成四种空间插值结果：

```powershell
conda run -n crowd-diffusion python D:\webui\interpolate_density_json.py
```

CADRE 模型仓库、权重和原始数据作为本机旁车目录使用，不属于这个 WebUI 仓库；默认生成脚本会从同级 `CADRE/` 目录读取它们。仓库保留小型单窗口和展示集合示例，插值实验结果可以随时重新生成。前端实现与数据契约说明见 [`crowd_ui/README.md`](crowd_ui/README.md)。
