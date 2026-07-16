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

// The form builder labels its questions for humans ("Nome Completo",
// "Whatsapp"), so the keys arrive capitalized and spaced. Match on a
// folded key — lowercased, with spaces/underscores/hyphens collapsed —
// and keep every KEYS entry below written in that same folded form.
function foldKey(key: string): string {
  return key.toLowerCase().trim().replace(/[\s_-]+/g, ' ');
}

/** First present string field among the given keys, trimmed. */
function pickString(
  fields: Map<string, string>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = fields.get(key);
    if (v) return v;
  }
  return undefined;
}

const PHONE_KEYS = ['phone', 'whatsapp', 'telefone', 'celular', 'tel', 'fone'];
const NAME_KEYS = ['name', 'nome', 'nome completo', 'full name', 'fullname'];
const EMAIL_KEYS = ['email', 'e mail'];
const COMPANY_KEYS = ['company', 'empresa'];
const KNOWN_KEYS = new Set([
  ...PHONE_KEYS,
  ...NAME_KEYS,
  ...EMAIL_KEYS,
  ...COMPANY_KEYS,
]);

/** Non-empty string fields of the body, indexed by folded key. */
function foldFields(body: Record<string, unknown>): Map<string, string> {
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const folded = foldKey(key);
    if (!fields.has(folded)) fields.set(folded, value.trim());
  }
  return fields;
}

/** Fold any body fields not already mapped to a contact column into a note. */
function buildNoteFromExtraFields(body: Record<string, unknown>): string | null {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (KNOWN_KEYS.has(foldKey(key))) continue;
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

    const fields = foldFields(body);

    const rawPhone = pickString(fields, PHONE_KEYS);
    if (!rawPhone) {
      return fail(
        'bad_request',
        "One of 'phone', 'whatsapp', 'telefone' or 'celular' is required",
        400
      );
    }

    const { contact, deal } = await ingestLead(ctx.supabase, ctx.accountId, {
      phone: rawPhone,
      name: pickString(fields, NAME_KEYS),
      email: pickString(fields, EMAIL_KEYS),
      company: pickString(fields, COMPANY_KEYS),
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
