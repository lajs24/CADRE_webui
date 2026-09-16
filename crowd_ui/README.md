# 人群时空场前端

这是可直接双击打开的静态前端，不需要 Node、打包器或本地服务。入口是 `index.html`。

目录职责：

- `index.html`：页面语义结构和资源引用。
- `styles.css`：所有布局、色彩、响应式规则和可访问性状态。
- `js/data-contract.js`：CADRE 密度 JSON 的校验、时间帧选择和统计计算。它的公开 interface 是 `window.CrowdFieldData`。
- `js/heatmap.js`：Canvas 密度 / 误差绘制和单元格命中。它的公开 interface 是 `window.CrowdFieldHeatmap.create(canvas)`。
- `js/app.js`：DOM 状态、导入流程、播放控制和对上面两个模块的协调。

色标按导入样本计算，而不是按单帧计算：密度上限是观测、预测和真值全部帧中的最大物理密度向上取整；误差色标以全部预测帧的最大绝对误差向上取整，并保持正负对称。这样切换帧、真值和预测时，颜色含义不变。

运行：双击 `index.html`，导入 `../generated_heatmaps/cadre_test_000.json`。重新生成数据仍使用：

```powershell
conda run -n crowd-diffusion python D:\webui\generate_cadre_density.py
```

如需查看 14 倍空间插值的显示效果，可生成 nearest、bilinear、bicubic、Lanczos 四份 JSON：

```powershell
conda run -n crowd-diffusion python D:\webui\interpolate_density_json.py
```

文件写入 `../generated_heatmaps/interpolated/`。插值后的网格为 `196 × 308`，单元边长会同步从 `0.5 m` 缩小到 `0.035714 m`；密度单位仍是人/平方米。脚本会逐帧恢复积分人数，供展示的默认选择是 bilinear；nearest 用于核对原始格点，bicubic 与 Lanczos 可能在峰值附近出现过冲或振铃。前端按 JSON 网格尺寸绘制，并将 Canvas 的最长边限制在 2048 像素，避免高分辨率文件分配过大的位图。

维护约束：数据结构变化时先改 `data-contract.js`；热图表现变化时改 `heatmap.js`；不要让 `app.js` 重新承担 JSON 校验或像素级绘制。
