/**
 * script.js
 * -----------------------------------------------------------------------
 * Application entry point. Wires together the DOM, Settings, ImageProcessor,
 * Packetizer and BluetoothLink modules and drives the end-to-end workflow:
 *   connect -> choose image -> process -> packetize -> transmit -> complete
 * -----------------------------------------------------------------------
 */

(() => {
  "use strict";

  // ---- App state --------------------------------------------------------
  const state = {
    file: null,
    processed: null,     // result of ImageProcessor.process()
    packets: [],          // Uint8Array[] built by Packetizer
    totalDataPackets: 0,
    sending: false,
  };

  // ---- DOM references -----------------------------------------------
  const dom = {};

  function cacheDom() {
    const ids = [
      "connIndicator", "connLabel", "deviceName", "serviceStatus",
      "connectBtn", "disconnectBtn",
      "dropzone", "chooseImageBtn", "fileInput",
      "imageInfo", "imagePreview", "processedPreview",
      "infoName", "infoSize", "infoRes", "infoProcessedSize", "infoPackets",
      "downloadProcessedBtn",
      "sendBtn", "txSubStatus",
      "progressPacketLabel", "progressEta", "progressFill", "progressPercent",
      "packetStream", "txComplete",
      "console", "clearConsoleBtn",
      "toastStack",
    ];
    ids.forEach((id) => { dom[id] = document.getElementById(id); });
  }

  // ---- Initialisation -----------------------------------------------
  function init() {
    cacheDom();
    Utils.initConsole(dom.console);
    Utils.initToasts(dom.toastStack);
    Settings.load();
    Settings.bindUI();

    bindConnectionEvents();
    bindUploadEvents();
    bindTransmissionEvents();
    bindConsoleEvents();

    BluetoothLink.setHandlers({
      statusChange: updateConnectionUI,
      disconnected: () => {
        Utils.log("Device disconnected.", "warn");
        Utils.toast("Disconnected", "The BLE connection was closed.", "warn");
      },
    });

    if (!BluetoothLink.isSupported()) {
      Utils.log("Web Bluetooth is not supported in this browser.", "error");
      dom.connectBtn.disabled = true;
      dom.connectBtn.title = "Web Bluetooth unsupported in this browser";
    }

    Utils.log("Smart Notice Board dashboard ready.", "info");
    maybeAutoReconnect();
  }

  // ---- Connection panel -----------------------------------------------
  function bindConnectionEvents() {
    dom.connectBtn.addEventListener("click", async () => {
      try {
        const info = await BluetoothLink.connect();
        Utils.log(`Connected to ${info.name} (${info.id}).`, "success");
        Utils.toast("Connected", `Linked to ${info.name}.`, "success");
      } catch (err) {
        handleError(err, "Connection failed");
        updateConnectionUI("disconnected");
      }
    });

    dom.disconnectBtn.addEventListener("click", async () => {
      await BluetoothLink.disconnect();
      Utils.log("Manually disconnected.", "info");
    });
  }

  async function maybeAutoReconnect() {
    const settings = Settings.get();
    if (!settings.autoReconnect) return;
    updateConnectionUI("connecting");
    const info = await BluetoothLink.tryAutoReconnect();
    if (info) {
      Utils.log(`Auto-reconnected to ${info.name}.`, "success");
      Utils.toast("Reconnected", `Automatically linked to ${info.name}.`, "success");
    } else {
      updateConnectionUI("disconnected");
    }
  }

  function updateConnectionUI(stateName) {
    dom.connIndicator.dataset.state = stateName;
    const labels = { connected: "Connected", connecting: "Connecting…", disconnected: "Disconnected" };
    dom.connLabel.textContent = labels[stateName] || stateName;

    const info = BluetoothLink.getDeviceInfo();
    dom.deviceName.textContent = info ? info.name : "No device selected";
    dom.serviceStatus.textContent = stateName === "connected" ? "Notice Board GATT service ready" : "—";

    dom.connectBtn.disabled = stateName === "connected" || stateName === "connecting";
    dom.disconnectBtn.disabled = stateName !== "connected";
    updateSendAvailability();
  }

  // ---- Upload panel -----------------------------------------------
  function bindUploadEvents() {
    dom.chooseImageBtn.addEventListener("click", () => dom.fileInput.click());
    dom.dropzone.addEventListener("click", (e) => {
      if (e.target === dom.chooseImageBtn) return;
      dom.fileInput.click();
    });
    dom.dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dom.fileInput.click(); }
    });

    dom.fileInput.addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });

    ["dragenter", "dragover"].forEach((evt) => {
      dom.dropzone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dom.dropzone.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      dom.dropzone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dom.dropzone.classList.remove("dragover");
      });
    });
    dom.dropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    dom.downloadProcessedBtn.addEventListener("click", () => {
      if (!state.processed) return;
      const name = state.processed.originalName.replace(/\.[^.]+$/, "") + "_processed.jpg";
      Utils.downloadBlob(state.processed.processedBlob, name);
      Utils.log(`Downloaded processed image as "${name}".`, "info");
    });

    document.addEventListener("settings:changed", () => {
      // If an image is already loaded, reprocess it with the new settings.
      if (state.file) handleFile(state.file, true);
    });
  }

  async function handleFile(file, isReprocess = false) {
    if (!ImageProcessor.isSupported(file)) {
      Utils.toast("Unsupported file", "Please choose a JPG, JPEG, PNG, or BMP image.", "error");
      Utils.log(`Rejected unsupported file: ${file.name}`, "error");
      return;
    }

    state.file = file;
    resetTransmissionUI();
    Utils.log(`${isReprocess ? "Reprocessing" : "Loading"} "${file.name}" (${Utils.formatBytes(file.size)})…`, "info");

    try {
      const settings = Settings.get();
      const result = await ImageProcessor.process(file, {
        displayWidth: settings.displayWidth,
        displayHeight: settings.displayHeight,
        quality: settings.quality,
      });
      state.processed = result;

      const { packets, totalDataPackets } = Packetizer.buildPackets(
        result.processedBytes, settings.packetSize, settings.displayWidth, settings.displayHeight
      );
      state.packets = packets;
      state.totalDataPackets = totalDataPackets;

      renderImageInfo(result, totalDataPackets);
      buildPacketStreamGrid(totalDataPackets);
      updateSendAvailability();

      Utils.log(
        `Processed to ${settings.displayWidth}x${settings.displayHeight}, ` +
        `${Utils.formatBytes(result.processedBytes.length)}, split into ${totalDataPackets} packets.`,
        "success"
      );
      Utils.toast("Image ready", `${totalDataPackets} packets generated.`, "success");
    } catch (err) {
      handleError(err, "Image processing failed");
    }
  }

  function renderImageInfo(result, totalDataPackets) {
    dom.imageInfo.hidden = false;
    dom.imagePreview.src = result.previewUrl;
    dom.imagePreview.hidden = false;
    dom.processedPreview.hidden = true;

    dom.infoName.textContent = result.originalName;
    dom.infoSize.textContent = Utils.formatBytes(result.originalSize);
    dom.infoRes.textContent = `${result.originalWidth}×${result.originalHeight} → ${result.targetWidth}×${result.targetHeight}`;
    dom.infoProcessedSize.textContent = Utils.formatBytes(result.processedBytes.length);
    dom.infoPackets.textContent = `${totalDataPackets} data packets + 1 metadata packet`;

    dom.downloadProcessedBtn.disabled = false;
  }

  // ---- Packet-stream visual (signature element) -----------------------
  function buildPacketStreamGrid(count) {
    dom.packetStream.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const cell = document.createElement("div");
      cell.className = "packet-cell";
      cell.dataset.index = String(i);
      frag.appendChild(cell);
    }
    dom.packetStream.appendChild(frag);
  }

  function setPacketCellState(index, cls) {
    const cell = dom.packetStream.children[index];
    if (!cell) return;
    cell.classList.remove("sent", "acked", "active", "failed");
    if (cls) cell.classList.add(cls);
  }

  // ---- Transmission panel -----------------------------------------------
  function bindTransmissionEvents() {
    dom.sendBtn.addEventListener("click", startTransmission);
  }

  function updateSendAvailability() {
    dom.sendBtn.disabled = state.sending || !state.processed || !BluetoothLink.isConnected();
  }

  function resetTransmissionUI() {
    dom.progressFill.style.width = "0%";
    dom.progressPercent.textContent = "0%";
    dom.progressPacketLabel.textContent = "Packet 0 / 0";
    dom.progressEta.textContent = "ETA —";
    dom.txComplete.hidden = true;
    dom.txSubStatus.textContent = "Idle";
    dom.packetStream.innerHTML = "";
  }

  async function startTransmission() {
    if (!state.processed || !BluetoothLink.isConnected() || state.sending) return;

    const settings = Settings.get();
    const packets = state.packets; // index 0 = metadata packet, 1..N = data
    const total = packets.length;

    state.sending = true;
    updateSendAvailability();
    dom.txComplete.hidden = true;
    dom.txSubStatus.textContent = "Transmitting…";
    Utils.log(`Starting transmission of ${total} packets (metadata + ${state.totalDataPackets} data).`, "info");

    const startTime = performance.now();
    let sentCount = 0;

    try {
      for (let i = 0; i < total; i++) {
        const packet = packets[i];
        const gridIndex = i === 0 ? null : i - 1; // metadata packet has no grid cell
        if (gridIndex !== null) setPacketCellState(gridIndex, "active");

        await sendWithRetry(packet, i, settings.maxRetries, settings.txDelay);

        if (gridIndex !== null) setPacketCellState(gridIndex, "acked");
        sentCount++;

        const elapsed = performance.now() - startTime;
        const avgPerPacket = elapsed / sentCount;
        const remaining = (total - sentCount) * avgPerPacket;

        dom.progressPacketLabel.textContent = `Packet ${sentCount} / ${total}`;
        dom.progressEta.textContent = `ETA ${Utils.formatDuration(remaining)}`;
        const pct = Math.round((sentCount / total) * 100);
        dom.progressFill.style.width = pct + "%";
        dom.progressPercent.textContent = pct + "%";

        if (settings.txDelay > 0) await Utils.sleep(settings.txDelay);
      }

      dom.txComplete.hidden = false;
      dom.txSubStatus.textContent = "Complete";
      Utils.log("Transmission Completed Successfully.", "success");
      Utils.toast("Transmission complete", `${total} packets delivered and acknowledged.`, "success");
    } catch (err) {
      dom.txSubStatus.textContent = "Failed";
      handleError(err, "Transmission failed");
    } finally {
      state.sending = false;
      updateSendAvailability();
    }
  }

  async function sendWithRetry(packet, packetIndex, maxRetries, txDelay) {
    let attempt = 0;
    // The packet number used for ACK matching lives in bytes [3-4] for both
    // metadata and data packets, low-byte first.
    const packetNumber = packet[3] | (packet[4] << 8);

    while (true) {
      try {
        await BluetoothLink.sendPacket(packet, packetNumber);
        return;
      } catch (err) {
        attempt++;
        const gridIndex = packetIndex === 0 ? null : packetIndex - 1;
        if (attempt > maxRetries) {
          if (gridIndex !== null) setPacketCellState(gridIndex, "failed");
          throw new Error(`Packet ${packetIndex} failed after ${maxRetries} retries: ${err.message}`);
        }
        Utils.log(`Retry ${attempt}/${maxRetries} for packet ${packetIndex}: ${err.message}`, "warn");
        if (txDelay > 0) await Utils.sleep(txDelay);
      }
    }
  }

  // ---- Console panel -----------------------------------------------
  function bindConsoleEvents() {
    dom.clearConsoleBtn.addEventListener("click", () => Utils.clearConsole());
  }

  // ---- Shared error handling -----------------------------------------------
  function handleError(err, title) {
    console.error(err);
    Utils.log(`${title}: ${err.message || err}`, "error");
    Utils.toast(title, err.message || String(err), "error");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
