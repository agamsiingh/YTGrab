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

// ═══════════════════════════════════════════════════════
// PIPED API — YouTube proxy that bypasses IP blocking
// ═══════════════════════════════════════════════════════
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.r4fo.com',
  'https://pipedapi.in.projectsegfau.lt',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.adminforge.de',
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ═══════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function isValidYouTubeUrl(url) {
  return extractVideoId(url) !== null;
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

// Fetch JSON from URL (with redirect support)
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSON(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Download a file from URL to disk (streaming, low memory)
function downloadFile(fileUrl, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    function doRequest(url) {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 600000, // 10 min timeout for large files
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          doRequest(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
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

// Merge video + audio with ffmpeg
function mergeMedia(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const audioExt = path.extname(audioPath).toLowerCase();
    const audioCodec = ['.m4a', '.mp4', '.aac'].includes(audioExt) ? 'copy' : 'aac';

    const args = [
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', audioCodec,
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ];

    console.log(`🔧 ffmpeg: merging video + audio (audio codec: ${audioCodec})`);
    const proc = spawn(ffmpegPath, args);

    let stderr = '';
    proc.stderr.on('data', (d) => stderr += d.toString());

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        console.error('ffmpeg error (last 300 chars):', stderr.slice(-300));
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

// Convert audio to mp3
function convertToMp3(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', inputPath, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', '-y', outputPath,
    ]);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mp3 conversion failed (code ${code})`));
    });
    proc.on('error', reject);
  });
}

// Fetch video info from Piped API (tries multiple instances)
async function fetchFromPiped(videoId) {
  let lastError;

  for (const instance of PIPED_INSTANCES) {
    try {
      console.log(`📡 Trying: ${instance}/streams/${videoId}`);
      const data = await fetchJSON(`${instance}/streams/${videoId}`);
      if (data.error) throw new Error(data.error);
      console.log(`✅ Success from ${instance}`);
      return data;
    } catch (err) {
      console.error(`❌ ${instance}: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('All Piped API instances are unavailable');
}

// Pick best video stream for a target resolution
function getBestVideoStream(streams, targetHeight) {
  if (!streams || streams.length === 0) return null;

  // Only video-only adaptive streams
  const filtered = streams.filter(s => s.videoOnly !== false);
  if (filtered.length === 0) return streams[0];

  if (targetHeight > 0) {
    // Exact match first
    const exact = filtered.find(s => s.height === targetHeight);
    if (exact) return exact;

    // Closest match ≤ target
    const sorted = [...filtered].sort((a, b) => (b.height || 0) - (a.height || 0));
    const closest = sorted.find(s => (s.height || 0) <= targetHeight);
    if (closest) return closest;
  }

  // Default: highest quality
  return [...filtered].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
}

// Pick best audio stream (highest bitrate)
function getBestAudioStream(streams) {
  if (!streams || streams.length === 0) return null;
  return [...streams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
}

// ═══════════════════════════════════════════════════════
// EXPRESS SETUP
// ═══════════════════════════════════════════════════════

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

console.log(`🔧 ffmpeg: ${ffmpegPath}`);

// ═══════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    method: 'piped-api',
    ffmpeg: ffmpegPath,
    instances: PIPED_INSTANCES,
    node: process.version,
    platform: process.platform,
  });
});

// Get video info
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL. Please provide a valid YouTube video link.' });

  try {
    const data = await fetchFromPiped(videoId);

    const formats = [];
    const seen = new Set();

    // Process video streams
    if (data.videoStreams) {
      for (const s of data.videoStreams) {
        if (s.quality && s.height && !seen.has(s.quality)) {
          seen.add(s.quality);
          formats.push({
            format_id: String(s.height),
            ext: s.format === 'MPEG_4' ? 'mp4' : 'webm',
            quality: s.quality,
            height: s.height,
            filesize: s.contentLength ? parseInt(s.contentLength) : null,
            type: 'video',
            note: s.codec || s.format || '',
          });
        }
      }
    }

    // Sort highest first
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    // Fallback
    if (formats.length === 0) {
      formats.push({
        format_id: 'best',
        ext: 'mp4',
        quality: 'Best Available',
        height: 0,
        filesize: null,
        type: 'video',
        note: 'Best quality',
      });
    }

    // Audio option
    formats.push({
      format_id: 'bestaudio',
      ext: 'mp3',
      quality: 'Audio Only',
      height: 0,
      filesize: null,
      type: 'audio',
      note: 'Best audio quality',
    });

    res.json({
      title: data.title || 'Unknown',
      thumbnail: data.thumbnailUrl || '',
      duration: data.duration || 0,
      duration_string: formatDuration(data.duration),
      channel: data.uploader || 'Unknown',
      view_count: data.views || 0,
      upload_date: data.uploadDate || '',
      description: data.description ? data.description.substring(0, 300) : '',
      formats,
    });
  } catch (error) {
    console.error('Info error:', error.message);
    res.status(500).json({
      error: 'Failed to fetch video information. Please check the URL and try again.',
    });
  }
});

// ═══════════════════════════════════════════════════════
// DOWNLOAD ENDPOINTS
// ═══════════════════════════════════════════════════════

const jobs = new Map();

app.get('/api/download/start', async (req, res) => {
  const { url, format_id, title } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const jobId = uuidv4();
  const sanitizedTitle = (title || 'video').replace(/[^a-zA-Z0-9\s\-_]/g, '').substring(0, 100);
  const isAudio = format_id === 'bestaudio';
  const ext = isAudio ? 'mp3' : 'mp4';
  const outputPath = path.join(tempDir, `${jobId}.${ext}`);

  jobs.set(jobId, {
    status: 'downloading',
    progress: '0%',
    filename: `${sanitizedTitle}.${ext}`,
    path: outputPath,
  });

  res.json({ jobId });

  // Process in background
  processDownload(jobId, videoId, format_id, isAudio, outputPath).catch((err) => {
    console.error(`Job ${jobId} failed:`, err.message);
    const job = jobs.get(jobId);
    if (job && job.status !== 'done') job.status = 'error';
  });
});

async function processDownload(jobId, videoId, formatId, isAudio, outputPath) {
  const job = jobs.get(jobId);

  // Step 1: Get stream URLs from Piped
  job.progress = '5%';
  console.log(`📥 Job ${jobId}: fetching streams...`);
  const data = await fetchFromPiped(videoId);

  if (isAudio) {
    // ── AUDIO-ONLY ──
    const audioStream = getBestAudioStream(data.audioStreams);
    if (!audioStream) throw new Error('No audio stream available');

    job.progress = '10%';
    console.log(`📥 Job ${jobId}: downloading audio (${audioStream.quality})...`);

    const tempAudio = path.join(tempDir, `${jobId}_audio.${getExtFromMime(audioStream.mimeType)}`);
    await downloadFile(audioStream.url, tempAudio);

    job.progress = '70%';
    console.log(`📥 Job ${jobId}: converting to mp3...`);
    await convertToMp3(tempAudio, outputPath);

    fs.unlink(tempAudio, () => {});
  } else {
    // ── VIDEO + AUDIO ──
    const targetHeight = parseInt(formatId) || 0;
    const videoStream = getBestVideoStream(data.videoStreams, targetHeight);
    const audioStream = getBestAudioStream(data.audioStreams);

    if (!videoStream) throw new Error('No video stream available');
    if (!audioStream) throw new Error('No audio stream available');

    // Download video
    job.progress = '10%';
    console.log(`📥 Job ${jobId}: downloading video (${videoStream.quality})...`);
    const tempVideo = path.join(tempDir, `${jobId}_video.${getExtFromMime(videoStream.mimeType)}`);
    await downloadFile(videoStream.url, tempVideo);

    // Download audio
    job.progress = '50%';
    console.log(`📥 Job ${jobId}: downloading audio...`);
    const tempAudio = path.join(tempDir, `${jobId}_audio.${getExtFromMime(audioStream.mimeType)}`);
    await downloadFile(audioStream.url, tempAudio);

    // Merge with ffmpeg
    job.progress = '80%';
    console.log(`📥 Job ${jobId}: merging...`);
    await mergeMedia(tempVideo, tempAudio, outputPath);

    fs.unlink(tempVideo, () => {});
    fs.unlink(tempAudio, () => {});
  }

  job.status = 'done';
  job.progress = '100%';
  console.log(`✅ Job ${jobId}: complete!`);
}

// Status check
app.get('/api/download/status', (req, res) => {
  const { id } = req.query;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress });
});

// Serve downloaded file
app.get('/api/download/file', (req, res) => {
  const { id } = req.query;
  const job = jobs.get(id);
  if (!job || job.status !== 'done') return res.status(404).send('File not found or not ready');

  res.setHeader('Content-Type', job.filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);

  const fileStream = fs.createReadStream(job.path);
  fileStream.pipe(res);
  fileStream.on('close', () => {
    fs.unlink(job.path, () => {});
    jobs.delete(id);
  });
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🎬 YTGrab is running!`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`🔄 Using Piped API — no cookies needed\n`);
});
