const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// ═════════════════════════════════════════════════════════════
// INSTANCE LISTS — Piped + Invidious (lots of fallbacks)
// ═════════════════════════════════════════════════════════════
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.in.projectsegfau.lt',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.leptons.xyz',
];

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://iv.datura.network',
  'https://invidious.jing.rocks',
  'https://vid.puffyan.us',
  'https://inv.tux.pizza',
  'https://invidious.protokoll-11.dev',
  'https://yewtu.be',
  'https://inv.in.projectsegfau.lt',
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Cache last working instance for speed
let lastWorkingInstance = null;

// ═════════════════════════════════════════════════════════════
// HTTP HELPERS
// ═════════════════════════════════════════════════════════════

function fetchJSON(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSON(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    function doRequest(url, redirects = 0) {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 600000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          doRequest(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          file.close(); fs.unlink(destPath, () => {});
          reject(new Error(`Download HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      });
      req.on('error', (err) => { file.close(); fs.unlink(destPath, () => {}); reject(err); });
      req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    }
    doRequest(fileUrl);
  });
}

// ═════════════════════════════════════════════════════════════
// FFMPEG HELPERS
// ═════════════════════════════════════════════════════════════

function mergeMedia(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const audioExt = path.extname(audioPath).toLowerCase();
    const audioCodec = ['.m4a', '.mp4', '.aac'].includes(audioExt) ? 'copy' : 'aac';
    const proc = spawn(ffmpegPath, [
      '-i', videoPath, '-i', audioPath,
      '-c:v', 'copy', '-c:a', audioCodec,
      '-movflags', '+faststart', '-y', outputPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve();
      else { console.error('ffmpeg:', stderr.slice(-300)); reject(new Error(`ffmpeg code ${code}`)); }
    });
    proc.on('error', reject);
  });
}

function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', inputPath, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', '-y', outputPath,
    ]);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`mp3 convert code ${code}`)));
    proc.on('error', reject);
  });
}

// ═════════════════════════════════════════════════════════════
// VIDEO INFO FETCHERS (Piped + Invidious adapters)
// ═════════════════════════════════════════════════════════════

// Normalize Piped API response
function parsePipedResponse(data) {
  const videoStreams = [];
  const audioStreams = [];
  const seen = new Set();

  if (data.videoStreams) {
    for (const s of data.videoStreams) {
      if (s.quality && s.height && !seen.has(s.quality)) {
        seen.add(s.quality);
        videoStreams.push({
          url: s.url,
          quality: s.quality,
          height: s.height,
          mimeType: s.mimeType || 'video/mp4',
          codec: s.codec || '',
          contentLength: s.contentLength ? parseInt(s.contentLength) : null,
        });
      }
    }
  }
  if (data.audioStreams) {
    for (const s of data.audioStreams) {
      audioStreams.push({
        url: s.url,
        quality: s.quality || 'audio',
        bitrate: s.bitrate || 0,
        mimeType: s.mimeType || 'audio/mp4',
        codec: s.codec || '',
        contentLength: s.contentLength ? parseInt(s.contentLength) : null,
      });
    }
  }

  return {
    title: data.title || 'Unknown',
    thumbnail: data.thumbnailUrl || '',
    duration: data.duration || 0,
    channel: data.uploader || 'Unknown',
    views: data.views || 0,
    uploadDate: data.uploadDate || '',
    description: data.description ? data.description.substring(0, 300) : '',
    videoStreams,
    audioStreams,
  };
}

// Normalize Invidious API response
function parseInvidiousResponse(data) {
  const videoStreams = [];
  const audioStreams = [];
  const seen = new Set();

  if (data.adaptiveFormats) {
    for (const f of data.adaptiveFormats) {
      const typeStr = f.type || '';
      const isAudio = typeStr.startsWith('audio/');
      const isVideo = typeStr.startsWith('video/');
      const mime = typeStr.split(';')[0].trim();

      if (isVideo && f.qualityLabel && !seen.has(f.qualityLabel)) {
        seen.add(f.qualityLabel);
        const heightMatch = f.qualityLabel.match(/(\d+)p/);
        videoStreams.push({
          url: f.url,
          quality: f.qualityLabel,
          height: heightMatch ? parseInt(heightMatch[1]) : 0,
          mimeType: mime,
          codec: f.encoding || '',
          contentLength: f.clen ? parseInt(f.clen) : null,
        });
      } else if (isAudio) {
        audioStreams.push({
          url: f.url,
          quality: f.audioQuality || 'audio',
          bitrate: f.bitrate ? parseInt(f.bitrate) : 0,
          mimeType: mime,
          codec: f.encoding || '',
          contentLength: f.clen ? parseInt(f.clen) : null,
        });
      }
    }
  }

  // Thumbnail
  let thumbnail = '';
  if (data.videoThumbnails && data.videoThumbnails.length > 0) {
    const best = data.videoThumbnails.find(t => t.quality === 'maxresdefault')
      || data.videoThumbnails.find(t => t.quality === 'sddefault')
      || data.videoThumbnails[0];
    thumbnail = best.url || '';
    // Some Invidious instances return relative URLs
    if (thumbnail.startsWith('//')) thumbnail = 'https:' + thumbnail;
  }

  return {
    title: data.title || 'Unknown',
    thumbnail,
    duration: data.lengthSeconds || 0,
    channel: data.author || 'Unknown',
    views: data.viewCount || 0,
    uploadDate: data.published ? new Date(data.published * 1000).toISOString().split('T')[0] : '',
    description: data.description ? data.description.substring(0, 300) : '',
    videoStreams,
    audioStreams,
  };
}

// Try a single Piped instance
async function tryPiped(instance, videoId) {
  const data = await fetchJSON(`${instance}/streams/${videoId}`);
  if (data.error) throw new Error(data.error);
  if (!data.videoStreams && !data.audioStreams) throw new Error('No streams');
  return { source: 'piped', instance, ...parsePipedResponse(data) };
}

// Try a single Invidious instance (local=true for proxied URLs)
async function tryInvidious(instance, videoId) {
  const data = await fetchJSON(`${instance}/api/v1/videos/${videoId}?local=true`);
  if (data.error) throw new Error(data.error);
  if (!data.adaptiveFormats || data.adaptiveFormats.length === 0) throw new Error('No formats');
  return { source: 'invidious', instance, ...parseInvidiousResponse(data) };
}

// Main fetcher — tries all instances
async function fetchVideoInfo(videoId) {
  const errors = [];

  // Try last working instance first
  if (lastWorkingInstance) {
    try {
      const { type, url } = lastWorkingInstance;
      const result = type === 'piped' ? await tryPiped(url, videoId) : await tryInvidious(url, videoId);
      return result;
    } catch (err) {
      console.log(`⚡ Cached instance failed: ${err.message}`);
      lastWorkingInstance = null;
    }
  }

  // Try all Piped instances
  for (const inst of PIPED_INSTANCES) {
    try {
      const result = await tryPiped(inst, videoId);
      lastWorkingInstance = { type: 'piped', url: inst };
      return result;
    } catch (err) {
      errors.push(`Piped ${inst}: ${err.message}`);
    }
  }

  // Try all Invidious instances
  for (const inst of INVIDIOUS_INSTANCES) {
    try {
      const result = await tryInvidious(inst, videoId);
      lastWorkingInstance = { type: 'invidious', url: inst };
      return result;
    } catch (err) {
      errors.push(`Invidious ${inst}: ${err.message}`);
    }
  }

  console.error('All instances failed:', errors.join(' | '));
  throw new Error('All proxy instances failed. Please try again later.');
}

// ═════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getExtFromMime(mimeType) {
  if (!mimeType) return 'mp4';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('m4a')) return 'm4a';
  return 'mp4';
}

function getBestVideoStream(streams, targetHeight) {
  if (!streams || streams.length === 0) return null;
  if (targetHeight > 0) {
    const exact = streams.find(s => s.height === targetHeight);
    if (exact) return exact;
  }
  return [...streams].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
}

function getBestAudioStream(streams) {
  if (!streams || streams.length === 0) return null;
  return [...streams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

// ═════════════════════════════════════════════════════════════
// EXPRESS SETUP
// ═════════════════════════════════════════════════════════════

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// ═════════════════════════════════════════════════════════════
// ENDPOINTS
// ═════════════════════════════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    piped_count: PIPED_INSTANCES.length,
    invidious_count: INVIDIOUS_INSTANCES.length,
    cached_instance: lastWorkingInstance,
    ffmpeg: ffmpegPath,
    node: process.version,
  });
});

// Test all instances (diagnostic)
app.get('/api/test', async (req, res) => {
  const testVideoId = 'dQw4w9WgXcQ'; // Never Gonna Give You Up (always available)
  const results = [];

  for (const inst of PIPED_INSTANCES) {
    try {
      const start = Date.now();
      await tryPiped(inst, testVideoId);
      results.push({ instance: inst, type: 'piped', status: '✅ OK', ms: Date.now() - start });
    } catch (err) {
      results.push({ instance: inst, type: 'piped', status: `❌ ${err.message}` });
    }
  }

  for (const inst of INVIDIOUS_INSTANCES) {
    try {
      const start = Date.now();
      await tryInvidious(inst, testVideoId);
      results.push({ instance: inst, type: 'invidious', status: '✅ OK', ms: Date.now() - start });
    } catch (err) {
      results.push({ instance: inst, type: 'invidious', status: `❌ ${err.message}` });
    }
  }

  const working = results.filter(r => r.status.includes('OK')).length;
  res.json({ total: results.length, working, results });
});

// Get video info
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL.' });

  try {
    const info = await fetchVideoInfo(videoId);

    // Build format list for frontend
    const formats = info.videoStreams.map(s => ({
      format_id: String(s.height),
      ext: getExtFromMime(s.mimeType),
      quality: s.quality,
      height: s.height,
      filesize: s.contentLength,
      type: 'video',
      note: s.codec,
    }));

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    if (formats.length === 0) {
      formats.push({ format_id: 'best', ext: 'mp4', quality: 'Best Available', height: 0, filesize: null, type: 'video', note: 'Best quality' });
    }

    formats.push({ format_id: 'bestaudio', ext: 'mp3', quality: 'Audio Only', height: 0, filesize: null, type: 'audio', note: 'Best audio quality' });

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      duration_string: formatDuration(info.duration),
      channel: info.channel,
      view_count: info.views,
      upload_date: info.uploadDate,
      description: info.description,
      formats,
    });

    console.log(`✅ Info served for "${info.title}" via ${info.source} (${info.instance})`);
  } catch (error) {
    console.error('Info error:', error.message);
    res.status(500).json({ error: 'Failed to fetch video information. Please try again later.' });
  }
});

// ═══════════════════════════════════════
// DOWNLOAD
// ═══════════════════════════════════════

const jobs = new Map();

app.get('/api/download/start', async (req, res) => {
  const { url, format_id, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const jobId = uuidv4();
  const sanitized = (title || 'video').replace(/[^a-zA-Z0-9\s\-_]/g, '').substring(0, 100);
  const isAudio = format_id === 'bestaudio';
  const ext = isAudio ? 'mp3' : 'mp4';
  const outputPath = path.join(tempDir, `${jobId}.${ext}`);

  jobs.set(jobId, { status: 'downloading', progress: '0%', filename: `${sanitized}.${ext}`, path: outputPath });
  res.json({ jobId });

  processDownload(jobId, videoId, format_id, isAudio, outputPath).catch(err => {
    console.error(`Job ${jobId} failed:`, err.message);
    const job = jobs.get(jobId);
    if (job && job.status !== 'done') job.status = 'error';
  });
});

async function processDownload(jobId, videoId, formatId, isAudio, outputPath) {
  const job = jobs.get(jobId);
  job.progress = '5%';

  const info = await fetchVideoInfo(videoId);

  if (isAudio) {
    const audio = getBestAudioStream(info.audioStreams);
    if (!audio) throw new Error('No audio stream');

    job.progress = '10%';
    const tempAudio = path.join(tempDir, `${jobId}_a.${getExtFromMime(audio.mimeType)}`);
    await downloadFile(audio.url, tempAudio);

    job.progress = '70%';
    await convertToMp3(tempAudio, outputPath);
    fs.unlink(tempAudio, () => {});
  } else {
    const targetH = parseInt(formatId) || 0;
    const video = getBestVideoStream(info.videoStreams, targetH);
    const audio = getBestAudioStream(info.audioStreams);
    if (!video) throw new Error('No video stream');
    if (!audio) throw new Error('No audio stream');

    job.progress = '10%';
    const tempV = path.join(tempDir, `${jobId}_v.${getExtFromMime(video.mimeType)}`);
    await downloadFile(video.url, tempV);

    job.progress = '50%';
    const tempA = path.join(tempDir, `${jobId}_a.${getExtFromMime(audio.mimeType)}`);
    await downloadFile(audio.url, tempA);

    job.progress = '80%';
    await mergeMedia(tempV, tempA, outputPath);
    fs.unlink(tempV, () => {});
    fs.unlink(tempA, () => {});
  }

  job.status = 'done';
  job.progress = '100%';
  console.log(`✅ Job ${jobId}: done`);
}

app.get('/api/download/status', (req, res) => {
  const job = jobs.get(req.query.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress });
});

app.get('/api/download/file', (req, res) => {
  const job = jobs.get(req.query.id);
  if (!job || job.status !== 'done') return res.status(404).send('Not ready');
  res.setHeader('Content-Type', job.filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
  const stream = fs.createReadStream(job.path);
  stream.pipe(res);
  stream.on('close', () => { fs.unlink(job.path, () => {}); jobs.delete(req.query.id); });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🎬 YTGrab running on port ${PORT}`);
  console.log(`📡 ${PIPED_INSTANCES.length} Piped + ${INVIDIOUS_INSTANCES.length} Invidious instances`);
  console.log(`🔧 ffmpeg: ${ffmpegPath}\n`);
});
