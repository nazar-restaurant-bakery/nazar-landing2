const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const subjectMarker = new RegExp(`\\[NazarDecision:(${uuid}):(${uuid})\\]`, "i");
const CAPTURE_ADDRESS = "crm-decisions@nazarrestaurantandbakery.com";
const DECISION_ADDRESS = "ctnazarbakery@gmail.com";

export function parseDecisionReply({ recipient, envelopeFrom, headerFrom, subject, messageId, inReplyTo, body }) {
  if (recipient?.toLowerCase() !== CAPTURE_ADDRESS
      || envelopeFrom?.toLowerCase() !== DECISION_ADDRESS
      || headerFrom?.toLowerCase() !== DECISION_ADDRESS) return null;
  const marker = subjectMarker.exec(subject || "");
  if (!marker || !messageId || messageId.length > 255 || !inReplyTo) return null;
  const unquoted = (body || "").slice(0, 12000).replace(/\r\n?/g, "\n")
    .split(/^(?:On .+ wrote:|From:|>+|[- ]{2,}Original Message[- ]{2,})/im)[0];
  const answer = /^Decision:\s*([\s\S]*?)^Signed:\s*(Y[uü]cel(?:\s+Otay)?)\s*$/im.exec(unquoted);
  if (!answer) return null;
  const text = answer[1].trim();
  const signer = answer[2].trim();
  const signed = `${text}\n\nSigned: ${signer}`;
  if (!text || signed.length > 2000) return null;
  return {
    p_decision_id: marker[1].toLowerCase(), p_token: marker[2].toLowerCase(),
    p_sender: DECISION_ADDRESS, p_message_id: messageId.trim(), p_answer: signed,
  };
}
