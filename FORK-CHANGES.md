# dsh-drawai-vectorizer · HQ fork（v0.4.0）

> 上游：[fourzkw/dsh-drawai](https://github.com/fourzkw/dsh-drawai) @ 0.3.2（MIT）
> 本 fork 保留上游全部功能，新增 **vtracer 高质量矢量化引擎**。

## 一句话

原版插件的矢量化走「调色板量化 + k-means → 连通域 → marching squares → Douglas-Peucker 折线」，
**没有曲线拟合**、工作分辨率上限 499px（图片 887px）。本 fork 增加一条 **vtracer** 路线：
分层颜色聚类 + **三次贝塞尔样条** + 每通道位深控制，并在 1920 原生分辨率上工作。

## 新增能力

### 1. 双引擎（UI 可选）

视频「绘制复刻」面板与单图「绘制」面板都新增 **「矢量化引擎」** 下拉：

| 引擎 | 说明 |
|---|---|
| `plugin`（默认） | 上游自研描边，快、体积小，适合视频全片 |
| `vtracer` | 高质量，适合单图；可选保真档位 |

### 2. 三档保真度（实测，同一 1920×1080 帧）

| 档位 | 参数 | SVG 体积 | 绘制步骤 | 耗时 | PSNR |
|---|---|---|---|---|---|
| `fast` | cp6 fs2 ld8 spline | 1.6 MB | 4,060 | 1.4s | ~18 dB |
| **`hifi`**（默认） | cp8 fs0 ld8 spline | 9.9 MB | 35,069 | 2.8s | **~38 dB** |
| `pixel` | cp8 fs0 ld1 none | 15.9 MB | 173,479 | 3.7s | **~46 dB** |

> 对照：上游 `plugin` 引擎同帧约 18 KB / 584 步 / **~26 dB**。

### 3. 并行度：一半核心

原策略 `min(4, 逻辑核-1)`（本机 16 核 → 只用 4）。
本 fork 改为 **`floor(逻辑核/2)`**（本机 → **8**），并叠加内存收敛（每 worker 512MB 预算，上限 32）。

### 4. `traceImage` op 也支持引擎

```json
{ "op": "traceImage", "image": "ref.png", "removeBg": false,
  "engine": "vtracer", "vtraceLevel": "pixel" }
```

可选覆盖项：`colorPrecision`(4-8) / `filterSpeckle`(0-16) / `layerDifference`(1-64) /
`maxLayers`(8-256，默认 48) / `mode`(spline|polygon|none)。

## 绘制过程展示（与原版一致）

vtracer 后端**完整对齐上游的 `drawing` 契约**：

```js
drawing = {
  viewBox: [0, 0, w, h],
  fills:  ['#rrggbb', ...],                 // 每层填充色
  steps:  [{ layer, d, area }, ...]         // 按面积降序 → 先大块后细节
}
```

因此客户端的渐进绘制回放（`traceDrawingLayers` / `createTraceDrawingPlayback`）
**一行都不用改**，观感与原版一致（大色块 → 细节，进度条，完成后自动回放）。

**层数收敛**：vtracer 因渐变会产生上万种精确色，直接按 fill 建 `<path>` 会让 DOM 爆炸。
本 fork 按面积加权量化到 `maxLayers`（默认 48）层——与原版「几十个调色板颜色」一致。

## 使用方式

### UI

画布 → 选视频/图片节点 → 「绘制复刻」/「绘制」 → **矢量化引擎** 选 `vtracer 高保真`。

### AI 工具

```js
// 视频/单图任务（内部接口，客户端提交时使用）
{ options: { engine: "vtracer", vtraceLevel: "hifi", maxLayers: 48 } }
```

## 什么时候**不要**用 vtracer

| 场景 | 建议 |
|---|---|
| 视频全片 | ⚠️ 用 `plugin`。vtracer 的体积是数百倍（实测 2209 帧生成约 **80 亿字符**） |
| 单图 / 短视频片段 | ✅ 推荐 |
| 源分辨率很低（< 800px） | vtracer 的位深优势发挥不出来，`plugin` 够用 |

## 已知边界

- **`pixel` 档位体积大**：1920×1080 约 15.9 MB SVG、17 万步。超大图上可能触及画布单节点上限，建议先试 `hifi`。
- **渲染节点上限**：实测 `mode:None` 在 2048px 原生分辨率下会触发 resvg `nodes limit reached`；1440px 以下正常。
- **纯 JS 描边的边界**：上游 `plugin` 引擎在生产环境中对大图有 887px 校准上限（其自身设计），本 fork 未改动该路径。

## 构建与验证

```powershell
npm install          # 装 @neplex/vectorizer + @resvg/resvg-js
npm run build        # src/ → lib/（vtrace.js 已登记进 HOST_ONLY_MODULES）
npm test             # 25 项自测
npm run check        # 包完整性校验
```

## 目录结构（本 fork 新增/修改）

```
src/vtrace.js              ★ 新增：vtracer 后端 + drawing 契约生成
src/video-trace-worker.js    改：engine 分支
src/video-trace-pool.js      改：一半核心并行策略（resolvePoolSize）
src/index.js                 改：engine 参数白名单 + traceImage 引擎支持
src/client.js                改：视频面板 + 单图面板加「矢量化引擎」
tools/build.mjs              改：HOST_ONLY_MODULES 登记 src/vtrace.js
tools/check-video-trace.mjs  改：poolSize 断言去掉旧的 <=4 上限
```

## 许可

MIT（与上游一致）。二次分发请保留上游版权声明与 `forkOf` 字段。
