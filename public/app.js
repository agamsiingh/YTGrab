// ================================
// YouTube Video Downloader — App Logic
// ================================

let currentVideoInfo = null;
let selectedFormatId = null;

// DOM Elements
const urlInput = document.getElementById('url-input');
const fetchBtn = document.getElementById('fetch-btn');
const errorContainer = document.getElementById('error-container');
const errorMessage = document.getElementById('error-message');
const videoSection = document.getElementById('video-section');
const videoThumbnail = document.getElementById('video-thumbnail');
const videoTitle = document.getElementById('video-title');
const videoChannel = document.getElementById('video-channel');
const videoViews = document.getElementById('video-views');
const durationBadge = document.getElementById('duration-badge');
const formatGrid = document.getElementById('format-grid');
const downloadBtn = document.getElementById('download-btn');

// ================================
// Event Listeners
// ================================
urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        fetchVideoInfo();
    }
});

// Handle paste event — auto-fetch after paste
urlInput.addEventListener('paste', () => {
    setTimeout(() => {
        const val = urlInput.value.trim();
        if (val && isValidYouTubeUrl(val)) {
            fetchVideoInfo();
        }
    }, 100);
});

// Clear error on input
urlInput.addEventListener('input', () => {
    hideError();
});

// ================================
// URL Validation
// ================================
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

// ================================
// Fetch Video Info
// ================================
async function fetchVideoInfo() {
    const url = urlInput.value.trim();

    if (!url) {
        showError('Please paste a YouTube video link.');
        urlInput.focus();
        return;
    }

    if (!isValidYouTubeUrl(url)) {
        showError('Invalid YouTube URL. Try a link like: youtube.com/watch?v=...');
        return;
    }

    // Set loading state
    setLoading(true);
    hideError();
    videoSection.classList.remove('visible');

    try {
        const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to fetch video info');
        }

        currentVideoInfo = data;
        renderVideoInfo(data);
    } catch (error) {
        showError(error.message || 'Something went wrong. Please try again.');
    } finally {
        setLoading(false);
    }
}

// ================================
// Render Video Info
// ================================
function renderVideoInfo(data) {
    // Set thumbnail
    videoThumbnail.src = data.thumbnail || '';
    videoThumbnail.alt = data.title || 'Video Thumbnail';

    // Set title
    videoTitle.textContent = data.title || 'Unknown Title';

    // Set channel
    videoChannel.textContent = data.channel || 'Unknown Channel';

    // Set views
    videoViews.textContent = formatViews(data.view_count) + ' views';

    // Set duration
    durationBadge.textContent = data.duration_string || formatDuration(data.duration);

    // Render formats
    renderFormats(data.formats);

    // Show section with animation
    videoSection.classList.add('visible');

    // Scroll to video section
    setTimeout(() => {
        videoSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
}

// ================================
// Render Format Options
// ================================
function renderFormats(formats) {
    formatGrid.innerHTML = '';
    selectedFormatId = null;

    formats.forEach((format, index) => {
        const isVideo = format.type === 'video';
        const div = document.createElement('div');
        div.className = 'format-option';

        const inputEl = document.createElement('input');
        inputEl.type = 'radio';
        inputEl.name = 'format';
        inputEl.id = `format-${index}`;
        inputEl.value = format.format_id;

        if (index === 0) {
            inputEl.checked = true;
            selectedFormatId = format.format_id;
        }

        inputEl.addEventListener('change', () => {
            selectedFormatId = format.format_id;
        });

        const label = document.createElement('label');
        label.htmlFor = `format-${index}`;

        // Icon
        const iconSpan = document.createElement('span');
        iconSpan.className = 'format-type-icon';
        if (isVideo) {
            iconSpan.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/><line x1="17" y1="17" x2="22" y2="17"/></svg>`;
        } else {
            iconSpan.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
        }

        // Text
        const textSpan = document.createElement('span');
        let qualityText = format.quality;
        if (format.filesize) {
            qualityText += ` · ${formatFileSize(format.filesize)}`;
        }
        textSpan.textContent = qualityText;

        label.appendChild(iconSpan);
        label.appendChild(textSpan);

        div.appendChild(inputEl);
        div.appendChild(label);
        formatGrid.appendChild(div);
    });
}

// ================================
// Download Video
// ================================
async function downloadVideo() {
    if (!currentVideoInfo) {
        showError('No video loaded. Please fetch a video first.');
        return;
    }

    const formatId = selectedFormatId || 'best';
    const url = urlInput.value.trim();
    const title = currentVideoInfo.title || 'video';

    // UI Feedback
    downloadBtn.classList.add('downloading');
    const btnText = downloadBtn.querySelector('span');
    const originalText = btnText.textContent;
    btnText.textContent = 'Preparing...';

    try {
        // Start download job
        const startRes = await fetch(`/api/download/start?url=${encodeURIComponent(url)}&format_id=${encodeURIComponent(formatId)}&title=${encodeURIComponent(title)}`);
        const startData = await startRes.json();

        if (!startRes.ok) throw new Error(startData.error || 'Failed to start download');

        const jobId = startData.jobId;

        // Poll for status
        const pollInterval = setInterval(async () => {
            try {
                const statusRes = await fetch(`/api/download/status?id=${jobId}`);
                const statusData = await statusRes.json();

                if (statusData.status === 'downloading') {
                    btnText.textContent = `Downloading... ${statusData.progress || '0%'}`;
                } else if (statusData.status === 'done') {
                    clearInterval(pollInterval);
                    btnText.textContent = 'Ready! Starting download...';
                    
                    // Trigger actual file download
                    const a = document.createElement('a');
                    a.href = `/api/download/file?id=${jobId}`;
                    a.download = '';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);

                    // Reset button
                    setTimeout(() => {
                        downloadBtn.classList.remove('downloading');
                        btnText.textContent = originalText;
                    }, 3000);
                } else if (statusData.status === 'error') {
                    throw new Error('Download failed on server');
                }
            } catch (err) {
                clearInterval(pollInterval);
                showError(err.message || 'Download failed');
                downloadBtn.classList.remove('downloading');
                btnText.textContent = originalText;
            }
        }, 1000);

    } catch (error) {
        showError(error.message || 'Download failed');
        downloadBtn.classList.remove('downloading');
        btnText.textContent = originalText;
    }
}

// ================================
// UI Helpers
// ================================
function setLoading(isLoading) {
    if (isLoading) {
        fetchBtn.classList.add('loading');
        fetchBtn.disabled = true;
        urlInput.disabled = true;
    } else {
        fetchBtn.classList.remove('loading');
        fetchBtn.disabled = false;
        urlInput.disabled = false;
    }
}

function showError(message) {
    errorMessage.textContent = message;
    errorContainer.classList.add('visible');
}

function hideError() {
    errorContainer.classList.remove('visible');
}

// ================================
// Formatters
// ================================
function formatViews(count) {
    if (!count) return '0';
    if (count >= 1000000000) return (count / 1000000000).toFixed(1) + 'B';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toLocaleString();
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(0) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
}
