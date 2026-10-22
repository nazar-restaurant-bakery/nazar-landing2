/** Printed P stock (GotPrint 30805504): fixed public attribution, never arbitrary UTM/PII. */
export function qrCardEventParams(utm: Record<string,string> | null): Record<string,string> {
 return utm?.utm_source === 'qr' && utm.utm_medium === 'offline' && utm.utm_campaign === 'qr_paket'
  ? {qr_source:'qr',qr_medium:'offline',qr_campaign:'qr_paket'} : {};
}
