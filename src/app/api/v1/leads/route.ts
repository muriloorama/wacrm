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
//     name?: string, email?: string, company?: string,
//     pipeline?: string (default "Formulário"),
//     value?: number, notes?: string }
//
// Behavior: find-or-create the contact by phone, find-or-create the
// named pipeline (with default stages) if it doesn't exist yet, then
// always create a NEW deal in that pipeline's first stage — leads are
// never deduped as deals, only the contact is.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateContact,
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

const DEFAULT_PIPELINE_NAME = 'Formulário';

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

    const pipelineName =
      typeof body.pipeline === 'string' && body.pipeline.trim()
        ? body.pipeline.trim()
        : DEFAULT_PIPELINE_NAME;

    const value =
      typeof body.value === 'number' && Number.isFinite(body.value)
        ? body.value
        : undefined;

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { id: contactId } = await findOrCreateContact(
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

    const pipelineId = await findOrCreatePipelineByName(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      pipelineName
    );
    const stageId = await getFirstStageId(ctx.supabase, pipelineId);

    const title =
      typeof body.name === 'string' && body.name.trim()
        ? `Lead: ${body.name.trim()}`
        : `Lead: ${phone}`;

    const deal = await createDeal(ctx.supabase, ctx.accountId, auditUserId, {
      title,
      contactId,
      pipelineId,
      stageId,
      value,
      notes: typeof body.notes === 'string' ? body.notes : null,
    });

    const contact = await getContactById(ctx.supabase, ctx.accountId, contactId);

    return ok({ deal, contact }, 201);
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
