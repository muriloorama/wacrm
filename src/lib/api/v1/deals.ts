// ============================================================
// Shared deal logic for the public API (v1) leads webhook.
//
// A lead webhook has no pipeline/stage to reference by id — the
// external form only knows the account's API key. This module
// resolves (or lazily creates) a named pipeline and its first stage,
// then creates a deal in it. Kept separate from `contacts.ts` since
// it's a distinct resource with its own dedupe-free (leads are always
// new deals) create path.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class DealError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DealError';
    this.status = status;
  }
}

const DEFAULT_STAGE_NAMES = ['Novo', 'Em contato', 'Qualificado', 'Fechado'];
const DEFAULT_STAGE_COLORS = ['#3b82f6', '#f59e0b', '#8b5cf6', '#22c55e'];

/**
 * Find a pipeline by exact name within `accountId`, creating it (with
 * a default stage set) if it doesn't exist yet. Races on first call
 * are resolved by re-querying after a unique-violation-shaped insert
 * failure — same backstop pattern as `findOrCreateContact`.
 */
export async function findOrCreatePipelineByName(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  name: string
): Promise<string> {
  const { data: existing, error: findErr } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .eq('name', name)
    .maybeSingle();
  if (findErr) {
    console.error('[api/v1/deals] pipeline lookup error:', findErr);
    throw new DealError('Failed to look up pipeline', 500);
  }
  if (existing) return existing.id as string;

  const { data: created, error: insertErr } = await db
    .from('pipelines')
    .insert({ account_id: accountId, user_id: auditUserId, name })
    .select('id')
    .single();

  if (insertErr || !created) {
    // Lost a race against a concurrent create (e.g. two leads landing
    // at once on a brand-new pipeline name).
    const { data: raced } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', name)
      .maybeSingle();
    if (raced) return raced.id as string;
    console.error('[api/v1/deals] pipeline create error:', insertErr);
    throw new DealError('Failed to create pipeline', 500);
  }

  const { error: stagesErr } = await db.from('pipeline_stages').insert(
    DEFAULT_STAGE_NAMES.map((stageName, i) => ({
      pipeline_id: created.id,
      name: stageName,
      position: i,
      color: DEFAULT_STAGE_COLORS[i],
    }))
  );
  if (stagesErr) {
    console.error('[api/v1/deals] default stages create error:', stagesErr);
    throw new DealError('Failed to create pipeline stages', 500);
  }

  return created.id as string;
}

/** The first stage (lowest `position`) of a pipeline — where new leads land. */
export async function getFirstStageId(
  db: SupabaseClient,
  pipelineId: string
): Promise<string> {
  const { data, error } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    console.error('[api/v1/deals] first stage lookup error:', error);
    throw new DealError('Pipeline has no stages', 500);
  }
  return data.id as string;
}

export interface DealInput {
  title: string;
  contactId: string;
  pipelineId: string;
  stageId: string;
  value?: number;
  notes?: string | null;
}

export interface ApiDeal {
  id: string;
  title: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string;
  value: number;
  currency: string;
  status: string;
  created_at: string;
}

/** Create a deal scoped to `accountId`. Always inserts — leads are never deduped as deals. */
export async function createDeal(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  input: DealInput
): Promise<ApiDeal> {
  const { data, error } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      pipeline_id: input.pipelineId,
      stage_id: input.stageId,
      contact_id: input.contactId,
      title: input.title,
      value: input.value ?? 0,
      notes: input.notes ?? null,
    })
    .select('id, title, pipeline_id, stage_id, contact_id, value, currency, status, created_at')
    .single();

  if (error || !data) {
    console.error('[api/v1/deals] create error:', error);
    throw new DealError('Failed to create deal', 500);
  }

  return data as ApiDeal;
}
