# 贡献指南

本仓库是 [fourzkw/dsh-drawai](https://github.com/fourzkw/dsh-drawai) 的增强 fork（本仓库为 `dsh-drawai-vectorizer`），欢迎提交改进。

## 开发环境

```powershell
npm install
npm run build      # src/ → lib/（lib/ 是构建产物，不要手改）
npm test           # 25 项自测
npm run check      # 包完整性校验
```

> **重要：`lib/` 是 `src/` 的构建产物**。
> `lib/*.js` 文件头写着「由 tools/build.mjs 生成 —— 请勿直接编辑；改 src/ 下的源文件」。
> 手工改 `lib/` 会在下次构建时被覆盖。

## 新增宿主模块的注意事项

宿主侧（Node）模块需要登记在 `tools/build.mjs` 的 `HOST_ONLY_MODULES` 数组里，
否则构建时不会被拷贝到 `lib/`，运行期会抛 `MODULE_NOT_FOUND`。
本 fork 的 `src/vtrace.js` 就是这样登记的。

## 提交前

- `npm run build` 后确认 `lib/` 已更新（提交里要包含构建产物，因为包直接吃 `lib/`）
- `npm test` 全绿
- 涉及并行度/性能的改动，请在 PR 描述里附上本机实测数据（核心数、单帧耗时、内存峰值）

## 代码风格

跟随上游：
- ESM（`package.json` 里 `"type": "module"`）
- 2 空格缩进，无分号
- 注释用中文，解释「为什么」而不是「做了什么」
- 关键决策点写清楚取舍依据（本仓库的注释风格偏重于记录踩坑与实测数据）
