/**
 * SMS Service for TruckSphere
 * Uses HostPinnacle Bulk SMS API to send OTP messages.
 *
 * API: https://smsportal.hostpinnacle.co.ke/SMSApi/send
 *
 * Configuration is loaded from environment variables (see .env):
 *   SMS_BASE_URL, SMS_USERID, SMS_PASSWORD, SMS_SENDERID,
 *   SMS_MSG_TYPE, SMS_DUPLICATE_CHECK, SMS_OUTPUT
 */
const axios = require('axios');

const SMS_CONFIG = {
  baseUrl: process.env.SMS_BASE_URL,
  userid: process.env.SMS_USERID,
  password: process.env.SMS_PASSWORD,
  senderid: process.env.SMS_SENDERID,
  msgType: process.env.SMS_MSG_TYPE,
  duplicatecheck: process.env.SMS_DUPLICATE_CHECK,
  output: process.env.SMS_OUTPUT,
};

/**
 * Send an SMS message to a Kenyan phone number.
 * @param {string} mobile - Phone number in format 2547XXXXXXXX (without leading +)
 * @param {string} message - The message content
 * @returns {Promise<{ success: boolean; data?: any; error?: string }>}
 */
async function sendSMS(mobile, message) {
  if (!mobile || !message) {
    console.warn('[SMS] Missing mobile or message');
    return { success: false, error: 'Missing mobile or message' };
  }

  const params = {
    userid: SMS_CONFIG.userid,
    password: SMS_CONFIG.password,
    sendMethod: 'quick',
    mobile: normaliseMobile(mobile),
    msg: message,
    senderid: SMS_CONFIG.senderid,
    msgType: SMS_CONFIG.msgType,
    duplicatecheck: SMS_CONFIG.duplicatecheck,
    output: SMS_CONFIG.output,
  };

  try {
    console.log(`[SMS] Sending to ${params.mobile}: "${message.substring(0, 50)}..."`);
    const response = await axios.get(SMS_CONFIG.baseUrl, { params, timeout: 15000 });
    console.log('[SMS] Response:', response.data);
    return { success: true, data: response.data };
  } catch (error) {
    const errMsg = error?.response?.data || error?.message || 'Unknown error';
    console.error('[SMS] Send failed:', errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Normalise a Kenyan mobile number to 2547XXXXXXXX format.
 * Accepts: 07XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX, 7XXXXXXXX
 */
function normaliseMobile(raw) {
  let num = String(raw).replace(/[^0-9]/g, '');
  if (num.startsWith('0') && num.length === 10) {
    num = '254' + num.substring(1);
  } else if (num.startsWith('254') && num.length === 14) {
    // +254 → strip + already handled by regex
    num = num;
  } else if (num.length === 9 && num.startsWith('7')) {
    num = '254' + num;
  }
  return num;
}

/**
 * Generate a 6-digit OTP.
 */
function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

module.exports = { sendSMS, generateOTP, normaliseMobile };