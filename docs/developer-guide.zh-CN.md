# 开发与同步

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `src/` | 白板插件、录制面板、项目 I/O 与录后编辑器 |
| `server/` | 本地服务、ASR 和最终渲染 |
| `native/capture-agent/macos/` | macOS Capture Agent 源码 |
| `schemas/` | Excalicord 项目 schema |
| `scripts/` | 配置、部署、检查、打包与 smoke test |
| `tests/` | 编辑器、存储、粗剪、镜头与渲染测试 |
| `examples/` | 可直接载入的 Excalidraw 示例 |

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run preflight` | 检查本地环境、运行目录、写权限和页面状态 |
| `npm run configure:local -- --runtime-root <path>` | 配置本机 Excalidraw 目录 |
| `npm run setup:local` | 配置默认目录并执行预检 |
| `npm run setup:asr` | 安装本地 faster-whisper 并缓存 base 模型 |
| `npm run check` | 运行语法、schema、单元测试和仓库检查 |
| `npm run deploy:local` | 部署插件到本地 Excalidraw |
| `npm run deploy:capture-agent` | 构建并安装 macOS Capture Agent |
| `npm run verify:deploy` | 比较仓库源码与已部署文件 |
| `npm run smoke:render` | 执行录后渲染 smoke test |
| `npm run status` | 查看 Git 与部署状态 |
| `npm run pack:release` | 生成 Release ZIP |

## 三方关系

    GitHub 远程仓库
        ↑ push / pull
    本地源码仓库
        ↓ npm run deploy:local
    本地 Excalidraw 运行目录

本地源码仓库是唯一真相，运行目录只是部署结果。网页模块、渲染服务和 `native/capture-agent/macos/` 都必须先改仓库，再部署；不要把运行目录里的 Capture Agent 当作第二份源码。

## 正常开发流程

    npm run status
    修改源码
    npm run check
    npm run deploy:local
    打开 http://localhost:5001/ 验收
    git add ...
    git commit -m "..."
    git push

## 如果直接改了运行目录

偶尔为了紧急调试可能直接改运行目录。调试完成后必须执行：

    npm run sync:from-live
    npm run check
    npm run verify:deploy

然后提交 Git。

## 不要提交

- 真实 scene.excalidraw
- scene.json
- 录屏文件
- 浏览器缓存
- 本地备份
- 密钥和 .env 文件

示例白板可以放进 examples/，但必须先脱敏。
