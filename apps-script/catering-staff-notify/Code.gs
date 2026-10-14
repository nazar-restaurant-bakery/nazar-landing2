/* Nazar catering staff alerts. Deploy as the ctnazarbakery@gmail.com account. */
const RECIPIENT = 'ctnazarbakery@gmail.com';
const CRM_URL = 'https://www.nazarrestaurantandbakery.com/staff';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function result_(ok, error) {
  return ContentService.createTextOutput(JSON.stringify(ok ? { ok: true } : { ok: false, error }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let input;
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > 2048) {
      return result_(false, 'invalid_request');
    }
    input = JSON.parse(e.postData.contents);
  } catch (_) {
    return result_(false, 'invalid_request');
  }
  const properties = PropertiesService.getScriptProperties();
  const expected = properties.getProperty('WEBHOOK_SECRET');
  if (!expected || !input || input.key !== expected) return result_(false, 'forbidden');
  if (typeof input.requestId !== 'string' || !ID_RE.test(input.requestId) ||
      typeof input.requestDate !== 'string' || Number.isNaN(Date.parse(input.requestDate)) ||
      typeof input.eventDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate) ||
      !Number.isInteger(input.guests) || input.guests < 1 || input.guests > 10000) {
    return result_(false, 'invalid_request');
  }

  // A repeated POST must not create a second email. The form request ID is
  // private state only and is deliberately omitted from the email itself.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return result_(false, 'busy');
  try {
    const sentKey = 'sent_' + input.requestId;
    if (properties.getProperty(sentKey)) return result_(true);
    if (MailApp.getRemainingDailyQuota() < 1) return result_(false, 'quota');
    const requestDate = Utilities.formatDate(new Date(input.requestDate),
      'America/New_York', 'yyyy-MM-dd HH:mm z');
    const body = [
      'Request date: ' + requestDate,
      'Event date: ' + input.eventDate,
      'Guest count: ' + input.guests,
      'CRM: ' + CRM_URL,
    ].join('\n');
    MailApp.sendEmail(RECIPIENT, 'New Nazar catering request', body);
    properties.setProperty(sentKey, new Date().toISOString());
    return result_(true);
  } catch (_) {
    return result_(false, 'delivery_failed');
  } finally {
    lock.releaseLock();
  }
}
