/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers tolerando diferença de código de país e de
 * trunk-prefix — SEM o antigo "últimos 8 dígitos", que fundia números
 * de DDDs diferentes no Brasil (ex.: (65) 99566-2000 e (11) 99566-2000
 * têm os mesmos 8 dígitos finais mas são pessoas diferentes).
 *
 * Casam quando:
 *   - as formas normalizadas são iguais; OU
 *   - uma é a outra só com o código de país à frente (o mais curto, de
 *     pelo menos 10 dígitos, é sufixo do mais longo e a diferença é o
 *     CC, ≤ 3 dígitos); OU
 *   - diferem apenas por um trunk-0 inserido/removido após o CC
 *     (via phoneVariants) — o caso internacional original.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (!n1 || !n2) return false
  if (n1 === n2) return true

  const [short, long] = n1.length <= n2.length ? [n1, n2] : [n2, n1]
  if (short.length >= 10 && long.endsWith(short) && long.length - short.length <= 3) {
    return true
  }

  const v2 = new Set(phoneVariants(n2))
  return phoneVariants(n1).some((v) => v2.has(v))
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Prepend Brazil's country code (55) to a local-format number that's
 * missing it — e.g. a lead-gen form sending "(65) 9 5662-0000" (DDD +
 * 8/9-digit number, 10-11 digits) instead of "+55 65 99566-20000".
 * Digits-only input required (run through `sanitizePhoneForMeta` /
 * `normalizePhone` first). Numbers that already look international
 * (12+ digits, or already start with "55" at a length consistent with
 * a BR number) are returned unchanged — this only fixes the common
 * "country code omitted" case, it doesn't try to detect every locale.
 */
export function withBrazilCountryCode(digitsOnly: string): string {
  if (!digitsOnly) return digitsOnly
  if (digitsOnly.length === 10 || digitsOnly.length === 11) {
    return `55${digitsOnly}`
  }
  return digitsOnly
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}
