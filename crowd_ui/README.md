# 人群时空场前端

这是可直接双击打开的静态前端，不需要 Node、打包器或本地服务。入口是 `index.html`。

目录职责：

- `index.html`：页面语义结构和资源引用。
- `styles.css`、`collection.css`：浅色视觉令牌、整体布局和集合切换控件。
- `js/data-contract.js`：单窗口/集合 JSON 的统一校验、TypedArray 转换、时间帧选择和统计计算。它的公开 interface 是 `window.CrowdFieldData`。
- `js/heatmap.js`：基于 `ImageData` 的密度 / 误差绘制、近期帧缓存和单元格命中。它的公开 interface 是 `window.CrowdFieldHeatmap.create(canvas)`。
- `js/app.js`：DOM 状态、Web Worker 导入、窗口切换、播放控制和对上面两个模块的协调。

色标按整个导入集合计算，而不是按单帧或单窗口计算：密度上限是所有窗口中观测、预测和真值的最大物理密度向上取整；误差色标以所有预测帧的最大绝对误差向上取整，并保持正负对称。密度绘制会将不超过 `0.02 人/平方米` 的单元显示为背景色，并以非线性映射增强阈值以上的低至中等密度；原始 JSON、提示数值和统计指标不受影响。这样切换窗口、帧、真值和预测时，颜色含义不变。

运行：双击 `index.html`，导入 `../generated_heatmaps/cadre_test_showcase.json`。旧的 `cadre-density/v1` 单窗口文件仍受支持；新集合格式为 `cadre-density-collection/v1`。重新生成集合使用：

```powershell
conda run -n crowd-diffusion python D:\webui\generate_cadre_density.py
```

JSON 在后台 Worker 中解析并转换为 `Float32Array`。50 MiB 以上会显示大文件提示；超过 256 MiB 或 1,500 万个密度值会拒绝加载，建议降低插值倍率或减少集合窗口数。

如需查看 14 倍空间插值的显示效果，可生成 nearest、bilinear、bicubic、Lanczos 四份 JSON：

```powershell
conda run -n crowd-diffusion python D:\webui\interpolate_density_json.py
```

文件写入 `../generated_heatmaps/interpolated/`。插值后的网格为 `196 × 308`，单元边长会同步从 `0.5 m` 缩小到 `0.035714 m`；密度单位仍是人/平方米。脚本会逐帧恢复积分人数，供展示的默认选择是 bilinear；nearest 用于核对原始格点，bicubic 与 Lanczos 可能在峰值附近出现过冲或振铃。前端按 JSON 网格尺寸绘制，并将 Canvas 的最长边限制在 2048 像素，避免高分辨率文件分配过大的位图。

维护约束：数据结构变化时先改 `data-contract.js`；热图表现变化时改 `heatmap.js`；不要让 `app.js` 重新承担 JSON 校验或像素级绘制。
