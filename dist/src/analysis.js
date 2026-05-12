function numberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return '';
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : NaN;
}

function pushCsvField(row, field) {
  row.push(field);
}

export function parseCsv(text) {
  const source = String(text ?? '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushCsvField(row, field);
      field = '';
    } else if (ch === '\n') {
      pushCsvField(row, field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      pushCsvField(row, field);
      rows.push(row);
      row = [];
      field = '';
      if (source[i + 1] === '\n') i += 1;
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    pushCsvField(row, field);
    rows.push(row);
  }

  const nonEmptyRows = rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
  if (nonEmptyRows.length === 0) return { headers: [], rows: [] };

  const headers = nonEmptyRows[0].map((h, i) => {
    const cleaned = String(h).replace(/^\uFEFF/, '').trim();
    return cleaned || `column_${i + 1}`;
  });

  const objects = nonEmptyRows.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((header, i) => {
      obj[header] = cells[i] ?? '';
    });
    return obj;
  });

  return { headers, rows: objects };
}

function pickColumn(headers, requested, preferred) {
  if (requested && headers.includes(requested)) return requested;
  return preferred.find((name) => headers.includes(name)) ?? null;
}

function numericTimeScale(column) {
  const lower = column.toLowerCase();
  if (lower.includes('us') || lower.includes('micro')) return 1 / 1_000_000;
  if (lower.includes('ms') || lower.includes('milli')) return 1 / 1_000;
  return 1;
}

function extractSamples(rows, headers, options = {}) {
  const angleColumn = pickColumn(headers, options.angleColumn, [
    'knee_angle_filtered_deg',
    'knee_angle_deg',
    'knee_angle_unfiltered_deg',
    'angle_deg',
    'knee_angle',
  ]);

  if (!angleColumn) {
    throw new Error('Could not find a knee angle column. Expected knee_angle_filtered_deg or knee_angle_deg.');
  }

  const timeColumn = pickColumn(headers, options.timeColumn, [
    'iso_time',
    'time_s',
    'time_sec',
    'time_seconds',
    'elapsed_s',
    'timestamp_s',
    'timestamp_ms',
    'timestamp_us',
  ]);

  const sampleRateHz = Math.max(1, numberOrDefault(options.sampleRateHz, 60));
  const raw = [];

  rows.forEach((row, rowIndex) => {
    const angleDeg = parseNumber(row[angleColumn]);
    if (!Number.isFinite(angleDeg)) return;

    let timeValue = rowIndex / sampleRateHz;
    let rawTime = null;

    if (timeColumn) {
      if (timeColumn === 'iso_time') {
        const parsedMs = Date.parse(row[timeColumn]);
        if (Number.isFinite(parsedMs)) rawTime = parsedMs / 1000;
      } else {
        const parsedTime = parseNumber(row[timeColumn]);
        if (Number.isFinite(parsedTime)) rawTime = parsedTime * numericTimeScale(timeColumn);
      }
    }

    if (Number.isFinite(rawTime)) timeValue = rawTime;

    raw.push({
      rowIndex,
      rawTime: timeValue,
      angleDeg,
    });
  });

  if (raw.length < 3) {
    throw new Error('Not enough valid knee angle samples to analyze.');
  }

  raw.sort((a, b) => a.rawTime - b.rawTime || a.rowIndex - b.rowIndex);
  const baseTime = raw[0].rawTime;
  const samples = raw.map((sample, i) => ({
    index: i,
    rowIndex: sample.rowIndex,
    timeSec: Math.max(0, sample.rawTime - baseTime),
    angleDeg: sample.angleDeg,
  }));

  return { samples, angleColumn, timeColumn: timeColumn || 'row_index_assuming_60_hz' };
}

function centeredMovingAverage(values, requestedWindow) {
  const windowSize = Math.max(1, Math.floor(numberOrDefault(requestedWindow, 1)));
  if (windowSize <= 1) return values.slice();

  const half = Math.floor(windowSize / 2);
  const smoothed = [];
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j += 1) {
      if (Number.isFinite(values[j])) {
        sum += values[j];
        count += 1;
      }
    }
    smoothed.push(count > 0 ? sum / count : values[i]);
  }
  return smoothed;
}


function medianSampleIntervalSec(samples) {
  const intervals = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = samples[i].timeSec - samples[i - 1].timeSec;
    if (Number.isFinite(dt) && dt > 0) intervals.push(dt);
  }
  if (intervals.length === 0) return 1 / 60;
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)] || 1 / 60;
}

function addAngularVelocity(samples, directionSign, velocitySmoothingWindow = 1) {
  const velocities = samples.map((sample, i) => {
    let previousIndex = i - 1;
    while (previousIndex >= 0 && samples[previousIndex].timeSec === sample.timeSec) previousIndex -= 1;
    let nextIndex = i + 1;
    while (nextIndex < samples.length && samples[nextIndex].timeSec === sample.timeSec) nextIndex += 1;

    let velocityDegS = 0;
    if (previousIndex >= 0 && nextIndex < samples.length) {
      const dt = samples[nextIndex].timeSec - samples[previousIndex].timeSec;
      velocityDegS = dt > 0 ? (samples[nextIndex].angleDeg - samples[previousIndex].angleDeg) / dt : 0;
    } else if (previousIndex >= 0) {
      const dt = sample.timeSec - samples[previousIndex].timeSec;
      velocityDegS = dt > 0 ? (sample.angleDeg - samples[previousIndex].angleDeg) / dt : 0;
    } else if (nextIndex < samples.length) {
      const dt = samples[nextIndex].timeSec - sample.timeSec;
      velocityDegS = dt > 0 ? (samples[nextIndex].angleDeg - sample.angleDeg) / dt : 0;
    }
    return velocityDegS;
  });

  const smoothedVelocities = centeredMovingAverage(velocities, velocitySmoothingWindow);
  return samples.map((sample, i) => ({
    ...sample,
    velocityDegS: velocities[i] || 0,
    smoothedVelocityDegS: smoothedVelocities[i] || 0,
    detectionVelocityDegS: directionSign * (smoothedVelocities[i] || 0),
  }));
}

function classifyVelocityStates(samples, thresholdDegS) {
  const threshold = Math.max(0.1, numberOrDefault(thresholdDegS, 10));
  return samples.map((sample) => {
    if (sample.detectionVelocityDegS <= -threshold) return 'extension';
    if (sample.detectionVelocityDegS >= threshold) return 'flexion';
    return 'hold';
  });
}

function makeBlocks(states, samples) {
  if (!states.length) return [];
  const blocks = [];
  let startIndex = 0;
  let state = states[0];

  const pushBlock = (endIndex) => {
    const start = samples[startIndex];
    const end = samples[endIndex];
    if (!start || !end) return;
    blocks.push({
      state,
      startIndex,
      endIndex,
      startTimeSec: start.timeSec,
      endTimeSec: end.timeSec,
      durationSec: Math.max(0, end.timeSec - start.timeSec),
      signedChangeDeg: end.angleDeg - start.angleDeg,
      detectionChangeDeg: end.detectionDeg - start.detectionDeg,
      angleDistanceDeg: Math.abs(end.angleDeg - start.angleDeg),
    });
  };

  for (let i = 1; i < states.length; i += 1) {
    if (states[i] !== state) {
      pushBlock(i - 1);
      startIndex = i;
      state = states[i];
    }
  }
  pushBlock(states.length - 1);
  return blocks;
}

function statesFromBlocks(blocks, length) {
  const states = new Array(length).fill('hold');
  for (const block of blocks) {
    for (let i = block.startIndex; i <= block.endIndex; i += 1) states[i] = block.state;
  }
  return states;
}

function cleanVelocityStates(rawStates, samples, options = {}) {
  const minMoveDurationSec = Math.max(0.05, numberOrDefault(options.minMovementDurationSec, 0.25));
  const minMoveAngleDeg = Math.max(0.5, numberOrDefault(options.minMovementAngleDeg, 3));
  const maxHoldMergeSec = Math.max(0.02, numberOrDefault(options.maxHoldMergeSec, minMoveDurationSec));
  let states = rawStates.slice();

  let changed = true;
  while (changed) {
    changed = false;
    const blocks = makeBlocks(states, samples);
    for (const block of blocks) {
      if (
        block.state !== 'hold'
        && (block.durationSec < minMoveDurationSec || block.angleDistanceDeg < minMoveAngleDeg)
      ) {
        for (let i = block.startIndex; i <= block.endIndex; i += 1) states[i] = 'hold';
        changed = true;
        break;
      }
    }
  }

  changed = true;
  while (changed) {
    changed = false;
    const blocks = makeBlocks(states, samples);
    for (let i = 1; i < blocks.length - 1; i += 1) {
      const previous = blocks[i - 1];
      const current = blocks[i];
      const next = blocks[i + 1];
      if (
        current.state === 'hold'
        && current.durationSec <= maxHoldMergeSec
        && previous.state === next.state
        && previous.state !== 'hold'
      ) {
        for (let j = current.startIndex; j <= current.endIndex; j += 1) states[j] = previous.state;
        changed = true;
        break;
      }
    }
  }

  return states;
}

function meanAbsVelocity(samples, startIndex, endIndex) {
  const values = [];
  for (let i = startIndex; i <= endIndex; i += 1) {
    const v = Math.abs(samples[i]?.smoothedVelocityDegS ?? samples[i]?.velocityDegS ?? NaN);
    if (Number.isFinite(v)) values.push(v);
  }
  return mean(values);
}

function movementDistance(samples, startIndex, endIndex) {
  let distance = 0;
  for (let i = startIndex + 1; i <= endIndex; i += 1) {
    const delta = samples[i].angleDeg - samples[i - 1].angleDeg;
    if (Number.isFinite(delta)) distance += Math.abs(delta);
  }
  return distance;
}

function getExtremaInRange(samples, startIndex, endIndex, directionSign) {
  let peakFlexion = null;
  let peakExtension = null;
  for (let i = Math.max(0, startIndex); i <= Math.min(samples.length - 1, endIndex); i += 1) {
    const sample = samples[i];
    if (!sample) continue;
    const detectionAngle = directionSign * sample.angleDeg;
    if (!peakFlexion || detectionAngle > directionSign * peakFlexion.angleDeg) peakFlexion = sample;
    if (!peakExtension || detectionAngle < directionSign * peakExtension.angleDeg) peakExtension = sample;
  }
  return { peakFlexion, peakExtension };
}

function findRepsFromVelocityBlocks(samples, blocks, options = {}) {
  const minRomDeg = Math.max(0, numberOrDefault(options.minRomDeg, 10));
  const minRepDurationSec = Math.max(0, numberOrDefault(options.minRepDurationSec, 0.4));
  const directionSign = options.flexionDirection === 'lower' ? -1 : 1;
  const movementBlocks = blocks.filter((block) => block.state !== 'hold');
  const reps = [];
  let i = 0;

  while (i < movementBlocks.length - 1) {
    const extensionBlock = movementBlocks[i];
    if (extensionBlock.state !== 'extension') {
      i += 1;
      continue;
    }

    let flexionBlockIndex = -1;
    for (let j = i + 1; j < movementBlocks.length; j += 1) {
      if (movementBlocks[j].state === 'flexion') {
        flexionBlockIndex = j;
        break;
      }
      if (movementBlocks[j].state === 'extension') break;
    }

    if (flexionBlockIndex < 0) {
      i += 1;
      continue;
    }

    const flexionBlock = movementBlocks[flexionBlockIndex];
    const extensionStartSample = samples[extensionBlock.startIndex];
    const extensionEndSample = samples[extensionBlock.endIndex];
    const flexionStartSample = samples[flexionBlock.startIndex];
    const flexionEndSample = samples[flexionBlock.endIndex];
    const repStartIndex = extensionBlock.startIndex;
    const repEndIndex = flexionBlock.endIndex;
    const repDurationSec = flexionEndSample.timeSec - extensionStartSample.timeSec;

    if (repDurationSec < minRepDurationSec) {
      i = flexionBlockIndex + 1;
      continue;
    }

    const extensionRomDeg = Math.abs(extensionStartSample.angleDeg - extensionEndSample.angleDeg);
    const flexionRomDeg = Math.abs(flexionEndSample.angleDeg - flexionStartSample.angleDeg);
    const { peakFlexion, peakExtension } = getExtremaInRange(samples, repStartIndex, repEndIndex, directionSign);
    const rangeOfMotionDeg = peakFlexion && peakExtension ? Math.abs(peakFlexion.angleDeg - peakExtension.angleDeg) : NaN;

    if (
      !Number.isFinite(rangeOfMotionDeg)
      || rangeOfMotionDeg < minRomDeg
      || extensionRomDeg < Math.max(1, minRomDeg * 0.35)
      || flexionRomDeg < Math.max(1, minRomDeg * 0.35)
    ) {
      i = flexionBlockIndex + 1;
      continue;
    }

    const extensionDistanceDeg = movementDistance(samples, extensionBlock.startIndex, extensionBlock.endIndex);
    const flexionDistanceDeg = movementDistance(samples, flexionBlock.startIndex, flexionBlock.endIndex);
    const movementDurationSec = extensionBlock.durationSec + flexionBlock.durationSec;
    const movementAngleDistanceDeg = extensionDistanceDeg + flexionDistanceDeg;

    reps.push({
      rep: reps.length + 1,
      startIndex: repStartIndex,
      endIndex: repEndIndex,
      extensionStartIndex: extensionBlock.startIndex,
      extensionEndIndex: extensionBlock.endIndex,
      extensionPeakIndex: extensionBlock.endIndex,
      flexionStartIndex: flexionBlock.startIndex,
      flexionEndIndex: flexionBlock.endIndex,
      extensionMovementDetected: true,
      flexionMovementDetected: true,
      startTimeSec: extensionStartSample.timeSec,
      endTimeSec: flexionEndSample.timeSec,
      durationSec: repDurationSec,
      extensionStartTimeSec: extensionStartSample.timeSec,
      extensionEndTimeSec: extensionEndSample.timeSec,
      flexionStartTimeSec: flexionStartSample.timeSec,
      flexionEndTimeSec: flexionEndSample.timeSec,
      extensionStartDeg: extensionStartSample.angleDeg,
      extensionEndDeg: extensionEndSample.angleDeg,
      flexionStartDeg: flexionStartSample.angleDeg,
      flexionEndDeg: flexionEndSample.angleDeg,
      extensionRomDeg,
      flexionRomDeg,
      peakFlexionIndex: peakFlexion?.index ?? extensionBlock.startIndex,
      peakExtensionIndex: peakExtension?.index ?? extensionBlock.endIndex,
      peakFlexionDeg: peakFlexion?.angleDeg ?? extensionStartSample.angleDeg,
      peakFlexionTimeSec: peakFlexion?.timeSec ?? extensionStartSample.timeSec,
      peakExtensionDeg: peakExtension?.angleDeg ?? extensionEndSample.angleDeg,
      peakExtensionTimeSec: peakExtension?.timeSec ?? extensionEndSample.timeSec,
      rangeOfMotionDeg,
      extensionDurationSec: extensionBlock.durationSec,
      flexionDurationSec: flexionBlock.durationSec,
      extensionAngleDistanceDeg: extensionDistanceDeg,
      flexionAngleDistanceDeg: flexionDistanceDeg,
      movementDurationSec,
      movementAngleDistanceDeg,
      meanExtensionSpeedDegS: meanAbsVelocity(samples, extensionBlock.startIndex, extensionBlock.endIndex),
      meanFlexionSpeedDegS: meanAbsVelocity(samples, flexionBlock.startIndex, flexionBlock.endIndex),
      meanMovementSpeedDegS: movementDurationSec > 0 ? movementAngleDistanceDeg / movementDurationSec : NaN,
    });

    i = flexionBlockIndex + 1;
  }

  return reps;
}

function endpointsFromReps(reps, samples) {
  const points = [];
  const add = (type, index) => {
    const sample = samples[index];
    if (!sample) return;
    points.push({ type, index, y: sample.angleDeg, timeSec: sample.timeSec });
  };

  for (const rep of reps) {
    add('extension-start', rep.extensionStartIndex);
    add('extension-end', rep.extensionEndIndex);
    add('flexion-start', rep.flexionStartIndex);
    add('flexion-end', rep.flexionEndIndex);
  }
  return points;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return NaN;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function extreme(values, fn) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return NaN;
  return fn(...finite);
}

function buildSummary(reps, samples, directionSign) {
  const angleValues = samples.map((sample) => sample.angleDeg);
  const overallPeakFlexion = directionSign === 1
    ? extreme(angleValues, Math.max)
    : extreme(angleValues, Math.min);
  const overallPeakExtension = directionSign === 1
    ? extreme(angleValues, Math.min)
    : extreme(angleValues, Math.max);

  return {
    repetitionCount: reps.length,
    sampleCount: samples.length,
    durationSec: samples.length > 1 ? samples[samples.length - 1].timeSec - samples[0].timeSec : 0,
    overallPeakFlexionDeg: overallPeakFlexion,
    overallPeakExtensionDeg: overallPeakExtension,
    meanRangeOfMotionDeg: mean(reps.map((rep) => rep.rangeOfMotionDeg)),
    meanExtensionSpeedDegS: mean(reps.map((rep) => rep.meanExtensionSpeedDegS)),
    meanFlexionSpeedDegS: mean(reps.map((rep) => rep.meanFlexionSpeedDegS)),
    meanMovementSpeedDegS: mean(reps.map((rep) => rep.meanMovementSpeedDegS)),
  };
}

export function analyzeKneeAngleRows(rows, headers, options = {}) {
  const { samples: extractedSamples, angleColumn, timeColumn } = extractSamples(rows, headers, options);
  const directionSign = options.flexionDirection === 'lower' ? -1 : 1;
  const smoothingWindow = clamp(Math.floor(numberOrDefault(options.smoothingWindow, 1)), 1, 101);
  const smoothedAngles = centeredMovingAverage(extractedSamples.map((sample) => sample.angleDeg), smoothingWindow);
  const samplesWithoutVelocity = extractedSamples.map((sample, i) => ({
    ...sample,
    angleDeg: smoothedAngles[i],
    originalAngleDeg: sample.angleDeg,
    detectionDeg: directionSign * smoothedAngles[i],
  }));
  const velocitySmoothingWindow = Math.max(1, Math.floor(numberOrDefault(options.velocitySmoothingWindow, 11)));
  const samples = addAngularVelocity(samplesWithoutVelocity, directionSign, velocitySmoothingWindow);
  const rawStates = classifyVelocityStates(samples, options.movementThresholdDegS);
  const states = cleanVelocityStates(rawStates, samples, options);
  const blocks = makeBlocks(states, samples);
  const reps = findRepsFromVelocityBlocks(samples, blocks, options);
  const extrema = endpointsFromReps(reps, samples);

  return {
    angleColumn,
    timeColumn,
    directionSign,
    smoothingWindow,
    velocitySmoothingWindow,
    samples,
    states,
    blocks,
    extrema,
    reps,
    summary: buildSummary(reps, samples, directionSign),
  };
}

export function analyzeKneeAngleCsv(text, options = {}) {
  const { headers, rows } = parseCsv(text);
  if (headers.length === 0) throw new Error('The selected CSV appears to be empty.');
  return analyzeKneeAngleRows(rows, headers, options);
}

export function repetitionMetricsToCsv(reps) {
  const headers = [
    'rep',
    'extension_start_time_s',
    'extension_end_time_s',
    'extension_start_angle_deg',
    'extension_end_angle_deg',
    'extension_rom_deg',
    'flexion_start_time_s',
    'flexion_end_time_s',
    'flexion_start_angle_deg',
    'flexion_end_angle_deg',
    'flexion_rom_deg',
    'rep_start_time_s',
    'rep_end_time_s',
    'rep_duration_s',
    'rep_rom_deg',
    'peak_flexion_deg',
    'peak_extension_deg',
    'mean_extension_angular_speed_deg_s',
    'mean_flexion_angular_speed_deg_s',
    'mean_movement_angular_speed_deg_s',
    'extension_start_index',
    'extension_end_index',
    'flexion_start_index',
    'flexion_end_index',
  ];

  const rows = reps.map((rep) => ({
    rep: rep.rep,
    extension_start_time_s: round(rep.extensionStartTimeSec),
    extension_end_time_s: round(rep.extensionEndTimeSec),
    extension_start_angle_deg: round(rep.extensionStartDeg),
    extension_end_angle_deg: round(rep.extensionEndDeg),
    extension_rom_deg: round(rep.extensionRomDeg),
    flexion_start_time_s: round(rep.flexionStartTimeSec),
    flexion_end_time_s: round(rep.flexionEndTimeSec),
    flexion_start_angle_deg: round(rep.flexionStartDeg),
    flexion_end_angle_deg: round(rep.flexionEndDeg),
    flexion_rom_deg: round(rep.flexionRomDeg),
    rep_start_time_s: round(rep.startTimeSec),
    rep_end_time_s: round(rep.endTimeSec),
    rep_duration_s: round(rep.durationSec),
    rep_rom_deg: round(rep.rangeOfMotionDeg),
    peak_flexion_deg: round(rep.peakFlexionDeg),
    peak_extension_deg: round(rep.peakExtensionDeg),
    mean_extension_angular_speed_deg_s: round(rep.meanExtensionSpeedDegS),
    mean_flexion_angular_speed_deg_s: round(rep.meanFlexionSpeedDegS),
    mean_movement_angular_speed_deg_s: round(rep.meanMovementSpeedDegS),
    extension_start_index: rep.extensionStartIndex,
    extension_end_index: rep.extensionEndIndex,
    flexion_start_index: rep.flexionStartIndex,
    flexion_end_index: rep.flexionEndIndex,
  }));

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => JSON.stringify(row[header] ?? '')).join(','));
  }
  return lines.join('\n');
}
