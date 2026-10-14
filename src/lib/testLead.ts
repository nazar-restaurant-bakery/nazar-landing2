// These explicit markers reserve internal submissions for testing, not marketing.
// Ordinary names containing "test" (for example, a surname) are not classified.
export function isTestLead({ name, email }: { name?: string | null; email?: string | null }): boolean {
  const domain = (email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return /^(?:example\.(?:com|net|org)|(?:.*\.)?invalid)$/.test(domain)
    || /^INTERNAL\s+TEST(?:\s|$)/i.test((name ?? "").trim());
}
