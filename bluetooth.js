/**
 * bluetooth.js
 * -----------------------------------------------------------------------
 * Wraps the Web Bluetooth API to talk to the ESP32 BLE transmitter.
 *
 * Expected ESP32 firmware contract (documented in README.md too):
 *   - Advertises a GATT service with UUID SERVICE_UUID.
 *   - Exposes a "TX" characteristic (write / write-without-response) that
 *     the browser writes each packet to.
 *   - Exposes an "ACK" characteristic (notify) that the ESP32 uses to
 *     acknowledge each packet it has received and forwarded to LoRa.
 *     ACK payload: [0x06, packetNumberLowByte, packetNumberHighByte]
 *     NACK payload: [0x15, packetNumberLowByte, packetNumberHighByte]
 *
 * If a device does not expose characteristics matching the known UUIDs,
 * this module falls back to auto-discovering the first writable
 * characteristic and the first notifying characteristic it can find, so
 * the app remains usable against slightly different firmware layouts.
 * -----------------------------------------------------------------------
 */

const BluetoothLink = (() => {

  // Custom 128-bit UUIDs for the Smart Notice Board GATT profile.
  const SERVICE_UUID          = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"; // Nordic UART-style base
  const TX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // write: browser -> ESP32
  const ACK_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // notify: ESP32 -> browser

  const ACK_TIMEOUT_MS = 4000;

  let device = null;
  let server = null;
  let txChar = null;
  let ackChar = null;
  let ackWaiters = new Map(); // packetNumber -> {resolve, reject}
  let onStatusChange = () => {};
  let onDisconnected = () => {};

  function isSupported() {
    return "bluetooth" in navigator;
  }

  function setHandlers({ statusChange, disconnected }) {
    if (statusChange) onStatusChange = statusChange;
    if (disconnected) onDisconnected = disconnected;
  }

  /** Prompt the user to pick a BLE device and connect to it. */
  async function connect() {
    if (!isSupported()) {
      throw new Error("Web Bluetooth is not supported in this browser. Try Chrome or Edge on desktop/Android.");
    }

    onStatusChange("connecting");
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });

    device.addEventListener("gattserverdisconnected", handleDisconnected);
    await gattConnect();

    Utils.saveLocal("lastDeviceId", device.id);
    Utils.saveLocal("lastDeviceName", device.name || "ESP32 Notice Board");

    return { id: device.id, name: device.name || "ESP32 Notice Board" };
  }

  /** Attempt a silent reconnect to a previously paired device, if the
   *  browser exposes the permissions-backed getDevices() API. Returns
   *  null if no such device is available (caller should fall back to
   *  a manual connect() triggered by a user gesture). */
  async function tryAutoReconnect() {
    if (!isSupported() || !navigator.bluetooth.getDevices) return null;
    const lastId = Utils.loadLocal("lastDeviceId", null);
    if (!lastId) return null;

    try {
      const known = await navigator.bluetooth.getDevices();
      const match = known.find((d) => d.id === lastId);
      if (!match) return null;

      device = match;
      device.addEventListener("gattserverdisconnected", handleDisconnected);
      onStatusChange("connecting");
      await gattConnect();
      return { id: device.id, name: device.name || "ESP32 Notice Board" };
    } catch (err) {
      // Silent failure is fine here — this is a best-effort convenience.
      return null;
    }
  }

  async function gattConnect() {
    server = await device.gatt.connect();
    await discoverCharacteristics();
    onStatusChange("connected");
  }

  /** Discover the TX/ACK characteristics, preferring known UUIDs but
   *  falling back to the first writable/notifiable characteristics found. */
  async function discoverCharacteristics() {
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch (err) {
      throw new Error("The connected device does not expose the expected Notice Board BLE service.");
    }

    const characteristics = await service.getCharacteristics();

    txChar = characteristics.find((c) => c.uuid === TX_CHARACTERISTIC_UUID)
      || characteristics.find((c) => c.properties.write || c.properties.writeWithoutResponse);

    ackChar = characteristics.find((c) => c.uuid === ACK_CHARACTERISTIC_UUID)
      || characteristics.find((c) => c.properties.notify || c.properties.indicate);

    if (!txChar) throw new Error("No writable characteristic found for sending packets.");

    if (ackChar) {
      await ackChar.startNotifications();
      ackChar.addEventListener("characteristicvaluechanged", handleAckNotification);
    }
  }

  function handleAckNotification(event) {
    const value = event.target.value; // DataView
    if (!value || value.byteLength < 3) return;
    const status = value.getUint8(0);          // 0x06 = ACK, 0x15 = NACK
    const packetNumber = value.getUint16(1, true);
    const waiter = ackWaiters.get(packetNumber);
    if (!waiter) return;
    ackWaiters.delete(packetNumber);
    if (status === 0x06) waiter.resolve(true);
    else waiter.reject(new Error(`Device NACKed packet ${packetNumber}`));
  }

  function handleDisconnected() {
    txChar = null;
    ackChar = null;
    server = null;
    onStatusChange("disconnected");
    onDisconnected();
  }

  async function disconnect() {
    if (device && device.gatt && device.gatt.connected) {
      device.gatt.disconnect();
    } else {
      handleDisconnected();
    }
  }

  /**
   * Write one packet and wait for its ACK (if an ACK characteristic is
   * available). If no ACK characteristic exists, resolves immediately
   * after the write completes (best-effort mode).
   */
  async function sendPacket(packetBytes, packetNumber) {
    if (!txChar) throw new Error("Not connected to a device.");

    const writePromise = txChar.properties.writeWithoutResponse
      ? txChar.writeValueWithoutResponse(packetBytes)
      : txChar.writeValue(packetBytes);

    await writePromise;

    if (!ackChar) return true; // best-effort mode, no ACK channel available

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ackWaiters.delete(packetNumber);
        reject(new Error(`Timed out waiting for ACK on packet ${packetNumber}`));
      }, ACK_TIMEOUT_MS);

      ackWaiters.set(packetNumber, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  function isConnected() {
    return !!(device && device.gatt && device.gatt.connected && txChar);
  }

  function getDeviceInfo() {
    return device ? { id: device.id, name: device.name || "ESP32 Notice Board" } : null;
  }

  return {
    SERVICE_UUID, TX_CHARACTERISTIC_UUID, ACK_CHARACTERISTIC_UUID,
    isSupported, setHandlers, connect, disconnect, tryAutoReconnect,
    sendPacket, isConnected, getDeviceInfo,
  };
})();
