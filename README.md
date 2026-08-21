# more-excalicord

more-excalicord is a local Excalidraw enhancement plugin for slide-style whiteboard navigation, presentation, recording, camera picture-in-picture, teleprompter, and whiteboard view controls.

中文说明见 README.zh-CN.md。

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

## Do not commit

Do not commit scene.excalidraw, scene.json, local recordings, browser caches, backups, or personal whiteboard content.

## License

MIT
