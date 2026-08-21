# more-excalicord

more-excalicord is a local Excalidraw enhancement plugin for slide-style whiteboard navigation, presentation, recording, camera picture-in-picture, teleprompter, and whiteboard view controls.

中文说明见 README.zh-CN.md。

This repository may live under /Users/Bing/.codex/skills for local organization, but it is not a Codex skill. It intentionally does not include SKILL.md or agents/openai.yaml.

## Start here

Chinese documentation is the primary user documentation:

1. [快速开始](docs/quickstart.zh-CN.md)
2. [安装与部署](docs/install.zh-CN.md)
3. [使用说明](docs/user-guide.zh-CN.md)
4. [常见问题](docs/troubleshooting.zh-CN.md)

Maintainers should also read:

- [开发与同步](docs/developer-guide.zh-CN.md)
- [GitHub 发布检查清单](docs/release-checklist.zh-CN.md)

## What is included

- Slide toolbar based on Excalidraw frames
- Slide overview with real content previews, multi-select, delete, rename, and reorder
- Whiteboard controls: overview, zoom, focus, undo, redo, presentation
- Smart slide snapping, grid visibility, and alignment guides
- Local recording panel with screen/window, whiteboard, and current slide scopes
- Camera picture-in-picture and optional composition into exported video
- Teleprompter panel for presentation recording
- Local scene persistence endpoint used by slide add/delete/reorder operations

## Repository model

Source code lives in this repository. The local Excalidraw runtime under /Users/Bing/.local/share/excalidraw is only a deployment target.

Use these commands:

    npm run check
    npm run deploy:local
    npm run verify:deploy
    npm run sync:from-live
    npm run status
    npm run pack:release

## Do not commit

Do not commit scene.excalidraw, scene.json, local recordings, browser caches, backups, or personal whiteboard content.

## Example scenes

Sanitized example whiteboards can be placed under examples/, for example:

    examples/demo-scene.excalidraw

Example files may be committed. Real working scenes and runtime scene.excalidraw / scene.json files should stay local.

## License

MIT
