# 开发与同步

## 三方关系

    GitHub 远程仓库
        ↑ push / pull
    本地源码仓库
        ↓ npm run deploy:local
    本地 Excalidraw 运行目录

本地源码仓库是唯一真相，运行目录只是部署结果。

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
