# GitHub 发布检查清单

## 发布前

- README.md 能说明项目用途
- docs/quickstart.zh-CN.md 能指导新用户下载、预检、配置和部署
- docs/install.zh-CN.md 能说明前置条件、本地路径、Codex/大模型辅助部署和验收点
- docs/troubleshooting.zh-CN.md 覆盖常见失败
- examples/ 只包含脱敏示例
- 没有 scene.excalidraw / scene.json
- 没有录屏成片、缓存、备份和密钥

## 命令检查

    npm run preflight
    npm run check
    npm run verify:deploy
    npm run status

## 打包

    npm run pack:release

打包文件会输出到 dist/，用于 GitHub Release 附件。dist/ 不入库。

## GitHub 页面建议

- About 中写清楚：Local Excalidraw enhancement plugin
- Topics 可添加：excalidraw, whiteboard, slides, recording, local-first
- public 仓库发布前确认 README、examples、截图、部署文档和 .gitignore 无敏感内容

## 发布后

从 GitHub 页面模拟一次新用户流程：

1. 阅读 README
2. 打开快速开始
3. 下载 ZIP 或 git clone
4. 执行 npm run setup:local 或 configure:local
5. 执行 npm run preflight
6. 执行 npm run check
7. 执行 npm run deploy:local
8. 打开 http://localhost:5001/
9. 验证悬浮栏、幻灯片总览、白板控制、录制范围和摄像头画中画
