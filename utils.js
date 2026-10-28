/**
 * utils.js
 * -----------------------------------------------------------------------
 * Small, dependency-free helper functions shared across the app:
 *   - byte / time formatting
 *   - CRC16 checksum calculation (used to validate packets on the ESP32)
 *   - status console logging
 *   - toast notifications
 *   - localStorage read/write helpers
 * Every helper is attached to the global `Utils` namespace so the other
 * modules (loaded as plain <script> tags, no bundler) can call into it.
 * -----------------------------------------------------------------------
 */

const Utils = (() => {

  /** Format a byte count as a human readable string, e.g. 182300 -> "178.0 KB" */
  function formatBytes(bytes, decimals = 1) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const value = bytes / Math.pow(k, i);
    return `${value.toFixed(i === 0 ? 0 : decimals)} ${sizes[i]}`;
  }

  /** Format milliseconds as a friendly "Xm Ys" / "Xs" ETA string */
  function formatDuration(ms) {
    if (!isFinite(ms) || ms < 0) return "—";
    const totalSeconds = Math.ceil(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    if (m <= 0) return `${s}s`;
    return `${m}m ${s}s`;
  }

  /** Zero-pad a number, e.g. pad(7, 3) -> "007" */
  function pad(num, size) {
    return String(num).padStart(size, "0");
  }

  /**
   * CRC-16/CCITT-FALSE checksum over a Uint8Array.
   * This is a lightweight, well-known algorithm that is cheap to
   * re-implement identically in ESP32 (Arduino) firmware for verification.
   * Polynomial: 0x1021, Initial value: 0xFFFF
   */
  function crc16(bytes) {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        crc &= 0xffff;
      }
    }
    return crc;
  }

  /** Current time as HH:MM:SS.mmm for console log lines */
  function timeStamp() {
    const d = new Date();
    return `${pad(d.getHours(),2)}:${pad(d.getMinutes(),2)}:${pad(d.getSeconds(),2)}`;
  }

  // ---- Status console -----------------------------------------------
  let consoleEl = null;
  function initConsole(el) { consoleEl = el; }

  /** Append a line to the status console. level: info|success|error|warn */
  function log(message, level = "info") {
    if (!consoleEl) return;
    const line = document.createElement("div");
    line.className = "log-line";
    line.innerHTML =
      `<span class="log-time">${timeStamp()}</span><span class="log-${level}">${escapeHtml(message)}</span>`;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function clearConsole() {
    if (consoleEl) consoleEl.innerHTML = "";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Toast notifications -------------------------------------------
  let toastStack = null;
  function initToasts(el) { toastStack = el; }

  /** Show a transient toast. type: info|success|error|warn */
  function toast(title, message = "", type = "info", duration = 4200) {
    if (!toastStack) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.innerHTML = `<strong>${escapeHtml(title)}</strong>${message ? escapeHtml(message) : ""}`;
    toastStack.appendChild(el);
    setTimeout(() => {
      el.classList.add("leaving");
      setTimeout(() => el.remove(), 220);
    }, duration);
  }

  // ---- localStorage helpers ------------------------------------------
  const STORAGE_PREFIX = "smartNoticeBoard.";

  function saveLocal(key, value) {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn("Utils.saveLocal failed:", err);
      return false;
    }
  }

  function loadLocal(key, fallback = null) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      console.warn("Utils.loadLocal failed:", err);
      return fallback;
    }
  }

  /** Trigger a browser download of a Blob with the given filename */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Simple sleep/delay promise, used to throttle packet transmission */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    formatBytes, formatDuration, pad, crc16, timeStamp,
    initConsole, log, clearConsole,
    initToasts, toast,
    saveLocal, loadLocal,
    downloadBlob, sleep,
  };
})();
