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
// WhatsApp webhook), tag it "Novo Lead" (additive — never touches
// tags already on the contact), then ALWAYS create a fresh deal in
// the account's "Formulário" pipeline (auto-created on first lead)
// — deliberately its own board, separate from the WhatsApp-driven
// "Funil de Vendas", so form leads don't get mixed into that pipeline
// or its automations. Every submission gets a new card, even for a
// phone already on file — a repeat form fill is still a fresh
// opportunity to work.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateContact,
  addContactTags,
  resolveAuditUserId,
  getContactById,
  ContactError,
} from '@/lib/api/v1/contacts';
import {
  findOrCreatePipelineByName,
  getFirstStageId,
  createDeal,
  DealError,
} from '@/lib/api/v1/deals';
import {
  normalizePhone,
  withBrazilCountryCode,
} from '@/lib/whatsapp/phone-utils';

const LEAD_PIPELINE_NAME = 'Formulário';
const LEAD_TAG_NAME = 'Novo Lead';

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
    const name = pickString(body, NAME_KEYS);

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { id: contactId } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone,
        name,
        email: pickString(body, EMAIL_KEYS),
        company: pickString(body, COMPANY_KEYS),
        notes: buildNoteFromExtraFields(body),
      }
    );

    await addContactTags(ctx.supabase, ctx.accountId, auditUserId, contactId, [
      LEAD_TAG_NAME,
    ]);

    const pipelineId = await findOrCreatePipelineByName(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      LEAD_PIPELINE_NAME
    );
    const stageId = await getFirstStageId(ctx.supabase, pipelineId);

    const deal = await createDeal(ctx.supabase, ctx.accountId, auditUserId, {
      title: name ? `Lead: ${name}` : `Lead: ${phone}`,
      contactId,
      pipelineId,
      stageId,
    });

    const contact = await getContactById(ctx.supabase, ctx.accountId, contactId);

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
