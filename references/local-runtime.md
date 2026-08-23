# Local runtime mapping

Repository files map to the local Excalidraw runtime as follows:

- src/studio-recorder.js -> public/recorder/studio-recorder.js and excalidraw-app/build/recorder/studio-recorder.js
- src/recorder.css -> public/recorder/recorder.css and excalidraw-app/build/recorder/recorder.css
- src/native-bridge.js -> public/recorder/native-bridge.js and excalidraw-app/build/recorder/native-bridge.js
- src/editor-core.js -> public/recorder/editor-core.js and excalidraw-app/build/recorder/editor-core.js
- src/editor-store.js -> public/recorder/editor-store.js and excalidraw-app/build/recorder/editor-store.js
- src/editor-io.js -> public/recorder/editor-io.js and excalidraw-app/build/recorder/editor-io.js
- src/rough-cut-core.js -> public/recorder/rough-cut-core.js and excalidraw-app/build/recorder/rough-cut-core.js
- src/smart-camera-core.js -> public/recorder/smart-camera-core.js and excalidraw-app/build/recorder/smart-camera-core.js
- src/post-editor.js -> public/recorder/post-editor.js and excalidraw-app/build/recorder/post-editor.js
- src/post-editor.css -> public/recorder/post-editor.css and excalidraw-app/build/recorder/post-editor.css
- src/vendor/ -> public/recorder/vendor/ and excalidraw-app/build/recorder/vendor/
- server/no-cache-server.js -> excalidraw-app/no-cache-server.js
- server/render-core.js -> excalidraw-app/render-core.js
- server/render_caption_overlays.py -> excalidraw-app/render_caption_overlays.py
- server/transcribe_audio.py -> excalidraw-app/transcribe_audio.py

The deployment scripts intentionally do not copy scene.excalidraw or scene.json into the repository.
