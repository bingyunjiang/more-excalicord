---
name: more-excalicord
description: Maintain and deploy the local more-excalicord Excalidraw enhancement plugin, including slide navigation, whiteboard controls, recording, camera, teleprompter, and local scene persistence.
metadata:
  short-description: Local Excalidraw slide and recording plugin
---

# more-excalicord

Use this skill when the user asks to modify, verify, deploy, sync, or publish the local more-excalicord Excalidraw enhancement.

## Source of truth

- Treat this skill folder as the source repository.
- Treat /Users/Bing/.local/share/excalidraw/ as a runtime deployment target.
- Do not edit the runtime target as the long-term source. If a hotfix is made there, run npm run sync:from-live before committing.
- Do not commit user scene files such as scene.excalidraw or scene.json.

## Normal workflow

1. Modify files under src/, server/, scripts/, or docs.
2. Run npm run check.
3. Deploy locally with npm run deploy:local.
4. Verify the visible page at http://localhost:5001/.
5. Commit and push only after the deployed behavior is checked.

## Important boundaries

- Keep user-facing UI wording in Chinese unless the user asks otherwise.
- User-facing labels should say “幻灯片”, not “Frame”.
- Preserve Excalidraw native controls; plugin controls belong inside the more-excalicord toolbar and panels.
- Recording changes require real playback verification before claiming final recording acceptance.
- Keep local scenes, recordings, browser profiles, caches, credentials, and backups out of Git.

## Helpful commands

- npm run check: static and consistency checks.
- npm run deploy:local: deploy repository files to the local Excalidraw runtime.
- npm run sync:from-live: recover current deployed runtime files back into this repository.
- npm run verify:deploy: compare repository files with deployed runtime files.
- npm run status: show local Git and deployment consistency.
