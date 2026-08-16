const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

/**
 * Downloads media (audio or image) referenced by a normalized message
 * into a temp file and returns its local path + mime type + base64 data.
 *
 * Supports:
 *  - Direct HTTP(S) URLs (Evolution API / Wasender typically expose a media URL)
 *  - Meta Cloud API media IDs (requires a lookup call to resolve the URL first)
 *  - Raw base64 payloads already embedded in the webhook (Evolution API sometimes does this)
 */

async function downloadFromUrl(url, headers = {}) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers,
    timeout: 30000,
  });
  const buffer = Buffer.from(response.data);
  const contentType =
    response.headers['content-type'] || 'application/octet-stream';
  return { buffer, mimeType: contentType };
}

async function resolveMetaMediaUrl(mediaId) {
  // Meta Cloud API requires resolving the media ID to a temporary CDN URL first.
  const graphBase = config.gateway.baseUrl.split('/').slice(0, 3).join('/'); // e.g. https://graph.facebook.com
  const lookupUrl = `${graphBase}/v20.0/${mediaId}`;
  const { data } = await axios.get(lookupUrl, {
    headers: { Authorization: `Bearer ${config.gateway.apiKey}` },
    timeout: 15000,
  });
  return data.url;
}

async function saveBufferToTemp(buffer, extensionHint) {
  const tmpDir = os.tmpdir();
  const filename = `munshi-${uuidv4()}${extensionHint ? '.' + extensionHint : ''}`;
  const filePath = path.join(tmpDir, filename);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

function extensionFromMime(mimeType = '') {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  return 'bin';
}

/**
 * @param {object} media - normalized media descriptor { url, mediaId, base64, mimeType, gatewayType }
 * @returns {Promise<{ filePath: string, mimeType: string, base64: string }>}
 */
async function downloadMedia(media) {
  if (!media) throw new Error('No media provided to downloadMedia');

  let buffer;
  let mimeType = media.mimeType || 'application/octet-stream';

  if (media.base64) {
    buffer = Buffer.from(media.base64, 'base64');
  } else if (media.gatewayType === 'meta' && media.mediaId) {
    const resolvedUrl = await resolveMetaMediaUrl(media.mediaId);
    const result = await downloadFromUrl(resolvedUrl, {
      Authorization: `Bearer ${config.gateway.apiKey}`,
    });
    buffer = result.buffer;
    mimeType = result.mimeType || mimeType;
  } else if (media.url) {
    const headers = {};
    if (media.gatewayType === 'evolution' || media.gatewayType === 'wasender') {
      headers['apikey'] = config.gateway.apiKey;
      headers['Authorization'] = `Bearer ${config.gateway.apiKey}`;
    }
    const result = await downloadFromUrl(media.url, headers);
    buffer = result.buffer;
    mimeType = result.mimeType || mimeType;
  } else {
    throw new Error('Media descriptor missing url, mediaId, and base64');
  }

  const ext = extensionFromMime(mimeType);
  const filePath = await saveBufferToTemp(buffer, ext);

  return {
    filePath,
    mimeType,
    base64: buffer.toString('base64'),
  };
}

async function cleanupTempFile(filePath) {
  try {
    if (filePath) await fs.promises.unlink(filePath);
  } catch (err) {
    // Non-fatal — temp dir gets cleaned by the OS eventually.
    console.warn(`Could not delete temp file ${filePath}: ${err.message}`);
  }
}

module.exports = {
  downloadMedia,
  cleanupTempFile,
};
