const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('ffmpeg-static');
const path = require('path');

const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const options = {
  noCheckCertificates: true,
  noWarnings: true,
  ffmpegLocation: ffmpeg, // Use NO QUOTES to see if it fixes it
  output: path.join(__dirname, 'temp', 'test_download.mp4'),
  format: '137+bestaudio/best', // 1080p
  mergeOutputFormat: 'mp4'
};

console.log('Testing with ffmpegLocation:', options.ffmpegLocation);

const subprocess = youtubedl.exec(url, options);

subprocess.stdout.on('data', (data) => console.log('STDOUT:', data.toString().trim()));
subprocess.stderr.on('data', (data) => console.log('STDERR:', data.toString().trim()));

subprocess.on('close', (code) => {
  console.log('Finished with code:', code);
});
