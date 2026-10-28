# Smart Notice Board using LoRaWAN

A browser-based dashboard that turns any image on your computer into a
compressed frame for a remote LoRa-connected notice board. The web app
processes the image entirely client-side, splits it into packets, and
streams them over **Bluetooth Low Energy (BLE)** to an ESP32, which
forwards them over **LoRa** to a second ESP32 wired to a **Raspberry Pi
Zero** that reconstructs the image and drives an LCD.

```
[ Browser (this app) ]
        │  BLE (Web Bluetooth API)
        ▼
[ ESP32 #1 — BLE receiver / LoRa transmitter ]
        │  LoRa radio link
        ▼
[ ESP32 #2 — LoRa receiver ]
        │  UART
        ▼
[ Raspberry Pi Zero — reassembles image, drives LCD ]
```

## Project structure

```
SmartNoticeBoard/
├── index.html         Dashboard markup
├── style.css           Blue/white theme, dark mode, responsive layout
├── script.js            App orchestration (glue between the modules below)
├── bluetooth.js        Web Bluetooth: connect, discover, send, ACK/retry
├── imageProcessor.js   Canvas-based resize + compression
├── packetizer.js         Binary data → LoRa-ready packets with CRC16
├── settings.js           Settings drawer + localStorage persistence
├── utils.js               Formatting, CRC16, console log, toasts, storage
├── assets/                  Static assets (icons, etc.)
├── images/                 Sample/reference images
└── README.md
```

No build step or external dependencies are required — everything runs as
plain ES6 modules loaded via `<script>` tags. Open `index.html` in a
Chromium-based browser (Chrome or Edge, desktop or Android) that supports
the Web Bluetooth API.

## Using the dashboard

1. Open `index.html` (serve it over `https://` or `http://localhost` —
   Web Bluetooth requires a secure context).
2. Click **Connect ESP32** and pick your device from the browser's
   Bluetooth chooser.
3. Drag an image onto the drop zone, or click **Choose Image**
   (JPG, JPEG, PNG, BMP supported).
4. The app automatically resizes the image to the configured display
   resolution (default 320×240), compresses it, and shows the packet
   count.
5. Click **Send to Notice Board**. Progress, ETA, and a live packet grid
   update as each packet is sent and acknowledged.
6. "Transmission Completed Successfully" appears once every packet has
   been delivered.

All settings (resolution, quality, packet size, delay, retries, theme,
auto-reconnect) are available from the gear icon and persist in
`localStorage`.

## BLE protocol (browser ⇄ ESP32 #1)

The app expects the ESP32 to expose a GATT service with these UUIDs
(defined at the top of `bluetooth.js`):

| Role                | UUID                                   | Properties          |
|---------------------|------------------------------------------|----------------------|
| Service              | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | —                    |
| TX (browser→ESP32)  | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write / Write-without-response |
| ACK (ESP32→browser) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify               |

If a connected device doesn't expose these exact UUIDs, the app falls
back to the first writable characteristic it finds for TX and the first
notifying characteristic for ACK, so it can still work with slightly
different firmware.

### Packet format (little-endian)

**Metadata packet** (sent once, first):

| Bytes | Field | Notes |
|-------|-------|-------|
| 0–1   | Magic | `0xA5 0x5A` |
| 2     | Type  | `0x00` = metadata |
| 3–4   | Total data packets | uint16 |
| 5–6   | Image width | uint16 |
| 7–8   | Image height | uint16 |
| 9–12  | Total image bytes | uint32 |
| 13–14 | CRC16 | over bytes 0–12 |

**Data packet** (one per chunk, sent after the metadata packet):

| Bytes | Field | Notes |
|-------|-------|-------|
| 0–1   | Magic | `0xA5 0x5A` |
| 2     | Type  | `0x01` = data |
| 3–4   | Packet number | uint16, 1-based |
| 5–6   | Total data packets | uint16 |
| 7–8   | Payload length | uint16 |
| 9…    | Payload | JPEG chunk bytes |
| last-2..last | CRC16 | over everything before it |

CRC16 uses CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`) — trivial to
reimplement identically in Arduino/ESP-IDF C++.

### Acknowledgement

After validating a packet's CRC, the ESP32 should notify the ACK
characteristic with:

```
[0x06, packetNumberLowByte, packetNumberHighByte]   // ACK
[0x15, packetNumberLowByte, packetNumberHighByte]   // NACK (bad CRC)
```

The browser waits up to 4 seconds for the matching ACK before retrying
(configurable retry count, default 3) or failing the packet.

## ESP32 #1 firmware responsibilities (BLE receiver / LoRa transmitter)

1. Advertise the GATT service/characteristics above.
2. On each TX write: verify magic bytes + CRC16, buffer the packet.
3. Forward the packet payload over LoRa (e.g. SX127x/RFM95 module via
   SPI) to ESP32 #2, preserving packet number / total / type so the
   receiver can reassemble frames out of order if needed.
4. Send an ACK/NACK notification back to the browser once the packet
   has been handed to the LoRa radio.

## ESP32 #2 + Raspberry Pi Zero responsibilities (receiver)

1. ESP32 #2 receives LoRa packets and relays the raw bytes to the
   Raspberry Pi Zero over UART (e.g. 115200 baud), ideally with a
   simple framing byte (e.g. length-prefixed) since UART has no
   built-in message boundaries.
2. The Pi accumulates data packets by packet number until it has
   received the total announced by the metadata packet.
3. The Pi decodes the reassembled JPEG buffer (e.g. with Pillow in
   Python) and renders it to the LCD (SPI/I²C display driver of your
   choice — ST7789, ILI9341, etc. are common for 320×240 panels).
4. Missing/corrupt packets can be requested for re-send by relaying a
   NACK back up the chain, mirroring the BLE ACK/NACK scheme.

## Configurable settings

| Setting | Default | Description |
|---------|---------|--------------|
| Display width / height | 320 × 240 | Target LCD resolution; image is resized to fit, centered on a white background |
| Compression quality | 80% | JPEG quality used when re-encoding the resized image |
| Packet size | 200 bytes | Total bytes per BLE/LoRa packet, including header + CRC |
| Transmission delay | 30 ms | Pause between packets, in addition to ACK wait, to respect LoRa duty-cycle limits |
| Max retry count | 3 | Retries per packet before the transmission is aborted |

## Browser support

The Web Bluetooth API is supported in Chrome and Edge on desktop,
Android, and ChromeOS. It is **not** supported in Safari or Firefox as
of this writing — use a Chromium-based browser to test BLE connectivity.
Everything else (image processing, settings, UI) works in any modern
browser.

## Bonus features included

- Dark mode toggle (persisted).
- Live packet transmission log in the status console.
- Download the processed (resized/compressed) image.
- Settings saved to `localStorage`.
- Automatic reconnect to the last connected ESP32 where the browser's
  permissions API (`navigator.bluetooth.getDevices`) allows it.
- Responsive layout and motion, with `prefers-reduced-motion` respected.
