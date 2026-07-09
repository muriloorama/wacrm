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
// Behavior: find-or-create the contact by phone (same dedupe as the
// WhatsApp webhook), then — ONLY when the contact is genuinely new —
// fire the `new_contact_created` automation trigger, exactly like
// `src/app/api/whatsapp/webhook/route.ts` does. This is what actually
// applies the account's tag/deal-creation automations (e.g. tag "Novo
// Lead" + deal in "Funil de Vendas" → "Aguardando Atendimento" on
// Vila Real) instead of hardcoding a separate pipeline here.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateContact,
  resolveAuditUserId,
  getContactById,
  ContactError,
} from '@/lib/api/v1/contacts';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import {
  normalizePhone,
  withBrazilCountryCode,
} from '@/lib/whatsapp/phone-utils';

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
    const phone = withBrazilCountryCode(normalizePhone(rawPhone));

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { id: contactId, created } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone,
        name: pickString(body, NAME_KEYS),
        email: pickString(body, EMAIL_KEYS),
        company: pickString(body, COMPANY_KEYS),
        notes: buildNoteFromExtraFields(body),
      }
    );

    if (created) {
      // Awaited (unlike the WhatsApp webhook's fire-and-forget): this
      // route has no external ack deadline forcing an early return, and
      // a detached promise risks the serverless function freezing before
      // it finishes (the exact bug `after()` works around in the Meta
      // webhook — see its comment). `runAutomationsForTrigger` never
      // throws (logs internally), so no try/catch needed here.
      await runAutomationsForTrigger({
        accountId: ctx.accountId,
        triggerType: 'new_contact_created',
        contactId,
      });
    }

    const contact = await getContactById(ctx.supabase, ctx.accountId, contactId);

    return ok({ contact, created }, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
