export const UUIDS = Object.freeze({
  configurationService: '15171000-4947-11e9-8646-d663bd873d93',
  measurementService: '15172000-4947-11e9-8646-d663bd873d93',
  batteryService: '15173000-4947-11e9-8646-d663bd873d93',
  measurementControl: '15172001-4947-11e9-8646-d663bd873d93',
  longPayload: '15172002-4947-11e9-8646-d663bd873d93',
  mediumPayload: '15172003-4947-11e9-8646-d663bd873d93',
  shortPayload: '15172004-4947-11e9-8646-d663bd873d93',
  batteryCharacteristic: '15173001-4947-11e9-8646-d663bd873d93',
});

export const PAYLOAD_MODE = Object.freeze({
  ORIENTATION_EULER: 4,
});

const BATTERY_POLL_INTERVAL_MS = 60_000;

export function browserSupportsWebBluetooth() {
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
}

function asDataView(value) {
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (ArrayBuffer.isView(value)) {
    return new DataView(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('Expected a DataView, ArrayBuffer, or typed array.');
}

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function parseOrientationEuler(value) {
  const view = asDataView(value);
  if (view.byteLength < 16) {
    throw new Error(`Orientation Euler payload must be at least 16 bytes; received ${view.byteLength}.`);
  }

  return {
    timestampUs: view.getUint32(0, true),
    euler: {
      x: view.getFloat32(4, true),
      y: view.getFloat32(8, true),
      z: view.getFloat32(12, true),
    },
    receivedAtMs: nowMs(),
  };
}

export function parseBatteryStatus(value) {
  const view = asDataView(value);
  if (view.byteLength < 2) {
    throw new Error(`Battery payload must be 2 bytes; received ${view.byteLength}.`);
  }

  const levelPercent = view.getUint8(0);
  const chargingStatus = view.getUint8(1);

  return {
    levelPercent,
    chargingStatus,
    isCharging: chargingStatus === 1,
    receivedAtMs: nowMs(),
  };
}

async function writeCharacteristic(characteristic, bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(value);
  } else {
    await characteristic.writeValue(value);
  }
}

export class XsensDotDevice extends EventTarget {
  constructor(segmentLabel) {
    super();
    this.segmentLabel = segmentLabel;
    this.device = null;
    this.server = null;
    this.measurementService = null;
    this.controlCharacteristic = null;
    this.payloadCharacteristic = null;
    this.batteryService = null;
    this.batteryCharacteristic = null;
    this.latestSample = null;
    this.latestBattery = null;
    this.connected = false;
    this.streaming = false;
    this._batteryPollTimer = null;
    this._onNotification = this._onNotification.bind(this);
    this._onBatteryNotification = this._onBatteryNotification.bind(this);
    this._onDisconnected = this._onDisconnected.bind(this);
  }

  get name() {
    return this.device?.name ?? 'Unnamed DOT';
  }

  async requestAndConnect() {
    if (!browserSupportsWebBluetooth()) {
      throw new Error('Web Bluetooth is not available in this browser. Use Chrome or Edge over HTTPS/localhost.');
    }

    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'Movella' },
        { namePrefix: 'Xsens' },
      ],
      optionalServices: [
        UUIDS.measurementService,
        UUIDS.configurationService,
        UUIDS.batteryService,
      ],
    });

    await this.connect(device);
    return this;
  }

  async connect(device = this.device) {
    if (!device) {
      throw new Error('No Bluetooth device selected.');
    }

    this.device = device;
    this.device.removeEventListener('gattserverdisconnected', this._onDisconnected);
    this.device.addEventListener('gattserverdisconnected', this._onDisconnected);

    this.server = await this.device.gatt.connect();
    this.measurementService = await this.server.getPrimaryService(UUIDS.measurementService);
    this.controlCharacteristic = await this.measurementService.getCharacteristic(UUIDS.measurementControl);
    this.payloadCharacteristic = await this.measurementService.getCharacteristic(UUIDS.shortPayload);

    this.connected = true;
    this.dispatchEvent(new CustomEvent('status', { detail: this.statusDetail('connected') }));
    await this._setupBatteryMonitoring();
  }

  async startStreaming() {
    if (!this.connected || !this.payloadCharacteristic || !this.controlCharacteristic) {
      throw new Error(`${this.segmentLabel} DOT is not connected.`);
    }

    this.payloadCharacteristic.removeEventListener('characteristicvaluechanged', this._onNotification);
    this.payloadCharacteristic.addEventListener('characteristicvaluechanged', this._onNotification);

    await this.payloadCharacteristic.startNotifications();

    // Control characteristic: type=1 measurement, action=1 start, payload mode=4 Orientation Euler.
    await writeCharacteristic(this.controlCharacteristic, [0x01, 0x01, PAYLOAD_MODE.ORIENTATION_EULER]);
    this.streaming = true;
    this.dispatchEvent(new CustomEvent('status', { detail: this.statusDetail('streaming') }));
  }

  async stopStreaming() {
    if (!this.controlCharacteristic) return;

    // Control characteristic: type=1 measurement, action=0 stop. Payload byte is ignored for stop.
    await writeCharacteristic(this.controlCharacteristic, [0x01, 0x00, 0x00]);

    if (this.payloadCharacteristic) {
      try {
        await this.payloadCharacteristic.stopNotifications();
      } catch {
        // Some platforms throw when notifications have already stopped. Safe to ignore.
      }
      this.payloadCharacteristic.removeEventListener('characteristicvaluechanged', this._onNotification);
    }

    this.streaming = false;
    this.dispatchEvent(new CustomEvent('status', { detail: this.statusDetail('connected') }));
  }

  async refreshBattery() {
    if (!this.connected || !this.batteryCharacteristic) {
      throw new Error(`${this.segmentLabel} DOT battery characteristic is not available.`);
    }

    const value = await this.batteryCharacteristic.readValue();
    const battery = parseBatteryStatus(value);
    this.latestBattery = battery;
    this.dispatchEvent(new CustomEvent('battery', {
      detail: {
        segment: this.segmentLabel,
        battery,
        available: true,
        device: this,
      },
    }));
    return battery;
  }

  async disconnect() {
    await this.stopStreaming();
    await this._stopBatteryMonitoring();
    this.device?.gatt?.disconnect();
    this.connected = false;
    this.streaming = false;
    this.latestBattery = null;
    this.dispatchEvent(new CustomEvent('status', { detail: this.statusDetail('disconnected') }));
    this.dispatchEvent(new CustomEvent('battery', {
      detail: {
        segment: this.segmentLabel,
        battery: null,
        available: false,
        device: this,
      },
    }));
  }

  statusDetail(state) {
    return {
      segment: this.segmentLabel,
      state,
      name: this.name,
      connected: this.connected,
      streaming: this.streaming,
      battery: this.latestBattery,
    };
  }

  async _setupBatteryMonitoring() {
    await this._stopBatteryMonitoring();

    try {
      this.batteryService = await this.server.getPrimaryService(UUIDS.batteryService);
      this.batteryCharacteristic = await this.batteryService.getCharacteristic(UUIDS.batteryCharacteristic);

      this.batteryCharacteristic.removeEventListener('characteristicvaluechanged', this._onBatteryNotification);
      this.batteryCharacteristic.addEventListener('characteristicvaluechanged', this._onBatteryNotification);

      await this.refreshBattery();

      try {
        await this.batteryCharacteristic.startNotifications();
      } catch {
        // Reading still works even if the browser/platform rejects battery notifications.
      }

      if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
        this._batteryPollTimer = window.setInterval(() => {
          this.refreshBattery().catch(() => {
            // Ignore transient read failures; disconnect/status events handle permanent failures.
          });
        }, BATTERY_POLL_INTERVAL_MS);
      }
    } catch (error) {
      this.latestBattery = null;
      this.batteryService = null;
      this.batteryCharacteristic = null;
      this.dispatchEvent(new CustomEvent('battery', {
        detail: {
          segment: this.segmentLabel,
          battery: null,
          available: false,
          error,
          device: this,
        },
      }));
    }
  }

  async _stopBatteryMonitoring() {
    if (this._batteryPollTimer && typeof window !== 'undefined') {
      window.clearInterval(this._batteryPollTimer);
    }
    this._batteryPollTimer = null;

    if (this.batteryCharacteristic) {
      try {
        await this.batteryCharacteristic.stopNotifications();
      } catch {
        // Some platforms throw when notifications have already stopped. Safe to ignore.
      }
      this.batteryCharacteristic.removeEventListener('characteristicvaluechanged', this._onBatteryNotification);
    }
  }

  _onNotification(event) {
    try {
      const sample = parseOrientationEuler(event.target.value);
      this.latestSample = sample;
      this.dispatchEvent(new CustomEvent('sample', {
        detail: {
          segment: this.segmentLabel,
          sample,
          device: this,
        },
      }));
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    }
  }

  _onBatteryNotification(event) {
    try {
      const battery = parseBatteryStatus(event.target.value);
      this.latestBattery = battery;
      this.dispatchEvent(new CustomEvent('battery', {
        detail: {
          segment: this.segmentLabel,
          battery,
          available: true,
          device: this,
        },
      }));
    } catch (error) {
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    }
  }

  _onDisconnected() {
    this.connected = false;
    this.streaming = false;
    this.latestBattery = null;
    this._stopBatteryMonitoring().catch(() => {});
    this.dispatchEvent(new CustomEvent('status', { detail: this.statusDetail('disconnected') }));
    this.dispatchEvent(new CustomEvent('battery', {
      detail: {
        segment: this.segmentLabel,
        battery: null,
        available: false,
        device: this,
      },
    }));
  }
}
