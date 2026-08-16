const axios = require('axios');
const config = require('./config');

/**
 * Sends a text message back to a WhatsApp user via the configured gateway.
 * Supports: Evolution API (default), Wasender, Meta WhatsApp Cloud API.
 *
 * @param {string} toNumber - recipient number, digits only, with country code (no +)
 * @param {string} text - message body
 */
async function sendText(toNumber, text) {
  const type = config.gateway.type;

  try {
    if (type === 'evolution') {
      return await sendViaEvolution(toNumber, text);
    }
    if (type === 'wasender') {
      return await sendViaWasender(toNumber, text);
    }
    if (type === 'meta') {
      return await sendViaMeta(toNumber, text);
    }
    throw new Error(`Unknown WHATSAPP_GATEWAY_TYPE: "${type}"`);
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error(`❌ Failed to send WhatsApp message via ${type} to ${toNumber}: ${detail}`);
    throw err;
  }
}

async function sendViaEvolution(toNumber, text) {
  // Evolution API: POST {baseUrl}/message/sendText/{instanceName}
  const url = `${trimTrailingSlash(config.gateway.baseUrl)}/message/sendText/${config.gateway.evolutionInstanceName}`;
  const { data } = await axios.post(
    url,
    {
      number: toNumber,
      text,
    },
    {
      headers: {
        apikey: config.gateway.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  return data;
}

async function sendViaWasender(toNumber, text) {
  // Wasender API: POST {baseUrl}/send-message
  const url = `${trimTrailingSlash(config.gateway.baseUrl)}/send-message`;
  const { data } = await axios.post(
    url,
    {
      to: toNumber,
      text,
    },
    {
      headers: {
        Authorization: `Bearer ${config.gateway.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  return data;
}

async function sendViaMeta(toNumber, text) {
  // Meta WhatsApp Cloud API: POST {baseUrl}/messages
  // baseUrl expected to be like https://graph.facebook.com/v20.0/<PHONE_NUMBER_ID>
  const url = `${trimTrailingSlash(config.gateway.baseUrl)}/messages`;
  const { data } = await axios.post(
    url,
    {
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'text',
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${config.gateway.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  return data;
}

function trimTrailingSlash(url) {
  return url && url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Notifies all configured manager numbers with the same text.
 * Used for e.g. Daily_Closing summaries or error alerts.
 */
async function notifyManagers(text) {
  const results = [];
  for (const num of config.access.managerNumbers) {
    try {
      results.push(await sendText(num, text));
    } catch (err) {
      // Already logged in sendText; continue notifying remaining managers.
    }
  }
  return results;
}

module.exports = {
  sendText,
  notifyManagers,
};
