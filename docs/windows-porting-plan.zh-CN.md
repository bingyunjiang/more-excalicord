# Windows 适配开发计划

## 文档状态

- 状态：社区接手用开发计划，尚未实施。
- 当前产品边界：more-excalicord 仅在 macOS 开发、安装和端到端验收。
- 维护承诺：项目当前不安排官方 Windows 开发、发布日期或安装包。
- 使用边界：Windows 用户可以基于本计划自行开发和维护适配分支；在完整验收前，不得宣称 Windows 已受支持。

本计划的目标是让接手者清楚知道“哪些代码可以复用、哪些必须重写、接口要保持什么样、做到什么程度才算完成”。它不是 Windows 安装教程，也不代表仓库已经具备 Windows 运行能力。

## 1. 当前架构与平台边界

| 层 | 当前路径 | 跨平台判断 |
| --- | --- | --- |
| Excalidraw 插件、录制面板、项目 I/O | `src/` | 以浏览器 JavaScript 为主，可复用，但需做 Windows 浏览器回归 |
| 本地页面、媒体读取、ASR、最终渲染 | `server/` | Node.js/Python 为主；存在 Python、FFmpeg、路径和进程启动差异，不能直接视为已兼容 |
| 浏览器到原生采集端的桥 | `src/native-bridge.js` | 协议可复用；当前固定连接 `http://127.0.0.1:5002/v1` |
| 原生屏幕/窗口/摄像头/麦克风采集 | `native/capture-agent/macos/` | 使用 Swift、AppKit、ScreenCaptureKit、AVFoundation，只能在 macOS 构建 |
| 安装、预检、部署、后台启动 | `scripts/` 与 macOS agent 脚本 | 以 Bash、Unix 命令和 LaunchAgent 为主；Windows 需要 PowerShell 与独立启动方案 |
| 项目清单与相对文件结构 | `schemas/`、`docs/project-format.zh-CN.md` | 应保持平台无关；Windows 实现必须继续使用项目内相对路径 |

需要特别区分两类能力：

1. 白板全景、当前幻灯片、部分摄像头画中画可由浏览器能力参与完成；
2. 屏幕/窗口来源预览、原生项目目录、可靠 MP4、后台服务及系统集成功能依赖 Capture Agent。

因此，“页面能打开”或“工具栏能显示”不等于 Windows 已适配。

## 2. 适配目标与非目标

### 2.1 最小可发布目标

首个 Windows 版本至少应做到：

- 在 Windows 11 的受支持版本上完成 x64 真机验收；ARM64 可作为后续目标；
- 自托管 Excalidraw 能加载插件，原有白板与幻灯片功能不回归；
- 本地 Capture Agent 只监听 `127.0.0.1:5002`，实现协议版本 1；
- 用户可以选择项目目录，安全读写项目文件，并将浏览器录制保存到项目；
- 用户可以选择真实屏幕或普通应用窗口，看到可识别预览后开始录制；
- 录制支持麦克风、暂停/恢复/停止，得到浏览器和播放器均可解码的 H.264/AAC MP4；
- 摄像头至少支持“合成进原片”；独立 sidecar 可作为下一阶段，但能力上报必须真实；
- 安装、卸载、后台启动和日志路径清楚，不要求用户安装 macOS/Swift 工具；
- 项目可整体迁移，原片不被录后编辑覆盖；失败或崩溃后不会留下错误的录制状态。

### 2.2 暂不作为首版阻塞项

- 隐藏 Windows 桌面图标；
- 屏幕边缘补光与 Windows 原生补光联动；
- 系统音频录制；
- ARM64 安装包；
- 自动更新、商店分发和代码签名自动化；
- 与 macOS 完全一致的窗口过滤名单和 UI 细节。

这些功能应通过 `capabilities` 逐项声明。没有实现就不返回对应能力，网页端应隐藏或禁用入口，不得返回成功占位值。

## 3. 推荐技术路线

推荐新增独立实现，而不是改写现有 macOS 目录：

```text
native/capture-agent/
├── macos/                         # 保持现状
└── windows/
    ├── ExcalicordCaptureAgent.sln
    ├── src/
    │   ├── Agent/                 # 进程入口、状态机、日志、生命周期
    │   ├── Http/                  # loopback HTTP、CORS、session token
    │   ├── Capture/               # 屏幕/窗口、摄像头、麦克风、编码
    │   ├── Project/               # 目录选择、相对路径校验、原子写入
    │   └── SystemIntegration/     # Explorer、开机启动、可选桌面/补光能力
    ├── tests/
    │   ├── Contract/
    │   ├── Security/
    │   └── Integration/
    └── scripts/
        ├── build.ps1
        ├── install-agent.ps1
        ├── uninstall-agent.ps1
        └── smoke-test.ps1
```

建议使用 C# 与实现时仍受支持的 .NET LTS，并通过 WinRT/Win32 调用 Windows 原生媒体能力：

- 屏幕与窗口：优先评估 [Windows.Graphics.Capture](https://learn.microsoft.com/windows/uwp/audio-video-camera/screen-capture)；需要从 `HWND`/`HMONITOR` 创建采集项时参考 [Windows Graphics Capture interop](https://learn.microsoft.com/windows/win32/api/windows.graphics.capture.interop/)；
- 麦克风：使用 WASAPI 或 Windows 媒体采集 API，参考 [Capturing a Stream](https://learn.microsoft.com/windows/win32/coreaudio/capturing-a-stream)；
- MP4：可选 Media Foundation Sink Writer，参考 [Sink Writer](https://learn.microsoft.com/windows/win32/medfound/sink-writer)，或使用经过许可审查并随安装包固定版本的 FFmpeg；
- 文件夹选择与 Explorer：使用 Windows 原生文件夹选择器和 Explorer 打开路径；
- 后台启动：首版在“用户登录后启动”的 Startup/计划任务/MSIX 启动任务中选择一种，必须支持显式卸载和禁用；
- 可选覆盖层：如果实现屏幕补光，必须验证覆盖层不会被误录；可研究 [`SetWindowDisplayAffinity`](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)，但不能把它当作安全或 DRM 保证。

技术选型需先做 30 秒原型录制，再冻结框架。不要在尚未验证帧率、音画同步、暂停续录和 MP4 封装前先制作安装器。

## 4. 必须保持的本地协议

网页桥接当前使用以下固定约束：

- 基地址：`http://127.0.0.1:5002/v1`；
- 协议版本：`protocolVersion: 1`；
- `GET /health` 返回当前 session token；
- 除 `/health` 与 CORS 预检外，其余请求必须携带 `X-Excalicord-Token`；
- 只允许 loopback 监听；至少允许来源 `http://localhost:5001` 与 `http://127.0.0.1:5001`；
- agent 重启导致 token 失效时，客户端会重新请求 `/health` 并重试一次；
- 来源 ID 只在当前枚举周期内使用，不应写入项目作为永久设备标识。

### 4.1 协议端点清单

| 方法与路径 | Windows 实现要求 | 阶段 |
| --- | --- | --- |
| `GET /health` | 返回平台、状态、真实能力、权限与 token；`platform` 使用 `windows` | P0 |
| `GET /sources` | 返回 displays/windows、名称、尺寸、应用名和可识别缩略图 | P1 |
| `GET /status` | 返回 `idle/recording/paused/error`、时长、输出路径和错误 | P0 |
| `GET /save-folder`、`GET /project-folder` | 返回当前目录状态 | P0 |
| `POST /save-folder/choose`、`POST /project-folder/choose` | 弹出原生目录选择器，允许取消 | P0 |
| `POST /save-folder/open`、`POST /project-folder/open` | 用 Explorer 打开目录 | P0 |
| `POST /project-file`、`/read`、`/delete` | 仅访问项目根内白名单相对路径 | P0 |
| `POST /browser-recording` | 将浏览器产生的 Blob 安全写入项目录制目录 | P0 |
| `POST /start`、`/pause`、`/resume`、`/stop` | 管理单一录制状态机并返回真实媒体路径 | P1 |
| `GET /recording`、`POST /recording/open` | 下载或用系统播放器打开最近原片 | P1 |
| `GET /desktop-icons`、`POST /desktop-icons/restore` | 未实现时不声明 `desktop-icons`；网页端需降级 | P2 |
| `POST /screen-light` | 未实现时不声明 `screen-light`；网页端需降级 | P2 |

请求和响应字段应以 `src/native-bridge.js`、macOS `Models.swift` 和 `AgentController.swift` 的当前实现为准。建议先把这些行为固化为平台无关的 JSON contract tests，再写 Windows 采集代码，防止两端悄然分叉。

## 5. Windows 安全与文件规则

Windows 适配不能只把 `/` 替换成 `\`。至少落实以下规则：

- HTTP 服务只绑定 IPv4 loopback，不绑定 `0.0.0.0`、局域网 IP 或公网接口；
- 每次 agent 启动生成新的高熵 token；日志不得打印 token；
- 项目 API 接收的仍是 `/` 分隔的项目内相对路径；拒绝 `..`、`.` 绕过、空段、反斜杠、盘符、UNC、设备路径、ADS（如 `file:stream`）和保留设备名；
- 对规范化后的最终路径再次检查其仍位于用户选择的项目根内；对 junction、symlink、reparse point 越界单独测试；
- 写 `project.excalicord.json`、字幕和事件文件时采用同卷临时文件加原子替换；
- 原片目录只新增文件，录后编辑和导出不得覆盖 `recordings/`；
- 限制 JSON、文本和上传媒体的大小；中断上传不得留下被误认为有效原片的文件；
- 目录选择、摄像头、麦克风和屏幕采集都由用户动作触发，并向用户显示实际选择结果；
- 安装脚本不关闭 Defender/UAC，不添加防火墙入站规则，不要求管理员权限，除非某个经过说明的安装模式确实需要；
- 日志、缓存、安装文件和用户项目分开，卸载默认不删除用户项目。

## 6. 分阶段实施计划

### Phase 0：基线、契约与可构建骨架

交付物：

- 确定最低 Windows 版本、x64/ARM64 范围、.NET LTS 与媒体技术选型；
- 新建 `native/capture-agent/windows/`，可在干净 Windows 环境构建；
- 抽取或复制协议 fixture，建立 `/health`、token、CORS、错误响应和状态机测试；
- 建立 `build.ps1`、`smoke-test.ps1` 和 CI Windows runner；
- 在 `scripts/` 增加平台分发入口，但保持 macOS 路径不变。

完成门槛：agent 可启动、只监听 loopback、health/鉴权测试通过，未实现能力不虚报。

### Phase 1：项目目录与浏览器录制落盘

交付物：

- Windows 原生目录选择和 Explorer 打开；
- 项目文件 read/write/delete、浏览器 Blob 保存；
- Windows 路径、junction、UNC、ADS、保留名和原子写入安全测试；
- 同一项目再次保存时按现有产品规则覆盖或生成新 session，不散落到下载目录。

完成门槛：创建、关闭、重启、重新打开项目后，白板与清单一致；越界用例全部拒绝。

### Phase 2：屏幕/窗口录制与音视频

交付物：

- 屏幕和普通应用窗口枚举、缩略图、来源确认；
- 30/60 fps 策略、DPI 缩放、多显示器、竖屏、窗口移动/缩放处理；
- 麦克风选择、静音状态、设备拔插错误；
- H.264/AAC MP4、暂停/恢复、停止、异常恢复；
- 摄像头合成或 sidecar，能力上报与实际输出严格一致。

完成门槛：连续录制 30 秒、10 分钟和 60 分钟；音画同步、文件时长、帧率、暂停段和播放器兼容性均通过人工与自动检查。

### Phase 3：录后服务与脚本跨平台化

交付物：

- 处理 `python3`/虚拟环境在 Windows 的路径差异；
- 统一发现或配置 `ffmpeg.exe`、`ffprobe.exe`，明确许可证和打包来源；
- 将 VideoToolbox 专属编码回退改为按平台选择 Media Foundation、可用硬件编码器或软件 H.264；
- 将 Bash-only 预检、配置、部署、验证、ASR 安装和打包流程补齐为 PowerShell；
- `.env.local`、含空格路径、非 ASCII 路径和不同盘符均通过测试。

完成门槛：Windows 项目可以从原始录制进入编辑器、预览并导出 `exports/final.mp4`，字幕、摄像头位置和音频均实际写入成片。

### Phase 4：安装、后台运行与发布

交付物：

- 可重复安装/升级/卸载的安装包或签名 ZIP；
- 用户登录后可选自启动、端口占用诊断、日志和状态命令；
- 安装前置条件、权限、故障排除和完整卸载文档；
- Windows CI 产物哈希、SBOM/依赖清单和发布检查表；
- 更新 README 平台表，但只能在真机验收完成后改为“支持”。

完成门槛：在一台未配置开发环境的干净 Windows 机器上，由新用户按照文档完成安装、录制、导出、重启后恢复和卸载。

### Phase 5：可选系统集成

按实际需求再实现桌面图标隐藏、屏幕补光、系统音频、ARM64 和自动更新。每项都必须独立能力探测、可关闭、异常后恢复；不能阻塞核心录制。

## 7. 验收矩阵

| 维度 | 至少覆盖 |
| --- | --- |
| 系统 | Windows 11 当前受支持版本；至少 x64，ARM64 若发布则单独验收 |
| 显示 | 单屏、双屏、不同 DPI、主副屏交换、横屏/竖屏、窗口跨屏 |
| 来源 | 整屏、普通 Win32 窗口、浏览器、Office/Zotero 类常用窗口、最小化/关闭来源 |
| 媒体 | 无摄像头、摄像头合成、sidecar（若支持）、无麦克风、USB 麦克风拔插 |
| 时长 | 30 秒、10 分钟、60 分钟；暂停/恢复多次 |
| 项目 | 新项目、已有项目、含空格和中文路径、只读目录、不同盘符、整体迁移 |
| 失败 | 5002 端口占用、agent 崩溃、磁盘满、权限拒绝、来源消失、编码器不可用 |
| 播放 | Edge/Chrome、Windows Media Player 或系统播放器、FFprobe；核对时长和音画同步 |
| 安全 | 非 loopback 访问、无 token、旧 token、路径穿越、UNC/ADS/junction、超大请求 |
| 回归 | `npm run check`、项目 schema v2、macOS 原有部署与录制链路不得因 Windows 改动失效 |

最终人工验收必须查看真实来源预览和实际导出的 MP4。单元测试、接口 200、文件存在或 FFprobe 成功都不能单独替代播放器回放和操作路径检查。

## 8. 贡献与交付要求

建议 Windows 适配以小步提交或独立 PR 推进：

1. 契约测试和 agent 骨架；
2. 项目目录安全；
3. 屏幕/窗口录制；
4. 摄像头与麦克风；
5. 渲染与 ASR；
6. 安装、CI 和文档。

每个 PR 应说明：

- 支持的 Windows 版本和架构；
- 新增/缺失的 `capabilities`；
- 使用的系统 API、第三方依赖、许可证和分发方式；
- 自动测试结果、真机型号/显示配置和实际录制文件证据；
- 安全边界、已知限制、回滚和卸载方法；
- 是否影响 macOS，以及 macOS 回归结果。

不要提交真实录屏、个人白板、用户名路径、token、证书或本地缓存。用于测试的媒体与项目必须经过脱敏，并控制仓库体积。

## 9. Windows 用户当前可以怎么做

如果只想体验项目，可以阅读源码、示例和项目格式；但当前仓库没有可直接使用的 Windows 完整安装路径。如果决定自行适配：

1. fork 仓库并建立 Windows 专用分支；
2. 先完成 Phase 0 的协议与安全测试；
3. 保持 `src/native-bridge.js` 的协议版本 1，不要先修改网页端绕过鉴权；
4. 按 Phase 1 至 Phase 4 逐步实现并保留测试证据；
5. 只有验收矩阵完成后，才在自己的分支或发行说明中标注 Windows 支持范围。

在此之前，最准确的表述是：“Windows 适配计划已提供，Windows 实现与安装包尚未提供。”
