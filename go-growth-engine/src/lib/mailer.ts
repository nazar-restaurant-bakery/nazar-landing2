import { getConfig } from '../config.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

export interface SendEmailOptions {
  from: { name: string; address: string };
  replyTo?: string;
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  // Aynı anahtarla tekrar gelen istek Resend'de ikinci kez gönderilmez (24 saat)
  idempotencyKey?: string;
}

// "Ad" <adres>: ad her zaman tırnak içinde, tırnak ve ters bölü kaçışlı
function formatFrom({ name, address }: { name: string; address: string }): string {
  return `"${name.replace(/["\\]/g, '\\$&')}" <${address}>`;
}

export async function sendEmail(options: SendEmailOptions): Promise<{ id: string | null }> {
  const apiKey = getConfig('RESEND_API_KEY');
  if (!apiKey) {
    throw new Error('RESEND_API_KEY boş; e-posta gönderilemez.');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const response = await fetch(RESEND_EMAILS_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: formatFrom(options.from),
      to: [options.to],
      subject: options.subject,
      text: options.text,
      reply_to: options.replyTo,
      headers: options.headers
    })
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Resend hatası (${response.status}): ${responseText}`);
  }

  // Gönderim kabul edildi; id okunamazsa bile 'failed' sayılmaz (tekrar gönderimi önlemek için)
  let id: string | null = null;
  try {
    id = JSON.parse(responseText)?.id ?? null;
  } catch {
    id = null;
  }
  if (!id) {
    console.warn('⚠️ [Mailer] Resend yanıtında id yok:', responseText);
  }
  console.log(`📧 [Mailer] E-posta gönderildi: ${id}`);
  return { id };
}
