// ============================================================
// Ingestão de lead de formulário — caminho único.
//
// Dois pontos de entrada usam isto:
//   - POST /api/v1/leads              (formulário de site, auth por API key)
//   - POST /api/webhooks/meta/leadgen (Lead Ads do Meta, auth por assinatura)
//
// Regras, todas vindas da reunião de 09/07/2026:
//   - o lead cai no funil ÚNICO da conta ("Funil de Vendas"). A separação em
//     um kanban "Formulário" foi descartada. Consequência assumida: as
//     automações do funil principal passam a agir sobre leads de formulário —
//     era justamente o que a separação evitava.
//   - origem = 'formulario', gravada pelo sistema. Nunca sobrescreve uma
//     origem que já exista: o primeiro sinal vence, e um lead que já veio do
//     WhatsApp não vira "formulário" só porque preencheu um form depois.
//   - toda submissão gera um card novo, mesmo para telefone já cadastrado —
//     preencher de novo é uma nova oportunidade.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findOrCreateContact,
  addContactTags,
  resolveAuditUserId,
  getContactById,
} from '@/lib/api/v1/contacts';
import {
  findOrCreatePipelineByName,
  getFirstStageId,
  createDeal,
} from '@/lib/api/v1/deals';
import { normalizePhone, withBrazilCountryCode } from '@/lib/whatsapp/phone-utils';

export const LEAD_PIPELINE_NAME = 'Funil de Vendas';
export const LEAD_TAG_NAME = 'Novo Lead';
export const LEAD_ORIGEM = 'formulario';

// Coluna de entrada dos leads de formulário DENTRO do funil único. Não é o
// kanban separado de antes: é só a primeira coluna, para o lead não se
// misturar com quem chegou pelo WhatsApp antes de alguém olhar.
// Se a conta não tiver essa coluna, o lead cai na primeira etapa do funil.
export const LEAD_STAGE_NAME = 'Formulário';

/** Etapa `Formulário` do funil, ou a primeira etapa se ela não existir. */
async function resolveLeadStage(
  db: SupabaseClient,
  pipelineId: string,
): Promise<string> {
  const { data } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipelineId)
    .eq('name', LEAD_STAGE_NAME)
    .maybeSingle();

  if (data?.id) return data.id as string;
  return getFirstStageId(db, pipelineId);
}

export interface LeadInput {
  /** Aceita telefone local BR; normalizado para E.164 aqui. */
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Campos extras do formulário, já formatados como nota. */
  notes?: string | null;
}

export async function ingestLead(
  db: SupabaseClient,
  accountId: string,
  input: LeadInput,
) {
  const phone = withBrazilCountryCode(normalizePhone(input.phone));
  const auditUserId = await resolveAuditUserId(db, accountId);

  const { id: contactId } = await findOrCreateContact(
    db,
    accountId,
    auditUserId,
    {
      phone,
      name: input.name,
      email: input.email,
      company: input.company,
      notes: input.notes ?? null,
    },
  );

  // `is null` no WHERE: o primeiro sinal de origem vence.
  await db
    .from('contacts')
    .update({ origem: LEAD_ORIGEM })
    .eq('id', contactId)
    .eq('account_id', accountId)
    .is('origem', null);

  await addContactTags(db, accountId, auditUserId, contactId, [LEAD_TAG_NAME]);

  const pipelineId = await findOrCreatePipelineByName(
    db,
    accountId,
    auditUserId,
    LEAD_PIPELINE_NAME,
  );
  const stageId = await resolveLeadStage(db, pipelineId);

  const deal = await createDeal(db, accountId, auditUserId, {
    title: input.name ? `Lead: ${input.name}` : `Lead: ${phone}`,
    contactId,
    pipelineId,
    stageId,
  });

  const contact = await getContactById(db, accountId, contactId);
  return { contact, deal };
}
