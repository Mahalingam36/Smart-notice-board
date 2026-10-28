/**
 * imageProcessor.js
 * -----------------------------------------------------------------------
 * Handles everything between "user picked a file" and "we have a binary
 * buffer ready to packetize":
 *   1. Validate the file type/extension.
 *   2. Decode it into an <img>/ImageBitmap.
 *   3. Resize it to the configured display resolution using the Canvas
 *      API (aspect-ratio preserved, centred on a white canvas so the
 *      notice-board LCD always receives an exact WxH frame).
 *   4. Re-encode as JPEG at the configured quality to compress it.
 *   5. Return both a Blob (for preview/download) and a Uint8Array
 *      (for packetization).
 * -----------------------------------------------------------------------
 */

const ImageProcessor = (() => {

  const ACCEPTED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/bmp"];
  const ACCEPTED_EXT = [".jpg", ".jpeg", ".png", ".bmp"];

  /** Return true if the File looks like a supported image */
  function isSupported(file) {
    const name = (file.name || "").toLowerCase();
    const extOk = ACCEPTED_EXT.some((ext) => name.endsWith(ext));
    const typeOk = ACCEPTED_TYPES.includes((file.type || "").toLowerCase());
    // Some browsers report an empty type for .bmp — fall back to extension check.
    return extOk || typeOk;
  }

  /** Load a File into an HTMLImageElement, resolving with the element + natural size */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({ img, width: img.naturalWidth, height: img.naturalHeight, url });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not decode image file. It may be corrupted or in an unsupported encoding."));
      };
      img.src = url;
    });
  }

  /**
   * Resize + compress an already-loaded image element to the target
   * resolution using an off-screen canvas, preserving aspect ratio and
   * centering on a white background (letterbox/pillarbox as needed).
   *
   * @returns {Promise<{blob: Blob, canvas: HTMLCanvasElement}>}
   */
  function resizeAndCompress(img, targetW, targetH, quality) {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");

      // White background so any letterboxed edges are clean on the LCD.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, targetW, targetH);

      // Preserve aspect ratio ("contain" fit) and centre the result.
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;
      const scale = Math.min(targetW / srcW, targetH / srcH);
      const drawW = Math.round(srcW * scale);
      const drawH = Math.round(srcH * scale);
      const dx = Math.floor((targetW - drawW) / 2);
      const dy = Math.floor((targetH - drawH) / 2);

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, dx, dy, drawW, drawH);

      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error("Canvas failed to export the processed image.")); return; }
          resolve({ blob, canvas });
        },
        "image/jpeg",
        Math.min(1, Math.max(0.1, quality / 100))
      );
    });
  }

  /** Convert a Blob to a Uint8Array (the "binary data" fed to the packetizer) */
  async function blobToBytes(blob) {
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * Full pipeline: File -> { previewUrl, processedBlob, processedBytes, meta }
   */
  async function process(file, opts) {
    if (!isSupported(file)) {
      throw new Error(`Unsupported file type: ${file.name}. Please choose a JPG, JPEG, PNG, or BMP image.`);
    }

    const { img, width, height, url: previewUrl } = await loadImage(file);
    const { blob: processedBlob, canvas } = await resizeAndCompress(img, opts.displayWidth, opts.displayHeight, opts.quality);
    const processedBytes = await blobToBytes(processedBlob);

    return {
      originalName: file.name,
      originalSize: file.size,
      originalWidth: width,
      originalHeight: height,
      previewUrl,
      processedBlob,
      processedBytes,
      processedUrl: canvas.toDataURL("image/jpeg", Math.min(1, Math.max(0.1, opts.quality / 100))),
      targetWidth: opts.displayWidth,
      targetHeight: opts.displayHeight,
    };
  }

  return { isSupported, loadImage, resizeAndCompress, blobToBytes, process, ACCEPTED_EXT };
})();
