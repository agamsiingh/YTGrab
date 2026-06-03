const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const youtubedl = require('youtube-dl-exec');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

// Determine the yt-dlp binary path
// On Render (Linux), we install it via build.sh to ./yt-dlp
// Locally, youtube-dl-exec bundles its own binary
const localYtdlp = path.join(__dirname, 'yt-dlp');
const ytdlpPath = fs.existsSync(localYtdlp) ? localYtdlp : undefined;

// Create a configured yt-dlp instance
const ytdlp = ytdlpPath
  ? youtubedl.create(ytdlpPath)
  : youtubedl;

console.log(`🔧 yt-dlp binary: ${ytdlpPath || 'bundled default'}`);
console.log(`🔧 ffmpeg binary: ${ffmpeg}`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Validate YouTube URL
function isValidYouTubeUrl(url) {
  const patterns = [
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
    /^(https?:\/\/)?youtu\.be\/[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]{11}/,
    /^(https?:\/\/)?(m\.)?youtube\.com\/watch\?v=[\w-]{11}/,
  ];
  return patterns.some(pattern => pattern.test(url));
}

// Health check / debug endpoint
app.get('/api/health', (req, res) => {
  const localBinExists = fs.existsSync(localYtdlp);
  res.json({
    status: 'ok',
    ytdlp_path: ytdlpPath || 'bundled',
    ytdlp_local_exists: localBinExists,
    ffmpeg_path: ffmpeg,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
  });
});

// Get video info
app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL. Please provide a valid YouTube video link.' });
  }

  try {
    const info = await ytdlp(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
    });

    const formats = [];
    const seen = new Set();

    if (info.formats) {
      for (const f of info.formats) {
        // We include ALL video streams because yt-dlp + ffmpeg will merge them with the best audio
        if (f.vcodec && f.vcodec !== 'none' && f.height) {
          const key = `${f.height}p`;
          // Keep the first (usually highest quality) format for each resolution
          if (!seen.has(key)) {
            seen.add(key);
            formats.push({
              format_id: f.format_id,
              ext: f.ext,
              quality: `${f.height}p`,
              height: f.height,
              filesize: f.filesize || f.filesize_approx || null,
              type: 'video',
              note: f.vcodec,
            });
          }
        }
      }
    }

    // Sort by quality (highest first)
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    // If no formats found for some reason, provide a generic fallback
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

    // Add audio-only option
    formats.push({
      format_id: 'bestaudio',
      ext: 'mp3',
      quality: 'Audio Only',
      height: 0,
      filesize: null,
      type: 'audio',
      note: 'Best audio quality',
    });

    const response = {
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      duration_string: info.duration_string,
      channel: info.channel || info.uploader,
      view_count: info.view_count,
      upload_date: info.upload_date,
      description: info.description ? info.description.substring(0, 300) : '',
      formats: formats,
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching video info:', error.message);
    console.error('Full error:', error.stderr || error);
    res.status(500).json({
      error: 'Failed to fetch video information. Please check the URL and try again.',
    });
  }
});

const jobs = new Map();

// Start download job
app.get('/api/download/start', async (req, res) => {
  const { url, format_id, title } = req.query;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  if (!isValidYouTubeUrl(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

  const jobId = uuidv4();
  const sanitizedTitle = (title || 'video').replace(/[^a-zA-Z0-9\s\-_]/g, '').substring(0, 100);
  const isAudio = format_id === 'bestaudio';
  
  let ext = isAudio ? 'mp3' : 'mp4';
  const tempOutputPath = path.join(tempDir, `${jobId}.${ext}`);

  jobs.set(jobId, { status: 'downloading', progress: '0%', filename: `${sanitizedTitle}.${ext}`, path: tempOutputPath });

  res.json({ jobId });

  const options = {
    noCheckCertificates: true,
    noWarnings: true,
    ffmpegLocation: ffmpeg,
    output: tempOutputPath,
    concurrentFragments: 8,
    bufferSize: '16K',
    httpChunkSize: '10M',
    retries: 10,
    fragmentRetries: 10,
    noPart: true,
  };

  if (isAudio) {
    options.format = 'bestaudio';
    options.extractAudio = true;
    options.audioFormat = 'mp3';
  } else {
    if (format_id && format_id !== 'best') {
      options.format = `${format_id}+bestaudio[ext=m4a]/bestaudio/best`;
    } else {
      options.format = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
    }
    options.mergeOutputFormat = 'mp4';
  }

  try {
    // Use the correct binary for exec too
    const execFn = ytdlpPath
      ? youtubedl.create(ytdlpPath)
      : youtubedl;

    const subprocess = execFn.exec(url, options);
    
    subprocess.stdout.on('data', (data) => {
      const text = data.toString();
      const match = text.match(/\[download\]\s+([\d\.]+)%/);
      if (match) {
        const job = jobs.get(jobId);
        if (job) {
          job.progress = match[1] + '%';
        }
      }
    });

    subprocess.on('close', (code) => {
      const job = jobs.get(jobId);
      if (job) {
        if (code === 0) {
          job.status = 'done';
          job.progress = '100%';
        } else {
          job.status = 'error';
          console.error(`Download job ${jobId} exited with code ${code}`);
        }
      }
    });
    
    subprocess.on('error', (err) => {
      const job = jobs.get(jobId);
      if (job) job.status = 'error';
      console.error(`Download job ${jobId} error:`, err.message);
    });
  } catch (error) {
    const job = jobs.get(jobId);
    if (job) job.status = 'error';
    console.error(`Download job ${jobId} catch error:`, error.message);
  }
});

// Check job status
app.get('/api/download/status', (req, res) => {
  const { id } = req.query;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress });
});

// Serve the file
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
  console.log(`\n🎬 YouTube Video Downloader is running!`);
  console.log(`📡 Open http://localhost:${PORT} in your browser\n`);
});
