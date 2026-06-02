class PuffcoBrowserBleClient {
  constructor() {
    this.device = null;
    this.server = null;
    this.service = null;
    this.commandChar = null;
    this.replyChar = null;
    this.versionChar = null;
    this.sequence = 0;
    this.pending = new Map();
    this.commandQueue = Promise.resolve();
    this.lastProfiles = null;
    this.onDisconnected = null;
    this.disconnecting = false;
    this.replyHandler = (event) => this.onReply(event);
    this.disconnectHandler = () => this.handleGattDisconnected();
  }

  static LORAX_SERVICE = 'e276967f-ea8a-478a-a92e-d78f5dd15dd5';
  static VERSION_CHAR = '05434bca-cc7f-4ef6-bbb3-b1c520b9800c';
  static COMMAND_CHAR = '60133d5c-5727-4f2c-9697-d842c5292a3c';
  static REPLY_CHAR = '8dc5ec05-8f7d-45ad-99db-3fbde65dbd9c';
  static LORAX_KEY = 'ZMZFYlbyb1scoSc3pd1x+w==';

  static OPCODES = {
    GET_ACCESS_SEED: 0x00,
    UNLOCK_ACCESS: 0x01,
    READ_SHORT: 0x10,
    WRITE_SHORT: 0x11,
  };

  static MODE_COMMANDS = {
    sleep: 1,
    idle: 2,
    show_battery: 5,
    show_version: 6,
    heat: 7,
    stop: 8,
    boost: 9,
    off: 0,
  };

  static STATE_NAMES = {
    0: 'INIT_MEMORY',
    1: 'INIT_VERSION',
    2: 'INIT_BATTERY',
    3: 'MASTER_OFF',
    4: 'SLEEP',
    5: 'IDLE',
    6: 'TEMP_SELECT',
    7: 'HEAT_CYCLE_PREHEAT',
    8: 'HEAT_CYCLE_ACTIVE',
    9: 'HEAT_CYCLE_FADE',
    10: 'VERSION',
    11: 'BATT_LEVEL',
    12: 'FACTORY_TEST',
    13: 'BONDING',
  };

  static CHARGE_LABELS = {
    0: 'Charging',
    1: 'Charging',
    2: 'Full',
    3: 'Paused',
    4: 'On battery',
  };

  static CHAMBER_LABELS = {
    0: 'No chamber',
    1: 'Classic chamber',
    2: 'XL chamber',
    3: '3D chamber',
    4: 'Toad chamber',
  };

  static MOOD_PRESETS = {
    no_animation: { name: 'Static color', desc: 'Split your Peak into different color regions', tag: 'pikaled2-no-animation-mood-light', minColors: 1, maxColors: 6, defaults: ['#ff0000'], anim: 1 },
    fade: { name: 'Fade', desc: 'Smooth transitions', tag: 'pikaled2-fade-mood-light', minColors: 2, maxColors: 6, defaults: ['#ff0000', '#00ff00'], anim: 1 },
    disco: { name: 'Disco', desc: 'A spiraling color cycle', tag: 'pikaled2-disco-mood-light', minColors: 2, maxColors: 6, defaults: ['#ff0000', '#00ff00', '#0000ff'], anim: 1 },
    spin: { name: 'Spin', desc: 'A lighthouse to guide you', tag: 'pikaled2-spin-mood-light', minColors: 1, maxColors: 6, defaults: ['#ff0000'], anim: 7 },
    split_gradient: { name: 'Split Gradient', desc: 'Look into the fissure', tag: 'pikaled2-split-gradient-mood-light', minColors: 2, maxColors: 6, defaults: ['#ff0000', '#00ff00'], anim: 1 },
    vertical_slideshow: { name: 'Vertical Slideshow', desc: 'Colors slide upwards', tag: 'pikaled2-vertical-slideshow-mood-light', minColors: 2, maxColors: 6, defaults: ['#ff0000', '#00ff00'], anim: 1 },
  };

  static NO_ANIMATION_OFFSETS = [
    [0, 0, 0, 0, 0, 0, 65536, 0, 0, 65536, 0, 0, 65536, 65536, 0, 0, 65536, 65536, 65536, 0],
    [0, 0, 0, 0, 0, 0, 65536, 0, 0, 65536, 4096, 4096, 65536, 65536, 4096, 4096, 65536, 65536, 65536, 4096],
    [0, 0, 0, 0, 0, 0, 65536, 8192, 8192, 65536, 4096, 4096, 65536, 65536, 4096, 4096, 65536, 65536, 65536, 4096],
    [0, 0, 0, 0, 0, 0, 65536, 8192, 12288, 65536, 4096, 4096, 65536, 65536, 4096, 4096, 65536, 65536, 65536, 4096],
    [0, 0, 16384, 16384, 16384, 0, 65536, 8192, 12288, 65536, 4096, 4096, 65536, 65536, 4096, 4096, 65536, 65536, 65536, 4096],
    [0, 0, 16384, 16384, 16384, 0, 65536, 8192, 12288, 65536, 4096, 4096, 65536, 65536, 20480, 20480, 65536, 65536, 65536, 4096],
  ];

  static DISCO_BASE_OFFSETS = [15360, 18773, 1707, 5120, 8533, 11947, 15360, 10240, 10240, 5120, 2844, 1138, 853, 19627, 19342, 17636, 0, 0, 0, 0];
  static SPLIT_OFFSETS_2 = [0, 0, 0, 0, 0, 0, 7680, 25600, 15360, 7680, 12800, 12800, 17920, 17920, 12800, 12800, 15360, 15360, 15360, 15360];
  static SPLIT_OFFSETS_3_4 = [0, 0, 0, 0, 0, 0, 7680, 46080, 15360, 7680, 33280, 33280, 38400, 38400, 33280, 33280, 15360, 15360, 15360, 15360];
  static SPLIT_OFFSETS_5_6 = [0, 0, 0, 0, 0, 0, 7680, 66560, 15360, 7680, 53760, 53760, 58880, 58880, 53760, 53760, 15360, 15360, 15360, 15360];
  static VERTICAL_SLIDESHOW_OFFSETS = [20480, 20480, 20480, 20480, 20480, 20480, 15930, 9100, 11835, 15930, 0, 0, 6825, 6825, 0, 0, 20480, 20480, 20480, 20480];

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.commandChar && this.replyChar);
  }

  supported() {
    return Boolean(window.navigator?.bluetooth && window.isSecureContext);
  }

  async handleCommand(cmd, params = {}) {
    const noDevice = new Set(['connect', 'disconnect', 'scan_devices', 'status', 'lorax_registry']);
    if (!noDevice.has(cmd) && !this.connected) {
      return { type: 'error', message: 'Browser Bluetooth is not connected to the Puffco.' };
    }
    if (cmd === 'connect') return this.connect(params);
    if (cmd === 'disconnect') return this.disconnect();
    if (cmd === 'scan_devices') return this.scanDevices();
    if (cmd === 'status') return { type: 'status', data: await this.snapshot(false) };
    if (cmd === 'lorax_registry') return this.registry();
    if (cmd === 'lorax_read') return this.loraxRead(params);
    if (cmd === 'lorax_write') return this.loraxWrite(params);
    if (cmd === 'select_profile') return this.selectProfile(params);
    if (cmd === 'set_profile') return this.setProfile(params);
    if (cmd === 'set_color') return this.setColor(params);
    if (cmd === 'mood_light') return this.setMoodLight(params);
    if (cmd === 'lantern_color') return this.setLanternColor(params);
    if (cmd === 'lantern') return this.setLantern(params);
    if (cmd === 'stealth') return this.setStealth(params);
    if (cmd === 'brightness') return this.setBrightness(params);
    if (cmd === 'show_battery') return this.modeCommand('show_battery', 'Battery animation started');
    if (cmd === 'show_version') return this.modeCommand('show_version', 'Version animation started');
    if (cmd === 'heat') return this.modeCommand('heat', 'Heat cycle started');
    if (cmd === 'stop') return this.modeCommand('stop', 'Heat cycle stopped');
    if (cmd === 'boost') return this.modeCommand('boost', 'Boost sent');
    if (cmd === 'set_boost_options') return this.setBoostOptions(params);
    if (cmd === 'power') return this.power(params);
    if (cmd === 'official_attributes') return this.officialAttributes();
    if (cmd === 'temperature_source') return this.temperatureSource(params);
    if (cmd === 'heat_probe') return this.loraxProbe({ ...params, category: 'heater' }, 'heat_probe');
    if (cmd === 'lorax_probe') return this.loraxProbe(params, 'lorax_probe');
    if (cmd === 'heat_observe') return this.loraxObserve({ ...params, category: 'heater' }, 'heat_observe');
    if (cmd === 'temperature_observe') return this.loraxObserve({ ...params, category: 'heater' }, 'temperature_observe');
    if (cmd === 'lorax_observe') return this.loraxObserve(params, 'lorax_observe');
    if (cmd === 'lorax_action') return { type: 'error', message: 'Browser Bluetooth Lorax actions are not enabled online. Use direct Lorax read/write paths instead.' };
    return { type: 'error', message: `Browser Bluetooth command is not implemented yet: ${cmd}` };
  }

  async connect(params = {}) {
    if (!this.supported()) {
      return {
        type: 'error',
        message: 'Web Bluetooth requires Chrome or Edge on a secure HTTPS page, localhost, or 127.0.0.1.',
      };
    }
    if (this.connected) {
      return { type: 'connected', message: 'Already connected through browser Bluetooth.', data: await this.snapshot(true) };
    }

    this.resetSessionState('Starting new browser Bluetooth connection');
    this.disconnecting = false;

    const requestOptions = {
      acceptAllDevices: true,
      optionalServices: [PuffcoBrowserBleClient.LORAX_SERVICE],
    };
    try {
      if (this.device) this.device.removeEventListener('gattserverdisconnected', this.disconnectHandler);
      this.device = await window.navigator.bluetooth.requestDevice(requestOptions);
      this.device.addEventListener('gattserverdisconnected', this.disconnectHandler);
      this.server = await this.device.gatt.connect();
      this.service = await this.server.getPrimaryService(PuffcoBrowserBleClient.LORAX_SERVICE);
      this.versionChar = await this.service.getCharacteristic(PuffcoBrowserBleClient.VERSION_CHAR);
      this.commandChar = await this.service.getCharacteristic(PuffcoBrowserBleClient.COMMAND_CHAR);
      this.replyChar = await this.service.getCharacteristic(PuffcoBrowserBleClient.REPLY_CHAR);
      await this.versionChar.readValue();
      await this.replyChar.startNotifications();
      this.replyChar.removeEventListener('characteristicvaluechanged', this.replyHandler);
      this.replyChar.addEventListener('characteristicvaluechanged', this.replyHandler);
      await this.auth();
      return {
        type: 'connected',
        message: 'Connected through browser Web Bluetooth.',
        data: await this.snapshot(true),
      };
    } catch (error) {
      const hadConnection = Boolean(this.device?.gatt?.connected);
      if (hadConnection) {
        this.disconnecting = true;
        this.device.gatt.disconnect();
      }
      this.resetSessionState('Browser Bluetooth connection failed');
      if (!hadConnection) this.disconnecting = false;
      throw error;
    }
  }

  async disconnect() {
    const hadConnection = Boolean(this.device?.gatt?.connected);
    this.disconnecting = true;
    if (hadConnection) this.device.gatt.disconnect();
    this.resetSessionState('User disconnected');
    if (!hadConnection) this.disconnecting = false;
    return { type: 'disconnected', message: 'Disconnected browser Bluetooth.', data: this.disconnectedSnapshot('User disconnected') };
  }

  handleGattDisconnected() {
    const manual = this.disconnecting;
    this.resetSessionState('Browser Bluetooth disconnected');
    this.disconnecting = false;
    if (!manual && typeof this.onDisconnected === 'function') this.onDisconnected();
  }

  rejectPending(reason) {
    const error = new Error(reason);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  resetSessionState(reason = 'Browser Bluetooth session reset') {
    this.rejectPending(reason);
    if (this.replyChar) {
      try {
        this.replyChar.removeEventListener('characteristicvaluechanged', this.replyHandler);
      } catch {}
    }
    this.server = null;
    this.service = null;
    this.commandChar = null;
    this.replyChar = null;
    this.versionChar = null;
    this.lastProfiles = null;
    this.commandQueue = Promise.resolve();
  }

  scanDevices() {
    return {
      type: 'scan_devices',
      message: 'Web Bluetooth scanning happens inside the browser chooser. Press Connect to open it.',
      data: { devices: [], note: 'Browser Bluetooth does not expose passive scan results to pages.' },
    };
  }

  registry() {
    return {
      type: 'lorax_registry',
      data: {
        paths: [
          { path: '/u/sys/name', name: 'device_name', category: 'system', access: 'read', data_type: 'text', size: 32, status: 'known' },
          { path: '/p/sys/fw/ver', name: 'firmware_version', category: 'system', access: 'read', data_type: 'uint8', size: 4, status: 'known' },
          { path: '/p/app/stat/id', name: 'operating_state', category: 'state', access: 'read', data_type: 'uint8', size: 1, status: 'known' },
          { path: '/p/app/stat/elap', name: 'state_elapsed_time', category: 'state', access: 'read', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/app/stat/tott', name: 'state_total_time', category: 'state', access: 'read', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/app/htr/temp', name: 'current_temperature', category: 'heater', access: 'read', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/app/htr/tcmd', name: 'target_temperature', category: 'heater', access: 'read', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/app/thc/btmp', name: 'active_profile_boost_temperature_delta', category: 'profile', access: 'read_write', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/app/thc/btim', name: 'active_profile_boost_time_delta', category: 'profile', access: 'read_write', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/bat/soc', name: 'battery_soc', category: 'battery', access: 'read', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/bat/chg/stat', name: 'battery_charge_state', category: 'battery', access: 'read', data_type: 'uint8', size: 1, status: 'known' },
          { path: '/p/app/hcs', name: 'current_profile', category: 'profile', access: 'read_write', data_type: 'int8', size: 1, status: 'known' },
          { path: '/p/app/info/dpd', name: 'dabs_per_day', category: 'usage', access: 'read', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/app/info/drem', name: 'dabs_remaining', category: 'usage', access: 'read', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/app/odom/0/nc', name: 'total_heat_cycles', category: 'usage', access: 'read', data_type: 'float32', size: 4, status: 'known' },
          { path: '/p/app/mc', name: 'mode_command', category: 'command', access: 'write', data_type: 'uint8', size: 1, status: 'known' },
          { path: '/p/app/ltrn/cmd', name: 'lantern_command', category: 'lighting', access: 'read_write', data_type: 'uint8', size: 1, status: 'known' },
          { path: '/u/app/ui/stlm', name: 'stealth_mode', category: 'lighting', access: 'read_write', data_type: 'uint8', size: 1, status: 'known' },
          { path: '/u/app/ui/lbrt', name: 'led_brightness', category: 'lighting', access: 'read_write', data_type: 'bytes', size: 4, status: 'known' },
        ],
        actions: {},
      },
    };
  }

  onReply(event) {
    const bytes = new Uint8Array(event.target.value.buffer.slice(0));
    if (bytes.length < 3) return;
    const seq = bytes[0] | (bytes[1] << 8);
    const pending = this.pending.get(seq);
    if (!pending) return;
    this.pending.delete(seq);
    clearTimeout(pending.timer);
    pending.resolve(bytes.slice(3));
  }

  async runQueued(task) {
    const run = this.commandQueue.then(task, task);
    this.commandQueue = run.catch(() => {});
    return run;
  }

  async runCommand(opcode, body = new Uint8Array(), { timeout = 4000, exactLen = null } = {}) {
    return this.runQueued(() => new Promise(async (resolve, reject) => {
      if (!this.commandChar) return reject(new Error('Browser Bluetooth command characteristic is not ready.'));
      const seq = this.sequence & 0xffff;
      this.sequence = (this.sequence + 1) & 0xffff;
      const msg = new Uint8Array(3 + body.length);
      msg[0] = seq & 0xff;
      msg[1] = (seq >> 8) & 0xff;
      msg[2] = opcode & 0xff;
      msg.set(body, 3);
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Lorax command 0x${opcode.toString(16)} timed out`));
      }, timeout);
      this.pending.set(seq, { resolve: (payload) => {
        if (exactLen !== null && payload.length !== exactLen) {
          reject(new Error(`Reply length ${payload.length} != ${exactLen}`));
        } else {
          resolve(payload);
        }
      }, reject, timer });
      try {
        if (this.commandChar.writeValueWithoutResponse) {
          await this.commandChar.writeValueWithoutResponse(msg);
        } else {
          await this.commandChar.writeValue(msg);
        }
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(error);
      }
    }));
  }

  async auth() {
    const seed = await this.runCommand(PuffcoBrowserBleClient.OPCODES.GET_ACCESS_SEED, new Uint8Array(), { exactLen: 16 });
    const keyBytes = Uint8Array.from(atob(PuffcoBrowserBleClient.LORAX_KEY), (ch) => ch.charCodeAt(0));
    const material = new Uint8Array(32);
    material.set(keyBytes.slice(0, 16), 0);
    material.set(seed.slice(0, 16), 16);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
    await this.runCommand(PuffcoBrowserBleClient.OPCODES.UNLOCK_ACCESS, digest.slice(0, 16), { exactLen: 0 });
  }

  async readShort(path, offset, size) {
    const pathBytes = new TextEncoder().encode(path);
    const body = new Uint8Array(4 + pathBytes.length);
    const view = new DataView(body.buffer);
    view.setUint16(0, offset, true);
    view.setUint16(2, size, true);
    body.set(pathBytes, 4);
    return this.runCommand(PuffcoBrowserBleClient.OPCODES.READ_SHORT, body);
  }

  async writeShort(path, offset, flags, valueBytes) {
    const pathBytes = new TextEncoder().encode(path);
    const body = new Uint8Array(3 + pathBytes.length + 1 + valueBytes.length);
    const view = new DataView(body.buffer);
    view.setUint16(0, offset, true);
    view.setUint8(2, flags);
    body.set(pathBytes, 3);
    body[3 + pathBytes.length] = 0;
    body.set(valueBytes, 4 + pathBytes.length);
    await this.runCommand(PuffcoBrowserBleClient.OPCODES.WRITE_SHORT, body, { exactLen: 0 });
  }

  async readBytesAll(path, chunkSize = 125, cap = 4096) {
    const out = [];
    let offset = 0;
    while (offset < cap) {
      const chunk = await this.readShort(path, offset, chunkSize);
      out.push(...chunk);
      offset += chunk.length;
      if (chunk.length < chunkSize) break;
    }
    return Uint8Array.from(out);
  }

  async readText(path, size = 32) {
    const bytes = await this.readShort(path, 0, size);
    const end = bytes.indexOf(0);
    const slice = end >= 0 ? bytes.slice(0, end) : bytes;
    return new TextDecoder().decode(slice).trim();
  }

  async readUint8(path, fallback = null) {
    try {
      const bytes = await this.readShort(path, 0, 1);
      return bytes.length ? bytes[0] : fallback;
    } catch {
      return fallback;
    }
  }

  async readFloat32(path, fallback = null) {
    try {
      const bytes = await this.readShort(path, 0, 4);
      if (bytes.length < 4) return fallback;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
    } catch {
      return fallback;
    }
  }

  async readUint32(path, fallback = null) {
    try {
      const bytes = await this.readShort(path, 0, 4);
      if (bytes.length < 4) return fallback;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    } catch {
      return fallback;
    }
  }

  async readInt8(path, fallback = null) {
    const value = await this.readUint8(path, null);
    if (value == null) return fallback;
    return value > 127 ? value - 256 : value;
  }

  packFloat32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, Number(value), true);
    return bytes;
  }

  fToC(value) {
    return (Number(value) - 32) / 1.8;
  }

  cToF(value) {
    return Math.round((Number(value) * 1.8) + 32);
  }

  versionBytesLabel(bytes) {
    const parts = Array.from(bytes || []).slice(0, 4);
    while (parts.length > 2 && parts[parts.length - 1] === 0) parts.pop();
    return parts.length ? parts.join('.') : null;
  }

  async readVersionPath(path) {
    try {
      return this.versionBytesLabel(await this.readShort(path, 0, 4));
    } catch {
      return null;
    }
  }

  async readVersionCharacteristic() {
    try {
      const value = await this.versionChar?.readValue();
      if (!value) return null;
      return this.versionBytesLabel(new Uint8Array(value.buffer.slice(0)));
    } catch {
      return null;
    }
  }

  brightnessLabel(value) {
    if (value == null) return null;
    const bytes = Array.from(value);
    if (!bytes.length) return null;
    if (bytes.length >= 4) {
      const names = ['base', 'front', 'glass', 'logo'];
      return bytes.slice(0, 4).map((byte, index) => `${names[index]} ${byte}/255`).join(', ');
    }
    return `${bytes[0]}/255`;
  }

  chamberLabel(value) {
    return PuffcoBrowserBleClient.CHAMBER_LABELS[value] || null;
  }

  applySelectedProfileDefaults(data) {
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const selected = Number(data?.current_profile);
    const profile = profiles.find((item, fallbackIndex) => Number(item.index ?? fallbackIndex) === selected)
      || profiles.find((item) => item.active);
    if (!profile) return;
    if (profile.name) data.active_profile_name = profile.name;
    if (profile.temp_f != null) data.active_profile_temp_f = profile.temp_f;
    if (profile.time_s != null) data.active_profile_time_s = profile.time_s;
  }

  decodeCbor(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 0;
    const readLength = (additional) => {
      if (additional < 24) return additional;
      if (additional === 24) return data[offset++];
      if (additional === 25) {
        const value = view.getUint16(offset, false);
        offset += 2;
        return value;
      }
      if (additional === 26) {
        const value = view.getUint32(offset, false);
        offset += 4;
        return value;
      }
      if (additional === 27) {
        const high = view.getUint32(offset, false);
        const low = view.getUint32(offset + 4, false);
        offset += 8;
        return high * 4294967296 + low;
      }
      throw new Error('Unsupported indefinite CBOR length');
    };
    const readItem = () => {
      if (offset >= data.length) return null;
      const header = data[offset++];
      const major = header >> 5;
      const additional = header & 31;
      if (major === 0) return readLength(additional);
      if (major === 1) return -1 - readLength(additional);
      if (major === 2) {
        const length = readLength(additional);
        const value = Array.from(data.slice(offset, offset + length));
        offset += length;
        return value;
      }
      if (major === 3) {
        const length = readLength(additional);
        const value = new TextDecoder().decode(data.slice(offset, offset + length));
        offset += length;
        return value;
      }
      if (major === 4) {
        const length = readLength(additional);
        return Array.from({ length }, () => readItem());
      }
      if (major === 5) {
        const length = readLength(additional);
        const object = {};
        for (let i = 0; i < length; i += 1) object[String(readItem())] = readItem();
        return object;
      }
      if (major === 7) {
        if (additional === 20) return false;
        if (additional === 21) return true;
        if (additional === 22 || additional === 23) return null;
        if (additional === 26) {
          const value = view.getFloat32(offset, false);
          offset += 4;
          return value;
        }
        if (additional === 27) {
          const value = view.getFloat64(offset, false);
          offset += 8;
          return value;
        }
      }
      throw new Error(`Unsupported CBOR major ${major}`);
    };
    return readItem();
  }

  async readCbor(path, size = 125) {
    return this.decodeCbor(await this.readShort(path, 0, size));
  }

  async safe(call, fallback = null) {
    try {
      const value = await call();
      return value == null || Number.isNaN(value) ? fallback : value;
    } catch {
      return fallback;
    }
  }

  async snapshot(full = false) {
    if (!this.connected) return this.disconnectedSnapshot();
    const currentProfile = await this.safe(() => this.readInt8('/p/app/hcs'), null);
    const state = await this.safe(() => this.readUint8('/p/app/stat/id'), null);
    const stateName = PuffcoBrowserBleClient.STATE_NAMES[state] || null;
    const charge = await this.safe(() => this.readUint8('/p/bat/chg/stat'), null);
    const chamber = await this.safe(() => this.readUint8('/p/htr/chmt'), null);
    const currentTempC = await this.safe(() => this.readFloat32('/p/app/htr/temp'), null);
    const targetTempC = await this.safe(() => this.readFloat32('/p/app/htr/tcmd'), null);
    const elapsed = await this.safe(() => this.readFloat32('/p/app/stat/elap'), null);
    const total = await this.safe(() => this.readFloat32('/p/app/stat/tott'), null);
    const activeName = await this.safe(() => this.readText('/p/app/thc/name', 32), null);
    const activeTempC = await this.safe(() => this.readFloat32('/p/app/thc/temp'), null);
    const activeTime = await this.safe(() => this.readFloat32('/p/app/thc/time'), null);
    const battery = await this.safe(() => this.readFloat32('/p/bat/soc'), null);
    const dabsPerDay = await this.safe(() => this.readFloat32('/p/app/info/dpd'), null);
    const dabsLeft = await this.safe(() => this.readFloat32('/p/app/info/drem'), null);
    const totalDabs = await this.safe(() => this.readFloat32('/p/app/odom/0/nc'), null);
    const firmware = await this.safe(() => this.readVersionPath('/p/sys/fw/ver'), null)
      || await this.safe(() => this.readVersionCharacteristic(), null);
    const bootloader = await this.safe(() => this.readVersionPath('/p/sys/fw/bver'), null);
    const apiVersion = await this.safe(() => this.readUint32('/p/sys/fw/api'), null);
    const serial = await this.safe(() => this.readText('/p/sys/hw/ser', 64), null);
    const brightnessBytes = await this.safe(() => this.readShort('/u/app/ui/lbrt', 0, 4), null);
    const chargeEta = await this.safe(() => this.readFloat32('/p/bat/chg/etf'), null);
    const maxBattery = await this.safe(() => this.readFloat32('/u/bat/msoc'), null);
    const lanternTime = await this.safe(() => this.readFloat32('/p/app/ltrn/time'), null);
    const lanternRemaining = await this.safe(() => this.readFloat32('/p/app/ltrn/remt'), null);
    const boostTempC = await this.safe(() => this.readFloat32('/p/app/thc/btmp'), null);
    const boostTime = await this.safe(() => this.readFloat32('/p/app/thc/btim'), null);

    const data = {
      connected: true,
      transport: 'browser_ble',
      name: this.device?.name || activeName || 'Puffco',
      firmware,
      software_version: firmware,
      bootloader,
      api_version: apiVersion,
      serial,
      state: stateName,
      heat: ['HEAT_CYCLE_PREHEAT', 'HEAT_CYCLE_ACTIVE', 'HEAT_CYCLE_FADE'].includes(stateName) ? 'HEATING' : 'idle',
      charge,
      chamber,
      battery: battery == null ? null : Math.max(0, Math.min(100, Math.round(battery))),
      battery_source: '/p/bat/soc',
      current_profile: currentProfile,
      active_profile_name: activeName,
      active_profile_temp_f: activeTempC == null ? null : this.cToF(activeTempC),
      active_profile_time_s: activeTime == null ? null : Math.round(activeTime),
      current_temperature_c: currentTempC,
      current_temperature_f: currentTempC == null ? null : this.cToF(currentTempC),
      live_temperature_source: { path: '/p/app/htr/temp', encoding: 'float32_c', transport: 'browser_ble' },
      target_temperature_c: targetTempC,
      target_temperature_f: targetTempC == null || Number(targetTempC) < 80 ? null : this.cToF(targetTempC),
      state_elapsed_time: elapsed,
      state_total_time: total,
      state_elapsed_time_s: elapsed,
      state_total_time_s: total,
      led_brightness: brightnessBytes ? Array.from(brightnessBytes) : null,
      charge_estimated_time_to_full_s: chargeEta,
      max_battery_level: maxBattery,
      lantern_time_s: lanternTime,
      lantern_remaining_time_s: lanternRemaining,
      lantern: lanternRemaining == null ? null : lanternRemaining > 0,
      boost_temperature_delta_c: boostTempC,
      boost_temperature_delta_f: boostTempC == null ? null : Math.round(boostTempC * 1.8),
      boost_time_s: boostTime,
      dabs_per_day: dabsPerDay,
      dabs_left: dabsLeft,
      total_dabs: totalDabs,
      official_readable: {
        brightness: this.brightnessLabel(brightnessBytes),
        chargeEstimatedTimeToFull: chargeEta == null ? null : `${Math.round(chargeEta)}s`,
        maxBatteryLevel: maxBattery == null ? null : `${Math.round(maxBattery)}%`,
        lanternTime: lanternTime == null ? null : `${Math.round(lanternTime)}s`,
        lanternRemainingTime: lanternRemaining == null ? null : `${Math.round(lanternRemaining)}s`,
        boostTemperature: boostTempC == null ? null : `+${Math.round(boostTempC * 1.8)}°F`,
        boostTime: boostTime == null ? null : `${Math.round(boostTime)}s`,
      },
      labels: {
        state: this.labelState(stateName),
        heat: ['HEAT_CYCLE_PREHEAT', 'HEAT_CYCLE_ACTIVE', 'HEAT_CYCLE_FADE'].includes(stateName) ? 'Heating' : 'Idle',
        battery: battery == null ? '—' : `${Math.round(battery)}%`,
        charge: PuffcoBrowserBleClient.CHARGE_LABELS[charge] || '—',
        chamber: this.chamberLabel(chamber) || '—',
        dabs_per_day: dabsPerDay == null ? '—' : dabsPerDay.toFixed(2),
        dabs_left: dabsLeft == null ? '—' : String(Math.round(dabsLeft)),
        total_dabs: totalDabs == null ? '—' : String(Math.round(totalDabs)),
      },
      backend: {
        device_connected_flag: true,
        ble_link_connected: true,
        transport: 'browser_ble',
      },
    };

    if (full || !this.lastProfiles) {
      data.profiles = await this.readProfiles(currentProfile);
      this.lastProfiles = data.profiles;
    } else {
      data.profiles = this.lastProfiles.map((profile) => ({ ...profile, active: profile.index === currentProfile }));
    }
    this.applySelectedProfileDefaults(data);
    return data;
  }

  disconnectedSnapshot(reason = 'Browser Bluetooth disconnected') {
    return {
      connected: false,
      disconnect_reason: reason,
      labels: { state: 'Disconnected', heat: 'Idle' },
      readable: { state: 'Disconnected', heat: 'Idle', summary: reason },
      backend: { device_connected_flag: false, ble_link_connected: false, transport: 'browser_ble' },
    };
  }

  labelState(state) {
    return String(state || 'Disconnected').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  async readProfiles(currentProfile) {
    const profiles = [];
    for (let index = 0; index < 4; index += 1) {
      const name = await this.safe(() => this.readText(`/u/app/hc/${index}/name`, 32), `Profile ${index}`);
      const tempC = await this.safe(() => this.readFloat32(`/u/app/hc/${index}/temp`), null);
      const time = await this.safe(() => this.readFloat32(`/u/app/hc/${index}/time`), null);
      const color = await this.safe(() => this.readCbor(`/u/app/hc/${index}/colr`, 125), null);
      profiles.push({
        index,
        active: index === currentProfile,
        name,
        temp_f: tempC == null ? null : this.cToF(tempC),
        time_s: time == null ? null : Math.round(time),
        color,
        labels: {
          status: index === currentProfile ? 'Active' : 'Inactive',
          temperature: tempC == null ? '—' : `${this.cToF(tempC)}°F`,
          duration: time == null ? '—' : `${Math.round(time)}s`,
        },
      });
    }
    return profiles;
  }

  async modeCommand(name, message) {
    const command = PuffcoBrowserBleClient.MODE_COMMANDS[name];
    await this.writeShort('/p/app/mc', 0, 0, Uint8Array.of(command));
    return { type: 'ok', message, data: await this.snapshot(false) };
  }

  normalizeHexColor(value) {
    const match = String(value || '').trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (!match) throw new Error(`Invalid RGB color: ${value}`);
    return `#${match[1].toLowerCase()}`;
  }

  hexToRgb(color) {
    const hex = this.normalizeHexColor(color);
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }

  rgbToHex(rgb) {
    return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`;
  }

  normalizeColorList(value, preset) {
    const raw = value == null
      ? preset.defaults
      : Array.isArray(value)
        ? value
        : String(value).split(',').map((part) => part.trim()).filter(Boolean);
    const colors = raw.map((color) => this.normalizeHexColor(color));
    if (colors.length < preset.minColors) throw new Error(`${preset.name} needs at least ${preset.minColors} color(s)`);
    if (colors.length > preset.maxColors) throw new Error(`${preset.name} supports at most ${preset.maxColors} colors`);
    return colors;
  }

  colorTable(colors, length, steady = 0) {
    if (length <= 0) return [];
    if (colors.length === 1) return Array.from({ length }, () => colors[0]);
    const rgbs = colors.map((color) => this.hexToRgb(color));
    const out = [];
    for (let idx = 0; idx < length; idx += 1) {
      const pos = (idx / length) * rgbs.length;
      const base = Math.floor(pos) % rgbs.length;
      let frac = pos - Math.floor(pos);
      if (steady) {
        const hold = Math.max(0, Math.min(0.9, steady)) / 2;
        if (frac < hold) frac = 0;
        else if (frac > 1 - hold) frac = 1;
        else frac = (frac - hold) / (1 - (2 * hold));
      }
      const eased = 0.5 - (Math.cos(frac * Math.PI) / 2);
      const next = (base + 1) % rgbs.length;
      out.push(this.rgbToHex(rgbs[base].map((channel, i) => channel + ((rgbs[next][i] - channel) * eased))));
    }
    return out;
  }

  moodSpeed(presetId, tempoFrac) {
    const tempoCpm = tempoFrac * tempoFrac * 480;
    if (presetId === 'spin') return Math.max(0, Math.min(255, Math.round((tempoCpm * 256) / 480)));
    if (['split_gradient', 'vertical_slideshow'].includes(presetId) && tempoCpm <= 0) return 64;
    return Math.max(0, Math.min(255, Math.round(tempoCpm / 3)));
  }

  moodOffsets(presetId, colorCount) {
    if (presetId === 'no_animation') return PuffcoBrowserBleClient.NO_ANIMATION_OFFSETS[colorCount - 1];
    if (presetId === 'disco') return PuffcoBrowserBleClient.DISCO_BASE_OFFSETS.map((value) => Math.round(value * colorCount));
    if (presetId === 'split_gradient') {
      if (colorCount === 2) return PuffcoBrowserBleClient.SPLIT_OFFSETS_2;
      if (colorCount <= 4) return PuffcoBrowserBleClient.SPLIT_OFFSETS_3_4;
      return PuffcoBrowserBleClient.SPLIT_OFFSETS_5_6;
    }
    if (presetId === 'vertical_slideshow') return PuffcoBrowserBleClient.VERTICAL_SLIDESHOW_OFFSETS;
    return Array.from({ length: 20 }, () => 0);
  }

  moodLightPayload(presetId, colors, options = {}) {
    const presetKey = String(presetId || 'no_animation').trim().toLowerCase().replace(/-/g, '_');
    const preset = PuffcoBrowserBleClient.MOOD_PRESETS[presetKey];
    if (!preset) throw new Error(`Unknown mood preset: ${presetId}`);
    const userColors = this.normalizeColorList(colors, preset);
    const tempo = Math.max(0, Math.min(1, Number(options.tempo_frac ?? options.tempoFrac ?? 0.5) || 0.5));
    const dynamic = (options.dynamic_inhale ?? options.dynamicInhale) ? 1 : 0;
    const count = userColors.length;
    const speed = this.moodSpeed(presetKey, tempo);
    const speedDi1 = Math.min(speed * 2, 255);
    const speedDi0 = speedDi1 / 8;
    let table;
    let colorLen;
    let params;
    if (presetKey === 'no_animation') {
      table = userColors;
      colorLen = 32;
      params = { bright: 255, speed: 64, anim: 1, plNum: 0, plDenom: 1, offset: this.moodOffsets(presetKey, count), color: table, colorLen };
    } else {
      colorLen = count * 5;
      table = this.colorTable(userColors, colorLen, ['fade', 'spin'].includes(presetKey) ? 0.3 : 0);
      const tempoCpm = tempo * tempo * 480;
      const plNum = presetKey === 'spin' ? 1 : 0;
      let plDenom = 0;
      if (presetKey === 'spin') plDenom = count;
      else if (['disco', 'split_gradient', 'vertical_slideshow'].includes(presetKey)) plDenom = tempoCpm > 0 ? 0 : 1;
      params = { bright: 255, speed, speedDi0, speedDi1, anim: preset.anim, plNum, plDenom, offset: this.moodOffsets(presetKey, count), color: table, colorLen, diFrac: dynamic };
    }
    return {
      lamp: { name: 'pikaled2', param: params },
      meta: {
        led3Name: preset.name,
        led3Tag: preset.tag,
        moodName: preset.name,
        moodType: presetKey,
        desc: preset.desc,
        userColors,
        arrayColors: table,
        tempoFrac: tempo,
        dynamicInhale: dynamic,
        format: 'official-pikaled2-profile-colr',
        version: 1,
      },
    };
  }

  profileColorPayload(color) {
    return this.moodLightPayload('no_animation', [this.normalizeHexColor(color)], { tempo_frac: 0.5, dynamic_inhale: false });
  }

  hexifyForCbor(value, key = null) {
    if (Array.isArray(value)) {
      if (key === 'color') {
        const bytes = [];
        value.forEach((color) => bytes.push(...this.hexToRgb(color)));
        return new Uint8Array(bytes);
      }
      if (key === 'userColors') return value.map((color) => new Uint8Array(this.hexToRgb(color)));
      return value.map((item) => this.hexifyForCbor(item));
    }
    if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
      const out = {};
      Object.entries(value).forEach(([childKey, childValue]) => { out[childKey] = this.hexifyForCbor(childValue, childKey); });
      return out;
    }
    if (typeof value === 'string') {
      if (/^#?[0-9a-fA-F]{6}$/.test(value)) return new Uint8Array(this.hexToRgb(value));
    }
    return value;
  }

  concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    parts.forEach((part) => {
      out.set(part, offset);
      offset += part.length;
    });
    return out;
  }

  cborTypeAndLength(major, length) {
    if (length < 24) return Uint8Array.of((major << 5) | length);
    if (length < 256) return Uint8Array.of((major << 5) | 24, length);
    if (length < 65536) return Uint8Array.of((major << 5) | 25, (length >> 8) & 0xff, length & 0xff);
    return Uint8Array.of((major << 5) | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff);
  }

  floatToHalf(value) {
    const floatView = new Float32Array(1);
    const intView = new Uint32Array(floatView.buffer);
    floatView[0] = value;
    const bits = intView[0];
    const sign = (bits >>> 16) & 0x8000;
    let mantissa = bits & 0x7fffff;
    let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
    if (exponent <= 0) {
      if (exponent < -10) return sign;
      mantissa = (mantissa | 0x800000) >> (1 - exponent);
      return sign | ((mantissa + 0x1000) >> 13);
    }
    if (exponent >= 31) return sign | 0x7c00;
    return sign | (exponent << 10) | ((mantissa + 0x1000) >> 13);
  }

  halfToFloat(half) {
    const sign = (half & 0x8000) ? -1 : 1;
    const exponent = (half >> 10) & 0x1f;
    const fraction = half & 0x03ff;
    if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }

  cborEncodeFloat(value) {
    const half = this.floatToHalf(value);
    if (Object.is(this.halfToFloat(half), value)) return Uint8Array.of(0xf9, (half >> 8) & 0xff, half & 0xff);

    const f32 = new Float32Array(1);
    f32[0] = value;
    if (Object.is(f32[0], value)) {
      const out32 = new Uint8Array(5);
      out32[0] = 0xfa;
      new DataView(out32.buffer).setFloat32(1, value, false);
      return out32;
    }

    const out64 = new Uint8Array(9);
    out64[0] = 0xfb;
    new DataView(out64.buffer).setFloat64(1, value, false);
    return out64;
  }

  cborEncode(value) {
    if (value === null || value === undefined) return Uint8Array.of(0xf6);
    if (value === false) return Uint8Array.of(0xf4);
    if (value === true) return Uint8Array.of(0xf5);
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0) return this.cborTypeAndLength(0, value);
      if (Number.isInteger(value) && value < 0) return this.cborTypeAndLength(1, -1 - value);
      return this.cborEncodeFloat(value);
    }
    if (typeof value === 'string') {
      const bytes = new TextEncoder().encode(value);
      return this.concatBytes([this.cborTypeAndLength(3, bytes.length), bytes]);
    }
    if (value instanceof Uint8Array) return this.concatBytes([this.cborTypeAndLength(2, value.length), value]);
    if (Array.isArray(value)) return this.concatBytes([this.cborTypeAndLength(4, value.length), ...value.map((item) => this.cborEncode(item))]);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, child]) => [this.cborEncode(String(key)), this.cborEncode(child)]);
      entries.sort((a, b) => {
        if (a[0].length !== b[0].length) return a[0].length - b[0].length;
        for (let i = 0; i < a[0].length; i += 1) {
          if (a[0][i] !== b[0][i]) return a[0][i] - b[0][i];
        }
        return 0;
      });
      return this.concatBytes([this.cborTypeAndLength(5, entries.length), ...entries.flat()]);
    }
    throw new Error(`Cannot CBOR encode ${typeof value}`);
  }

  async writeCborFull(path, payload, chunk = 80) {
    const blob = this.cborEncode(this.hexifyForCbor(payload));
    for (let offset = 0; offset < blob.length; offset += chunk) {
      await this.writeShort(path, offset, 0, blob.slice(offset, offset + chunk));
    }
  }

  async power(params) {
    const cmd = params.cmd;
    if (cmd === 'factory_reset') {
      await this.writeShort('/p/app/facr', 0, 0, Uint8Array.of(1));
      return { type: 'disconnected', message: 'Factory reset command sent', data: this.disconnectedSnapshot('Factory reset command sent') };
    }
    if (!Object.prototype.hasOwnProperty.call(PuffcoBrowserBleClient.MODE_COMMANDS, cmd)) {
      return { type: 'error', message: `Unknown power command: ${cmd}` };
    }
    await this.modeCommand(cmd, cmd === 'off' ? 'Device power-off sent' : 'Sleep command sent');
    if (cmd === 'off') return { type: 'disconnected', message: 'Device powered off', data: this.disconnectedSnapshot('Device powered off') };
    return { type: 'ok', message: 'Power command sent', data: await this.snapshot(false) };
  }

  async selectProfile(params) {
    const index = Number(params.index);
    await this.writeShort('/p/app/hcs', 0, 0, Uint8Array.of(index & 0xff));
    this.lastProfiles = null;
    return { type: 'ok', message: `Selected profile ${index}`, data: await this.snapshot(true) };
  }

  profileNameBytes(name) {
    const encoded = new TextEncoder().encode(String(name || '').slice(0, 31));
    const out = new Uint8Array(32);
    out.set(encoded.slice(0, 31));
    return out;
  }

  async setProfile(params) {
    const index = Number(params.index);
    const changed = [];
    if (params.name != null) {
      await this.writeShort(`/u/app/hc/${index}/name`, 0, 0, this.profileNameBytes(params.name));
      changed.push('name');
    }
    if (params.temp_f != null) {
      await this.writeShort(`/u/app/hc/${index}/temp`, 0, 0, this.packFloat32(this.fToC(params.temp_f)));
      changed.push('temperature');
    }
    if (params.time_s != null) {
      await this.writeShort(`/u/app/hc/${index}/time`, 0, 0, this.packFloat32(params.time_s));
      changed.push('time');
    }
    if (params.select) {
      await this.writeShort('/p/app/hcs', 0, 0, Uint8Array.of(index & 0xff));
      changed.push('selected');
    }
    if (params.color) {
      await this.writeCborFull(`/u/app/hc/${index}/colr`, this.profileColorPayload(params.color));
      changed.push('color');
    }
    if (params.mood_light && typeof params.mood_light === 'object') {
      const mood = params.mood_light;
      const payload = this.moodLightPayload(
        mood.preset || mood.mood || 'no_animation',
        mood.colors,
        { tempo_frac: mood.tempo_frac ?? mood.tempoFrac, dynamic_inhale: mood.dynamic_inhale ?? mood.dynamicInhale },
      );
      await this.writeCborFull(`/u/app/hc/${index}/colr`, payload);
      changed.push('mood light');
    }
    this.lastProfiles = null;
    return { type: 'ok', message: `Updated profile ${index}: ${changed.join(', ') || 'nothing'}`, data: await this.snapshot(true) };
  }

  async setColor(params) {
    const index = params.index == null ? await this.readInt8('/p/app/hcs') : Number(params.index);
    const color = this.normalizeHexColor(params.hex);
    await this.writeCborFull(`/u/app/hc/${index}/colr`, this.profileColorPayload(color));
    this.lastProfiles = null;
    return { type: 'ok', message: `Set profile ${index} color to ${color}`, data: await this.snapshot(true) };
  }

  async setMoodLight(params) {
    const index = params.index == null ? await this.readInt8('/p/app/hcs') : Number(params.index);
    const payload = this.moodLightPayload(
      params.preset || params.mood || 'no_animation',
      params.colors ?? (params.hex ? [params.hex] : undefined),
      { tempo_frac: params.tempo_frac ?? params.tempoFrac, dynamic_inhale: params.dynamic_inhale ?? params.dynamicInhale },
    );
    await this.writeCborFull(`/u/app/hc/${index}/colr`, payload);
    this.lastProfiles = null;
    return { type: 'ok', message: `Applied ${payload.meta.moodName} mood light to profile ${index}`, data: await this.snapshot(true) };
  }

  async setBoostOptions(params) {
    const tempF = Number(params.temp_delta_f ?? params.temp_f);
    const timeS = Number(params.time_s ?? params.seconds);
    if (!Number.isFinite(tempF) || tempF < 0 || tempF > 120) throw new Error('Boost temperature must be 0-120 F');
    if (!Number.isFinite(timeS) || timeS < 0 || timeS > 180) throw new Error('Boost time must be 0-180 seconds');
    await this.writeShort('/p/app/thc/btmp', 0, 0, this.packFloat32(tempF / 1.8));
    await this.writeShort('/p/app/thc/btim', 0, 0, this.packFloat32(timeS));
    return { type: 'ok', message: `Boost options set to +${Math.round(tempF)} F / +${Math.round(timeS)}s`, data: await this.snapshot(false) };
  }

  async setLanternColor(params) {
    const response = params.preset || params.mood
      ? await this.setMoodLight(params)
      : await this.setColor(params);
    await this.setLantern({ state: 'on' });
    response.message = response.message.replace(/^Applied /, 'Lantern color set to ').replace(/^Set profile \d+ color to /, 'Lantern color set to ');
    return response;
  }

  async setLantern(params) {
    const on = params.on === true || params.state === 'on';
    await this.writeShort('/p/app/ltrn/cmd', 0, 0, Uint8Array.of(on ? 1 : 0));
    return { type: 'ok', message: on ? 'Lantern on' : 'Lantern off', data: await this.snapshot(false) };
  }

  async setStealth(params) {
    const on = params.on === true || params.state === 'on';
    await this.writeShort('/u/app/ui/stlm', 0, 0, Uint8Array.of(on ? 1 : 0));
    return { type: 'ok', message: on ? 'Stealth on' : 'Stealth off', data: await this.snapshot(false) };
  }

  async setBrightness(params) {
    const values = [params.base, params.mid, params.glass, params.logo].map((value) => Math.max(1, Math.min(255, Number(value) || 1)));
    await this.writeShort('/u/app/ui/lbrt', 0, 0, Uint8Array.from(values));
    return { type: 'ok', message: 'LED brightness updated', data: await this.snapshot(false) };
  }

  encodeValue(value, type) {
    if (type === 'uint8') return Uint8Array.of(Number(value) & 0xff);
    if (type === 'int8') return Uint8Array.of(Number(value) & 0xff);
    if (type === 'float32') return this.packFloat32(value);
    if (type === 'text') return new TextEncoder().encode(String(value));
    if (type === 'bytes') {
      const text = String(value).replace(/[^0-9a-f]/gi, '');
      const out = new Uint8Array(text.length / 2);
      for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    return Uint8Array.of(Number(value) & 0xff);
  }

  decodeValue(bytes, type) {
    if (type === 'float32' && bytes.length >= 4) return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
    if (type === 'uint8' && bytes.length) return bytes[0];
    if (type === 'int8' && bytes.length) return bytes[0] > 127 ? bytes[0] - 256 : bytes[0];
    if (type === 'text') return new TextDecoder().decode(bytes).replace(/\0.*$/, '');
    return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  }

  async officialAttributes() {
    const data = await this.snapshot(true);
    return {
      type: 'official_attributes',
      data: {
        transport: 'browser_ble',
        attributes: {
          batteryLevel: data.battery,
          chargeState: data.charge,
          selectedHeatCycle: data.current_profile,
          dabsPerDay: data.dabs_per_day,
          approxDabsRemaining: data.dabs_left,
          totalHeatCycles: data.total_dabs,
          stateElapsedTime: data.state_elapsed_time,
          stateTotalTime: data.state_total_time,
          operatingState: data.labels?.state || data.state,
          currentTemperature: data.current_temperature_c,
          targetTemperature: data.target_temperature_c,
        },
        snapshot: data,
      },
    };
  }

  temperatureSource(params = {}) {
    return {
      type: 'temperature_source',
      data: params.clear
        ? null
        : { path: params.path || '/p/app/htr/temp', encoding: params.encoding || 'float32', transport: 'browser_ble' },
    };
  }

  registryPaths(params = {}) {
    const paths = this.registry().data.paths;
    const category = params.category || '';
    return paths
      .filter((entry) => !category || entry.category === category)
      .slice(0, Math.max(1, Math.min(100, Number(params.limit || 40))));
  }

  async loraxProbe(params = {}, responseType = 'lorax_probe') {
    const entries = this.registryPaths(params);
    const results = [];
    for (const entry of entries) {
      try {
        const raw = await this.readShort(entry.path, Number(entry.offset || 0), Number(params.size || entry.size || 4));
        results.push({
          path: entry.path,
          name: entry.name,
          category: entry.category,
          type: entry.data_type,
          raw: Array.from(raw).map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
          value: this.decodeValue(raw, entry.data_type),
        });
      } catch (err) {
        results.push({ path: entry.path, name: entry.name, category: entry.category, error: err?.message || String(err) });
      }
    }
    return { type: responseType, data: { transport: 'browser_ble', count: results.length, results } };
  }

  async loraxObserve(params = {}, responseType = 'lorax_observe') {
    const samples = Math.max(1, Math.min(32, Number(params.samples || 4)));
    const intervalMs = Math.max(100, Math.min(3000, Number(params.interval || 0.75) * 1000));
    const entries = this.registryPaths(params);
    const series = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const probe = await this.loraxProbe({ ...params, limit: entries.length }, responseType);
      series.push({ sample, time: new Date().toISOString(), results: probe.data.results });
      if (sample < samples - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { type: responseType, data: { transport: 'browser_ble', samples: series } };
  }

  async loraxRead(params) {
    const path = params.path || params.identifier;
    const offset = Number(params.offset || 0);
    const type = params.type || params.data_type || 'bytes';
    const size = Number(params.size || (type === 'float32' ? 4 : type === 'uint8' || type === 'int8' ? 1 : 12));
    const raw = await this.readShort(path, offset, size);
    return {
      type: 'lorax_read',
      message: `Read ${path}`,
      data: {
        path,
        offset,
        size,
        type,
        raw: Array.from(raw).map((byte) => byte.toString(16).padStart(2, '0')).join(' '),
        decoded: this.decodeValue(raw, type),
      },
    };
  }

  async loraxWrite(params) {
    const path = params.path || params.identifier;
    const offset = Number(params.offset || 0);
    const type = params.type || params.data_type || 'bytes';
    const payload = this.encodeValue(params.value, type);
    await this.writeShort(path, offset, 0, payload);
    return {
      type: 'ok',
      message: `Wrote ${path}`,
      data: { write: { path, offset, type, raw: Array.from(payload).map((byte) => byte.toString(16).padStart(2, '0')).join(' ') }, status: await this.snapshot(false) },
    };
  }
}

window.PuffcoBrowserBleClient = PuffcoBrowserBleClient;
