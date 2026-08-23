# more-excalicord 项目格式

`project.excalicord.json` 是项目清单，不保存视频二进制。所有文件路径均相对于用户选择的项目文件夹，项目整体移动后仍可重新打开。

## schema v2

v2 将“原始录制”和“编辑决策”分开：

- `recordings[]` 只描述原始素材、录制范围、时长和事件文件；
- `edits[]` 保存剪辑、字幕、镜头、光标、摄像头和画面包装状态；
- `exports/` 中的文件是根据某个 edit 渲染出的成片，不是项目真值；
- `scene.excalidraw` 和 `text/script.md` 属于项目级内容。

录制事件、逐字稿和编辑轨统一使用毫秒，并保留原始素材时间。剪辑后的播放时间由 `timeline` 计算，不能直接回写原始时间戳。

## 兼容原则

schema v1 中的 `recording.media[]` 会迁移为 `legacyComposite` 录制。旧视频已经写入的摄像头、光标或背景无法在录后拆开，界面必须显示能力限制，但仍可做裁剪、字幕和整体镜头调整。

未知 schema 版本必须停止写入并提示升级，不能用默认值覆盖项目。

## 安全原则

- 拒绝绝对路径、反斜杠、`..` 和符号链接越界；
- 原始素材只读，编辑和导出不得覆盖 `recordings/`；
- 项目清单写入应使用原子替换；
- 云端 ASR 上传前必须得到用户明确确认。

机器可读结构见 `schemas/project-excalicord-v2.schema.json`，运行时归一化与 v1 迁移见 `src/editor-core.js`。
