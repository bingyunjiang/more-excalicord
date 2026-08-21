# 快速开始

这份文档面向刚从 GitHub 下载 more-excalicord 的用户。

## 1. 你需要先知道

more-excalicord 不是独立网页应用。它是给自托管 Excalidraw 增加幻灯片、录制、摄像头、提词器和白板控制能力的本地增强插件。

它需要一个本地 Excalidraw 运行目录。脚本默认使用：

    ~/.local/share/excalidraw

如果你的本地 Excalidraw 不在这个位置，可以通过环境变量指定：

    export MORE_EXCALICORD_RUNTIME_ROOT="/path/to/excalidraw"

## 2. 下载

推荐方式：

    git clone https://github.com/bingyunjiang/more-excalicord.git
    cd more-excalicord

如果不会用 Git，也可以在 GitHub 页面点击 Code -> Download ZIP，解压后进入目录。

## 3. 检查

    npm run check

看到 check ok 表示源码和基础文件结构正常。

## 4. 部署到本地 Excalidraw

    npm run deploy:local

部署完成后会自动执行一致性检查，看到 deploy verified 表示仓库源码和运行目录一致。

## 5. 打开使用

打开：

    http://localhost:5001/

右侧或你设置的位置会出现 more-excalicord 悬浮栏。你可以新增幻灯片、打开幻灯片总览、进入白板控制或打开录制面板。

## 6. 后续更新

如果是 Git 下载：

    git pull
    npm run check
    npm run deploy:local

如果是 ZIP 下载：重新下载 ZIP，解压覆盖你的插件源码目录，然后重新执行 npm run check 和 npm run deploy:local。
