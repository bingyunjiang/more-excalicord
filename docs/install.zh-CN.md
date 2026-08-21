# 安装与部署

## 适用范围

当前脚本默认适配 macOS 上的本地 Excalidraw 目录：

    /Users/Bing/.local/share/excalidraw

这是开发者本机路径。其他用户需要根据自己的安装位置调整 scripts/deploy-local.sh。

## 仓库内容

- src/studio-recorder.js：主要网页插件逻辑
- src/recorder.css：插件界面样式
- src/native-bridge.js：本地桥接脚本
- src/vendor/：摄像头美颜相关本地依赖
- server/no-cache-server.js：本地服务脚本，支持场景保存和版本刷新
- scripts/：检查、部署、同步和发布脚本

## 安装步骤

1. 下载仓库。
2. 进入仓库目录。
3. 执行 npm run check。
4. 确认本地 Excalidraw 目录存在。
5. 执行 npm run deploy:local。
6. 打开 http://localhost:5001/ 验收。

## 验收点

部署后建议至少检查：

- 页面能打开
- 悬浮栏能显示
- 新增幻灯片后默认全局鸟瞰
- 幻灯片总览能打开
- 白板控制能打开
- 录制面板能打开

录制合成功能如有改动，需要实际录制、下载并播放成片后再确认。
