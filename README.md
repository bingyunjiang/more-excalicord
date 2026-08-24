<p align="center">
  <img src="assets/brand/more-excalicord-logo.svg" alt="more-excalicord" width="560">
</p>

<h3 align="center">落笔成画，开讲成片。</h3>

<p align="center">
  在 Excalidraw 中创作、讲解、录制，一气呵成。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#核心体验">核心体验</a> ·
  <a href="#先看实际效果">真实截图</a> ·
  <a href="docs/user-guide.zh-CN.md">使用指南</a> ·
  <a href="LICENSE">MIT License</a>
</p>

> 当前版本：`v0.1.1` · 面向自托管 Excalidraw

## 在白板里创作，也在白板里开讲

Excalidraw 很适合自由思考，却不天然适合按页讲解、稳定录制和后期交付。`more-excalicord` 是面向自托管 Excalidraw 的轻量增强插件：默认设置即可开始录制并生成 MP4；需要时，还可以加入 Frame 幻灯片、提词器、摄像头画中画、字幕和录后编辑。

<p align="center">
  <img src="docs/assets/readme/workflow-concept.svg" alt="more-excalicord 落笔成画开讲成片概念图" width="100%">
</p>

适合用来制作：

- 技术方案讲解、课程与培训视频；
- 论文、项目和产品汇报；
- 带桌面操作演示的软件教程；
- 需要保留原片、字幕和编辑记录的内容项目。

## 先看实际效果

以下画面来自真实本地运行，不是产品设计稿。

### 一张白板，也能像幻灯片一样讲

<p align="center">
  <img src="docs/assets/readme/25-external-display-slide-overview-20260824.png" alt="more-excalicord 幻灯片总览" width="100%">
</p>

Frame 会成为可搜索、可重命名、可排序的讲解幻灯页。你可以在总览中定位内容，也可以一键回到整张白板的鸟瞰视图。

### 录制前，讲解所需一切皆在手边

<p align="center">
  <img src="docs/assets/readme/29-external-display-teleprompter-20260824.png" alt="more-excalicord 提词器与录制面板" width="100%">
</p>

录制面板集中管理范围、画幅、麦克风、摄像头、提词器和录制效果。摄像头支持四角位置、形状、大小与镜像预览。

### 一键录完，也可继续编辑

<p align="center">
  <img src="docs/assets/readme/35-external-display-post-editor-20260824.png" alt="more-excalicord 录后编辑工作台" width="100%">
</p>

剪辑、逐字稿、字幕、镜头、光标、摄像头、画面和音频设置都写入项目时间线；原始录制始终保留。

## 核心体验

| 体验 | 你可以做什么 |
| --- | --- |
| 白板即幻灯片 | 用 Frame 组织、搜索、排序和聚焦讲解页，也能随时回到全局鸟瞰 |
| 默认即可录制 | 直接录制白板全景或当前页；需要时再选择桌面窗口、麦克风和摄像头 |
| 讲解更自然 | 使用提词器、画中画、柔光补光和可拖动的录制工具条 |
| 录后继续精修 | 非破坏剪辑、逐字稿、字幕、智能镜头与画面包装都不会覆盖原片 |
| 本地项目交付 | 白板、原片、事件、字幕和成片保存在同一项目目录，便于备份与迁移 |

## 默认设置，直接开录

1. 载入或新建一张 Excalidraw 白板。
2. 保持默认设置，选择“白板全景”或“当前幻灯片”，点击开始录制。
3. 停止后直接得到原始 MP4；需要精修时，再进入录后编辑并导出 `exports/final.mp4`。

<p align="center">
  <img src="docs/assets/readme/operation-steps-concept.svg" alt="more-excalicord 三步开录概念图" width="100%">
</p>

Frame 整理、桌面窗口、摄像头、提词器、字幕和智能剪辑都是可选增强项，不是开始录制的前置条件。

## 快速开始

准备好 Node.js、npm 和一个可运行的自托管 Excalidraw，然后执行：

```bash
git clone https://github.com/bingyunjiang/more-excalicord.git
cd more-excalicord
npm run setup:local
npm run check
npm run deploy:local
```

部署后打开 `http://localhost:5001/`。右侧出现 more-excalicord 工具栏，即可载入[示例白板](examples/more-paper-workflow-video-rich-sketch-20260815.excalidraw)体验。

自定义 Excalidraw 目录、macOS Capture Agent、本地 ASR 和权限配置见[完整安装说明](docs/install.zh-CN.md)。

## 文档与开发

| 我想…… | 从这里开始 |
| --- | --- |
| 尽快用起来 | [快速开始](docs/quickstart.zh-CN.md) · [使用指南](docs/user-guide.zh-CN.md) |
| 完成安装或排障 | [安装说明](docs/install.zh-CN.md) · [排障说明](docs/troubleshooting.zh-CN.md) |
| 了解项目文件 | [项目格式](docs/project-format.zh-CN.md) |
| 参与开发或发布 | [开发指南](docs/developer-guide.zh-CN.md) · [发布检查](docs/release-checklist.zh-CN.md) |
| 查看实测证据 | [v0.1.1 UX 复核](docs/v0.1.1-ux-review.zh-CN.md) |

## 作者与许可

作者：Dr. Jiang（Bingyun Jiang）<br>
微信：Bingyunjiang · 邮箱：bingyunjiang@qq.com · GitHub：[@bingyunjiang](https://github.com/bingyunjiang)

本项目采用 [MIT License](LICENSE)。
