# Local runtime mapping

Repository files map to the local Excalidraw runtime as follows:

- src/studio-recorder.js -> public/recorder/studio-recorder.js and excalidraw-app/build/recorder/studio-recorder.js
- src/recorder.css -> public/recorder/recorder.css and excalidraw-app/build/recorder/recorder.css
- src/native-bridge.js -> public/recorder/native-bridge.js and excalidraw-app/build/recorder/native-bridge.js
- src/vendor/ -> public/recorder/vendor/ and excalidraw-app/build/recorder/vendor/
- server/no-cache-server.js -> excalidraw-app/no-cache-server.js

The deployment scripts intentionally do not copy scene.excalidraw or scene.json into the repository.
