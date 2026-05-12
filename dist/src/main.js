import { browserSupportsWebBluetooth, XsensDotDevice } from './xsensDot.js';
import { KneeAngleEstimator } from './kneeAngle.js';
import { RepetitionAnalysisChart, RollingLineChart } from './chart.js';
import { analyzeKneeAngleCsv, repetitionMetricsToCsv } from './analysis.js';

const $ = (id) => document.getElementById(id);

const ui = {
  browserSupport: $('browserSupport'),
  thighPitch: $('thighPitch'),
  shankPitch: $('shankPitch'),
  rawAngle: $('rawAngle'),
  unfilteredAngle: $('unfilteredAngle'),
  zeroOffset: $('zeroOffset'),
  thighBatteryMetric: $('thighBatteryMetric'),
  shankBatteryMetric: $('shankBatteryMetric'),
  axisSelect: $('axisSelect'),
  smoothingRange: $('smoothingRange'),
  smoothingValue: $('smoothingValue'),
  invertSign: $('invertSign'),
  autoStart: $('autoStart'),
  calibrateBtn: $('calibrateBtn'),
  resetZeroBtn: $('resetZeroBtn'),
  resetFilterBtn: $('resetFilterBtn'),
  startAllBtn: $('startAllBtn'),
  stopAllBtn: $('stopAllBtn'),
  sessionNameInput: $('sessionNameInput'),
  fileNameInput: $('fileNameInput'),
  chooseFolderBtn: $('chooseFolderBtn'),
  folderStatus: $('folderStatus'),
  logBtn: $('logBtn'),
  downloadBtn: $('downloadBtn'),
  mockBtn: $('mockBtn'),
  clearBtn: $('clearBtn'),
  logStatus: $('logStatus'),
  analysisFileInput: $('analysisFileInput'),
  flexionDirectionSelect: $('flexionDirectionSelect'),
  minRomInput: $('minRomInput'),
  minRepDurationInput: $('minRepDurationInput'),
  analysisSmoothingInput: $('analysisSmoothingInput'),
  movementThresholdInput: $('movementThresholdInput'),
  analyzeFileBtn: $('analyzeFileBtn'),
  analyzeCurrentLogBtn: $('analyzeCurrentLogBtn'),
  exportAnalysisBtn: $('exportAnalysisBtn'),
  analysisStatus: $('analysisStatus'),
  analysisSummary: $('analysisSummary'),
  analysisTable: $('analysisTable'),
  analysisChart: $('analysisChart'),
  chart: $('angleChart'),
  thigh: {
    status: $('thighStatus'),
    name: $('thighName'),
    timestamp: $('thighTs'),
    euler: $('thighEuler'),
    battery: $('thighBattery'),
    connect: $('connectThighBtn'),
    start: $('startThighBtn'),
    stop: $('stopThighBtn'),
  },
  shank: {
    status: $('shankStatus'),
    name: $('shankName'),
    timestamp: $('shankTs'),
    euler: $('shankEuler'),
    battery: $('shankBattery'),
    connect: $('connectShankBtn'),
    start: $('startShankBtn'),
    stop: $('stopShankBtn'),
  },
};

const DEFAULT_SMOOTHING_PERCENT = 70;
const estimator = new KneeAngleEstimator({ axis: 'y', smoothingPercent: DEFAULT_SMOOTHING_PERCENT });
const chart = new RollingLineChart(ui.chart);
const analysisChart = new RepetitionAnalysisChart(ui.analysisChart);
const sensors = {
  thigh: new XsensDotDevice('thigh'),
  shank: new XsensDotDevice('shank'),
};

let isLogging = false;
let logRows = [];
let mockTimer = null;
let directoryHandle = null;
let latestAnalysisResult = null;
let latestAnalysisSourceName = '';
let mockBatteries = {
  thigh: null,
  shank: null,
};

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : '--.-';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localTimestampForFileName(date = new Date()) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('') + '-' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('');
}

function defaultCsvName() {
  return `xsens-dot-knee-angle-${localTimestampForFileName()}.csv`;
}

function getCsvFileName() {
  const raw = ui.fileNameInput.value.trim() || defaultCsvName();
  const sanitized = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 180) || defaultCsvName();
  return sanitized.toLowerCase().endsWith('.csv') ? sanitized : `${sanitized}.csv`;
}

function setStatus(segment, text, state = 'disconnected') {
  const el = ui[segment].status;
  el.textContent = text;
  el.dataset.state = state;
}

function showError(error) {
  console.error(error);
  ui.browserSupport.textContent = error?.message ?? String(error);
  ui.browserSupport.dataset.state = 'error';
}

function updateBrowserSupport() {
  const supported = browserSupportsWebBluetooth();
  ui.browserSupport.textContent = supported
    ? 'Web Bluetooth available. Use Chrome/Edge and keep this page on HTTPS or localhost.'
    : 'Web Bluetooth not detected. Use desktop Chrome or Edge over HTTPS/localhost.';
  ui.browserSupport.dataset.state = supported ? 'ok' : 'error';
}

function updateSmoothingLabel() {
  ui.smoothingValue.textContent = `${Math.round(estimator.smoothingPercent)}%`;
}

function updateFolderStatus() {
  if (directoryHandle) {
    ui.folderStatus.textContent = `Folder selected: ${directoryHandle.name}. Save CSV will write ${getCsvFileName()} there.`;
  } else if ('showDirectoryPicker' in window) {
    ui.folderStatus.textContent = 'No folder selected. Save CSV will use the browser download flow.';
  } else {
    ui.folderStatus.textContent = 'Folder picking is not supported in this browser. Save CSV will use the browser download flow.';
  }
}

function batteryLabel(battery, { compact = false } = {}) {
  if (!battery || !Number.isFinite(battery.levelPercent)) return '--';
  const level = `${battery.levelPercent}%`;
  if (battery.isCharging) return compact ? `${level} charging` : `${level} (charging)`;
  return level;
}

function batteryState(battery) {
  if (!battery || !Number.isFinite(battery.levelPercent)) return 'unknown';
  if (battery.isCharging) return 'charging';
  if (battery.levelPercent <= 15) return 'low';
  if (battery.levelPercent <= 30) return 'warn';
  return 'ok';
}

function chargingLabel(battery) {
  if (!battery || !Number.isFinite(battery.chargingStatus)) return '';
  return battery.isCharging ? 'charging' : 'not_charging';
}

function getBatteryForSegment(segment) {
  return sensors[segment].latestBattery ?? mockBatteries[segment] ?? null;
}

function updateBatteryPanel(segment, detail = null) {
  const hasBatteryProperty = detail
    && typeof detail === 'object'
    && Object.prototype.hasOwnProperty.call(detail, 'battery');
  const battery = hasBatteryProperty ? detail.battery : detail;
  const explicitlyUnavailable = detail && typeof detail === 'object' && detail.available === false;
  const sensor = sensors[segment];
  const unavailableText = sensor.connected ? 'Unavailable' : '--';
  const text = battery
    ? batteryLabel(battery)
    : explicitlyUnavailable
      ? unavailableText
      : '--';
  const compactText = battery
    ? batteryLabel(battery, { compact: true })
    : explicitlyUnavailable
      ? unavailableText
      : '--';
  const state = battery ? batteryState(battery) : 'unknown';

  ui[segment].battery.textContent = text;
  ui[segment].battery.dataset.state = state;

  const metric = segment === 'thigh' ? ui.thighBatteryMetric : ui.shankBatteryMetric;
  metric.textContent = compactText;
  metric.dataset.state = state;
}

function updateSensorPanel(segment, sample) {
  const panel = ui[segment];
  const e = sample?.euler;
  if (!e) return;
  panel.timestamp.textContent = `${sample.timestampUs} us`;
  panel.euler.textContent = `X ${fmt(e.x, 2)} / Y ${fmt(e.y, 2)} / Z ${fmt(e.z, 2)}`;
}

function updateMetrics(sourceSegment = '') {
  const thighPitch = estimator.thighPitchDeg;
  const shankPitch = estimator.shankPitchDeg;
  const rawAngle = estimator.rawAngleDeg;
  const unfilteredAngle = estimator.unfilteredKneeAngleDeg;
  const kneeAngle = estimator.kneeAngleDeg;

  ui.thighPitch.textContent = `${fmt(thighPitch)} deg`;
  ui.shankPitch.textContent = `${fmt(shankPitch)} deg`;
  ui.rawAngle.textContent = `${fmt(rawAngle)} deg`;
  ui.unfilteredAngle.textContent = `${fmt(unfilteredAngle)} deg`;
  ui.zeroOffset.textContent = `${fmt(estimator.zeroOffsetDeg)} deg`;

  if (Number.isFinite(kneeAngle)) {
    chart.push(kneeAngle);
    maybeLog(sourceSegment);
  }
}

function maybeLog(sourceSegment) {
  if (!isLogging || !estimator.ready) return;

  const thighBattery = getBatteryForSegment('thigh');
  const shankBattery = getBatteryForSegment('shank');

  logRows.push({
    iso_time: new Date().toISOString(),
    session_name: ui.sessionNameInput.value.trim(),
    source_segment: sourceSegment,
    knee_angle_deg: estimator.kneeAngleDeg,
    knee_angle_filtered_deg: estimator.filteredKneeAngleDeg,
    knee_angle_unfiltered_deg: estimator.unfilteredKneeAngleDeg,
    raw_angle_deg: estimator.rawAngleDeg,
    thigh_pitch_deg: estimator.thighPitchDeg,
    shank_pitch_deg: estimator.shankPitchDeg,
    thigh_timestamp_us: estimator.latest.thigh?.timestampUs ?? '',
    shank_timestamp_us: estimator.latest.shank?.timestampUs ?? '',
    thigh_battery_percent: thighBattery?.levelPercent ?? '',
    shank_battery_percent: shankBattery?.levelPercent ?? '',
    thigh_charging: chargingLabel(thighBattery),
    shank_charging: chargingLabel(shankBattery),
    zero_offset_deg: estimator.zeroOffsetDeg,
    smoothing_percent: estimator.smoothingPercent,
    axis: estimator.axis,
    inverted: estimator.inverted,
  });
  updateLoggingStatus();
}

function attachSensorEvents(segment) {
  const sensor = sensors[segment];

  sensor.addEventListener('status', (event) => {
    const detail = event.detail;
    ui[segment].name.textContent = detail.name ?? '--';
    const label = detail.state === 'streaming'
      ? 'Streaming'
      : detail.state === 'connected'
        ? 'Connected'
        : 'Disconnected';
    setStatus(segment, label, detail.state);
  });

  sensor.addEventListener('battery', (event) => {
    updateBatteryPanel(segment, event.detail);
  });

  sensor.addEventListener('sample', (event) => {
    const { sample } = event.detail;
    estimator.update(segment, sample);
    updateSensorPanel(segment, sample);
    updateMetrics(segment);
  });

  sensor.addEventListener('error', (event) => showError(event.detail));
}

async function connectSegment(segment) {
  try {
    setStatus(segment, 'Selecting...', 'connecting');
    await sensors[segment].requestAndConnect();
    ui[segment].name.textContent = sensors[segment].name;
    if (ui.autoStart.checked) {
      await sensors[segment].startStreaming();
    }
  } catch (error) {
    setStatus(segment, sensors[segment].connected ? 'Connected' : 'Disconnected', sensors[segment].connected ? 'connected' : 'disconnected');
    showError(error);
  }
}

async function startSegment(segment) {
  try {
    await sensors[segment].startStreaming();
  } catch (error) {
    showError(error);
  }
}

async function stopSegment(segment) {
  try {
    await sensors[segment].stopStreaming();
  } catch (error) {
    showError(error);
  }
}

async function startBoth() {
  await Promise.allSettled(['thigh', 'shank'].map((segment) => startSegment(segment)));
}

async function stopBoth() {
  await Promise.allSettled(['thigh', 'shank'].map((segment) => stopSegment(segment)));
}

function buildCsv() {
  if (logRows.length === 0) return null;

  const headers = Object.keys(logRows[0]);
  const lines = [headers.join(',')];
  for (const row of logRows) {
    lines.push(headers.map((h) => JSON.stringify(row[h] ?? '')).join(','));
  }
  return lines.join('\n');
}

function downloadCsvBlob(csvText, fileName) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function chooseFolder() {
  if (!('showDirectoryPicker' in window)) {
    updateFolderStatus();
    return;
  }

  try {
    directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    updateFolderStatus();
  } catch (error) {
    if (error?.name !== 'AbortError') showError(error);
  }
}

async function saveCsv() {
  const csvText = buildCsv();
  if (!csvText) {
    updateLoggingStatus('No rows to save yet.');
    return;
  }

  const fileName = getCsvFileName();

  if (directoryHandle) {
    try {
      const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(csvText);
      await writable.close();
      ui.logStatus.textContent = `Saved ${fileName}.`;
      ui.logStatus.hidden = false;
      updateFolderStatus();
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      showError(error);
      ui.folderStatus.textContent = 'Could not write to the selected folder. Falling back to browser download.';
    }
  }

  downloadCsvBlob(csvText, fileName);
  ui.logStatus.textContent = `Downloaded ${fileName}.`;
  ui.logStatus.hidden = false;
}


function analysisOptions() {
  return {
    flexionDirection: ui.flexionDirectionSelect.value,
    minRomDeg: Math.max(1, Number(ui.minRomInput.value) || 10),
    minRepDurationSec: Math.max(0.1, Number(ui.minRepDurationInput.value) || 0.5),
    smoothingWindow: Math.max(1, Math.floor(Number(ui.analysisSmoothingInput.value) || 5)),
    movementThresholdDegS: Math.max(0, Number(ui.movementThresholdInput.value) || 5),
  };
}

function setAnalysisStatus(message = '', state = 'info') {
  ui.analysisStatus.textContent = message;
  ui.analysisStatus.hidden = !message;
  ui.analysisStatus.dataset.state = state;
}

function makeElement(tag, text = '', className = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null && text !== undefined) el.textContent = text;
  return el;
}

function replaceAnalysisTableRows(rows) {
  const tbody = ui.analysisTable.querySelector('tbody');
  tbody.replaceChildren(...rows);
}

function clearAnalysisResults(message) {
  latestAnalysisResult = null;
  latestAnalysisSourceName = '';
  ui.exportAnalysisBtn.disabled = true;
  ui.analysisSummary.replaceChildren();
  analysisChart.clear(message);
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 11;
  cell.textContent = message;
  row.appendChild(cell);
  replaceAnalysisTableRows([row]);
}

function summaryCard(label, value) {
  const card = makeElement('div', '', 'analysis-summary-card');
  card.appendChild(makeElement('span', label));
  card.appendChild(makeElement('strong', value));
  return card;
}

function fmtUnit(value, unit, digits = 1) {
  return Number.isFinite(value) ? `${fmt(value, digits)} ${unit}` : '--';
}

function renderAnalysisResult(result, sourceName) {
  latestAnalysisResult = result;
  latestAnalysisSourceName = sourceName || 'analysis';
  ui.exportAnalysisBtn.disabled = result.reps.length === 0;

  const summary = result.summary;
  ui.analysisSummary.replaceChildren(
    summaryCard('Repetitions', String(summary.repetitionCount)),
    summaryCard('Peak flexion', fmtUnit(summary.overallPeakFlexionDeg, 'deg')),
    summaryCard('Peak extension', fmtUnit(summary.overallPeakExtensionDeg, 'deg')),
    summaryCard('Mean ROM', fmtUnit(summary.meanRangeOfMotionDeg, 'deg')),
    summaryCard('Mean ext. angular speed', fmtUnit(summary.meanExtensionSpeedDegS, 'deg/s')),
    summaryCard('Mean flex. angular speed', fmtUnit(summary.meanFlexionSpeedDegS, 'deg/s')),
    summaryCard('Mean movement angular speed', fmtUnit(summary.meanMovementSpeedDegS, 'deg/s')),
  );

  if (result.reps.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 11;
    cell.textContent = 'No complete repetitions detected. Try lowering Minimum ROM or Minimum rep duration, or switch the flexion convention.';
    row.appendChild(cell);
    replaceAnalysisTableRows([row]);
  } else {
    const rows = result.reps.map((rep) => {
      const row = document.createElement('tr');
      const cells = [
        String(rep.rep),
        `${fmt(rep.extensionStartDeg)} deg @ ${fmt(rep.extensionStartTimeSec, 2)} s`,
        `${fmt(rep.extensionEndDeg)} deg @ ${fmt(rep.extensionEndTimeSec, 2)} s`,
        `${fmt(rep.extensionRomDeg)} deg`,
        `${fmt(rep.flexionStartDeg)} deg @ ${fmt(rep.flexionStartTimeSec, 2)} s`,
        `${fmt(rep.flexionEndDeg)} deg @ ${fmt(rep.flexionEndTimeSec, 2)} s`,
        `${fmt(rep.flexionRomDeg)} deg`,
        `${fmt(rep.rangeOfMotionDeg)} deg`,
        `${fmt(rep.meanExtensionSpeedDegS)} deg/s`,
        `${fmt(rep.meanFlexionSpeedDegS)} deg/s`,
        `${fmt(rep.meanMovementSpeedDegS)} deg/s`,
      ];
      for (const text of cells) row.appendChild(makeElement('td', text));
      return row;
    });
    replaceAnalysisTableRows(rows);
  }

  analysisChart.render(result);
  setAnalysisStatus(`Analyzed file: ${sourceName || 'current log'}.`, 'success');
}

async function analyzeCsvText(csvText, sourceName) {
  clearAnalysisResults('Analyzing movement...');
  setAnalysisStatus('Analyzing movement...', 'info');

  try {
    const result = analyzeKneeAngleCsv(csvText, analysisOptions());
    renderAnalysisResult(result, sourceName);
  } catch (error) {
    clearAnalysisResults(error?.message ?? 'Could not analyze this CSV.');
    setAnalysisStatus(error?.message ?? 'Could not analyze this CSV.', 'error');
  }
}

async function analyzeSelectedCsvFile() {
  const file = ui.analysisFileInput.files?.[0];
  if (!file) {
    clearAnalysisResults('Choose a saved CSV file first.');
    setAnalysisStatus('Choose a saved CSV file first.', 'error');
    return;
  }

  try {
    const text = await file.text();
    await analyzeCsvText(text, file.name);
  } catch (error) {
    clearAnalysisResults(error?.message ?? 'Could not read the selected file.');
    setAnalysisStatus(error?.message ?? 'Could not read the selected file.', 'error');
  }
}

async function analyzeCurrentLog() {
  const csvText = buildCsv();
  if (!csvText) {
    clearAnalysisResults('No current log rows are available. Start logging first or choose a saved CSV.');
    setAnalysisStatus('No current log rows are available.', 'error');
    return;
  }
  await analyzeCsvText(csvText, 'current unsaved log');
}

function sanitizedBaseName(name) {
  const fallback = `xsens-dot-knee-analysis-${localTimestampForFileName()}`;
  const raw = String(name || fallback).replace(/\.[^.]+$/, '');
  const sanitized = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160);
  return sanitized || fallback;
}

async function exportAnalysisCsv() {
  if (!latestAnalysisResult || latestAnalysisResult.reps.length === 0) {
    setAnalysisStatus('No repetition metrics to save yet.', 'error');
    return;
  }

  const csvText = repetitionMetricsToCsv(latestAnalysisResult.reps);
  const fileName = `${sanitizedBaseName(latestAnalysisSourceName)}-analysis.csv`;

  if (directoryHandle) {
    try {
      const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(csvText);
      await writable.close();
      setAnalysisStatus(`Analysis saved to ${fileName}.`, 'success');
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      showError(error);
      setAnalysisStatus('Could not write analysis to the selected folder. Downloading instead.', 'error');
    }
  }

  downloadCsvBlob(csvText, fileName);
  setAnalysisStatus(`Analysis downloaded as ${fileName}.`, 'success');
}


function updateLoggingStatus(message = '') {
  if (isLogging) {
    ui.logStatus.textContent = '● Logging';
    ui.logStatus.hidden = false;
    ui.logStatus.dataset.state = 'active';
  } else if (message) {
    ui.logStatus.textContent = message;
    ui.logStatus.hidden = false;
    ui.logStatus.dataset.state = 'info';
  } else {
    ui.logStatus.textContent = '';
    ui.logStatus.hidden = true;
    ui.logStatus.dataset.state = 'idle';
  }
}

function toggleLogging() {
  isLogging = !isLogging;
  ui.logBtn.textContent = isLogging ? 'Stop CSV logging' : 'Start CSV logging';
  updateLoggingStatus();
}

function fakeSample(yDeg) {
  return {
    timestampUs: Math.floor(performance.now() * 1000),
    receivedAtMs: performance.now(),
    euler: { x: 0, y: yDeg, z: 0 },
  };
}

function fakeBattery(levelPercent, isCharging = false) {
  return {
    levelPercent,
    chargingStatus: isCharging ? 1 : 0,
    isCharging,
    receivedAtMs: performance.now(),
  };
}

function toggleMockStream() {
  if (mockTimer) {
    clearInterval(mockTimer);
    mockTimer = null;
    mockBatteries = { thigh: null, shank: null };
    ui.mockBtn.textContent = 'Start mock stream';
    setStatus('thigh', sensors.thigh.connected ? 'Connected' : 'Disconnected', sensors.thigh.connected ? 'connected' : 'disconnected');
    setStatus('shank', sensors.shank.connected ? 'Connected' : 'Disconnected', sensors.shank.connected ? 'connected' : 'disconnected');
    updateBatteryPanel('thigh', { battery: sensors.thigh.latestBattery, available: Boolean(sensors.thigh.latestBattery) });
    updateBatteryPanel('shank', { battery: sensors.shank.latestBattery, available: Boolean(sensors.shank.latestBattery) });
    return;
  }

  const startedAt = performance.now();
  mockBatteries = {
    thigh: fakeBattery(92),
    shank: fakeBattery(89),
  };
  setStatus('thigh', 'Mock streaming', 'streaming');
  setStatus('shank', 'Mock streaming', 'streaming');
  ui.thigh.name.textContent = 'Mock thigh DOT';
  ui.shank.name.textContent = 'Mock shank DOT';
  updateBatteryPanel('thigh', { battery: mockBatteries.thigh, available: true });
  updateBatteryPanel('shank', { battery: mockBatteries.shank, available: true });
  ui.mockBtn.textContent = 'Stop mock stream';

  mockTimer = setInterval(() => {
    const t = (performance.now() - startedAt) / 1000;
    const thighJitter = (Math.random() - 0.5) * 1.2;
    const shankJitter = (Math.random() - 0.5) * 1.2;
    const thigh = 8 * Math.sin(t * 1.2) + thighJitter;
    const relativeFlexion = 35 + 25 * Math.sin(t * 2.4);
    const shank = thigh - relativeFlexion + shankJitter;

    mockBatteries.thigh = fakeBattery(Math.max(0, 92 - Math.floor(t / 120)));
    mockBatteries.shank = fakeBattery(Math.max(0, 89 - Math.floor(t / 120)));
    updateBatteryPanel('thigh', { battery: mockBatteries.thigh, available: true });
    updateBatteryPanel('shank', { battery: mockBatteries.shank, available: true });

    const thighSample = fakeSample(thigh);
    const shankSample = fakeSample(shank);

    estimator.update('thigh', thighSample);
    estimator.update('shank', shankSample);
    updateSensorPanel('thigh', thighSample);
    updateSensorPanel('shank', shankSample);
    updateMetrics('mock');
  }, 1000 / 60);
}

function bindUi() {
  attachSensorEvents('thigh');
  attachSensorEvents('shank');

  ui.thigh.connect.addEventListener('click', () => connectSegment('thigh'));
  ui.shank.connect.addEventListener('click', () => connectSegment('shank'));
  ui.thigh.start.addEventListener('click', () => startSegment('thigh'));
  ui.shank.start.addEventListener('click', () => startSegment('shank'));
  ui.thigh.stop.addEventListener('click', () => stopSegment('thigh'));
  ui.shank.stop.addEventListener('click', () => stopSegment('shank'));

  ui.startAllBtn.addEventListener('click', startBoth);
  ui.stopAllBtn.addEventListener('click', stopBoth);

  ui.axisSelect.addEventListener('change', (event) => {
    estimator.setAxis(event.target.value);
    chart.clear();
    updateMetrics('axis-change');
  });

  ui.smoothingRange.addEventListener('input', (event) => {
    estimator.setSmoothingPercent(event.target.value);
    updateSmoothingLabel();
    updateMetrics('smoothing-change');
  });

  ui.invertSign.addEventListener('change', (event) => {
    estimator.setInverted(event.target.checked);
    chart.clear();
    updateMetrics('invert-change');
  });

  ui.calibrateBtn.addEventListener('click', () => {
    try {
      estimator.calibrateZero();
      chart.clear();
      updateMetrics('zero-calibration');
    } catch (error) {
      showError(error);
    }
  });

  ui.resetZeroBtn.addEventListener('click', () => {
    estimator.resetZero();
    chart.clear();
    updateMetrics('zero-reset');
  });

  ui.resetFilterBtn.addEventListener('click', () => {
    estimator.resetFilterToCurrent();
    updateMetrics('filter-reset');
  });

  ui.fileNameInput.addEventListener('input', updateFolderStatus);
  ui.chooseFolderBtn.addEventListener('click', chooseFolder);
  ui.logBtn.addEventListener('click', toggleLogging);
  ui.downloadBtn.addEventListener('click', saveCsv);
  ui.mockBtn.addEventListener('click', toggleMockStream);
  ui.clearBtn.addEventListener('click', () => chart.clear());
  ui.analyzeFileBtn.addEventListener('click', analyzeSelectedCsvFile);
  ui.analyzeCurrentLogBtn.addEventListener('click', analyzeCurrentLog);
  ui.exportAnalysisBtn.addEventListener('click', exportAnalysisCsv);
  ui.analysisFileInput.addEventListener('change', () => {
    const file = ui.analysisFileInput.files?.[0];
    if (file) setAnalysisStatus(`Selected file: ${file.name}.`, 'info');
  });
}

ui.fileNameInput.value = defaultCsvName();
ui.smoothingRange.value = String(DEFAULT_SMOOTHING_PERCENT);
updateBrowserSupport();
updateSmoothingLabel();
updateFolderStatus();
updateLoggingStatus();
setAnalysisStatus();
updateBatteryPanel('thigh');
updateBatteryPanel('shank');
bindUi();
updateMetrics();
