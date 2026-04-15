// Staff ID to Email mapping for Eighteen Studio
// Format in source: "{staffId}-{name}-{role}" e.g., "527-bao.nguyen-HoS"
// Target email: "{name}.{staffId}@enotion.io" e.g., "bao.0527@enotion.io"

export const STAFF_EMAIL_MAP: Record<string, string> = {
  '527': 'bao.0527@enotion.io',
  '484': 'hieu.0484@enotion.io',
  '364': 'nam.0364@enotion.io',
  '961': 'tram.0961@enotion.io',
  '172': 'phan.0172@enotion.io',
  '561': 'ngoc.0561@enotion.io',
  '548': 'my.0548@enotion.io',
  '851': 'cuong.0851@enotion.io',
  '855': 'khoa.0855@enotion.io',
  '108': 'binh.0108@enotion.io',
  '871': 'dao.0871@enotion.io',
  '556': 'son.0556@enotion.io',
  '487': 'khang.0487@enotion.io',
  '640': 'phuc.0640@enotion.io',
  '789': 'huy.0789@enotion.io',
  '507': 'thu.0507@enotion.io',
  '611': 'ngan.0611@enotion.io',
  '645': 'thang.0645@enotion.io',
  '856': 'an.0856@enotion.io',
  '816': 'nhan.0816@enotion.io',
  '725': 'duong.0725@enotion.io',
  '937': 'don.0937@enotion.io',
  '630': 'nhu.0630@enotion.io',
  '904': 'dung.0904@enotion.io',
  '667': 'tram.0667@enotion.io',
  '358': 'cuong.0358@enotion.io',
  '642': 'hoang.0642@enotion.io',
  '647': 'bao.0647@enotion.io',
  '831': 'phuong.0831@enotion.io',
  '729': 'phu.0729@enotion.io',
  '728': 'an.0728@enotion.io',
};

/**
 * Extract staff ID from display name and return the mapped email.
 * Supported formats:
 *   "527-bao.nguyen-HoS"
 *   "527 - bao.nguyen - HoS"
 *   "527 bao.nguyen"
 *   "bao.nguyen (527)"
 *   Just a number like "527"
 */
export function getEmailFromDisplayName(displayName: string): string | null {
  if (!displayName) return null;
  
  // Try: starts with digits, optionally followed by separator
  // Matches: "527-...", "527 - ...", "527 ..."
  const startMatch = displayName.match(/^(\d+)\s*[-\s]/);
  if (startMatch) {
    const email = STAFF_EMAIL_MAP[startMatch[1]];
    if (email) return email;
  }
  
  // Try: digits in parentheses like "name (527)"
  const parenMatch = displayName.match(/\((\d+)\)/);
  if (parenMatch) {
    const email = STAFF_EMAIL_MAP[parenMatch[1]];
    if (email) return email;
  }
  
  // Try: exact number
  const exactMatch = displayName.match(/^(\d+)$/);
  if (exactMatch) {
    const email = STAFF_EMAIL_MAP[exactMatch[1]];
    if (email) return email;
  }

  // Try: find any staff ID number anywhere in the string
  const anyDigits = displayName.match(/\b(\d{3,4})\b/g);
  if (anyDigits) {
    for (const num of anyDigits) {
      const email = STAFF_EMAIL_MAP[num];
      if (email) return email;
    }
  }
  
  return null;
}
