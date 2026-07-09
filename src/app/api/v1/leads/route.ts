// ============================================================
// POST /api/v1/leads — receive a lead from an external form webhook
// (scope: deals:write)
//
// Designed to be pointed at directly by a form tool's webhook config.
// The API key is minted per-account (Settings → API Keys), so
// "só recebe leads da Vila Real" is enforced simply by using a key
// created under the Vila Real account — every write below is scoped
// to `ctx.accountId`, the same discipline every other v1 route
// follows.
//
// Accepts both English and the Portuguese field names the actual
// lead-gen form sends (`nome`/`whatsapp` etc.), and a local BR phone
// (no country code, e.g. "(65) 9 5662-0000") — normalized to E.164
// before dedupe. Any other fields in the body (urgência, investimento,
// ...) are folded into the new contact's note so nothing is dropped
// even as the form's questions change.
//
// Behavior: see `ingestLead` in src/lib/api/v1/leads.ts — shared with
// the Meta Lead Ads webhook. Since 09/07/2026 the lead lands in the
// account's single "Funil de Vendas" (the separate "Formulário" board
// was dropped by decision) and gets origem='formulario'.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { ingestLead } from '@/lib/api/v1/leads';
import { ContactError } from '@/lib/api/v1/contacts';
import { DealError } from '@/lib/api/v1/deals';

/** First present string field among the given keys, trimmed. */
function pickString(
  body: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

const PHONE_KEYS = ['phone', 'whatsapp', 'telefone', 'celular'];
const NAME_KEYS = ['name', 'nome'];
const EMAIL_KEYS = ['email', 'e-mail'];
const COMPANY_KEYS = ['company', 'empresa'];
const KNOWN_KEYS = new Set([
  ...PHONE_KEYS,
  ...NAME_KEYS,
  ...EMAIL_KEYS,
  ...COMPANY_KEYS,
]);

/** Fold any body fields not already mapped to a contact column into a note. */
function buildNoteFromExtraFields(body: Record<string, unknown>): string | null {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (typeof value !== 'string' || !value.trim()) continue;
    lines.push(`${key}: ${value.trim()}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const rawPhone = pickString(body, PHONE_KEYS);
    if (!rawPhone) {
      return fail(
        'bad_request',
        "One of 'phone', 'whatsapp', 'telefone' or 'celular' is required",
        400
      );
    }

    const { contact, deal } = await ingestLead(ctx.supabase, ctx.accountId, {
      phone: rawPhone,
      name: pickString(body, NAME_KEYS),
      email: pickString(body, EMAIL_KEYS),
      company: pickString(body, COMPANY_KEYS),
      notes: buildNoteFromExtraFields(body),
    });

    return ok({ contact, deal }, 201);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    if (err instanceof DealError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
