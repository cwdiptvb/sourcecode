async function probeStreamCodecs(m3u8Url) {
  try {
    const playlistRes = await fetch(m3u8Url);
    if (!playlistRes.ok) return { needsTranscode: false, reason: 'fetch_failed' };

    const playlistText = await playlistRes.text();

    const codecMatch = playlistText.match(/CODECS="([^"]+)"/i);
    if (codecMatch) {
      const codecs = codecMatch[1].toLowerCase();

      if (codecs.includes('mp2v') || codecs.includes('mp4v.20.2') ||
          codecs.includes('mp4a.6b') || codecs.includes('ac-3')) {
        console.log(`🔍 MP2 codec detected via CODECS attribute: ${codecs}`);
        return { needsTranscode: true, reason: `codec_attr:${codecs}` };
      }
    }

    const segmentLines = playlistText.split('\n').filter(line =>
      line.trim() && !line.startsWith('#')
    );

    if (segmentLines.length === 0) return { needsTranscode: false, reason: 'no_segments' };

    const firstSegmentPath = segmentLines[0].trim();
    const firstSegmentUrl = new URL(firstSegmentPath, m3u8Url).href;

    const probeController = new AbortController();
    const probeTimeout = setTimeout(() => probeController.abort(), 5000);
    let segRes;
    try {
      segRes = await fetch(firstSegmentUrl, {
        headers: { Range: 'bytes=0-4095' },
        signal: probeController.signal
      });
    } catch (fetchErr) {
      clearTimeout(probeTimeout);

      return { needsTranscode: false, reason: 'segment_probe_timeout' };
    }
    clearTimeout(probeTimeout);

    if (!segRes.ok) return { needsTranscode: false, reason: 'segment_fetch_failed' };

    const buffer = await segRes.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x00 && bytes[i+1] === 0x00 &&
          bytes[i+2] === 0x01 && bytes[i+3] === 0xB3) {
        console.log(`🔍 MPEG-2 Video start code detected at byte ${i}`);
        return { needsTranscode: true, reason: 'mpeg2_video_startcode' };
      }
    }

    for (let i = 0; i < bytes.length - 2; i++) {
      if (bytes[i] === 0xFF) {
        const secondByte = bytes[i + 1];

        if (secondByte === 0xFD || secondByte === 0xFC || secondByte === 0xF5) {
          console.log(`🔍 MP2 Audio sync word detected at byte ${i}: FF ${secondByte.toString(16).toUpperCase()}`);
          return { needsTranscode: true, reason: 'mp2_audio_sync' };
        }
      }
    }

    return { needsTranscode: false, reason: 'no_mp2_detected' };

  } catch (err) {
    console.warn('⚠️ Codec probe error (falling back to native player):', err);
    return { needsTranscode: false, reason: 'probe_error' };
  }
}

function setFfmpegStatus(text, sub, progressPct) {
  document.getElementById('ffmpeg-status-text').textContent = text;
  if (sub !== null) document.getElementById('ffmpeg-status-sub').textContent = sub;
  if (progressPct !== undefined) {
    document.getElementById('ffmpeg-progress-bar').style.width = progressPct + '%';
  }
}

async function loadFfmpegWasm() {

  const FFMPEG_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js';
  const FFMPEG_UTIL_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js';

  setFfmpegStatus('Loading ffmpeg.wasm...', 'Downloading WebAssembly module (~30MB). One-time download.', 10);

  const { FFmpeg } = await import(FFMPEG_CDN);
  const { fetchFile } = await import(FFMPEG_UTIL_CDN);

  const ffmpeg = new FFmpeg();

  ffmpeg.on('log', ({ message }) => {

    if (message.includes('time=') || message.includes('frame=')) {
      console.debug('[ffmpeg]', message);
    }
  });

  ffmpeg.on('progress', ({ progress, time }) => {

    const pct = Math.min(Math.round(progress * 100), 99);
    if (pct > 0) {
      document.getElementById('ffmpeg-progress-bar').style.width = pct + '%';
    }
  });

  setFfmpegStatus('Initializing ffmpeg.wasm...', 'Loading MPEG-2 decoders...', 30);

  const coreUrl = typeof SharedArrayBuffer !== 'undefined'
    ? 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.6/dist/esm/ffmpeg-core.js'
    : 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js';

  await ffmpeg.load({ coreURL: coreUrl });

  setFfmpegStatus('ffmpeg.wasm ready', 'MP2 decoder loaded.', 60);
  console.log('✅ ffmpeg.wasm loaded successfully');

  return { ffmpeg, fetchFile };
}

async function resolveHlsSegments(m3u8Url) {
  const res = await fetch(m3u8Url);
  if (!res.ok) throw new Error(`Failed to fetch playlist: ${res.status}`);
  const text = await res.text();

  if (text.includes('#EXT-X-STREAM-INF')) {
    const variantLines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    if (variantLines.length === 0) throw new Error('Master playlist has no variant streams');
    const variantUrl = new URL(variantLines[0].trim(), m3u8Url).href;
    return resolveHlsSegments(variantUrl);
  }

  const segments = text.split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => new URL(l.trim(), m3u8Url).href);

  return segments;
}

async function startMp2Transcoding(m3u8Url, videoEl) {
  const { ffmpeg, fetchFile } = await loadFfmpegWasm();

  setFfmpegStatus('Buffering stream...', 'Downloading first segments...', 70);

  const mediaSource = new MediaSource();
  videoEl.src = URL.createObjectURL(mediaSource);

  let sourceBuffer;
  let segmentQueue = [];
  let isAppending = false;
  let mediaSourceOpen = false;
  let endOfStream = false;

  await new Promise(resolve => {
    mediaSource.addEventListener('sourceopen', () => {
      mediaSourceOpen = true;

      sourceBuffer = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
      sourceBuffer.mode = 'sequence';

      sourceBuffer.addEventListener('updateend', () => {
        isAppending = false;
        flushQueue();
      });

      resolve();
    });
  });

  function flushQueue() {
    if (isAppending || segmentQueue.length === 0) return;
    if (sourceBuffer.updating) return;

    const chunk = segmentQueue.shift();

    if (chunk === null) {

      if (!sourceBuffer.updating && mediaSource.readyState === 'open') {
        try { mediaSource.endOfStream(); } catch(e) {}
      }
      return;
    }

    isAppending = true;
    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (err) {
      console.error('❌ SourceBuffer append error:', err);
      isAppending = false;
    }
  }

  let segmentIndex = 0;
  let knownSegments = [];
  let isLive = true;

  async function fetchAndTranscodeSegments() {
    try {
      const allSegments = await resolveHlsSegments(m3u8Url);

      const res = await fetch(m3u8Url);
      const text = await res.text();
      isLive = !text.includes('#EXT-X-ENDLIST');

      const newSegments = allSegments.slice(segmentIndex);

      for (const segUrl of newSegments) {
        try {
          setFfmpegStatus(
            'Transcoding MP2 → H.264/AAC',
            `Segment ${segmentIndex + 1} — decoding MPEG-2...`,
            80
          );

          const segData = await fetchFile(segUrl);

          const inputName = `in_${segmentIndex}.ts`;
          const outputName = `out_${segmentIndex}.mp4`;
          await ffmpeg.writeFile(inputName, segData);

          await ffmpeg.exec([
            '-i', inputName,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4',
            outputName
          ]);

          const outputData = await ffmpeg.readFile(outputName);

          segmentQueue.push(outputData.buffer);
          flushQueue();

          await ffmpeg.deleteFile(inputName);
          await ffmpeg.deleteFile(outputName);

          segmentIndex++;

          if (segmentIndex === 1) {
            setFfmpegStatus('Playing', 'MP2 transcoding active via ffmpeg.wasm', 100);
            $('#loading-container').remove();
            $('#ffmpeg-status').hide();
            $('#transcode-video').show();
            videoEl.play().catch(e => console.warn('Autoplay blocked:', e));
          }

        } catch (segErr) {
          console.error(`❌ Failed to transcode segment ${segmentIndex}:`, segErr);
          segmentIndex++;
        }
      }

      if (isLive) {

        setTimeout(fetchAndTranscodeSegments, 3000);
      } else {

        segmentQueue.push(null);
        flushQueue();
        endOfStream = true;
        console.log('✅ VOD transcode complete.');
      }

    } catch (err) {
      console.error('❌ Segment fetch/processing error:', err);

      if (isLive) {
        setTimeout(fetchAndTranscodeSegments, 5000);
      }
    }
  }

  fetchAndTranscodeSegments();
}

    const M3U_URL = "http://iptvpro.ddns.net/tv_channels.m3u";
    let CHANNEL_NAME_MAP = {};
    let XMLTV_URL = null;
    let CURRENT_TVG_ID = null;
    let SCHEDULE_DATA = [];

    let TIME_OFFSET = 0;
    let LAST_TIME_SYNC = null;

    function copyPlaylistURL() {
      const url = "http://iptvpro.ddns.net/tv_channels.m3u";
      navigator.clipboard.writeText(url).then(() => {
        alert("Playlist URL copied to clipboard!");
      }).catch(err => {
        alert("Failed to copy URL.");
      });
    }

    function getAccurateTime() {
      return new Date(Date.now() + TIME_OFFSET);
    }

    function updateClock() {
      const now = getAccurateTime();
      const timeString = now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
      document.getElementById('schedule-clock').textContent = timeString;
    }

    function formatTimeRemaining(ms) {
      const minutes = Math.floor(ms / 60000);
      if (minutes < 60) {
        return `${minutes} min left`;
      }
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m left`;
    }

    async function syncTime() {
      try {
        const before = Date.now();
        const response = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC');
        const after = Date.now();

        if (!response.ok) throw new Error('Time sync failed');

        const data = await response.json();
        const serverTime = new Date(data.utc_datetime).getTime();
        const latency = (after - before) / 2;
        const adjustedServerTime = serverTime + latency;

        TIME_OFFSET = adjustedServerTime - after;
        LAST_TIME_SYNC = Date.now();

        console.log(`✅ Time synchronized. Offset: ${TIME_OFFSET}ms`);

        updateClock();
        if (SCHEDULE_DATA.length > 0) {
          renderSchedule();
        }
      } catch (error) {
        console.warn('⚠️ Time sync failed, using local time:', error);
        TIME_OFFSET = 0;
      }
    }

    function showError(errorCode, invalidId = null) {
      $("#loading-container").remove();
      $("#my-video").hide();
      $("#transcode-video").hide();
      $("#ffmpeg-status").hide();
      $("#schedule-section").hide();

      $("#invalid-id-text").hide();
      $("#invalid-channel-name").hide();
      $("#error-main-text").hide();
      $(".error-actions").hide();
      $(".error-actions-generic").hide();

      if (errorCode === "invalid_id" && invalidId) {
          $("#invalid-channel-name").text(invalidId);
          $("#invalid-id-text").show();
          $("#invalid-channel-name").show();
          $("#error-code-text").text(`Error Code: err_invalid_tvg_id`);
          $(".error-actions").css('display', 'flex');
      } else {
          $("#error-main-text").show();
          $("#error-main-text").html("An unexpected error has occurred. Please try refreshing the page. If the issue persists, please contact us.");
          $("#error-code-text").text("Error Code: err_code_" + (errorCode || "unknown"));
      }

      $("#error-message").show();
    }

    async function buildChannelMap() {
        try {
            const response = await fetch(M3U_URL);
            if (!response.ok) throw new Error("Failed to fetch M3U file");
            const data = await response.text();
            const lines = data.split(/\r?\n/);

            let currentTvgId = null;
            let currentName = null;

            for (let i = 0; i < lines.length; i++) {
                if (i === 0 && lines[i].startsWith("#EXTM3U")) {
                    const epgUrlMatch = lines[i].match(/(?:url-tvg|x-tvg-url)="([^"]+)"/i);
                    if (epgUrlMatch && epgUrlMatch[1]) {
                        XMLTV_URL = epgUrlMatch[1];
                        console.log(`✅ Dynamically loaded XMLTV URL: ${XMLTV_URL}`);
                    }
                }

                if (lines[i].startsWith("#EXTINF")) {
                    const idMatch = lines[i].match(/tvg-id="([^"]+)"/i);
                    currentTvgId = idMatch ? idMatch[1] : null;

                    const nameMatch = lines[i].match(/,([^,]+)$/);
                    currentName = nameMatch ? nameMatch[1].trim() : "Unknown Channel";
                } else if (lines[i].startsWith("http") && currentTvgId) {
                    const streamURL = lines[i].trim();
                    CHANNEL_NAME_MAP[currentTvgId] = {
                        name: currentName,
                        url: streamURL
                    };
                    currentTvgId = null;
                    currentName = null;
                }
            }
            if (!XMLTV_URL) {
                console.warn("⚠️ Could not find url-tvg or x-tvg-url in M3U header. Schedule may not load.");
            }
            console.log("✅ Channel Map built successfully.");
        } catch (error) {
            console.error("❌ Error building channel map:", error);
        }
    }

    function getStreamURL(tvgId, callback) {
        const channelInfo = CHANNEL_NAME_MAP[tvgId];
        if (channelInfo && channelInfo.url) {
            callback(channelInfo.url);
        } else {
            showError("not_found");
        }
    }

    async function getUserTimezone() {
      try {
        const res = await fetch("https://ipapi.co/timezone");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (err) {
        console.warn("⚠️ Failed to detect timezone:", err);
        throw new Error("err_timezone");
      }
    }

    const parseXmlTvDateFix = (dateStr) => {
      const cleanDigits = dateStr.substring(0, 14);

      if (cleanDigits.length !== 14) return new Date(NaN);

      const year = cleanDigits.substring(0, 4);
      const month = cleanDigits.substring(4, 6);
      const day = cleanDigits.substring(6, 8);
      const hour = cleanDigits.substring(8, 10);
      const minute = cleanDigits.substring(10, 12);
      const second = cleanDigits.substring(12, 14);

      const isoString = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
      return new Date(isoString);
    };

    function renderSchedule() {
      const scheduleList = document.getElementById("schedule-list");

      if (SCHEDULE_DATA.length === 0) {
        return;
      }

      scheduleList.innerHTML = "";
      const groupedByDay = {};
      const now = getAccurateTime();
      const threeDaysAhead = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

      let timezone = "UTC";
      try {
        timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (e) {}

      let currentProgram = null;
      let nextProgram = null;

      for (let i = 0; i < SCHEDULE_DATA.length; i++) {
        const item = SCHEDULE_DATA[i];
        if (item.startUTC <= now && item.stopUTC > now) {
          currentProgram = item;
          if (i + 1 < SCHEDULE_DATA.length) {
            nextProgram = SCHEDULE_DATA[i + 1];
          }
          break;
        }
      }

      SCHEDULE_DATA.forEach(item => {
        if (item.stopUTC < now) return;
        if (item.startUTC > threeDaysAhead) return;

        const localDate = new Intl.DateTimeFormat([], {
          timeZone: timezone,
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        }).format(item.startUTC);

        if (!groupedByDay[localDate]) {
          groupedByDay[localDate] = [];
        }

        groupedByDay[localDate].push(item);
      });

      if (Object.keys(groupedByDay).length === 0) {
        scheduleList.innerHTML = `<p>No current or upcoming programs were found. The EPG data may be stale or incomplete.</p>`;
        return;
      }

      Object.entries(groupedByDay).sort(([dateA], [dateB]) => new Date(dateA) - new Date(dateB)).forEach(([dayLabel, programs]) => {
        const dayHeader = document.createElement("div");
        dayHeader.className = "schedule-entry";
        dayHeader.innerHTML = `<h3 style="margin:0; color:#00ffff;">${dayLabel}</h3>`;
        scheduleList.appendChild(dayHeader);

        programs.sort((a, b) => a.startUTC - b.startUTC).forEach(item => {
          const localStart = new Intl.DateTimeFormat([], {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timezone
          }).format(item.startUTC);

          const localEnd = new Intl.DateTimeFormat([], {
            hour: '2-digit',
            minute: '2-digit',
            timeZone: timezone
          }).format(item.stopUTC);

          const episode = item.subtitle ? ` — ${item.subtitle}` : "";
          const isCurrent = item === currentProgram;
          const isNext = item === nextProgram;

          let timeLabel = '';
          let timeRemainingText = '';

          if (isCurrent) {
            timeLabel = `On now (${localStart} - ${localEnd})`;
            const timeLeft = item.stopUTC - now;
            timeRemainingText = `<span class="time-remaining">${formatTimeRemaining(timeLeft)}</span>`;
          } else if (isNext) {
            timeLabel = `Next up (${localStart} - ${localEnd})`;
          } else {
            timeLabel = `${localStart} - ${localEnd}`;
          }

          const entry = document.createElement("div");
          entry.className = isCurrent ? "schedule-entry current-program" : "schedule-entry";
          entry.innerHTML = `
            <strong>${timeLabel}</strong>${timeRemainingText}
            <div style="margin-top: 0.25rem;">${item.title}${episode}</div>
            <small>${item.desc}</small>
          `;
          scheduleList.appendChild(entry);
        });
      });
    }

    async function fetchGzippedXML(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const isGzip = url.endsWith('.gz') ||
        (res.headers.get('content-encoding') || '').includes('gzip') ||
        (res.headers.get('content-type') || '').includes('gzip');

      if (isGzip && typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const decompressed = res.body.pipeThrough(ds);
        const reader = decompressed.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const blob = new Blob(chunks);
        return await blob.text();
      } else {
        return await res.text();
      }
    }

    async function loadXMLTVSchedule(tvgId, silent = false) {
      const scheduleList = document.getElementById("schedule-list");

      if (!silent) {
        scheduleList.innerHTML = "<p>Loading EPG schedule...</p>";
      }

      if (!XMLTV_URL) {
        scheduleList.innerHTML = `<p>⚠️ Cannot load schedule. XMLTV URL not found in M3U header (url-tvg or x-tvg-url).</p>`;
        return;
      }

      const xmltvUrl = XMLTV_URL;

      let timezone = "UTC";
      try {
        timezone = await getUserTimezone();
      } catch (err) {
        if (!silent) {
          scheduleList.innerHTML = `<p>⚠️ Schedule shown in UTC as timezone detection failed.<br><strong>Error:</strong> ${err.message}</p>`;
        }
      }

      let xmlDoc;
      try {
        let xmlText = await fetchGzippedXML(xmltvUrl);

        const safeXmlText = xmlText.replace(/&(?!(?:apos|quot|[gl]t|amp);)/g, '&amp;');

        const parser = new DOMParser();
        xmlDoc = parser.parseFromString(safeXmlText, "text/xml");

        const errorNode = xmlDoc.querySelector('parsererror');
        if (errorNode) {
          console.error("XML Parsing Failed:", errorNode.textContent);
          throw new Error("XML Parsing Failed (Invalid XML Structure)");
        }

      } catch (err) {
        console.error("❌ Failed during XML fetch or parsing:", err.message);
        if (!silent) {
          scheduleList.innerHTML = `<p>Unable to load or parse the XMLTV data from: ${xmltvUrl}<br><strong>Error:</strong> err_xml_fetch</p>`;
        }
        return;
      }

      try {
        const targetChannelId = tvgId;

        const channelElement = xmlDoc.querySelector(`channel[id="${targetChannelId}"]`);
        if (!channelElement) {
          if (!silent) {
            scheduleList.innerHTML = `<p>Channel with ID '${targetChannelId}' not found in the XMLTV file.</p>`;
          }
          return;
        }

        const programElements = xmlDoc.querySelectorAll(`programme[channel="${targetChannelId}"]`);

        if (programElements.length === 0) {
          if (!silent) {
            scheduleList.innerHTML = `<p>No program entries found for this channel in the EPG file.</p>`;
          }
          return;
        }

        SCHEDULE_DATA = [];
        const now = getAccurateTime();
        const threeDaysAhead = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

        programElements.forEach(program => {
          const startStr = program.getAttribute('start');
          const stopStr = program.getAttribute('stop');
          if (!startStr || !stopStr || startStr.length < 14 || stopStr.length < 14) return;

          const startUTC = parseXmlTvDateFix(startStr);
          const stopUTC = parseXmlTvDateFix(stopStr);

          if (isNaN(startUTC.getTime()) || isNaN(stopUTC.getTime())) return;
          if (stopUTC < now) return;
          if (startUTC > threeDaysAhead) return;

          const title = program.querySelector('title')?.textContent || "Untitled Program";
          const subtitle = program.querySelector('sub-title')?.textContent;
          const desc = program.querySelector('desc')?.textContent || "No description available.";

          SCHEDULE_DATA.push({ startUTC, stopUTC, title, subtitle, desc });
        });

        SCHEDULE_DATA.sort((a, b) => a.startUTC - b.startUTC);

        if (!silent) {
          console.log("✅ Schedule data loaded successfully.");
        } else {
          console.log("✅ Schedule data refreshed in background.");
        }

        renderSchedule();

      } catch (err) {
        console.error("❌ Failed during XML processing/rendering:", err.message, err.stack);
        if (!silent) {
          scheduleList.innerHTML = `<p>Unable to process or display the XMLTV data.<br><strong>Error Code:</strong> err_processing_xml_data</p>`;
        }
      }
    }

    $(document).ready(async function () {
      await syncTime();

      setInterval(updateClock, 1000);
      updateClock();

      await buildChannelMap();

      const urlParams = new URLSearchParams(window.location.search);
      const tvgId = urlParams.get('id');

      if (!tvgId || tvgId.trim() === "") {
        showError("invalid_id", "(No ID specified)");
        return;
      }

      const targetTvgId = tvgId;
      CURRENT_TVG_ID = targetTvgId;
      const channelInfo = CHANNEL_NAME_MAP[targetTvgId];

      if (!channelInfo) {
        showError("invalid_id", targetTvgId);
        return;
      }

      const channelName = channelInfo.name;
      document.title = `Watch ${channelName} Free Online - Free Live TV`;
      $('main h2').text(`Now Streaming: ${channelName}`);
      $('#schedule-title').text(`${channelName} Schedule`);

      getStreamURL(targetTvgId, async function (rawStreamURL) {
        const normalized = await normalizeStreamURL(rawStreamURL);
        const streamURL = normalized.url;

        console.log(`🔍 Probing stream for MP2 codecs: ${streamURL}`);
        const { needsTranscode, reason } = await probeStreamCodecs(streamURL);

        if (needsTranscode) {
          console.log(`🎬 MP2 codec detected (${reason}). Activating ffmpeg.wasm transcoder.`);
          $('#loading-container').hide();
          $('#ffmpeg-status').css('display', 'flex');

          const videoEl = document.getElementById('transcode-video');
          try {
            await startMp2Transcoding(streamURL, videoEl);
          } catch (err) {
            console.error('❌ ffmpeg.wasm transcoding failed:', err);
            showError('ffmpeg_transcode_failed');
          }
        } else {
          console.log(`▶️ No MP2 detected (${reason}). Using JWPlayer.`);
          initializePlayer(streamURL);
        }
      });

      await loadXMLTVSchedule(targetTvgId);

      setInterval(() => {
        renderSchedule();
      }, 60000);

      setInterval(() => {
        loadXMLTVSchedule(CURRENT_TVG_ID, true);
      }, 30 * 60 * 1000);

      setInterval(syncTime, 10 * 60 * 1000);
    });

async function normalizeStreamURL(streamURL, _depth) {
  const depth = _depth || 0;
  if (depth > 5) return { url: streamURL };

  try {
    const r = await fetch(streamURL, { cache: "no-store" });
    const finalUrl = r.url || streamURL;
    const ct = (r.headers.get("content-type") || "").toLowerCase();

    if (ct.includes("video/mp2t") || ct.includes("video/mpeg")) {
      return { url: makeSyntheticPlaylist(finalUrl) };
    }

    const text = (await r.text()).replace(/^\uFEFF/, "");
    const trimmed = text.trim();

    if (trimmed.startsWith("#EXTM3U")) {

      return { url: finalUrl };
    }

    if (trimmed.includes("#EXTINF")) {
      const absolute = ("#EXTM3U\n" + trimmed)
        .split(/\r?\n/)
        .map(l => {
          const line = l.trim();
          return line && !line.startsWith("#") ? new URL(line, finalUrl).href : line;
        })
        .join("\n");
      return {
        url: URL.createObjectURL(
          new Blob([absolute], { type: "application/vnd.apple.mpegurl" })
        )
      };
    }

    const lines = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith("#"));
    if (lines.length === 1) {
      const resolved = new URL(lines[0], finalUrl).href;
      if (resolved.toLowerCase().includes(".m3u8")) {
        return normalizeStreamURL(resolved, depth + 1);
      }
      return { url: makeSyntheticPlaylist(resolved) };
    }

    return { url: finalUrl };
  } catch (e) {
    return { url: streamURL };
  }
}

function makeSyntheticPlaylist(rawUrl) {
  const playlist =
`#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10,
${rawUrl}
`;
  const blob = new Blob([playlist], { type: "application/vnd.apple.mpegurl" });
  return URL.createObjectURL(blob);
}
function initializePlayer(streamURL) {
      const player = jwplayer("my-video");

      player.setup({
        file: streamURL,
        type: "application/x-mpegURL",
        width: "100%",
        aspectratio: "16:9",
        autostart: true,
        primary: "html5",
        preload: "auto",
        mute: false
      });

      const stallTimer = setTimeout(function() {
        if ($("#loading-container").length) {
          console.warn("Player stall timeout — stream may be unreachable or codec unsupported.");
          showError("stall_timeout");
        }
      }, 12000);

      const forceRevealTimer = setTimeout(function() {
        if ($("#loading-container").length) {
          console.warn("Forcing player reveal after timeout — events may not have fired.");
          revealPlayer();
        }
      }, 4000);

      function revealPlayer() {
        clearTimeout(stallTimer);
        clearTimeout(forceRevealTimer);
        $("#loading-container").remove();
        $("#my-video").show();
      }

      player.on("ready", revealPlayer);
      player.on("firstFrame", revealPlayer);
      player.on("buffer", function(e){
        if(e && e.newstate==="playing"){ revealPlayer(); }
      });
      player.on("play", revealPlayer);
      player.on("fullscreen", function (e) {
        const videoElement = document.getElementById("my-video");
        if (e.fullscreen) {
          videoElement.style.border = "none";
          videoElement.style.borderRadius = "0";
        } else {
          videoElement.style.border = "2px solid #00ffff";
          videoElement.style.borderRadius = "8px";
        }
      });

      player.on("error", function (e) {
        console.error("Player error:", e.message || e);
        showError(e.code || "unknown");
      });

      jwplayer_hls_provider.attach();
    }
