export function normalizeDeg(angleDeg) {
  if (!Number.isFinite(angleDeg)) return NaN;
  return ((((angleDeg + 180) % 360) + 360) % 360) - 180;
}

export function circularDifferenceDeg(aDeg, bDeg) {
  return normalizeDeg(aDeg - bDeg);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class KneeAngleEstimator {
  constructor({ axis = 'y', inverted = false, smoothingPercent = 0 } = {}) {
    this.axis = axis;
    this.inverted = inverted;
    this.zeroOffsetDeg = 0;
    this.smoothingPercent = clamp(Number(smoothingPercent) || 0, 0, 95);
    this._filteredKneeAngleDeg = null;
    this.latest = {
      thigh: null,
      shank: null,
    };
  }

  setAxis(axis) {
    if (!['x', 'y', 'z'].includes(axis)) {
      throw new Error(`Invalid axis '${axis}'. Expected x, y, or z.`);
    }
    this.axis = axis;
    this.resetFilterToCurrent();
  }

  setInverted(inverted) {
    this.inverted = Boolean(inverted);
    this.resetFilterToCurrent();
  }

  setSmoothingPercent(percent) {
    const next = clamp(Number(percent) || 0, 0, 95);
    this.smoothingPercent = next;
    this.resetFilterToCurrent();
  }

  update(segment, sample) {
    if (!['thigh', 'shank'].includes(segment)) {
      throw new Error(`Invalid segment '${segment}'. Expected thigh or shank.`);
    }
    this.latest[segment] = sample;
    this._updateFilter();
  }

  get thighPitchDeg() {
    return this.latest.thigh?.euler?.[this.axis] ?? null;
  }

  get shankPitchDeg() {
    return this.latest.shank?.euler?.[this.axis] ?? null;
  }

  get ready() {
    return Number.isFinite(this.thighPitchDeg) && Number.isFinite(this.shankPitchDeg);
  }

  get rawAngleDeg() {
    if (!this.ready) return null;
    return circularDifferenceDeg(this.thighPitchDeg, this.shankPitchDeg);
  }

  get unfilteredKneeAngleDeg() {
    if (!this.ready) return null;
    const zeroed = circularDifferenceDeg(this.rawAngleDeg, this.zeroOffsetDeg);
    return this.inverted ? -zeroed : zeroed;
  }

  get filteredKneeAngleDeg() {
    if (!this.ready) return null;
    return Number.isFinite(this._filteredKneeAngleDeg)
      ? this._filteredKneeAngleDeg
      : this.unfilteredKneeAngleDeg;
  }

  get kneeAngleDeg() {
    return this.filteredKneeAngleDeg;
  }

  calibrateZero() {
    if (!this.ready) {
      throw new Error('Both thigh and shank samples are required before zero calibration.');
    }
    this.zeroOffsetDeg = this.rawAngleDeg;
    this.resetFilterToCurrent();
    return this.zeroOffsetDeg;
  }

  resetZero() {
    this.zeroOffsetDeg = 0;
    this.resetFilterToCurrent();
  }

  resetFilterToCurrent() {
    this._filteredKneeAngleDeg = Number.isFinite(this.unfilteredKneeAngleDeg)
      ? this.unfilteredKneeAngleDeg
      : null;
  }

  _updateFilter() {
    const unfiltered = this.unfilteredKneeAngleDeg;
    if (!Number.isFinite(unfiltered)) return;

    if (!Number.isFinite(this._filteredKneeAngleDeg) || this.smoothingPercent <= 0) {
      this._filteredKneeAngleDeg = unfiltered;
      return;
    }

    const alpha = 1 - this.smoothingPercent / 100;
    const delta = circularDifferenceDeg(unfiltered, this._filteredKneeAngleDeg);
    this._filteredKneeAngleDeg = normalizeDeg(this._filteredKneeAngleDeg + alpha * delta);
  }
}
