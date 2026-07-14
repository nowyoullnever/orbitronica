// node_modules/@webaudiomodules/sdk/dist/index.js
var WebAudioModule = class {
  static get isWebAudioModuleConstructor() {
    return true;
  }
  static createInstance(groupId, audioContext, initialState) {
    return new this(groupId, audioContext).initialize(initialState);
  }
  constructor(groupId, audioContext) {
    this._groupId = groupId;
    this._audioContext = audioContext;
    this._initialized = false;
    this._audioNode = void 0;
    this._timestamp = performance.now();
    this._guiModuleUrl = void 0;
    this._descriptorUrl = "./descriptor.json";
    this._descriptor = {
      identifier: `com.webaudiomodule.default`,
      name: `WebAudioModule_${this.constructor.name}`,
      vendor: "WebAudioModuleVendor",
      description: "",
      version: "0.0.0",
      apiVersion: "2.0.0",
      thumbnail: "",
      keywords: [],
      isInstrument: false,
      website: "",
      hasAudioInput: true,
      hasAudioOutput: true,
      hasAutomationInput: true,
      hasAutomationOutput: true,
      hasMidiInput: true,
      hasMidiOutput: true,
      hasMpeInput: true,
      hasMpeOutput: true,
      hasOscInput: true,
      hasOscOutput: true,
      hasSysexInput: true,
      hasSysexOutput: true
    };
  }
  get isWebAudioModule() {
    return true;
  }
  get groupId() {
    return this._groupId;
  }
  get moduleId() {
    return this.descriptor.identifier;
  }
  get instanceId() {
    return this.moduleId + this._timestamp;
  }
  get descriptor() {
    return this._descriptor;
  }
  get identifier() {
    return this.descriptor.identifier;
  }
  get name() {
    return this.descriptor.name;
  }
  get vendor() {
    return this.descriptor.vendor;
  }
  get audioContext() {
    return this._audioContext;
  }
  get audioNode() {
    if (!this.initialized)
      console.warn("WAM should be initialized before getting the audioNode");
    return this._audioNode;
  }
  set audioNode(node) {
    this._audioNode = node;
  }
  get initialized() {
    return this._initialized;
  }
  set initialized(value) {
    this._initialized = value;
  }
  async createAudioNode(initialState) {
    throw new TypeError("createAudioNode() not provided");
  }
  async initialize(state) {
    if (!this._audioNode)
      this.audioNode = await this.createAudioNode();
    this.initialized = true;
    return this;
  }
  async _loadGui() {
    const url = this._guiModuleUrl;
    if (!url)
      throw new TypeError("Gui module not found");
    return import(
      /* webpackIgnore: true */
      url
    );
  }
  async _loadDescriptor() {
    const url = this._descriptorUrl;
    if (!url)
      throw new TypeError("Descriptor not found");
    const response = await fetch(url);
    const descriptor = await response.json();
    Object.assign(this._descriptor, descriptor);
    return this._descriptor;
  }
  async createGui() {
    if (!this.initialized)
      console.warn("Plugin should be initialized before getting the gui");
    if (!this._guiModuleUrl)
      return void 0;
    const { createElement } = await this._loadGui();
    return createElement(this);
  }
  destroyGui() {
  }
};
var WebAudioModule_default = WebAudioModule;
var getRingBuffer = (moduleId) => {
  const audioWorkletGlobalScope = globalThis;
  class RingBuffer2 {
    static getStorageForCapacity(capacity, Type) {
      if (!Type.BYTES_PER_ELEMENT) {
        throw new Error("Pass in a ArrayBuffer subclass");
      }
      const bytes = 8 + (capacity + 1) * Type.BYTES_PER_ELEMENT;
      return new SharedArrayBuffer(bytes);
    }
    constructor(sab, Type) {
      if (!Type.BYTES_PER_ELEMENT) {
        throw new Error("Pass a concrete typed array class as second argument");
      }
      this._Type = Type;
      this._capacity = (sab.byteLength - 8) / Type.BYTES_PER_ELEMENT;
      this.buf = sab;
      this.write_ptr = new Uint32Array(this.buf, 0, 1);
      this.read_ptr = new Uint32Array(this.buf, 4, 1);
      this.storage = new Type(this.buf, 8, this._capacity);
    }
    get type() {
      return this._Type.name;
    }
    push(elements) {
      const rd = Atomics.load(this.read_ptr, 0);
      const wr = Atomics.load(this.write_ptr, 0);
      if ((wr + 1) % this._storageCapacity() === rd) {
        return 0;
      }
      const toWrite = Math.min(this._availableWrite(rd, wr), elements.length);
      const firstPart = Math.min(this._storageCapacity() - wr, toWrite);
      const secondPart = toWrite - firstPart;
      this._copy(elements, 0, this.storage, wr, firstPart);
      this._copy(elements, firstPart, this.storage, 0, secondPart);
      Atomics.store(this.write_ptr, 0, (wr + toWrite) % this._storageCapacity());
      return toWrite;
    }
    pop(elements) {
      const rd = Atomics.load(this.read_ptr, 0);
      const wr = Atomics.load(this.write_ptr, 0);
      if (wr === rd) {
        return 0;
      }
      const isArray = !Number.isInteger(elements);
      const toRead = Math.min(this._availableRead(rd, wr), isArray ? elements.length : elements);
      if (isArray) {
        const firstPart = Math.min(this._storageCapacity() - rd, toRead);
        const secondPart = toRead - firstPart;
        this._copy(this.storage, rd, elements, 0, firstPart);
        this._copy(this.storage, 0, elements, firstPart, secondPart);
      }
      Atomics.store(this.read_ptr, 0, (rd + toRead) % this._storageCapacity());
      return toRead;
    }
    get empty() {
      const rd = Atomics.load(this.read_ptr, 0);
      const wr = Atomics.load(this.write_ptr, 0);
      return wr === rd;
    }
    get full() {
      const rd = Atomics.load(this.read_ptr, 0);
      const wr = Atomics.load(this.write_ptr, 0);
      return (wr + 1) % this._capacity !== rd;
    }
    get capacity() {
      return this._capacity - 1;
    }
    get availableRead() {
      const rd = Atomics.load(this.read_ptr, 0);
      const wr = Atomics.load(this.write_ptr, 0);
      return this._availableRead(rd, wr);
    }
    get availableWrite() {
      const rd = Atomics.load(this.read_ptr, 0);
      const wr = Atomics.load(this.write_ptr, 0);
      return this._availableWrite(rd, wr);
    }
    _availableRead(rd, wr) {
      if (wr > rd) {
        return wr - rd;
      }
      return wr + this._storageCapacity() - rd;
    }
    _availableWrite(rd, wr) {
      let rv = rd - wr - 1;
      if (wr >= rd) {
        rv += this._storageCapacity();
      }
      return rv;
    }
    _storageCapacity() {
      return this._capacity;
    }
    _copy(input, offsetInput, output, offsetOutput, size) {
      for (let i = 0; i < size; i++) {
        output[offsetOutput + i] = input[offsetInput + i];
      }
    }
  }
  if (audioWorkletGlobalScope.AudioWorkletProcessor) {
    const ModuleScope = audioWorkletGlobalScope.webAudioModules.getModuleScope(moduleId);
    if (!ModuleScope.RingBuffer)
      ModuleScope.RingBuffer = RingBuffer2;
  }
  return RingBuffer2;
};
var RingBuffer_default = getRingBuffer;
var getWamArrayRingBuffer = (moduleId) => {
  const audioWorkletGlobalScope = globalThis;
  class WamArrayRingBuffer {
    static DefaultArrayCapacity = 2;
    static getStorageForEventCapacity(RingBuffer2, arrayLength, arrayType, maxArrayCapacity = void 0) {
      if (maxArrayCapacity === void 0)
        maxArrayCapacity = WamArrayRingBuffer.DefaultArrayCapacity;
      else
        maxArrayCapacity = Math.max(maxArrayCapacity, WamArrayRingBuffer.DefaultArrayCapacity);
      if (!arrayType.BYTES_PER_ELEMENT) {
        throw new Error("Pass in a ArrayBuffer subclass");
      }
      const capacity = arrayLength * maxArrayCapacity;
      return RingBuffer2.getStorageForCapacity(capacity, arrayType);
    }
    constructor(RingBuffer2, sab, arrayLength, arrayType, maxArrayCapacity = void 0) {
      if (!arrayType.BYTES_PER_ELEMENT) {
        throw new Error("Pass in a ArrayBuffer subclass");
      }
      this._arrayLength = arrayLength;
      this._arrayType = arrayType;
      this._arrayElementSizeBytes = arrayType.BYTES_PER_ELEMENT;
      this._arraySizeBytes = this._arrayLength * this._arrayElementSizeBytes;
      this._sab = sab;
      if (maxArrayCapacity === void 0)
        maxArrayCapacity = WamArrayRingBuffer.DefaultArrayCapacity;
      else
        maxArrayCapacity = Math.max(maxArrayCapacity, WamArrayRingBuffer.DefaultArrayCapacity);
      this._arrayArray = new arrayType(this._arrayLength);
      this._rb = new RingBuffer2(this._sab, arrayType);
    }
    write(array) {
      if (array.length !== this._arrayLength)
        return false;
      const elementsAvailable = this._rb.availableWrite;
      if (elementsAvailable < this._arrayLength)
        return false;
      let success = true;
      const elementsWritten = this._rb.push(array);
      if (elementsWritten != this._arrayLength)
        success = false;
      return success;
    }
    read(array, newest) {
      if (array.length !== this._arrayLength)
        return false;
      const elementsAvailable = this._rb.availableRead;
      if (elementsAvailable < this._arrayLength)
        return false;
      if (newest && elementsAvailable > this._arrayLength)
        this._rb.pop(elementsAvailable - this._arrayLength);
      let success = false;
      const elementsRead = this._rb.pop(array);
      if (elementsRead === this._arrayLength)
        success = true;
      return success;
    }
  }
  if (audioWorkletGlobalScope.AudioWorkletProcessor) {
    const ModuleScope = audioWorkletGlobalScope.webAudioModules.getModuleScope(moduleId);
    if (!ModuleScope.WamArrayRingBuffer)
      ModuleScope.WamArrayRingBuffer = WamArrayRingBuffer;
  }
  return WamArrayRingBuffer;
};
var WamArrayRingBuffer_default = getWamArrayRingBuffer;
var getWamEventRingBuffer = (moduleId) => {
  const audioWorkletGlobalScope = globalThis;
  class WamEventRingBuffer2 {
    static DefaultExtraBytesPerEvent = 64;
    static WamEventBaseBytes = 4 + 1 + 8;
    static WamAutomationEventBytes = WamEventRingBuffer2.WamEventBaseBytes + 2 + 8 + 1;
    static WamTransportEventBytes = WamEventRingBuffer2.WamEventBaseBytes + 4 + 8 + 8 + 1 + 1 + 1;
    static WamMidiEventBytes = WamEventRingBuffer2.WamEventBaseBytes + 1 + 1 + 1;
    static WamBinaryEventBytes = WamEventRingBuffer2.WamEventBaseBytes + 4;
    static getStorageForEventCapacity(RingBuffer2, eventCapacity, maxBytesPerEvent = void 0) {
      if (maxBytesPerEvent === void 0)
        maxBytesPerEvent = WamEventRingBuffer2.DefaultExtraBytesPerEvent;
      else
        maxBytesPerEvent = Math.max(maxBytesPerEvent, WamEventRingBuffer2.DefaultExtraBytesPerEvent);
      const capacity = (Math.max(WamEventRingBuffer2.WamAutomationEventBytes, WamEventRingBuffer2.WamTransportEventBytes, WamEventRingBuffer2.WamMidiEventBytes, WamEventRingBuffer2.WamBinaryEventBytes) + maxBytesPerEvent) * eventCapacity;
      return RingBuffer2.getStorageForCapacity(capacity, Uint8Array);
    }
    constructor(RingBuffer2, sab, parameterIds, maxBytesPerEvent = void 0) {
      this._eventSizeBytes = {};
      this._encodeEventType = {};
      this._decodeEventType = {};
      const wamEventTypes = ["wam-automation", "wam-transport", "wam-midi", "wam-sysex", "wam-mpe", "wam-osc", "wam-info"];
      wamEventTypes.forEach((type, encodedType) => {
        let byteSize = 0;
        switch (type) {
          case "wam-automation":
            byteSize = WamEventRingBuffer2.WamAutomationEventBytes;
            break;
          case "wam-transport":
            byteSize = WamEventRingBuffer2.WamTransportEventBytes;
            break;
          case "wam-mpe":
          case "wam-midi":
            byteSize = WamEventRingBuffer2.WamMidiEventBytes;
            break;
          case "wam-osc":
          case "wam-sysex":
          case "wam-info":
            byteSize = WamEventRingBuffer2.WamBinaryEventBytes;
            break;
          default:
            break;
        }
        this._eventSizeBytes[type] = byteSize;
        this._encodeEventType[type] = encodedType;
        this._decodeEventType[encodedType] = type;
      });
      this._parameterCode = 0;
      this._parameterCodes = {};
      this._encodeParameterId = {};
      this._decodeParameterId = {};
      this.setParameterIds(parameterIds);
      this._sab = sab;
      if (maxBytesPerEvent === void 0)
        maxBytesPerEvent = WamEventRingBuffer2.DefaultExtraBytesPerEvent;
      else
        maxBytesPerEvent = Math.max(maxBytesPerEvent, WamEventRingBuffer2.DefaultExtraBytesPerEvent);
      this._eventBytesAvailable = Math.max(WamEventRingBuffer2.WamAutomationEventBytes, WamEventRingBuffer2.WamTransportEventBytes, WamEventRingBuffer2.WamMidiEventBytes, WamEventRingBuffer2.WamBinaryEventBytes) + maxBytesPerEvent;
      this._eventBytes = new ArrayBuffer(this._eventBytesAvailable);
      this._eventBytesView = new DataView(this._eventBytes);
      this._rb = new RingBuffer2(this._sab, Uint8Array);
      this._eventSizeArray = new Uint8Array(this._eventBytes, 0, 4);
      this._eventSizeView = new DataView(this._eventBytes, 0, 4);
    }
    _writeHeader(byteSize, type, time) {
      let byteOffset = 0;
      this._eventBytesView.setUint32(byteOffset, byteSize);
      byteOffset += 4;
      this._eventBytesView.setUint8(byteOffset, this._encodeEventType[type]);
      byteOffset += 1;
      this._eventBytesView.setFloat64(byteOffset, Number.isFinite(time) ? time : -1);
      byteOffset += 8;
      return byteOffset;
    }
    _encode(event) {
      let byteOffset = 0;
      const { type, time } = event;
      switch (event.type) {
        case "wam-automation":
          {
            if (!(event.data.id in this._encodeParameterId))
              break;
            const byteSize = this._eventSizeBytes[type];
            byteOffset = this._writeHeader(byteSize, type, time);
            const { data } = event;
            const encodedParameterId = this._encodeParameterId[data.id];
            const { value, normalized } = data;
            this._eventBytesView.setUint16(byteOffset, encodedParameterId);
            byteOffset += 2;
            this._eventBytesView.setFloat64(byteOffset, value);
            byteOffset += 8;
            this._eventBytesView.setUint8(byteOffset, normalized ? 1 : 0);
            byteOffset += 1;
          }
          break;
        case "wam-transport":
          {
            const byteSize = this._eventSizeBytes[type];
            byteOffset = this._writeHeader(byteSize, type, time);
            const { data } = event;
            const {
              currentBar,
              currentBarStarted,
              tempo,
              timeSigNumerator,
              timeSigDenominator,
              playing
            } = data;
            this._eventBytesView.setUint32(byteOffset, currentBar);
            byteOffset += 4;
            this._eventBytesView.setFloat64(byteOffset, currentBarStarted);
            byteOffset += 8;
            this._eventBytesView.setFloat64(byteOffset, tempo);
            byteOffset += 8;
            this._eventBytesView.setUint8(byteOffset, timeSigNumerator);
            byteOffset += 1;
            this._eventBytesView.setUint8(byteOffset, timeSigDenominator);
            byteOffset += 1;
            this._eventBytesView.setUint8(byteOffset, playing ? 1 : 0);
            byteOffset += 1;
          }
          break;
        case "wam-mpe":
        case "wam-midi":
          {
            const byteSize = this._eventSizeBytes[type];
            byteOffset = this._writeHeader(byteSize, type, time);
            const { data } = event;
            const { bytes } = data;
            let b = 0;
            while (b < 3) {
              this._eventBytesView.setUint8(byteOffset, bytes[b]);
              byteOffset += 1;
              b++;
            }
          }
          break;
        case "wam-osc":
        case "wam-sysex":
        case "wam-info":
          {
            let bytes = null;
            if (event.type === "wam-info") {
              const { data } = event;
              bytes = new TextEncoder().encode(data.instanceId);
            } else {
              const { data } = event;
              bytes = data.bytes;
            }
            const numBytes = bytes.length;
            const byteSize = this._eventSizeBytes[type];
            byteOffset = this._writeHeader(byteSize + numBytes, type, time);
            this._eventBytesView.setUint32(byteOffset, numBytes);
            byteOffset += 4;
            const bytesRequired = byteOffset + numBytes;
            if (bytesRequired > this._eventBytesAvailable)
              console.error(`Event requires ${bytesRequired} bytes but only ${this._eventBytesAvailable} have been allocated!`);
            const buffer = new Uint8Array(this._eventBytes, byteOffset, numBytes);
            buffer.set(bytes);
            byteOffset += numBytes;
          }
          break;
        default:
          break;
      }
      return new Uint8Array(this._eventBytes, 0, byteOffset);
    }
    _decode() {
      let byteOffset = 0;
      const type = this._decodeEventType[this._eventBytesView.getUint8(byteOffset)];
      byteOffset += 1;
      let time = this._eventBytesView.getFloat64(byteOffset);
      if (time === -1)
        time = void 0;
      byteOffset += 8;
      switch (type) {
        case "wam-automation": {
          const encodedParameterId = this._eventBytesView.getUint16(byteOffset);
          byteOffset += 2;
          const value = this._eventBytesView.getFloat64(byteOffset);
          byteOffset += 8;
          const normalized = !!this._eventBytesView.getUint8(byteOffset);
          byteOffset += 1;
          if (!(encodedParameterId in this._decodeParameterId))
            break;
          const id = this._decodeParameterId[encodedParameterId];
          const event = {
            type,
            time,
            data: {
              id,
              value,
              normalized
            }
          };
          return event;
        }
        case "wam-transport": {
          const currentBar = this._eventBytesView.getUint32(byteOffset);
          byteOffset += 4;
          const currentBarStarted = this._eventBytesView.getFloat64(byteOffset);
          byteOffset += 8;
          const tempo = this._eventBytesView.getFloat64(byteOffset);
          byteOffset += 8;
          const timeSigNumerator = this._eventBytesView.getUint8(byteOffset);
          byteOffset += 1;
          const timeSigDenominator = this._eventBytesView.getUint8(byteOffset);
          byteOffset += 1;
          const playing = this._eventBytesView.getUint8(byteOffset) == 1;
          byteOffset += 1;
          const event = {
            type,
            time,
            data: {
              currentBar,
              currentBarStarted,
              tempo,
              timeSigNumerator,
              timeSigDenominator,
              playing
            }
          };
          return event;
        }
        case "wam-mpe":
        case "wam-midi": {
          const bytes = [0, 0, 0];
          let b = 0;
          while (b < 3) {
            bytes[b] = this._eventBytesView.getUint8(byteOffset);
            byteOffset += 1;
            b++;
          }
          const event = {
            type,
            time,
            data: { bytes }
          };
          return event;
        }
        case "wam-osc":
        case "wam-sysex":
        case "wam-info": {
          const numBytes = this._eventBytesView.getUint32(byteOffset);
          byteOffset += 4;
          const bytes = new Uint8Array(numBytes);
          bytes.set(new Uint8Array(this._eventBytes, byteOffset, numBytes));
          byteOffset += numBytes;
          if (type === "wam-info") {
            const instanceId = new TextDecoder().decode(bytes);
            const data = { instanceId };
            return { type, time, data };
          } else {
            const data = { bytes };
            return { type, time, data };
          }
        }
        default:
          break;
      }
      return false;
    }
    write(...events) {
      const numEvents = events.length;
      let bytesAvailable = this._rb.availableWrite;
      let numSkipped = 0;
      let i = 0;
      while (i < numEvents) {
        const event = events[i];
        const bytes = this._encode(event);
        const eventSizeBytes = bytes.byteLength;
        let bytesWritten = 0;
        if (bytesAvailable >= eventSizeBytes) {
          if (eventSizeBytes === 0)
            numSkipped++;
          else
            bytesWritten = this._rb.push(bytes);
        } else
          break;
        bytesAvailable -= bytesWritten;
        i++;
      }
      return i - numSkipped;
    }
    read() {
      if (this._rb.empty)
        return [];
      const events = [];
      let bytesAvailable = this._rb.availableRead;
      let bytesRead = 0;
      while (bytesAvailable > 0) {
        bytesRead = this._rb.pop(this._eventSizeArray);
        bytesAvailable -= bytesRead;
        const eventSizeBytes = this._eventSizeView.getUint32(0);
        const eventBytes = new Uint8Array(this._eventBytes, 0, eventSizeBytes - 4);
        bytesRead = this._rb.pop(eventBytes);
        bytesAvailable -= bytesRead;
        const decodedEvent = this._decode();
        if (decodedEvent)
          events.push(decodedEvent);
      }
      return events;
    }
    setParameterIds(parameterIds) {
      this._encodeParameterId = {};
      this._decodeParameterId = {};
      parameterIds.forEach((parameterId) => {
        let parameterCode = -1;
        if (parameterId in this._parameterCodes)
          parameterCode = this._parameterCodes[parameterId];
        else {
          parameterCode = this._generateParameterCode();
          this._parameterCodes[parameterId] = parameterCode;
        }
        this._encodeParameterId[parameterId] = parameterCode;
        this._decodeParameterId[parameterCode] = parameterId;
      });
    }
    _generateParameterCode() {
      if (this._parameterCode > 65535)
        throw Error("Too many parameters have been registered!");
      return this._parameterCode++;
    }
  }
  if (audioWorkletGlobalScope.AudioWorkletProcessor) {
    const ModuleScope = audioWorkletGlobalScope.webAudioModules.getModuleScope(moduleId);
    if (!ModuleScope.WamEventRingBuffer)
      ModuleScope.WamEventRingBuffer = WamEventRingBuffer2;
  }
  return WamEventRingBuffer2;
};
var WamEventRingBuffer_default = getWamEventRingBuffer;
var addFunctionModule = (audioWorklet, processorFunction, ...injection) => {
  const text = `(${processorFunction.toString()})(${injection.map((s) => JSON.stringify(s)).join(", ")});`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  return audioWorklet.addModule(url);
};
var addFunctionModule_default = addFunctionModule;
var getWamParameter = (moduleId) => {
  const audioWorkletGlobalScope = globalThis;
  class WamParameter {
    constructor(info) {
      this.info = info;
      this._value = info.defaultValue;
    }
    set value(value) {
      this._value = value;
    }
    get value() {
      return this._value;
    }
    set normalizedValue(valueNorm) {
      this.value = this.info.denormalize(valueNorm);
    }
    get normalizedValue() {
      return this.info.normalize(this.value);
    }
  }
  if (audioWorkletGlobalScope.AudioWorkletProcessor) {
    const ModuleScope = audioWorkletGlobalScope.webAudioModules.getModuleScope(moduleId);
    if (!ModuleScope.WamParameter)
      ModuleScope.WamParameter = WamParameter;
  }
  return WamParameter;
};
var WamParameter_default = getWamParameter;
var getWamParameterInfo = (moduleId) => {
  const audioWorkletGlobalScope = globalThis;
  const normExp = (x, e) => e === 0 ? x : x ** 1.5 ** -e;
  const denormExp = (x, e) => e === 0 ? x : x ** 1.5 ** e;
  const normalize = (x, min, max, e = 0) => min === 0 && max === 1 ? normExp(x, e) : normExp((x - min) / (max - min) || 0, e);
  const denormalize = (x, min, max, e = 0) => min === 0 && max === 1 ? denormExp(x, e) : denormExp(x, e) * (max - min) + min;
  const inRange = (x, min, max) => x >= min && x <= max;
  class WamParameterInfo {
    constructor(id, config = {}) {
      let {
        type,
        label,
        defaultValue,
        minValue,
        maxValue,
        discreteStep,
        exponent,
        choices,
        units
      } = config;
      if (type === void 0)
        type = "float";
      if (label === void 0)
        label = "";
      if (defaultValue === void 0)
        defaultValue = 0;
      if (choices === void 0)
        choices = [];
      if (type === "boolean" || type === "choice") {
        discreteStep = 1;
        minValue = 0;
        if (choices.length)
          maxValue = choices.length - 1;
        else
          maxValue = 1;
      } else {
        if (minValue === void 0)
          minValue = 0;
        if (maxValue === void 0)
          maxValue = 1;
        if (discreteStep === void 0)
          discreteStep = 0;
        if (exponent === void 0)
          exponent = 0;
        if (units === void 0)
          units = "";
      }
      const errBase = `Param config error | ${id}: `;
      if (minValue >= maxValue)
        throw Error(errBase.concat("minValue must be less than maxValue"));
      if (!inRange(defaultValue, minValue, maxValue))
        throw Error(errBase.concat("defaultValue out of range"));
      if (discreteStep % 1 || discreteStep < 0) {
        throw Error(errBase.concat("discreteStep must be a non-negative integer"));
      } else if (discreteStep > 0 && (minValue % 1 || maxValue % 1 || defaultValue % 1)) {
        throw Error(errBase.concat("non-zero discreteStep requires integer minValue, maxValue, and defaultValue"));
      }
      if (type === "choice" && !choices.length) {
        throw Error(errBase.concat("choice type parameter requires list of strings in choices"));
      }
      this.id = id;
      this.label = label;
      this.type = type;
      this.defaultValue = defaultValue;
      this.minValue = minValue;
      this.maxValue = maxValue;
      this.discreteStep = discreteStep;
      this.exponent = exponent;
      this.choices = choices;
      this.units = units;
    }
    normalize(value) {
      return normalize(value, this.minValue, this.maxValue, this.exponent);
    }
    denormalize(valueNorm) {
      return denormalize(valueNorm, this.minValue, this.maxValue, this.exponent);
    }
    valueString(value) {
      if (this.choices)
        return this.choices[value];
      if (this.units !== "")
        return `${value} ${this.units}`;
      return `${value}`;
    }
  }
  if (audioWorkletGlobalScope.AudioWorkletProcessor) {
    const ModuleScope = audioWorkletGlobalScope.webAudioModules.getModuleScope(moduleId);
    if (!ModuleScope.WamParameterInfo)
      ModuleScope.WamParameterInfo = WamParameterInfo;
  }
  return WamParameterInfo;
};
var WamParameterInfo_default = getWamParameterInfo;
var getWamParameterInterpolator = (moduleId) => {
  const audioWorkletGlobalScope = globalThis;
  const samplesPerQuantum = 128;
  const nullTableKey = "0_0";
  class WamParameterInterpolator {
    static _tables;
    static _tableReferences;
    constructor(info, samplesPerInterpolation, skew = 0) {
      if (!WamParameterInterpolator._tables) {
        WamParameterInterpolator._tables = { nullTableKey: new Float32Array(0) };
        WamParameterInterpolator._tableReferences = { nullTableKey: [] };
      }
      this.info = info;
      this.values = new Float32Array(samplesPerQuantum);
      this._tableKey = nullTableKey;
      this._table = WamParameterInterpolator._tables[this._tableKey];
      this._skew = 2;
      const { discreteStep } = info;
      this._discrete = !!discreteStep;
      this._N = this._discrete ? 0 : samplesPerInterpolation;
      this._n = 0;
      this._startValue = info.defaultValue;
      this._endValue = info.defaultValue;
      this._currentValue = info.defaultValue;
      this._deltaValue = 0;
      this._inverted = false;
      this._changed = true;
      this._filled = 0;
      if (!this._discrete)
        this.setSkew(skew);
      else
        this._skew = 0;
      this.setStartValue(this._startValue);
    }
    _removeTableReference(oldKey) {
      if (oldKey === nullTableKey)
        return;
      const { id } = this.info;
      const references = WamParameterInterpolator._tableReferences[oldKey];
      if (references) {
        const index = references.indexOf(id);
        if (index !== -1)
          references.splice(index, 1);
        if (references.length === 0) {
          delete WamParameterInterpolator._tables[oldKey];
          delete WamParameterInterpolator._tableReferences[oldKey];
        }
      }
    }
    setSkew(skew) {
      if (this._skew === skew || this._discrete)
        return;
      if (skew < -1 || skew > 1)
        throw Error("skew must be in range [-1.0, 1.0]");
      const newKey = [this._N, skew].join("_");
      const oldKey = this._tableKey;
      const { id } = this.info;
      if (newKey === oldKey)
        return;
      if (WamParameterInterpolator._tables[newKey]) {
        const references = WamParameterInterpolator._tableReferences[newKey];
        if (references)
          references.push(id);
        else
          WamParameterInterpolator._tableReferences[newKey] = [id];
      } else {
        let e = Math.abs(skew);
        e = Math.pow(3 - e, e * (e + 2));
        const linear = e === 1;
        const N = this._N;
        const table = new Float32Array(N + 1);
        if (linear)
          for (let n = 0; n <= N; ++n)
            table[n] = n / N;
        else
          for (let n = 0; n <= N; ++n)
            table[n] = (n / N) ** e;
        WamParameterInterpolator._tables[newKey] = table;
        WamParameterInterpolator._tableReferences[newKey] = [id];
      }
      this._removeTableReference(oldKey);
      this._skew = skew;
      this._tableKey = newKey;
      this._table = WamParameterInterpolator._tables[this._tableKey];
    }
    setStartValue(value, fill = true) {
      this._n = this._N;
      this._startValue = value;
      this._endValue = value;
      this._currentValue = value;
      this._deltaValue = 0;
      this._inverted = false;
      if (fill) {
        this.values.fill(value);
        this._changed = true;
        this._filled = this.values.length;
      } else {
        this._changed = false;
        this._filled = 0;
      }
    }
    setEndValue(value) {
      if (value === this._endValue)
        return;
      this._n = 0;
      this._startValue = this._currentValue;
      this._endValue = value;
      this._deltaValue = this._endValue - this._startValue;
      this._inverted = this._deltaValue > 0 && this._skew >= 0 || this._deltaValue <= 0 && this._skew < 0;
      this._changed = false;
      this._filled = 0;
    }
    process(startSample, endSample) {
      if (this.done)
        return;
      const length = endSample - startSample;
      let fill = 0;
      const change = this._N - this._n;
      if (this._discrete || !change)
        fill = length;
      else {
        if (change < length) {
          fill = Math.min(length - change, samplesPerQuantum);
          endSample -= fill;
        }
        if (endSample > startSample) {
          if (this._inverted) {
            for (let i = startSample; i < endSample; ++i) {
              const tableValue = 1 - this._table[this._N - ++this._n];
              this.values[i] = this._startValue + tableValue * this._deltaValue;
            }
          } else {
            for (let i = startSample; i < endSample; ++i) {
              const tableValue = this._table[++this._n];
              this.values[i] = this._startValue + tableValue * this._deltaValue;
            }
          }
        }
        if (fill > 0) {
          startSample = endSample;
          endSample += fill;
        }
      }
      if (fill > 0) {
        this.values.fill(this._endValue, startSample, endSample);
        this._filled += fill;
      }
      this._currentValue = this.values[endSample - 1];
      if (this._n === this._N) {
        if (!this._changed)
          this._changed = true;
        else if (this._filled >= this.values.length) {
          this.setStartValue(this._endValue, false);
          this._changed = true;
          this._filled = this.values.length;
        }
      }
    }
    get done() {
      return this._changed && this._filled === this.values.length;
    }
    is(value) {
      return this._endValue === value && this.done;
    }
    destroy() {
      this._removeTableReference(this._tableKey);
    }
  }
  if (audioWorkletGlobalScope.AudioWorkletProcessor) {
    const ModuleScope = audioWorkletGlobalScope.webAudioModules.getModuleScope(moduleId);
    if (!ModuleScope.WamParameterInterpolator)
      ModuleScope.WamParameterInterpolator = WamParameterInterpolator;
  }
  return WamParameterInterpolator;
};
var WamParameterInterpolator_default = getWamParameterInterpolator;
var getWamProcessor = (moduleId) => {
  const audioWorkletGlobalScope = globalThis;
  const {
    AudioWorkletProcessor,
    webAudioModules
  } = audioWorkletGlobalScope;
  const ModuleScope = audioWorkletGlobalScope.webAudioModules.getModuleScope(moduleId);
  const {
    RingBuffer: RingBuffer2,
    WamEventRingBuffer: WamEventRingBuffer2,
    WamParameter,
    WamParameterInterpolator
  } = ModuleScope;
  class WamProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const {
        groupId,
        moduleId: moduleId2,
        instanceId,
        useSab
      } = options.processorOptions;
      if (!moduleId2)
        throw Error("must provide moduleId argument in processorOptions!");
      if (!instanceId)
        throw Error("must provide instanceId argument in processorOptions!");
      this.groupId = groupId;
      this.moduleId = moduleId2;
      this.instanceId = instanceId;
      this._samplesPerQuantum = 128;
      this._compensationDelay = 0;
      this._parameterInfo = {};
      this._parameterState = {};
      this._parameterInterpolators = {};
      this._eventQueue = [];
      this._pendingResponses = {};
      this._useSab = !!useSab && !!globalThis.SharedArrayBuffer;
      this._eventSabReady = false;
      this._audioToMainEventSab = null;
      this._mainToAudioEventSab = null;
      this._eventWriter = null;
      this._eventReader = null;
      this._initialized = false;
      this._destroyed = false;
      this._eventQueueRequiresSort = false;
      webAudioModules.addWam(this);
      this.port.onmessage = this._onMessage.bind(this);
      if (this._useSab)
        this._configureSab();
    }
    getCompensationDelay() {
      return this._compensationDelay;
    }
    scheduleEvents(...events) {
      let i = 0;
      while (i < events.length) {
        this._eventQueue.push({ id: 0, event: events[i] });
        i++;
      }
      this._eventQueueRequiresSort = this._eventQueue.length > 1;
    }
    emitEvents(...events) {
      webAudioModules.emitEvents(this, ...events);
    }
    clearEvents() {
      this._eventQueue = [];
    }
    process(inputs, outputs, parameters) {
      if (!this._initialized)
        return true;
      if (this._destroyed)
        return false;
      if (this._eventSabReady)
        this.scheduleEvents(...this._eventReader.read());
      const processingSlices = this._getProcessingSlices();
      let i = 0;
      while (i < processingSlices.length) {
        const { range, events } = processingSlices[i];
        const [startSample, endSample] = range;
        let j = 0;
        while (j < events.length) {
          this._processEvent(events[j]);
          j++;
        }
        this._interpolateParameterValues(startSample, endSample);
        this._process(startSample, endSample, inputs, outputs, parameters);
        i++;
      }
      return true;
    }
    destroy() {
      this._destroyed = true;
      this.port.close();
      webAudioModules.removeWam(this);
    }
    _generateWamParameterInfo() {
      return {};
    }
    _initialize() {
      this._parameterState = {};
      this._parameterInterpolators = {};
      this._parameterInfo = this._generateWamParameterInfo();
      Object.keys(this._parameterInfo).forEach((parameterId) => {
        const info = this._parameterInfo[parameterId];
        this._parameterState[parameterId] = new WamParameter(this._parameterInfo[parameterId]);
        this._parameterInterpolators[parameterId] = new WamParameterInterpolator(info, 256);
      });
    }
    _configureSab() {
      const eventCapacity = 2 ** 10;
      const parameterIds = Object.keys(this._parameterInfo);
      if (this._eventSabReady) {
        this._eventWriter.setParameterIds(parameterIds);
        this._eventReader.setParameterIds(parameterIds);
      }
      this.port.postMessage({ eventSab: { eventCapacity, parameterIds } });
    }
    async _onMessage(message) {
      if (message.data.request) {
        const {
          id,
          request,
          content
        } = message.data;
        const response = { id, response: request };
        const requestComponents = request.split("/");
        const verb = requestComponents[0];
        const noun = requestComponents[1];
        response.content = "error";
        if (verb === "get") {
          if (noun === "parameterInfo") {
            let { parameterIds } = content;
            if (!parameterIds.length)
              parameterIds = Object.keys(this._parameterInfo);
            const parameterInfo = {};
            let i = 0;
            while (i < parameterIds.length) {
              const parameterId = parameterIds[i];
              parameterInfo[parameterId] = this._parameterInfo[parameterId];
              i++;
            }
            response.content = parameterInfo;
          } else if (noun === "parameterValues") {
            let { normalized, parameterIds } = content;
            response.content = this._getParameterValues(normalized, parameterIds);
          } else if (noun === "state") {
            response.content = this._getState();
          } else if (noun === "compensationDelay") {
            response.content = this.getCompensationDelay();
          }
        } else if (verb === "set") {
          if (noun === "parameterValues") {
            const { parameterValues } = content;
            this._setParameterValues(parameterValues, true);
            delete response.content;
          } else if (noun === "state") {
            const { state } = content;
            this._setState(state);
            delete response.content;
          }
        } else if (verb === "add") {
          if (noun === "event") {
            const { event } = content;
            this._eventQueue.push({ id, event });
            this._eventQueueRequiresSort = this._eventQueue.length > 1;
            return;
          }
        } else if (verb === "remove") {
          if (noun === "events") {
            const ids = this._eventQueue.map((queued) => queued.id);
            this.clearEvents();
            response.content = ids;
          }
        } else if (verb === "connect") {
          if (noun === "events") {
            const { wamInstanceId, output } = content;
            this._connectEvents(wamInstanceId, output);
            delete response.content;
          }
        } else if (verb === "disconnect") {
          if (noun === "events") {
            const { wamInstanceId, output } = content;
            this._disconnectEvents(wamInstanceId, output);
            delete response.content;
          }
        } else if (verb === "initialize") {
          if (noun === "processor") {
            this._initialize();
            this._initialized = true;
            delete response.content;
          } else if (noun === "eventSab") {
            const { mainToAudioEventSab, audioToMainEventSab } = content;
            this._audioToMainEventSab = audioToMainEventSab;
            this._mainToAudioEventSab = mainToAudioEventSab;
            const parameterIds = Object.keys(this._parameterInfo);
            this._eventWriter = new WamEventRingBuffer2(RingBuffer2, this._audioToMainEventSab, parameterIds);
            this._eventReader = new WamEventRingBuffer2(RingBuffer2, this._mainToAudioEventSab, parameterIds);
            this._eventSabReady = true;
            delete response.content;
          }
        }
        this.port.postMessage(response);
      } else if (message.data.destroy) {
        this.destroy();
      }
    }
    _onTransport(transportData) {
      console.error("_onTransport not implemented!");
    }
    _onMidi(midiData) {
      console.error("_onMidi not implemented!");
    }
    _onSysex(sysexData) {
      console.error("_onMidi not implemented!");
    }
    _onMpe(mpeData) {
      console.error("_onMpe not implemented!");
    }
    _onOsc(oscData) {
      console.error("_onOsc not implemented!");
    }
    _setState(state) {
      if (state.parameterValues)
        this._setParameterValues(state.parameterValues, false);
    }
    _getState() {
      return { parameterValues: this._getParameterValues(false) };
    }
    _getParameterValues(normalized, parameterIds) {
      const parameterValues = {};
      if (!parameterIds || !parameterIds.length)
        parameterIds = Object.keys(this._parameterState);
      let i = 0;
      while (i < parameterIds.length) {
        const id = parameterIds[i];
        const parameter = this._parameterState[id];
        parameterValues[id] = {
          id,
          value: normalized ? parameter.normalizedValue : parameter.value,
          normalized
        };
        i++;
      }
      return parameterValues;
    }
    _setParameterValues(parameterUpdates, interpolate) {
      const parameterIds = Object.keys(parameterUpdates);
      let i = 0;
      while (i < parameterIds.length) {
        this._setParameterValue(parameterUpdates[parameterIds[i]], interpolate);
        i++;
      }
    }
    _setParameterValue(parameterUpdate, interpolate) {
      const { id, value, normalized } = parameterUpdate;
      const parameter = this._parameterState[id];
      if (!parameter)
        return;
      if (!normalized)
        parameter.value = value;
      else
        parameter.normalizedValue = value;
      const interpolator = this._parameterInterpolators[id];
      if (interpolate)
        interpolator.setEndValue(parameter.value);
      else
        interpolator.setStartValue(parameter.value);
    }
    _interpolateParameterValues(startIndex, endIndex) {
      const parameterIds = Object.keys(this._parameterInterpolators);
      let i = 0;
      while (i < parameterIds.length) {
        this._parameterInterpolators[parameterIds[i]].process(startIndex, endIndex);
        i++;
      }
    }
    _connectEvents(wamInstanceId, output) {
      webAudioModules.connectEvents(this.groupId, this.instanceId, wamInstanceId, output);
    }
    _disconnectEvents(wamInstanceId, output) {
      if (typeof wamInstanceId === "undefined") {
        webAudioModules.disconnectEvents(this.groupId, this.instanceId);
        return;
      }
      webAudioModules.disconnectEvents(this.groupId, this.instanceId, wamInstanceId, output);
    }
    _getProcessingSlices() {
      const response = "add/event";
      const { currentTime, sampleRate } = audioWorkletGlobalScope;
      const eventsBySampleIndex = {};
      if (this._eventQueueRequiresSort) {
        this._eventQueue.sort((a, b) => a.event.time - b.event.time);
        this._eventQueueRequiresSort = false;
      }
      let i = 0;
      while (i < this._eventQueue.length) {
        const { id, event } = this._eventQueue[i];
        const offsetSec = event.time - currentTime;
        const sampleIndex = offsetSec > 0 ? Math.round(offsetSec * sampleRate) : 0;
        if (sampleIndex < this._samplesPerQuantum) {
          if (eventsBySampleIndex[sampleIndex])
            eventsBySampleIndex[sampleIndex].push(event);
          else
            eventsBySampleIndex[sampleIndex] = [event];
          if (id)
            this.port.postMessage({ id, response });
          else if (this._eventSabReady)
            this._eventWriter.write(event);
          else
            this.port.postMessage({ event });
          this._eventQueue.shift();
          i = -1;
        } else
          break;
        i++;
      }
      const processingSlices = [];
      const keys = Object.keys(eventsBySampleIndex);
      if (keys[0] !== "0") {
        keys.unshift("0");
        eventsBySampleIndex["0"] = [];
      }
      const lastIndex = keys.length - 1;
      i = 0;
      while (i < keys.length) {
        const key = keys[i];
        const startSample = parseInt(key);
        const endSample = i < lastIndex ? parseInt(keys[i + 1]) : this._samplesPerQuantum;
        processingSlices.push({ range: [startSample, endSample], events: eventsBySampleIndex[key] });
        i++;
      }
      return processingSlices;
    }
    _processEvent(event) {
      switch (event.type) {
        case "wam-automation":
          this._setParameterValue(event.data, true);
          break;
        case "wam-transport":
          this._onTransport(event.data);
          break;
        case "wam-midi":
          this._onMidi(event.data);
          break;
        case "wam-sysex":
          this._onSysex(event.data);
          break;
        case "wam-mpe":
          this._onMpe(event.data);
          break;
        case "wam-osc":
          this._onOsc(event.data);
          break;
        default:
          break;
      }
    }
    _process(startSample, endSample, inputs, outputs, parameters) {
      console.error("_process not implemented!");
    }
  }
  if (audioWorkletGlobalScope.AudioWorkletProcessor) {
    if (!ModuleScope.WamProcessor)
      ModuleScope.WamProcessor = WamProcessor;
  }
  return WamProcessor;
};
var WamProcessor_default = getWamProcessor;
var RingBuffer = RingBuffer_default();
var WamEventRingBuffer = WamEventRingBuffer_default();
var WamNode = class extends AudioWorkletNode {
  static async addModules(audioContext, moduleId) {
    const { audioWorklet } = audioContext;
    await addFunctionModule_default(audioWorklet, RingBuffer_default, moduleId);
    await addFunctionModule_default(audioWorklet, WamEventRingBuffer_default, moduleId);
    await addFunctionModule_default(audioWorklet, WamArrayRingBuffer_default, moduleId);
    await addFunctionModule_default(audioWorklet, WamParameter_default, moduleId);
    await addFunctionModule_default(audioWorklet, WamParameterInfo_default, moduleId);
    await addFunctionModule_default(audioWorklet, WamParameterInterpolator_default, moduleId);
    await addFunctionModule_default(audioWorklet, WamProcessor_default, moduleId);
  }
  constructor(module, options) {
    const { audioContext, groupId, moduleId, instanceId } = module;
    options.processorOptions = {
      groupId,
      moduleId,
      instanceId,
      ...options.processorOptions
    };
    super(audioContext, moduleId, options);
    this.module = module;
    this._supportedEventTypes = /* @__PURE__ */ new Set(["wam-automation", "wam-transport", "wam-midi", "wam-sysex", "wam-mpe", "wam-osc"]);
    this._messageId = 1;
    this._pendingResponses = {};
    this._pendingEvents = {};
    this._useSab = false;
    this._eventSabReady = false;
    this._destroyed = false;
    this.port.onmessage = this._onMessage.bind(this);
  }
  get groupId() {
    return this.module.groupId;
  }
  get moduleId() {
    return this.module.moduleId;
  }
  get instanceId() {
    return this.module.instanceId;
  }
  async getParameterInfo(...parameterIds) {
    const request = "get/parameterInfo";
    const id = this._generateMessageId();
    return new Promise((resolve) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({
        id,
        request,
        content: { parameterIds }
      });
    });
  }
  async getParameterValues(normalized, ...parameterIds) {
    const request = "get/parameterValues";
    const id = this._generateMessageId();
    return new Promise((resolve) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({
        id,
        request,
        content: { normalized, parameterIds }
      });
    });
  }
  async setParameterValues(parameterValues) {
    const request = "set/parameterValues";
    const id = this._generateMessageId();
    return new Promise((resolve) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({
        id,
        request,
        content: { parameterValues }
      });
    });
  }
  async getState() {
    const request = "get/state";
    const id = this._generateMessageId();
    return new Promise((resolve) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({ id, request });
    });
  }
  async setState(state) {
    const request = "set/state";
    const id = this._generateMessageId();
    return new Promise((resolve) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({
        id,
        request,
        content: { state }
      });
    });
  }
  async getCompensationDelay() {
    const request = "get/compensationDelay";
    const id = this._generateMessageId();
    return new Promise((resolve) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({ id, request });
    });
  }
  addEventListener(type, callback, options) {
    if (this._supportedEventTypes.has(type))
      super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) {
    if (this._supportedEventTypes.has(type))
      super.removeEventListener(type, callback, options);
  }
  scheduleEvents(...events) {
    let i = 0;
    const numEvents = events.length;
    if (this._eventSabReady) {
      i = this._eventWriter.write(...events);
    }
    while (i < numEvents) {
      const event = events[i];
      const request = "add/event";
      const id = this._generateMessageId();
      let processed = false;
      new Promise((resolve, reject) => {
        this._pendingResponses[id] = resolve;
        this._pendingEvents[id] = () => {
          if (!processed)
            reject();
        };
        this.port.postMessage({
          id,
          request,
          content: { event }
        });
      }).then((resolved) => {
        processed = true;
        delete this._pendingEvents[id];
        this._onEvent(event);
      }).catch((rejected) => {
        delete this._pendingResponses[id];
      });
      i++;
    }
  }
  async clearEvents() {
    const request = "remove/events";
    const id = this._generateMessageId();
    const ids = Object.keys(this._pendingEvents);
    if (ids.length) {
      return new Promise((resolve) => {
        this._pendingResponses[id] = resolve;
        this.port.postMessage({ id, request });
      }).then((clearedIds) => {
        clearedIds.forEach((clearedId) => {
          this._pendingEvents[clearedId]();
          delete this._pendingEvents[clearedId];
        });
      });
    }
  }
  connectEvents(toId, output) {
    const request = "connect/events";
    const id = this._generateMessageId();
    new Promise((resolve, reject) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({
        id,
        request,
        content: { wamInstanceId: toId, output }
      });
    });
  }
  disconnectEvents(toId, output) {
    const request = "disconnect/events";
    const id = this._generateMessageId();
    new Promise((resolve, reject) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({
        id,
        request,
        content: { wamInstanceId: toId, output }
      });
    });
  }
  destroy() {
    if (this._audioToMainInterval)
      clearInterval(this._audioToMainInterval);
    this.port.postMessage({ destroy: true });
    this.port.close();
    this.disconnect();
    this._destroyed = true;
  }
  _generateMessageId() {
    return this._messageId++;
  }
  async _initialize() {
    const request = "initialize/processor";
    const id = this._generateMessageId();
    return new Promise((resolve) => {
      this._pendingResponses[id] = resolve;
      this.port.postMessage({ id, request });
    });
  }
  _onMessage(message) {
    const { data } = message;
    const { response, event, eventSab } = data;
    if (response) {
      const { id, content } = data;
      const resolvePendingResponse = this._pendingResponses[id];
      if (resolvePendingResponse) {
        delete this._pendingResponses[id];
        resolvePendingResponse(content);
      }
    } else if (eventSab) {
      this._useSab = true;
      const { eventCapacity, parameterIds } = eventSab;
      if (this._eventSabReady) {
        this._eventWriter.setParameterIds(parameterIds);
        this._eventReader.setParameterIds(parameterIds);
        return;
      }
      this._mainToAudioEventSab = WamEventRingBuffer.getStorageForEventCapacity(RingBuffer, eventCapacity);
      this._audioToMainEventSab = WamEventRingBuffer.getStorageForEventCapacity(RingBuffer, eventCapacity);
      this._eventWriter = new WamEventRingBuffer(RingBuffer, this._mainToAudioEventSab, parameterIds);
      this._eventReader = new WamEventRingBuffer(RingBuffer, this._audioToMainEventSab, parameterIds);
      const request = "initialize/eventSab";
      const id = this._generateMessageId();
      new Promise((resolve, reject) => {
        this._pendingResponses[id] = resolve;
        this.port.postMessage({
          id,
          request,
          content: {
            mainToAudioEventSab: this._mainToAudioEventSab,
            audioToMainEventSab: this._audioToMainEventSab
          }
        });
      }).then((resolved) => {
        this._eventSabReady = true;
        this._audioToMainInterval = setInterval(() => {
          const events = this._eventReader.read();
          events.forEach((e) => {
            this._onEvent(e);
          });
        }, 100);
      });
    } else if (event)
      this._onEvent(event);
  }
  _onEvent(event) {
    const { type } = event;
    this.dispatchEvent(new CustomEvent(type, {
      bubbles: true,
      detail: event
    }));
  }
};

// plugins/src/orbitronica-bitcrusher/index.ts
var MODULE_ID = "com.orbitronica.bitcrusher";
var PROOF_ID = "com.orbitronica.bitcrusher.worklet-proof";
var defaults = { bitDepth: 8, reduction: 1, mix: 0 };
var clamp = (value, min, max) => Math.min(max, Math.max(min, value));
var dangerous = (value) => !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => key === "__proto__" || key === "constructor" || key === "prototype" || dangerous(child));
var installed = /* @__PURE__ */ new WeakMap();
var installProcessor = (context, moduleId, minimal) => {
  let byModule = installed.get(context);
  if (!byModule) {
    byModule = /* @__PURE__ */ new Map();
    installed.set(context, byModule);
  }
  const existing = byModule.get(moduleId);
  if (existing) return existing;
  const pending = (async () => {
    await WamNode.addModules(context, moduleId);
    await addFunctionModule_default(context.audioWorklet, (id, isMinimal) => {
      const clampValue = (value, min, max) => Math.min(max, Math.max(min, value));
      const scope = globalThis;
      const moduleScope = scope.webAudioModules.getModuleScope(id);
      const BaseProcessor = moduleScope.WamProcessor;
      const ParameterInfo = moduleScope.WamParameterInfo;
      class Processor extends BaseProcessor {
        #held = [];
        #count = [];
        _generateWamParameterInfo() {
          if (isMinimal) return {};
          return {
            bitDepth: new ParameterInfo("bitDepth", { label: "Bit depth", defaultValue: 8, minValue: 1, maxValue: 16, discreteStep: 1 }),
            reduction: new ParameterInfo("reduction", { label: "Reduction", defaultValue: 1, minValue: 1, maxValue: 64, discreteStep: 1 }),
            mix: new ParameterInfo("mix", { label: "Mix", defaultValue: 0, minValue: 0, maxValue: 1 })
          };
        }
        _process(start, end, inputs, outputs) {
          const input = inputs[0] || [], output = outputs[0] || [], state = this._parameterState || {};
          for (let channel = 0; channel < output.length; channel++) {
            const source = input[channel] || input[0], target = output[channel];
            if (!source) {
              target.fill(0, start, end);
              continue;
            }
            if (isMinimal) {
              target.set(source.subarray(start, end), start);
              continue;
            }
            const held = this.#held[channel] ?? 0, count = this.#count[channel] ?? 0;
            let last = held, remaining = count;
            for (let frame = start; frame < end; frame++) {
              const depth = Math.round(state.bitDepth && state.bitDepth.value || 8);
              const reduction = Math.round(state.reduction && state.reduction.value || 1);
              const mix = (state.mix && state.mix.value) ?? 0;
              if (remaining <= 0) {
                const levels = 2 ** clampValue(depth, 1, 16), bounded = clampValue(source[frame], -1, 1);
                last = Math.round((bounded + 1) * (levels - 1) / 2) * 2 / (levels - 1) - 1;
                remaining = clampValue(reduction, 1, 64);
              }
              remaining--;
              const dry = Math.cos(clampValue(mix, 0, 1) * Math.PI / 2), wet = Math.sin(clampValue(mix, 0, 1) * Math.PI / 2);
              target[frame] = source[frame] * dry + last * wet;
            }
            this.#held[channel] = last;
            this.#count[channel] = remaining;
          }
        }
      }
      registerProcessor(id, Processor);
    }, moduleId, minimal);
  })();
  byModule.set(moduleId, pending);
  pending.catch(() => {
    if (byModule?.get(moduleId) === pending) byModule.delete(moduleId);
  });
  return pending;
};
var BitcrusherModule = class extends WebAudioModule_default {
  constructor(groupId, context, moduleIdOverride = MODULE_ID) {
    super(groupId, context);
    this.moduleIdOverride = moduleIdOverride;
    this._descriptor = { ...this._descriptor, identifier: moduleIdOverride, name: moduleIdOverride === PROOF_ID ? "Orbitronica WamProcessor Proof" : "Orbitronica Bitcrusher", vendor: "Orbitronica", version: "1.0.0" };
  }
  async createAudioNode() {
    await installProcessor(this.audioContext, this.moduleIdOverride, this.moduleIdOverride === PROOF_ID);
    const node = new BitcrusherNode(this, this.moduleIdOverride);
    await node._initialize();
    return node;
  }
};
var BitcrusherNode = class extends WamNode {
  #state = { schemaVersion: 1, params: { ...defaults } };
  constructor(module, moduleId) {
    super(module, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { moduleId } });
  }
  async apply(params) {
    await this.setParameterValues(Object.fromEntries(Object.entries(params).map(([id, value]) => [id, { id, value, normalized: false }])));
  }
  async getState() {
    return structuredClone(this.#state);
  }
  async setState(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || dangerous(value)) throw new Error("invalid-bitcrusher-state");
    const source = value;
    if (source.schemaVersion !== void 0 && source.schemaVersion !== 0 && source.schemaVersion !== 1) throw new Error("unsupported-bitcrusher-state");
    const incoming = source.params ?? source;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || dangerous(incoming)) throw new Error("invalid-bitcrusher-state");
    const record = incoming, previous = this.#state.params;
    const raw = { bitDepth: record.bitDepth ?? previous.bitDepth, reduction: record.reduction ?? previous.reduction, mix: record.mix ?? previous.mix };
    if (!Object.values(raw).every((entry) => typeof entry === "number" && Number.isFinite(entry))) throw new Error("invalid-bitcrusher-state");
    const next = { schemaVersion: 1, params: { bitDepth: Math.round(clamp(raw.bitDepth, 1, 16)), reduction: Math.round(clamp(raw.reduction, 1, 64)), mix: clamp(raw.mix, 0, 1) } };
    await this.apply(next.params);
    this.#state = next;
  }
};
async function proveMinimalWamProcessor(groupId, context) {
  const module = new BitcrusherModule(groupId, context, PROOF_ID);
  const node = await module.createAudioNode();
  node.destroy();
}
async function createBitcrusherInstance(groupId, context) {
  const module = new BitcrusherModule(groupId, context);
  const audioNode = await module.createAudioNode();
  return { audioNode, createGui: () => {
    const root = document.createElement("div");
    root.textContent = "Orbitronica Bitcrusher";
    return root;
  }, destroyGui: (gui) => gui.remove() };
}
var index_default = { createInstance: createBitcrusherInstance };
export {
  createBitcrusherInstance,
  index_default as default,
  proveMinimalWamProcessor
};
