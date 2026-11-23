// ==UserScript==
// @name         BQ-GUI Global Bits/s + SpeedChart Tooltip & Peak
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Tampilkan Bytes/s & Bits/s di semua halaman BQ-GUI + Tooltip & Peak di #speedChart
// @match        *://*.bromn.biz.id/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================
    // 1. GLOBAL HELPER & CONVERTER (JALAN DI SEMUA HALAMAN)
    // =========================================================
    function formatBits(bytesPerSec) {
        const bits = (Number(bytesPerSec) || 0) * 8;
        if (bits < 1000) return `${bits.toFixed(0)} bps`;
        if (bits < 1e6) return `${(bits / 1e3).toFixed(1)} Kbps`;
        if (bits < 1e9) return `${(bits / 1e6).toFixed(1)} Mbps`;
        if (bits < 1e12) return `${(bits / 1e9).toFixed(2)} Gbps`;
        return `${(bits / 1e12).toFixed(2)} Tbps`;
    }

    const origFormatSpeedShort = typeof window.formatSpeedShort === 'function'
        ? window.formatSpeedShort
        : (v) => {
            const val = Number(v) || 0;
            if (val < 1024 * 1024) return `${(val / 1024).toFixed(1)} KB/s`;
            if (val < 1024 * 1024 * 1024) return `${(val / 1024 / 1024).toFixed(1)} MB/s`;
            return `${(val / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
        };

    const origFormatSpeed = typeof window.formatSpeed === 'function'
        ? window.formatSpeed
        : null;

    function fmtBoth(bytesPerSec) {
        return `${origFormatSpeedShort(bytesPerSec)} / ${formatBits(bytesPerSec)}`;
    }

    // Override fungsi formatter bawaan halaman (jika ada)
    window.formatSpeedShort = function (bps) {
        return fmtBoth(bps);
    };

    if (origFormatSpeed) {
        window.formatSpeed = function (bps) {
            return `${origFormatSpeed(bps)} / ${formatBits(bps)}`;
        };
    }

    // MutationObserver untuk menangkap semua teks speed di halaman mana pun
    const UNIT_MULT = {
        B: 1,
        KB: 1024,
        MB: 1024 ** 2,
        GB: 1024 ** 3,
        TB: 1024 ** 4
    };
    const SPEED_REGEX = /\b(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)\/s(?!\s*\/\s*[\d.]+\s*[KMGT]?bps)/gi;
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']);

    function processTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return;
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName)) return;

        const orig = node.nodeValue;
        if (!orig || !orig.includes('/s')) return;

        const updated = orig.replace(SPEED_REGEX, (match, numStr, unitStr) => {
            const mult = UNIT_MULT[unitStr.toUpperCase()] || 1;
            const bytesPerSec = parseFloat(numStr) * mult;
            return `${match} / ${formatBits(bytesPerSec)}`;
        });

        if (updated !== orig) {
            node.nodeValue = updated;
        }
    }

    function scanTree(root) {
        if (!root) return;
        if (root.nodeType === Node.TEXT_NODE) {
            processTextNode(root);
            return;
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
            processTextNode(n);
        }
    }

    scanTree(document.body);

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'characterData') {
                processTextNode(m.target);
            } else if (m.type === 'childList') {
                for (const added of m.addedNodes) {
                    scanTree(added);
                }
            }
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    // =========================================================
    // 2. FITUR KHUSUS DASHBOARD (#speedChart)
    // =========================================================
    const canvas = document.getElementById('speedChart');
    if (!canvas || typeof window.renderChart !== 'function') {
        if (typeof window.refresh === 'function') window.refresh();
        return;
    }

    let latestRead = [];
    let latestUpload = [];
    let pinnedIndex = null;

    const style = document.createElement('style');
    style.textContent = `
        .speed-current .speed-value { font-size: 1.15rem !important; }
    `;
    document.head.appendChild(style);

    function createStatSubline(targetId) {
        const el = document.getElementById(targetId);
        if (!el) return null;
        const sub = document.createElement('div');
        Object.assign(sub.style, {
            fontSize: '0.7rem',
            color: '#888899',
            marginTop: '4px',
            lineHeight: '1.4',
            whiteSpace: 'nowrap'
        });
        sub.textContent = 'Peak: -- · Avg: --';
        el.parentElement.appendChild(sub);
        return sub;
    }

    const readSubEl = createStatSubline('readSpeed');
    const uploadSubEl = createStatSubline('uploadSpeed');

    function calcStats(points) {
        if (!points || points.length === 0) return { peak: 0, avg: 0 };
        let peak = 0;
        let sum = 0;
        for (const p of points) {
            const s = Number(p.speed) || 0;
            if (s > peak) peak = s;
            sum += s;
        }
        return { peak, avg: sum / points.length };
    }

    function updatePeakAndAvg() {
        const rStats = calcStats(latestRead);
        const uStats = calcStats(latestUpload);

        if (readSubEl) {
            readSubEl.innerHTML =
                `Peak: <span style="color:#22d3ee">${fmtBoth(rStats.peak)}</span><br>` +
                `Avg: <span style="color:#e8e8f0">${fmtBoth(rStats.avg)}</span>`;
        }
        if (uploadSubEl) {
            uploadSubEl.innerHTML =
                `Peak: <span style="color:#22c55e">${fmtBoth(uStats.peak)}</span><br>` +
                `Avg: <span style="color:#e8e8f0">${fmtBoth(uStats.avg)}</span>`;
        }
    }

    function drawPeakMarker(points, numPoints, maxBps, color, labelPrefix, yOffsetFallback) {
        if (!points || points.length === 0) return;

        let peakIdx = 0;
        let peakVal = -1;
        for (let i = 0; i < points.length; i++) {
            const s = Number(points[i].speed) || 0;
            if (s > peakVal) {
                peakVal = s;
                peakIdx = i;
            }
        }
        if (peakVal <= 0) return;

        const ctx = canvas.getContext('2d');
        const padding = 5;
        const chartWidth = canvas.width - padding * 2;
        const chartHeight = canvas.height - padding * 2;

        const x = padding + (peakIdx / (numPoints - 1)) * chartWidth;
        const rawY = chartHeight + padding - (peakVal / maxBps) * chartHeight;
        const y = Math.max(padding, Math.min(rawY, chartHeight + padding));

        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.fillStyle = color === '#22d3ee' ? 'rgba(34, 211, 238, 0.25)' : 'rgba(34, 197, 94, 0.25)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const text = `▲ ${labelPrefix}: ${fmtBoth(peakVal)}`;
        ctx.font = 'bold 11px monospace';
        const textWidth = ctx.measureText(text).width;

        const boxPadX = 6;
        const boxW = textWidth + boxPadX * 2;
        const boxH = 18;

        let labelX = x + 8;
        if (labelX + boxW > canvas.width - 4) labelX = x - boxW - 8;
        if (labelX < 4) labelX = 4;

        let labelY = y - boxH - 6;
        if (labelY < 4) labelY = y + 8 + yOffsetFallback;

        ctx.fillStyle = 'rgba(10, 10, 15, 0.85)';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(labelX, labelY, boxW, boxH, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, labelX + boxPadX, labelY + boxH / 2);
        ctx.restore();
    }

    function drawAllPeaks() {
        const numPoints = Math.max(latestRead.length, latestUpload.length, 2);
        const maxBps = (typeof speedChartMaxBps !== 'undefined' && speedChartMaxBps > 0)
            ? speedChartMaxBps
            : 1024 * 1024 * 1024;

        drawPeakMarker(latestRead, numPoints, maxBps, '#22d3ee', 'Peak R', 0);
        drawPeakMarker(latestUpload, numPoints, maxBps, '#22c55e', 'Peak U', 20);
    }

    const origRenderChart = window.renderChart;
    window.renderChart = function (readHistory, uploadHistory) {
        latestRead = readHistory || [];
        latestUpload = uploadHistory || [];
        const res = origRenderChart.apply(this, arguments);
        drawAllPeaks();
        updatePeakAndAvg();
        if (pinnedIndex !== null) updateOverlay(pinnedIndex);
        return res;
    };

    const chartArea = canvas.parentElement;

    const crosshair = document.createElement('div');
    Object.assign(crosshair.style, {
        position: 'absolute',
        top: '0',
        bottom: '0',
        width: '1px',
        background: 'rgba(255, 255, 255, 0.35)',
        pointerEvents: 'none',
        display: 'none',
        zIndex: '5'
    });
    chartArea.appendChild(crosshair);

    const tooltip = document.createElement('div');
    Object.assign(tooltip.style, {
        position: 'fixed',
        display: 'none',
        pointerEvents: 'none',
        background: 'rgba(18, 18, 26, 0.96)',
        color: '#e8e8f0',
        border: '1px solid #3b3b4f',
        borderRadius: '8px',
        padding: '8px 12px',
        fontSize: '12px',
        fontFamily: "'JetBrains Mono', monospace",
        lineHeight: '1.6',
        zIndex: '99999',
        boxShadow: '0 6px 18px rgba(0,0,0,0.5)'
    });
    document.body.appendChild(tooltip);

    function formatTime(unixSec) {
        if (!unixSec) return '--:--:--';
        return new Date(unixSec * 1000).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

    function updateOverlay(idx) {
        const numPoints = Math.max(latestRead.length, latestUpload.length, 2);
        if (idx < 0 || idx >= numPoints) {
            hideOverlay();
            return;
        }

        const padding = 5;
        const chartWidth = canvas.width - padding * 2;
        const xCanvas = padding + (idx / (numPoints - 1)) * chartWidth;
        const rect = canvas.getBoundingClientRect();
        const xScreen = (xCanvas / canvas.width) * rect.width;

        crosshair.style.left = `${xScreen}px`;
        crosshair.style.display = 'block';

        const r = latestRead[idx];
        const u = latestUpload[idx];
        const ts = r?.time || u?.time;

        tooltip.innerHTML = `
            <div style="color:#888899; margin-bottom:2px;">🕒 ${formatTime(ts)}</div>
            <div style="color:#22d3ee;">Read  : <b>${r ? fmtBoth(r.speed) : '-'}</b></div>
            <div style="color:#22c55e;">Upload: <b>${u ? fmtBoth(u.speed) : '-'}</b></div>
        `;
        tooltip.style.display = 'block';

        const tipX = rect.left + xScreen + 12;
        const tipY = rect.top + 10;
        tooltip.style.left = `${Math.min(tipX, window.innerWidth - 260)}px`;
        tooltip.style.top = `${tipY}px`;
    }

    function hideOverlay() {
        pinnedIndex = null;
        crosshair.style.display = 'none';
        tooltip.style.display = 'none';
    }

    canvas.style.cursor = 'crosshair';
    document.addEventListener('click', (e) => {
        if (e.target !== canvas) {
            hideOverlay();
            return;
        }

        const numPoints = Math.max(latestRead.length, latestUpload.length, 2);
        if (latestRead.length === 0 && latestUpload.length === 0) return;

        const rect = canvas.getBoundingClientRect();
        const padding = 5;
        const chartWidth = canvas.width - padding * 2;
        const clickX = ((e.clientX - rect.left) / rect.width) * canvas.width;
        const idx = Math.max(0, Math.min(numPoints - 1, Math.round(((clickX - padding) / chartWidth) * (numPoints - 1))));

        if (pinnedIndex === idx) {
            hideOverlay();
        } else {
            pinnedIndex = idx;
            updateOverlay(idx);
        }
    });

    if (typeof window.refresh === 'function') {
        window.refresh();
    } else if (typeof window.renderChartWithTimeScale === 'function') {
        window.renderChartWithTimeScale();
    }
})();
