# GitHub 发布检查清单

## 发布前

- README.md 能说明项目用途
- docs/quickstart.zh-CN.md 能指导新用户下载和部署
- docs/install.zh-CN.md 能说明本地路径和验收点
- docs/troubleshooting.zh-CN.md 覆盖常见失败
- examples/ 只包含脱敏示例
- 没有 scene.excalidraw / scene.json
- 没有录屏成片、缓存、备份和密钥

## 命令检查

    npm run check
    npm run verify:deploy
    npm run status

## 打包

    npm run pack:release

打包文件会输出到 dist/，用于 GitHub Release 附件。dist/ 不入库。

## GitHub 页面建议

- About 中写清楚：Local Excalidraw enhancement plugin
- Topics 可添加：excalidraw, whiteboard, slides, recording, local-first
- 首次建议 private；确认示例和说明无敏感内容后再 public

## 发布后

从 GitHub 页面模拟一次新用户流程：

1. 阅读 README
2. 打开快速开始
3. 下载 ZIP 或 git clone
4. 执行 npm run check
5. 执行 npm run deploy:local
6. 打开 http://localhost:5001/
7. 验证悬浮栏、幻灯片总览和白板控制
