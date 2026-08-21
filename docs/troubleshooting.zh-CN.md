# 常见问题

## 页面没有出现悬浮栏

先确认页面加载的是部署后的脚本：

    npm run verify:deploy

然后刷新 http://localhost:5001/。如果仍然没有出现，检查本地 Excalidraw 的 index.html 是否引用了 /recorder/studio-recorder.js。

## 新增幻灯片没有鸟瞰

打开白板控制 -> 设置，确认“新增后全局鸟瞰”开启。当前版本会默认开启该选项。

## 修改后页面还是旧效果

执行：

    npm run deploy:local
    npm run verify:deploy

然后强制刷新浏览器页面。

## 仓库和部署目录不一致

执行：

    npm run verify:deploy

如果失败，重新执行：

    npm run deploy:local

如果你临时直接改了运行目录，先执行：

    npm run sync:from-live

再提交 Git。

## 录制视频有问题

录制问题需要按真实组合验证：

- 屏幕/窗口录制
- 白板录制
- 当前幻灯片录制
- 摄像头是否合成进视频
- 不同画幅和摄像头尺寸

不要只看按钮状态或页面提示，要实际下载并播放视频确认。
