# 快速开始

这份文档面向刚从 GitHub 下载 more-excalicord 的用户。

## 1. 你需要先知道

more-excalicord 不是独立网页应用。它是给自托管 Excalidraw 增加幻灯片、项目文件、录制、提词器、逐字稿、字幕、非破坏剪辑和成片导出的本地增强插件。

部署前需要准备：

- Node.js 18+ 和 npm；
- Git，或能从 GitHub 下载 ZIP；
- 一个已经能在本机运行的自托管 Excalidraw；
- 浏览器的屏幕录制、摄像头和麦克风权限；
- 可选：Codex、Claude Code、Cursor 等能执行终端命令的本地大模型助手。

它需要一个本地 Excalidraw 运行目录。脚本默认使用：

    ~/.local/share/excalidraw

如果你的本地 Excalidraw 不在这个位置，可以通过部署配置脚本指定：

    npm run configure:local -- --runtime-root /path/to/excalidraw

## 2. 下载

推荐方式：

    git clone https://github.com/bingyunjiang/more-excalicord.git
    cd more-excalicord

如果不会用 Git，也可以在 GitHub 页面点击 Code -> Download ZIP，解压后进入目录。

## 3. 配置和预检

默认运行目录：

    npm run setup:local

自定义运行目录：

    npm run configure:local -- --runtime-root /path/to/excalidraw
    npm run preflight

如需根据实际录音自动生成逐字稿，再安装本地 ASR：

    npm run setup:asr

如果预检提示缺少 Node.js、自托管 Excalidraw 目录或写入权限，先处理这些前置条件，再继续部署。

## 4. 检查源码

    npm run check

看到 check ok 表示源码和基础文件结构正常。

## 5. 部署到本地 Excalidraw

    npm run deploy:local

部署完成后会自动执行一致性检查，看到 deploy verified 表示仓库源码和运行目录一致。

## 6. 打开使用

打开：

    http://localhost:5001/

右侧或你设置的位置会出现 more-excalicord 悬浮栏。第一次使用建议按下面顺序操作：

1. 打开录制面板并选择“设置项目文件夹…”；
2. 用“保存白板”建立 `project.excalicord.json` 和 `scene.excalidraw`；
3. 选择录制范围并开始、停止录制；
4. 点击“进入录后编辑”，处理剪辑、逐字稿、字幕和镜头；
5. 点击“导出成片”，在项目的 `exports/final.mp4` 查看结果。

“打开项目文件夹…”用于加载完整项目；“打开 Excalidraw 文件…”只打开单个白板，两者不要混用。

## 7. 用 Codex 等大模型辅助部署

如果你希望 Codex、Claude Code、Cursor 或其他本地大模型助手代为执行部署，可以把下面这段话交给它：

    请帮我部署 more-excalicord。先运行 npm run preflight，检查 Node.js/npm、本地 Excalidraw 运行目录、写入权限和 localhost:5001 状态。如果运行目录不是默认值，先问我真实路径并运行 npm run configure:local -- --runtime-root <真实路径>。然后依次运行 npm run check、npm run deploy:local、npm run verify:deploy。不要提交 .env.local、个人白板、录屏、密钥或缓存文件。部署后提示我打开 http://localhost:5001/，检查工具栏、录制面板、三种录制范围、摄像头画中画和摄像头合成进视频。

大模型可以帮你执行命令和解释报错；但摄像头、屏幕录制授权和最终视频回放需要你在本机确认。

## 8. 后续更新

如果是 Git 下载：

    git pull
    npm run preflight
    npm run check
    npm run deploy:local

如果是 ZIP 下载：重新下载 ZIP，解压覆盖你的插件源码目录，然后重新执行 npm run preflight、npm run check 和 npm run deploy:local。
