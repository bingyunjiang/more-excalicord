# 安装与部署

## 适用范围

当前正式安装路径仅适用于 **macOS**。仓库中的 Capture Agent 使用 Swift、ScreenCaptureKit/AppKit 和 LaunchAgent，安装、权限与真实录制流程也只在 macOS 上验收。

| 平台 | 当前状态 | 安装结论 |
| --- | --- | --- |
| macOS | 当前开发与验收平台 | 可按本文继续安装 |
| Windows | 尚未实现、尚未端到端验收 | 不能直接安装完整功能；需先完成 Windows 适配 |
| Linux | 未纳入当前范围 | 不提供安装承诺 |

Windows 用户请先阅读 [Windows 适配开发计划](windows-porting-plan.zh-CN.md)。当前 `npm run deploy:capture-agent` 在非 macOS 系统会跳过原生采集端；这只表示脚本安全退出，不表示 Windows 已兼容。网页插件即使能够加载，也不能据此认定屏幕/窗口录制、原生项目目录、MP4 编码、后台启动或录后导出可用。

以下步骤均为 macOS 安装说明。默认本地 Excalidraw 目录为：

    ~/.local/share/excalidraw

如果你的本地 Excalidraw 安装在其他位置，设置环境变量即可：

    export MORE_EXCALICORD_RUNTIME_ROOT="/path/to/excalidraw"

也可以使用本仓库提供的配置脚本写入本机配置：

    npm run configure:local -- --runtime-root /path/to/excalidraw

配置会保存到 .env.local；该文件被 Git 忽略，不会上传。

## 前置条件

| 前置条件 | 检查命令 | 缺失时怎么处理 |
| --- | --- | --- |
| Node.js 18+ | node -v | 先安装 Node.js，再重新打开终端 |
| npm | npm -v | 通常随 Node.js 一起安装 |
| bash、perl、shasum | npm run preflight | macOS 通常自带；缺失时先安装对应命令行工具 |
| 自托管 Excalidraw 运行目录 | npm run preflight | 先安装或准备本地 Excalidraw，再用 configure:local 指向目录 |
| 本地页面 | 打开 http://localhost:5001/ | 启动或重启本地 Excalidraw 服务 |
| 浏览器录制权限 | 首次录制时浏览器会提示 | 允许屏幕录制、摄像头和麦克风 |
| 可选：Python 3.12 或 uv | 本地 faster-whisper 逐字稿 | 运行 npm run setup:asr |

推荐部署前先运行：

    npm run preflight

预检会提前报告缺少的命令、运行目录、写入权限和本地页面状态，避免部署到一半才失败。

## 仓库内容

- src/studio-recorder.js：主要网页插件逻辑
- src/recorder.css：插件界面样式
- src/native-bridge.js：本地桥接脚本
- src/editor-*.js、src/post-editor.*：项目 schema、时间线和录后编辑工作台
- src/rough-cut-core.js、src/smart-camera-core.js：智能粗剪和镜头规划
- src/vendor/：摄像头美颜相关本地依赖
- server/no-cache-server.js、server/render-core.js：项目媒体、逐字稿、渲染和版本刷新
- native/capture-agent/macos/：Capture Agent 的 Swift 源码
- schemas/：项目文件 schema v2
- scripts/：检查、部署、同步和发布脚本

## 推荐安装步骤

> 本节仅适用于 macOS。Windows 不应直接照搬这些命令作为完整安装方案。

1. 下载仓库。
2. 进入仓库目录。
3. 配置运行目录：默认目录运行 npm run setup:local；自定义目录运行 npm run configure:local -- --runtime-root /path/to/excalidraw。
4. 执行 npm run preflight。
5. 执行 npm run check。
6. 执行 npm run deploy:local。
7. 执行 npm run verify:deploy。
8. 如需自动逐字稿，执行 npm run setup:asr。
9. 打开 http://localhost:5001/ 验收。

## 用 Codex 等大模型辅助部署（macOS）

如果用户不熟悉终端，可以让 Codex、Claude Code、Cursor 或 ChatGPT Desktop 这类本地大模型助手代为部署。建议给大模型明确边界：先检查前置条件，再配置路径，再部署，最后让用户做浏览器和视频回放验收。

可复制的提示词：

    请帮我部署 more-excalicord。当前目录就是仓库根目录。先运行 npm run preflight，检查 Node.js/npm、自托管 Excalidraw 运行目录、写入权限和 http://localhost:5001/ 状态。如果运行目录不是 ~/.local/share/excalidraw，先问我真实路径，再运行 npm run configure:local -- --runtime-root <真实路径>。然后依次运行 npm run check、npm run deploy:local、npm run verify:deploy。不要提交 .env.local、个人白板、录屏、密钥或缓存文件。部署后提示我打开 http://localhost:5001/，检查 more-excalicord 工具栏、录制面板、屏幕/窗口录制、白板全景录制、当前幻灯片聚焦录制、摄像头画中画和摄像头合成进视频。

如果大模型提示缺少 Node.js 或本地 Excalidraw，它应该先指导用户安装或配置这些前置条件，而不是继续执行部署。若检测到 Windows，应停止套用上述提示词，改为先阅读 Windows 适配计划；不得声称仅安装 Node.js 或运行 Bash 脚本就已获得完整 Windows 支持。

## 部署过程中的配置文件

| 文件或变量 | 用途 | 是否提交 |
| --- | --- | --- |
| .env.local | 保存 MORE_EXCALICORD_RUNTIME_ROOT | 不提交 |
| MORE_EXCALICORD_RUNTIME_ROOT | 指向本地 Excalidraw 运行目录 | 不提交 |
| ~/.local/share/excalidraw | 默认运行目录 | 不提交 |

部署脚本会读取 .env.local；如果没有该文件，就使用默认目录。

## 验收点

部署后建议至少检查：

- 页面能打开
- 悬浮栏能显示
- 新增幻灯片后默认全局鸟瞰
- 幻灯片总览能打开
- 白板控制能打开
- 录制面板能打开
- 项目文件夹可设置，保存后可重新打开白板和项目
- 原始录制完成后能进入录后编辑
- 剪辑、字幕、镜头和光标设置可保存并恢复
- exports/final.mp4 能正常解码和回放

录制合成功能如有改动，需要实际录制、下载并播放成片后再确认。
