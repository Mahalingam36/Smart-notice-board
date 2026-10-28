/**
 * packetizer.js
 * -----------------------------------------------------------------------
 * Splits the processed image's binary data into fixed-size packets that
 * the ESP32 -> LoRa -> ESP32 -> Raspberry Pi chain can reassemble.
 *
 * Wire format (all multi-byte integers little-endian):
 *
 *   Metadata packet (sent first, packet index 0):
 *     [0]    0xA5              magic byte 1
 *     [1]    0x5A              magic byte 2
 *     [2]    0x00              type = METADATA
 *     [3-4]  uint16            total DATA packets that will follow
 *     [5-6]  uint16            image width  (px)
 *     [7-8]  uint16            image height (px)
 *     [9-12] uint32            total image byte length
 *     [13-14] uint16           CRC16 of bytes [0-12]
 *
 *   Data packet (packet index 1..N):
 *     [0]    0xA5              magic byte 1
 *     [1]    0x5A              magic byte 2
 *     [2]    0x01              type = DATA
 *     [3-4]  uint16            packet number (1-based)
 *     [5-6]  uint16            total packets (data packets only)
 *     [7-8]  uint16            payload length in bytes
 *     [9..]  bytes             payload (image chunk)
 *     [last-2..last] uint16    CRC16 over everything before it
 *
 * This header is intentionally compact (9 bytes for data packets) to
 * leave as much of the configured packet size as possible for payload,
 * which matters for LoRa's limited airtime budget.
 * -----------------------------------------------------------------------
 */

const Packetizer = (() => {

  const MAGIC_1 = 0xa5;
  const MAGIC_2 = 0x5a;
  const TYPE_METADATA = 0x00;
  const TYPE_DATA = 0x01;
  const DATA_HEADER_LEN = 9;   // bytes before payload in a data packet
  const CRC_LEN = 2;

  function writeUint16LE(arr, offset, value) {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >> 8) & 0xff;
  }
  function writeUint32LE(arr, offset, value) {
    arr[offset] = value & 0xff;
    arr[offset + 1] = (value >> 8) & 0xff;
    arr[offset + 2] = (value >> 16) & 0xff;
    arr[offset + 3] = (value >> 24) & 0xff;
  }

  /**
   * Build the full packet list for a processed image.
   * @param {Uint8Array} bytes   the processed (resized+compressed) image bytes
   * @param {number} packetSize  max total bytes per packet (header+payload+crc)
   * @param {number} width       target display width, for the metadata packet
   * @param {number} height      target display height, for the metadata packet
   * @returns {{packets: Uint8Array[], totalDataPackets: number, totalBytes: number}}
   */
  function buildPackets(bytes, packetSize, width, height) {
    const maxPayload = Math.max(1, packetSize - DATA_HEADER_LEN - CRC_LEN);
    const totalDataPackets = Math.ceil(bytes.length / maxPayload) || 1;

    const packets = [];

    // --- Metadata packet (packet 0) ---
    const meta = new Uint8Array(15);
    meta[0] = MAGIC_1;
    meta[1] = MAGIC_2;
    meta[2] = TYPE_METADATA;
    writeUint16LE(meta, 3, totalDataPackets);
    writeUint16LE(meta, 5, width);
    writeUint16LE(meta, 7, height);
    writeUint32LE(meta, 9, bytes.length);
    const metaCrc = Utils.crc16(meta.subarray(0, 13));
    writeUint16LE(meta, 13, metaCrc);
    packets.push(meta);

    // --- Data packets (packet 1..N) ---
    for (let i = 0; i < totalDataPackets; i++) {
      const start = i * maxPayload;
      const end = Math.min(start + maxPayload, bytes.length);
      const payload = bytes.subarray(start, end);

      const packet = new Uint8Array(DATA_HEADER_LEN + payload.length + CRC_LEN);
      packet[0] = MAGIC_1;
      packet[1] = MAGIC_2;
      packet[2] = TYPE_DATA;
      writeUint16LE(packet, 3, i + 1);
      writeUint16LE(packet, 5, totalDataPackets);
      writeUint16LE(packet, 7, payload.length);
      packet.set(payload, DATA_HEADER_LEN);

      const crc = Utils.crc16(packet.subarray(0, DATA_HEADER_LEN + payload.length));
      writeUint16LE(packet, DATA_HEADER_LEN + payload.length, crc);

      packets.push(packet);
    }

    return { packets, totalDataPackets, totalBytes: bytes.length };
  }

  return { buildPackets, MAGIC_1, MAGIC_2, TYPE_METADATA, TYPE_DATA };
})();
