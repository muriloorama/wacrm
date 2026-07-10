import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  resumePendingExecution,
  runAutomationsForTrigger,
} from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import type { AutomationTriggerType } from '@/types'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
// Aceita tanto o Vercel Cron (`Authorization: Bearer <CRON_SECRET>`)
// quanto um pinger externo (`x-cron-secret: <AUTOMATION_CRON_SECRET>`).
function cronAuthorized(request: Request): boolean {
  const secrets = [
    process.env.CRON_SECRET,
    process.env.AUTOMATION_CRON_SECRET,
  ].filter(Boolean) as string[]
  if (secrets.length === 0) return false
  const bearer = request.headers.get('authorization')
  const header = request.headers.get('x-cron-secret')
  return secrets.some(
    (s) => bearer === `Bearer ${s}` || header === s,
  )
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET && !process.env.AUTOMATION_CRON_SECRET) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  // ── 1) Retoma waits agendados (automation_pending_executions) ──────
  let processed = 0
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  // ── 2) Drena a fila de gatilhos (tag_added / conversation_assigned) ─
  // Enfileirada pelos triggers do banco (migration 054), já que essas
  // ações acontecem no cliente e não têm ponto de disparo no servidor.
  let triggers = 0
  const { data: events } = await admin
    .from('automation_trigger_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(200)

  for (const ev of events ?? []) {
    // Marca 'done' ANTES de rodar (claim). runAutomationsForTrigger nunca
    // lança, e não queremos reprocessar em loop se algo falhar.
    const { data: claim } = await admin
      .from('automation_trigger_queue')
      .update({ status: 'done' })
      .eq('id', ev.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await runAutomationsForTrigger({
      accountId: ev.account_id as string,
      triggerType: ev.trigger_type as AutomationTriggerType,
      contactId: (ev.contact_id as string | null) ?? null,
      context: {
        tag_id: (ev.tag_id as string | null) ?? undefined,
        agent_id: (ev.agent_id as string | null) ?? undefined,
      },
    })
    triggers++
  }

  return NextResponse.json({ processed, triggers })
}
