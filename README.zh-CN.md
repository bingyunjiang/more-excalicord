# more-excalicord

more-excalicord 是一个本地 Excalidraw 增强插件，用于把同一张白板中的 Frame 组织成“幻灯片”，并提供录制、摄像头、提词器、白板控制和演示播放能力。

它可以放在 /Users/Bing/.codex/skills 目录下便于本机管理，但它不是 Codex skill。仓库中故意不保留 SKILL.md 和 agents/openai.yaml，避免被 Codex 当成技能自动调用。

## 当前功能

- 悬浮幻灯片栏：新增、切换、总览、白板控制、录制入口
- 幻灯片总览：真实内容预览、多选、删除、重命名、拖拽排序
- 白板控制：白板总览、放大、缩小、恢复 100%、聚焦、撤回、前进
- 演示播放：类似 PPT 的全屏播放体验
- 智能吸附：移动或调整幻灯片大小时显示参考线并自动对齐
- 网格显示：可在设置中显示或隐藏白板网格，默认隐藏
- 新增幻灯片：默认按横向最多 6 张排版，新增后默认全局鸟瞰
- 录制工作室：支持屏幕/窗口、白板、当前幻灯片录制范围
- 摄像头：画中画、位置、形状、大小、镜像、美颜、补光
- 提词器：适合录制和演讲时滚动提示
- 本地场景保存：新增、删除和重排后持久化到本地 Excalidraw 运行环境

## 推荐工作流

本仓库是源码唯一真相；本地 Excalidraw 目录只是部署结果。

    修改本仓库源码
      -> npm run check
      -> npm run deploy:local
      -> 打开 http://localhost:5001/ 验收
      -> git commit
      -> git push

如果临时直接修改了本地运行目录，马上执行：

    npm run sync:from-live

然后再检查、提交、推送。

## 常用命令

    npm run check
    npm run deploy:local
    npm run verify:deploy
    npm run sync:from-live
    npm run status

含义：

- check：检查脚本语法、CSS 括号、关键文件和不应提交的场景文件
- deploy:local：把仓库源码部署到本机 Excalidraw 运行目录
- verify:deploy：比较仓库源码与运行目录哈希是否一致
- sync:from-live：从当前运行目录回收最新版源码到仓库
- status：查看 Git 状态和部署一致性

## 不要提交的内容

- scene.excalidraw
- scene.json
- 本地录屏成片
- 本地缓存和浏览器 profile
- 备份目录
- 个人白板内容
- 密钥、账号、token 或 .env 文件

## 示例白板

可以把脱敏后的示例白板放在 examples/ 目录下，例如：

    examples/demo-scene.excalidraw

示例文件可以提交到 GitHub；真实工作白板和本地运行目录中的 scene.excalidraw / scene.json 不要提交。

## GitHub 建议

首次同步建议先创建 private 仓库。确认 README、License、功能边界和截图材料后，再决定是否公开。

## License

MIT
