/**
 * settings.js
 * -----------------------------------------------------------------------
 * Owns the app's configurable options (display resolution, compression
 * quality, packet size, transmission delay, retry count, theme, and
 * auto-reconnect) plus the settings drawer UI that edits them.
 * Settings persist to localStorage via Utils.saveLocal/loadLocal so they
 * survive a page reload.
 * -----------------------------------------------------------------------
 */

const Settings = (() => {

  const DEFAULTS = {
    displayWidth: 320,
    displayHeight: 240,
    quality: 80,          // JPEG compression quality, 10-100
    packetSize: 200,       // bytes of payload per BLE/LoRa packet
    txDelay: 30,           // ms to wait between packets (in addition to ACK wait)
    maxRetries: 3,
    darkMode: false,
    autoReconnect: true,
    lastDeviceId: null,    // remembered for auto-reconnect
    lastDeviceName: null,
  };

  let current = { ...DEFAULTS };
  let els = {};

  function load() {
    const saved = Utils.loadLocal("settings", {});
    current = { ...DEFAULTS, ...saved };
    return current;
  }

  function save(partial) {
    current = { ...current, ...partial };
    Utils.saveLocal("settings", current);
    return current;
  }

  function get() { return current; }

  function reset() {
    const preserved = { lastDeviceId: current.lastDeviceId, lastDeviceName: current.lastDeviceName };
    current = { ...DEFAULTS, ...preserved };
    Utils.saveLocal("settings", current);
    return current;
  }

  /** Wire up the settings drawer form to the current values */
  function bindUI() {
    els = {
      drawer: document.getElementById("settingsDrawer"),
      overlay: document.getElementById("drawerOverlay"),
      openBtn: document.getElementById("settingsToggle"),
      closeBtn: document.getElementById("closeDrawerBtn"),
      form: document.getElementById("settingsForm"),
      width: document.getElementById("setWidth"),
      height: document.getElementById("setHeight"),
      quality: document.getElementById("setQuality"),
      qualityOut: document.getElementById("qualityOut"),
      packetSize: document.getElementById("setPacketSize"),
      delay: document.getElementById("setDelay"),
      retries: document.getElementById("setRetries"),
      darkMode: document.getElementById("setDarkMode"),
      autoReconnect: document.getElementById("setAutoReconnect"),
      resetBtn: document.getElementById("resetSettingsBtn"),
      themeToggle: document.getElementById("themeToggle"),
    };

    populateForm();
    applyTheme(current.darkMode);

    els.openBtn.addEventListener("click", openDrawer);
    els.closeBtn.addEventListener("click", closeDrawer);
    els.overlay.addEventListener("click", closeDrawer);

    els.quality.addEventListener("input", () => { els.qualityOut.textContent = els.quality.value; });

    els.themeToggle.addEventListener("click", () => {
      const next = !current.darkMode;
      applyTheme(next);
      save({ darkMode: next });
      els.darkMode.checked = next;
    });

    els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const updated = {
        displayWidth: clampInt(els.width.value, 16, 1024, DEFAULTS.displayWidth),
        displayHeight: clampInt(els.height.value, 16, 1024, DEFAULTS.displayHeight),
        quality: clampInt(els.quality.value, 10, 100, DEFAULTS.quality),
        packetSize: clampInt(els.packetSize.value, 20, 512, DEFAULTS.packetSize),
        txDelay: clampInt(els.delay.value, 0, 5000, DEFAULTS.txDelay),
        maxRetries: clampInt(els.retries.value, 0, 10, DEFAULTS.maxRetries),
        darkMode: els.darkMode.checked,
        autoReconnect: els.autoReconnect.checked,
      };
      save(updated);
      applyTheme(updated.darkMode);
      Utils.toast("Settings saved", "Your preferences have been updated.", "success");
      Utils.log("Settings updated: " + JSON.stringify(updated), "info");
      closeDrawer();
      document.dispatchEvent(new CustomEvent("settings:changed", { detail: current }));
    });

    els.resetBtn.addEventListener("click", () => {
      reset();
      populateForm();
      applyTheme(current.darkMode);
      Utils.toast("Settings reset", "Defaults restored.", "info");
      document.dispatchEvent(new CustomEvent("settings:changed", { detail: current }));
    });
  }

  function clampInt(val, min, max, fallback) {
    const n = parseInt(val, 10);
    if (isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function populateForm() {
    els.width.value = current.displayWidth;
    els.height.value = current.displayHeight;
    els.quality.value = current.quality;
    els.qualityOut.textContent = current.quality;
    els.packetSize.value = current.packetSize;
    els.delay.value = current.txDelay;
    els.retries.value = current.maxRetries;
    els.darkMode.checked = current.darkMode;
    els.autoReconnect.checked = current.autoReconnect;
  }

  function applyTheme(isDark) {
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  }

  function openDrawer() {
    els.drawer.classList.add("open");
    els.overlay.classList.add("open");
  }
  function closeDrawer() {
    els.drawer.classList.remove("open");
    els.overlay.classList.remove("open");
  }

  return { load, save, get, reset, bindUI, applyTheme };
})();
