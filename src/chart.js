export class RollingLineChart {
  constructor(canvas, { maxPoints = 600 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.maxPoints = maxPoints;
    this.points = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(300, rect.width || this.canvas.width);
    const height = Math.max(180, rect.height || this.canvas.height);
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  clear() {
    this.points = [];
    this.draw();
  }

  push(angleDeg) {
    if (!Number.isFinite(angleDeg)) return;
    this.points.push({ t: performance.now(), y: angleDeg });
    if (this.points.length > this.maxPoints) {
      this.points.splice(0, this.points.length - this.maxPoints);
    }
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    const width = this.canvas.clientWidth || 900;
    const height = this.canvas.clientHeight || 260;
    const pad = { left: 48, right: 16, top: 18, bottom: 34 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#d6dde8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    if (this.points.length < 2) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '14px system-ui, sans-serif';
      ctx.fillText('Waiting for live data...', pad.left + 10, pad.top + 28);
      return;
    }

    const ys = this.points.map((p) => p.y);
    let minY = Math.min(...ys, -5);
    let maxY = Math.max(...ys, 60);
    if (Math.abs(maxY - minY) < 10) {
      const mid = (maxY + minY) / 2;
      minY = mid - 5;
      maxY = mid + 5;
    }
    const yPad = (maxY - minY) * 0.12;
    minY -= yPad;
    maxY += yPad;

    const minT = this.points[0].t;
    const maxT = this.points[this.points.length - 1].t;
    const timeSpan = Math.max(1, maxT - minT);

    const x = (t) => pad.left + ((t - minT) / timeSpan) * plotW;
    const y = (value) => pad.top + (1 - (value - minY) / (maxY - minY)) * plotH;

    ctx.strokeStyle = '#eef2f7';
    ctx.beginPath();
    for (let i = 0; i <= 4; i += 1) {
      const yy = pad.top + (plotH * i) / 4;
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(pad.left + plotW, yy);
    }
    ctx.stroke();

    ctx.strokeStyle = '#1f6feb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    this.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(x(p.t), y(p.y));
      else ctx.lineTo(x(p.t), y(p.y));
    });
    ctx.stroke();

    ctx.fillStyle = '#374151';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i += 1) {
      const value = maxY - ((maxY - minY) * i) / 4;
      ctx.fillText(`${value.toFixed(0)} deg`, pad.left - 8, pad.top + (plotH * i) / 4);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('recent time', pad.left, height - 10);
  }
}

function range(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (Math.abs(max - min) < 10) {
    const mid = (min + max) / 2;
    min = mid - 5;
    max = mid + 5;
  }
  const pad = (max - min) * 0.12;
  return { min: min - pad, max: max + pad };
}

export class RepetitionAnalysisChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.result = null;
    this.message = 'Analyze a CSV to show detected repetitions.';
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(320, rect.width || this.canvas.width);
    const height = Math.max(220, rect.height || this.canvas.height);
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  hardClearCanvas() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear(message = 'Analyze a CSV to show detected repetitions.') {
    this.result = null;
    this.message = message;
    this.hardClearCanvas();
    this.draw();
  }

  render(result) {
    this.result = result;
    this.message = '';
    this.hardClearCanvas();
    this.draw();
  }

  drawMarker(x, y, type) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';

    if (type === 'extension-start') {
      ctx.fillStyle = '#1d4ed8';
      ctx.beginPath();
      ctx.moveTo(x, y + 7);
      ctx.lineTo(x - 6, y - 5);
      ctx.lineTo(x + 6, y - 5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (type === 'extension-end') {
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.rect(x - 5, y - 5, 10, 10);
      ctx.fill();
      ctx.stroke();
    } else if (type === 'flexion-start') {
      ctx.fillStyle = '#15803d';
      ctx.beginPath();
      ctx.moveTo(x + 7, y);
      ctx.lineTo(x - 5, y - 6);
      ctx.lineTo(x - 5, y + 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (type === 'flexion-end') {
      ctx.fillStyle = '#7c3aed';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (type === 'flexion') {
      ctx.fillStyle = '#7c3aed';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.rect(x - 5, y - 5, 10, 10);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  draw() {
    const ctx = this.ctx;
    this.hardClearCanvas();
    const width = this.canvas.clientWidth || 900;
    const height = this.canvas.clientHeight || 320;
    const pad = { left: 54, right: 18, top: 20, bottom: 54 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#d6dde8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    if (!this.result || !Array.isArray(this.result.samples) || this.result.samples.length < 2) {
      ctx.fillStyle = '#6b7280';
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(this.message || 'No analysis result to display.', pad.left + 10, pad.top + 28);
      return;
    }

    const samples = this.result.samples;
    const timeMin = samples[0].timeSec;
    const timeMax = samples[samples.length - 1].timeSec;
    const timeSpan = Math.max(0.001, timeMax - timeMin);
    const yRange = range(samples.map((sample) => sample.angleDeg));

    const x = (timeSec) => pad.left + ((timeSec - timeMin) / timeSpan) * plotW;
    const y = (angleDeg) => pad.top + (1 - (angleDeg - yRange.min) / (yRange.max - yRange.min)) * plotH;

    ctx.strokeStyle = '#eef2f7';
    ctx.beginPath();
    for (let i = 0; i <= 4; i += 1) {
      const yy = pad.top + (plotH * i) / 4;
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(pad.left + plotW, yy);
    }
    for (let i = 0; i <= 5; i += 1) {
      const xx = pad.left + (plotW * i) / 5;
      ctx.moveTo(xx, pad.top);
      ctx.lineTo(xx, pad.top + plotH);
    }
    ctx.stroke();

    for (const block of this.result.blocks || []) {
      const startSample = samples[block.startIndex];
      const endSample = samples[block.endIndex];
      if (!startSample || !endSample) continue;
      const blockX1 = x(startSample.timeSec);
      const blockX2 = x(endSample.timeSec);
      const widthValue = Math.max(0, blockX2 - blockX1);
      if (block.state === 'extension') ctx.fillStyle = 'rgba(37, 99, 235, 0.10)';
      else if (block.state === 'flexion') ctx.fillStyle = 'rgba(22, 163, 74, 0.10)';
      else ctx.fillStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.fillRect(blockX1, pad.top, widthValue, plotH);
    }

    const drawLineRange = (startIndex, endIndex, color, widthValue = 3) => {
      const start = Math.max(0, startIndex);
      const end = Math.min(samples.length - 1, endIndex);
      if (end <= start) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = widthValue;
      ctx.beginPath();
      for (let i = start; i <= end; i += 1) {
        const p = samples[i];
        if (i === start) ctx.moveTo(x(p.timeSec), y(p.angleDeg));
        else ctx.lineTo(x(p.timeSec), y(p.angleDeg));
      }
      ctx.stroke();
    };

    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((p, i) => {
      if (i === 0) ctx.moveTo(x(p.timeSec), y(p.angleDeg));
      else ctx.lineTo(x(p.timeSec), y(p.angleDeg));
    });
    ctx.stroke();

    for (const rep of this.result.reps || []) {
      drawLineRange(rep.extensionStartIndex, rep.extensionEndIndex, '#2563eb', 3);
      drawLineRange(rep.flexionStartIndex, rep.flexionEndIndex, '#16a34a', 3);

      const labelSample = samples[rep.extensionPeakIndex];
      if (labelSample) {
        ctx.fillStyle = '#111827';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Rep ${rep.rep}`, x(labelSample.timeSec), y(labelSample.angleDeg) - 10);
      }
    }

    for (const extreme of this.result.extrema || []) {
      const sample = samples[extreme.index];
      if (!sample) continue;
      this.drawMarker(x(sample.timeSec), y(sample.angleDeg), extreme.type);
    }

    ctx.fillStyle = '#374151';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i += 1) {
      const value = yRange.max - ((yRange.max - yRange.min) * i) / 4;
      ctx.fillText(`${value.toFixed(0)} deg`, pad.left - 8, pad.top + (plotH * i) / 4);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 5; i += 1) {
      const timeSec = timeMin + (timeSpan * i) / 5;
      ctx.fillText(`${timeSec.toFixed(1)} s`, pad.left + (plotW * i) / 5, pad.top + plotH + 8);
    }

    const legendY = height - 18;
    let legendX = pad.left;
    const legendItems = [
      { label: 'Extension movement', color: '#2563eb', shape: 'line' },
      { label: 'Flexion movement', color: '#16a34a', shape: 'line' },
      { label: 'Hold/rest', color: '#94a3b8', shape: 'line' },
      { label: 'Ext. start', color: '#1d4ed8', shape: 'triangle' },
      { label: 'Ext. end', color: '#f97316', shape: 'square' },
      { label: 'Flex. start', color: '#15803d', shape: 'triangle-right' },
      { label: 'Flex. end', color: '#7c3aed', shape: 'circle' },
    ];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '12px system-ui, sans-serif';
    for (const item of legendItems) {
      ctx.fillStyle = item.color;
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 3;
      if (item.shape === 'line') {
        ctx.beginPath();
        ctx.moveTo(legendX, legendY);
        ctx.lineTo(legendX + 18, legendY);
        ctx.stroke();
      } else if (item.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(legendX + 9, legendY, 5, 0, Math.PI * 2);
        ctx.fill();
      } else if (item.shape === 'triangle') {
        ctx.beginPath();
        ctx.moveTo(legendX + 9, legendY + 6);
        ctx.lineTo(legendX + 3, legendY - 5);
        ctx.lineTo(legendX + 15, legendY - 5);
        ctx.closePath();
        ctx.fill();
      } else if (item.shape === 'triangle-right') {
        ctx.beginPath();
        ctx.moveTo(legendX + 15, legendY);
        ctx.lineTo(legendX + 4, legendY - 6);
        ctx.lineTo(legendX + 4, legendY + 6);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(legendX + 4, legendY - 5, 10, 10);
      }
      ctx.fillStyle = '#475569';
      ctx.fillText(item.label, legendX + 24, legendY);
      legendX += ctx.measureText(item.label).width + 52;
    }
  }
}
