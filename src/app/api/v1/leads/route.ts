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
// Body:
//   { phone: string (required, E.164 or local),
//     name?: string, email?: string, company?: string }
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

    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      return fail('bad_request', "'phone' is required", 400);
    }

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { id: contactId, created } = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone,
        name: typeof body.name === 'string' ? body.name : undefined,
        email: typeof body.email === 'string' ? body.email : undefined,
        company: typeof body.company === 'string' ? body.company : undefined,
      }
    );

    if (created) {
      // Fire-and-forget, same as the WhatsApp webhook — never throws.
      runAutomationsForTrigger({
        accountId: ctx.accountId,
        triggerType: 'new_contact_created',
        contactId,
      }).catch((err) =>
        console.error('[api/v1/leads] automation dispatch failed:', err)
      );
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
