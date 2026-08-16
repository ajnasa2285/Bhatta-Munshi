/**
 * Normalizes incoming webhook payloads from Evolution API, Wasender, and
 * Meta WhatsApp Cloud API into a single common shape:
 *
 * {
 *   gatewayType: 'evolution' | 'wasender' | 'meta',
 *   from: '919876543210',           // sender number, digits only
 *   messageType: 'text' | 'audio' | 'image' | 'unsupported',
 *   text: string | null,            // for text messages
 *   media: {                        // for audio/image messages
 *     url: string | null,
 *     mediaId: string | null,
 *     base64: string | null,
 *     mimeType: string | null,
 *     gatewayType: string,
 *   } | null,
 *   raw: object,                    // original payload, for debugging
 * } | null   // null if the payload should be ignored (e.g. status updates, own messages)
 */

const config = require('../config');

function digitsOnly(str) {
  return (str || '').replace(/\D/g, '');
}

function normalizeEvolution(body) {
  // Evolution API webhook shape: { event, instance, data: { key, message, messageType, ... } }
  const data = body?.data;
  if (!data) return null;

  // Ignore messages sent by our own bot (fromMe = true)
  if (data.key?.fromMe) return null;

  const from = digitsOnly(data.key?.remoteJid?.split('@')[0]);
  if (!from) return null;

  const msg = data.message || {};

  if (msg.conversation || msg.extendedTextMessage?.text) {
    return {
      gatewayType: 'evolution',
      from,
      messageType: 'text',
      text: msg.conversation || msg.extendedTextMessage.text,
      media: null,
      raw: body,
    };
  }

  if (msg.audioMessage) {
    return {
      gatewayType: 'evolution',
      from,
      messageType: 'audio',
      text: null,
      media: {
        url: msg.audioMessage.url || null,
        mediaId: null,
        base64: data.message.base64 || null,
        mimeType: msg.audioMessage.mimetype || 'audio/ogg',
        gatewayType: 'evolution',
      },
      raw: body,
    };
  }

  if (msg.imageMessage) {
    return {
      gatewayType: 'evolution',
      from,
      messageType: 'image',
      text: msg.imageMessage.caption || null,
      media: {
        url: msg.imageMessage.url || null,
        mediaId: null,
        base64: data.message.base64 || null,
        mimeType: msg.imageMessage.mimetype || 'image/jpeg',
        gatewayType: 'evolution',
      },
      raw: body,
    };
  }

  return { gatewayType: 'evolution', from, messageType: 'unsupported', text: null, media: null, raw: body };
}

function normalizeWasender(body) {
  // Wasender webhook shape (approximate): { event, data: { from, type, text, media_url, mime_type } }
  const data = body?.data || body;
  if (!data) return null;
  if (data.fromMe || data.from_me) return null;

  const from = digitsOnly(data.from || data.sender);
  if (!from) return null;

  const type = (data.type || data.messageType || 'text').toLowerCase();

  if (type === 'text' || type === 'chat') {
    return {
      gatewayType: 'wasender',
      from,
      messageType: 'text',
      text: data.text || data.body || data.message,
      media: null,
      raw: body,
    };
  }

  if (type === 'audio' || type === 'ptt' || type === 'voice') {
    return {
      gatewayType: 'wasender',
      from,
      messageType: 'audio',
      text: null,
      media: {
        url: data.media_url || data.url || null,
        mediaId: null,
        base64: data.base64 || null,
        mimeType: data.mime_type || 'audio/ogg',
        gatewayType: 'wasender',
      },
      raw: body,
    };
  }

  if (type === 'image') {
    return {
      gatewayType: 'wasender',
      from,
      messageType: 'image',
      text: data.caption || null,
      media: {
        url: data.media_url || data.url || null,
        mediaId: null,
        base64: data.base64 || null,
        mimeType: data.mime_type || 'image/jpeg',
        gatewayType: 'wasender',
      },
      raw: body,
    };
  }

  return { gatewayType: 'wasender', from, messageType: 'unsupported', text: null, media: null, raw: body };
}

function normalizeMeta(body) {
  // Meta Cloud API webhook shape: { entry: [{ changes: [{ value: { messages: [...] } }] }] }
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  if (!message) return null; // could be a status update; ignore

  const from = digitsOnly(message.from);
  if (!from) return null;

  if (message.type === 'text') {
    return {
      gatewayType: 'meta',
      from,
      messageType: 'text',
      text: message.text?.body,
      media: null,
      raw: body,
    };
  }

  if (message.type === 'audio') {
    return {
      gatewayType: 'meta',
      from,
      messageType: 'audio',
      text: null,
      media: {
        url: null,
        mediaId: message.audio?.id || null,
        base64: null,
        mimeType: message.audio?.mime_type || 'audio/ogg',
        gatewayType: 'meta',
      },
      raw: body,
    };
  }

  if (message.type === 'image') {
    return {
      gatewayType: 'meta',
      from,
      messageType: 'image',
      text: message.image?.caption || null,
      media: {
        url: null,
        mediaId: message.image?.id || null,
        base64: null,
        mimeType: message.image?.mime_type || 'image/jpeg',
        gatewayType: 'meta',
      },
      raw: body,
    };
  }

  return { gatewayType: 'meta', from, messageType: 'unsupported', text: null, media: null, raw: body };
}

/**
 * Detects the gateway type from the payload shape and delegates to the
 * appropriate normalizer. If WHATSAPP_GATEWAY_TYPE is explicitly configured,
 * that normalizer is tried first.
 */
function normalizeWebhookPayload(body) {
  const preferred = config.gateway.type;

  const normalizers = {
    evolution: normalizeEvolution,
    wasender: normalizeWasender,
    meta: normalizeMeta,
  };

  // Try the configured gateway type first.
  if (normalizers[preferred]) {
    try {
      const result = normalizers[preferred](body);
      if (result) return result;
    } catch (err) {
      // fall through to auto-detection
    }
  }

  // Auto-detect based on payload shape as a fallback.
  if (body?.entry) return normalizeMeta(body);
  if (body?.data?.key) return normalizeEvolution(body);
  if (body?.data || body?.from) return normalizeWasender(body);

  return null;
}

module.exports = {
  normalizeWebhookPayload,
};
