// A separate, collect-only scheduler credential. Never a staff session or a
// service-role key disguised as a user. Platform JWT verification stays enabled.
export function validScheduleSecret(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
export function scheduleSecretMatches(provided: string | null, expected: string | undefined) {
  if (!validScheduleSecret(provided) || !validScheduleSecret(expected)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}
