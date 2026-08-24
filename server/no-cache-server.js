const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const renderCore = require('./render-core.js');

const BUILD_DIR = path.join(__dirname, 'build');
const PORT = 5001;
const MAX_RENDER_BODY_BYTES = 16 * 1024 * 1024;
const FFMPEG = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg';
const FFPROBE = fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe';
const CAPTION_RENDERER = path.join(__dirname, 'render_caption_overlays.py');
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe_audio.py');
const ASR_PYTHON = process.env.EXCALICORD_ASR_PYTHON
  || (fs.existsSync(path.join(__dirname, '.venv-asr/bin/python')) ? path.join(__dirname, '.venv-asr/bin/python') : 'python3');
let activeRender = null;
let lastRenderOutput = '';
let activeTranscription = null;

const MIME = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
};

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function allowedLocalOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === 'http://localhost:5001' || origin === 'http://127.0.0.1:5001';
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求内容超过允许大小'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error('请求 JSON 无效'));
      }
    });
    req.on('error', reject);
  });
}

function nativeJson(pathname, token) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: 5002,
      path: pathname,
      method: 'GET',
      headers: token ? { 'X-Excalicord-Token': token } : {},
      timeout: 2500,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(body.message || '本地录制服务不可用'));
            return;
          }
          resolve(body);
        } catch (error) {
          reject(new Error('本地录制服务返回无效数据'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('本地录制服务响应超时')));
    request.on('error', reject);
    request.end();
  });
}

async function selectedProjectRoot() {
  const health = await nativeJson('/v1/health');
  if (!health.token) throw new Error('本地录制服务未提供会话令牌');
  const folder = await nativeJson('/v1/project-folder', health.token);
  if (!folder.path || !path.isAbsolute(folder.path)) throw new Error('尚未选择项目文件夹');
  await fs.promises.mkdir(folder.path, { recursive: true });
  return fs.promises.realpath(folder.path);
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, options || {}));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 2 * 1024 * 1024) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 2 * 1024 * 1024) stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `${command} exited with ${code}`).trim()));
    });
  });
}

function shouldRetryWithSoftwareH264(error) {
  const message = error && error.message ? error.message : String(error || '');
  return /h264_videotoolbox|VideoToolbox|compression session|hardware encoder|allow_sw/i.test(message);
}

async function probeVideo(sourcePath) {
  const result = await runProcess(FFPROBE, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-of', 'json',
    sourcePath,
  ]);
  const payload = JSON.parse(result.stdout || '{}');
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('原始录制不包含视频轨');
  const frameRate = String(video.avg_frame_rate || video.r_frame_rate || '30/1').split('/');
  const fps = Number(frameRate[1]) ? Number(frameRate[0]) / Number(frameRate[1]) : 30;
  return {
    width: Number(video.width) || 1920,
    height: Number(video.height) || 1080,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    durationMs: Math.max(0, Number(payload.format && payload.format.duration || video.duration || 0) * 1000),
  };
}

async function ensureInsideProject(projectRoot, candidate) {
  const root = await fs.promises.realpath(projectRoot);
  const target = await fs.promises.realpath(candidate);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('项目素材越过项目根目录');
  return target;
}

async function serveProjectMedia(req, res) {
  const parsed = new URL(req.url, 'http://localhost:5001');
  const relativePath = renderCore.safeRelativePath(parsed.searchParams.get('path'));
  if (!renderCore.isProjectRecordingAssetPath(relativePath)) throw new Error('录制素材路径无效');
  const extension = path.extname(relativePath).toLowerCase();
  if (!['.mp4', '.mov', '.m4a', '.m4v', '.webm', '.wav'].includes(extension)) throw new Error('不支持读取该项目素材');
  const projectRoot = await selectedProjectRoot();
  const candidate = renderCore.resolveProjectPath(projectRoot, relativePath);
  const mediaPath = await ensureInsideProject(projectRoot, candidate);
  const stats = await fs.promises.stat(mediaPath);
  if (!stats.isFile()) throw new Error('项目素材不存在');
  const headers = {
    'Content-Type': MIME[extension] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!range) {
    res.writeHead(200, Object.assign(headers, { 'Content-Length': stats.size }));
    fs.createReadStream(mediaPath).pipe(res);
    return;
  }
  const requestedStart = range[1] ? Number(range[1]) : 0;
  const requestedEnd = range[2] ? Number(range[2]) : stats.size - 1;
  const start = Math.max(0, Math.min(stats.size - 1, requestedStart));
  const end = Math.max(start, Math.min(stats.size - 1, requestedEnd));
  res.writeHead(206, Object.assign(headers, {
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${stats.size}`,
  }));
  fs.createReadStream(mediaPath, { start, end }).pipe(res);
}

async function currentExportPath() {
  const projectRoot = await selectedProjectRoot();
  const expected = renderCore.resolveProjectPath(projectRoot, 'exports/final.mp4');
  if (!fs.existsSync(expected)) throw new Error('当前项目尚未导出成片');
  return ensureInsideProject(projectRoot, expected);
}

async function renderCaptions(plan, jobDir) {
  if (!plan.subtitles.length) return [];
  if (!fs.existsSync(CAPTION_RENDERER)) throw new Error('字幕渲染组件缺失');
  const configPath = path.join(jobDir, 'captions.json');
  const outputDir = path.join(jobDir, 'captions');
  await fs.promises.writeFile(configPath, JSON.stringify({ captions: plan.subtitles }), 'utf8');
  const result = await runProcess('python3', [
    CAPTION_RENDERER,
    configPath,
    outputDir,
    String(plan.width),
    String(plan.height),
  ]);
  const payload = JSON.parse(result.stdout || '{}');
  if (!payload.ok || !Array.isArray(payload.files) || payload.files.length !== plan.subtitles.length) {
    throw new Error('字幕图层生成不完整');
  }
  return payload.files;
}

async function renderPointerAssets(plan, jobDir) {
  if (!plan.cursor.visible || !plan.cursor.events.length) return {};
  if (!fs.existsSync(CAPTION_RENDERER)) throw new Error('光标渲染组件缺失');
  const outputDir = path.join(jobDir, 'pointer');
  const result = await runProcess('python3', [
    CAPTION_RENDERER,
    '--pointer-assets',
    outputDir,
    String(Math.round(42 * plan.cursor.size)),
    plan.cursor.color || '#ef4444',
  ]);
  const payload = JSON.parse(result.stdout || '{}');
  if (!payload.ok || !Array.isArray(payload.files) || payload.files.length !== 2) {
    throw new Error('光标图层生成不完整');
  }
  return { cursorPath: payload.files[0], clickPath: plan.cursor.clickEffect ? payload.files[1] : '' };
}

async function renderComposition(manifest) {
  if (activeRender && !['complete', 'error'].includes(activeRender.state)) {
    throw new Error('已有成片正在导出，请等待完成');
  }
  const jobId = crypto.randomBytes(8).toString('hex');
  activeRender = { id: jobId, state: 'preparing', startedAt: new Date().toISOString(), progress: 0 };
  let jobDir = '';
  try {
    const projectRoot = await selectedProjectRoot();
    const sourceCandidate = renderCore.resolveProjectPath(projectRoot, manifest && manifest.source && manifest.source.assets && manifest.source.assets.screen && manifest.source.assets.screen.path);
    const sourcePath = await ensureInsideProject(projectRoot, sourceCandidate);
    const probe = await probeVideo(sourcePath);
    const plan = renderCore.createRenderPlan(manifest, probe);
    const cacheRoot = renderCore.resolveProjectPath(projectRoot, 'cache');
    const exportsRoot = renderCore.resolveProjectPath(projectRoot, 'exports');
    await fs.promises.mkdir(cacheRoot, { recursive: true });
    await fs.promises.mkdir(exportsRoot, { recursive: true });
    jobDir = path.join(cacheRoot, `render-${jobId}`);
    await fs.promises.mkdir(jobDir, { recursive: false });
    activeRender.state = 'captions';
    activeRender.progress = 0.15;
    const captionPaths = await renderCaptions(plan, jobDir);
    const pointerAssets = await renderPointerAssets(plan, jobDir);
    let webcamPath = '';
    if (plan.webcam.visible) {
      if (!plan.webcam.path || !plan.webcam.path.startsWith('recordings/')) throw new Error('摄像头素材路径无效');
      webcamPath = await ensureInsideProject(projectRoot, renderCore.resolveProjectPath(projectRoot, plan.webcam.path));
    }
    const outputPath = renderCore.resolveProjectPath(projectRoot, plan.outputPath);
    const temporaryPath = path.join(jobDir, 'final.rendering.mp4');
    const overlayAssets = Object.assign({}, pointerAssets, { webcamPath });
    const ffmpegArgs = renderCore.buildFfmpegArgs(plan, sourcePath, captionPaths, temporaryPath, overlayAssets);
    activeRender.state = 'rendering';
    activeRender.progress = 0.35;
    let encoder = 'h264_videotoolbox';
    try {
      await runProcess(FFMPEG, ffmpegArgs);
    } catch (error) {
      if (!shouldRetryWithSoftwareH264(error)) throw error;
      activeRender.state = 'rendering-fallback';
      activeRender.progress = 0.45;
      encoder = 'libx264';
      await runProcess(FFMPEG, renderCore.buildFfmpegArgs(
        plan,
        sourcePath,
        captionPaths,
        temporaryPath,
        overlayAssets,
        { videoEncoder: 'libx264' },
      ));
    }
    const stats = await fs.promises.stat(temporaryPath);
    if (!stats.isFile() || stats.size < 1024) throw new Error('导出的 MP4 文件为空');
    await fs.promises.rename(temporaryPath, outputPath);
    lastRenderOutput = outputPath;
    const result = {
      ok: true,
      jobId,
      state: 'complete',
      outputPath,
      relativePath: plan.outputPath,
      bytes: stats.size,
      durationMs: plan.outputDurationMs,
      subtitleCount: plan.subtitles.length,
      cameraKeyframeCount: plan.camera.length,
      cursorEventCount: plan.cursor.events.length,
      webcamApplied: Boolean(webcamPath),
      encoder,
    };
    activeRender = Object.assign({}, result, { progress: 1 });
    return result;
  } catch (error) {
    activeRender = { id: jobId, state: 'error', progress: 0, message: error.message || String(error) };
    throw error;
  } finally {
    if (jobDir) fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeRecording(relativePath, language, contextTerms) {
  if (activeTranscription && activeTranscription.state === 'running') {
    throw new Error('已有逐字稿正在生成，请等待完成');
  }
  const safePath = renderCore.safeRelativePath(relativePath);
  if (!renderCore.isProjectRecordingAssetPath(safePath)) throw new Error('录音素材路径无效');
  if (!fs.existsSync(TRANSCRIBE_SCRIPT)) throw new Error('本地逐字稿组件缺失');
  const jobId = crypto.randomBytes(8).toString('hex');
  activeTranscription = { id: jobId, state: 'running', startedAt: new Date().toISOString() };
  try {
    const projectRoot = await selectedProjectRoot();
    const sourceCandidate = renderCore.resolveProjectPath(projectRoot, safePath);
    const sourcePath = await ensureInsideProject(projectRoot, sourceCandidate);
    const outputPath = renderCore.resolveProjectPath(projectRoot, 'text/transcript.raw.json');
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    const terms = (Array.isArray(contextTerms) ? contextTerms : []).map((term) => String(term || '').trim())
      .filter((term) => term && term.length <= 100)
      .slice(0, 200);
    const result = await runProcess(ASR_PYTHON, [
      TRANSCRIBE_SCRIPT,
      sourcePath,
      outputPath,
      /^[A-Za-z-]{2,16}$/.test(language || '') ? language : 'zh',
    ], {
      env: Object.assign({}, process.env, { EXCALICORD_ASR_HOTWORDS: terms.join(' ').slice(0, 4000) }),
    });
    const lines = result.stdout.trim().split(/\n/);
    const payload = JSON.parse(lines[lines.length - 1] || '{}');
    if (!payload.ok || !payload.transcript) throw new Error('逐字稿生成结果不完整');
    activeTranscription = {
      id: jobId,
      state: 'complete',
      outputPath,
      segmentCount: payload.transcript.segments.length,
      durationMs: payload.transcript.durationMs,
    };
    return Object.assign({ jobId, relativePath: 'text/transcript.raw.json' }, payload);
  } catch (error) {
    activeTranscription = { id: jobId, state: 'error', message: error.message || String(error) };
    throw error;
  }
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/api/project-media' && !allowedLocalOrigin(req)) {
    jsonResponse(res, 403, { ok: false, error: '仅允许本地 more-excalicord 页面读取项目素材' });
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/project-media') {
    serveProjectMedia(req, res).catch((error) => jsonResponse(res, /不存在/.test(error.message || '') ? 404 : 400, {
      ok: false,
      error: error.message || String(error),
    }));
    return;
  }
  if (urlPath.startsWith('/api/render') && !allowedLocalOrigin(req)) {
    jsonResponse(res, 403, { ok: false, error: '仅允许本地 more-excalicord 页面调用导出服务' });
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/render/status') {
    jsonResponse(res, 200, { ok: true, render: activeRender, outputPath: lastRenderOutput || null });
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/render/open') {
    currentExportPath().then((outputPath) => runProcess('/usr/bin/open', ['-R', outputPath]).then(() => outputPath))
      .then((outputPath) => {
        lastRenderOutput = outputPath;
        jsonResponse(res, 200, { ok: true, outputPath });
      })
      .catch((error) => jsonResponse(res, /尚未/.test(error.message || '') ? 404 : 500, { ok: false, error: error.message }));
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/render') {
    readJsonBody(req, MAX_RENDER_BODY_BYTES).then((body) => renderComposition(body && body.manifest))
      .then((result) => jsonResponse(res, 200, result))
      .catch((error) => jsonResponse(res, /已有成片/.test(error.message || '') ? 409 : 400, {
        ok: false,
        error: error.message || String(error),
      }));
    return;
  }
  if (urlPath.startsWith('/api/transcribe') && !allowedLocalOrigin(req)) {
    jsonResponse(res, 403, { ok: false, error: '仅允许本地 more-excalicord 页面调用逐字稿服务' });
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/transcribe/status') {
    jsonResponse(res, 200, { ok: true, transcription: activeTranscription });
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/transcribe') {
    readJsonBody(req, 1024 * 1024).then((body) => transcribeRecording(
      body && body.relativePath,
      body && body.language,
      body && body.contextTerms,
    ))
      .then((result) => jsonResponse(res, 200, result))
      .catch((error) => jsonResponse(res, /已有逐字稿/.test(error.message || '') ? 409 : 400, {
        ok: false,
        error: error.message || String(error),
      }));
    return;
  }
  /* POST /api/save-scene -- persist scene back to scene.excalidraw + bump version */
  if (req.method === 'POST' && urlPath === '/api/save-scene') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const scene = JSON.parse(body);
        const scenePath = path.join(BUILD_DIR, 'scene.excalidraw');
        fs.writeFileSync(scenePath, JSON.stringify(scene, null, 2), 'utf8');
        const now = new Date();
        const ts = String(now.getFullYear())
          + String(now.getMonth() + 1).padStart(2, '0')
          + String(now.getDate()).padStart(2, '0')
          + String(now.getHours()).padStart(2, '0')
          + String(now.getMinutes()).padStart(2, '0')
          + String(now.getSeconds()).padStart(2, '0');
        const versionPath = path.join(BUILD_DIR, 'scene.json');
        fs.writeFileSync(versionPath, JSON.stringify({ version: ts }), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: ts }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  
  const filePath = path.join(BUILD_DIR, urlPath);
  const ext = path.extname(filePath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

server.listen(PORT, 'localhost', () => {
  console.log('No-cache server running on http://localhost:' + PORT);
});
