import type { SupabaseClient } from '@supabase/supabase-js'

// Nomes das etapas que definem o fluxo "chegou → aguardando → em atendimento".
// Baseado em nome (não em id) para funcionar em qualquer conta que use esse
// padrão de funil; contas sem essas etapas simplesmente não são afetadas.
export const WAITING_STAGE_NAME = 'Aguardando Atendimento'
export const IN_SERVICE_STAGE_NAME = 'Em Atendimento'

/**
 * Quando o atendente responde uma conversa, avança o(s) negócio(s) ABERTO(s)
 * do contato que estão em "Aguardando Atendimento" para "Em Atendimento",
 * dentro do MESMO funil. Idempotente: negócios já adiante são ignorados.
 *
 * Vive aqui, e não na rota de envio, porque o atendente responde por DOIS
 * caminhos: a caixa de entrada (/api/whatsapp/send) e o WhatsApp do próprio
 * celular (webhook uazapi, mensagem `fromMe`). Enquanto só o primeiro
 * chamava esta regra, quem atendia pelo aparelho deixava o card parado em
 * "Aguardando Atendimento" para sempre — 99 cards presos assim quando o
 * problema foi percebido, mesmo com dezenas de mensagens trocadas.
 *
 * Aceita tanto o cliente sob a RLS do agente quanto o service_role do
 * webhook: os dois podem atualizar negócios da conta.
 */
export async function advanceDealOnAgentReply(
  supabase: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<void> {
  const { data: conv } = await supabase
    .from('conversations')
    .select('contact_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  const contactId = conv?.contact_id as string | undefined
  if (!contactId) return

  const { data: deals } = await supabase
    .from('deals')
    .select('id, stage_id, pipeline_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
  if (!deals || deals.length === 0) return

  const pipelineIds = [...new Set(deals.map((d) => d.pipeline_id as string))]
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('id, name, pipeline_id')
    .in('pipeline_id', pipelineIds)
    .in('name', [WAITING_STAGE_NAME, IN_SERVICE_STAGE_NAME])
  if (!stages) return

  // Por funil: qual é a etapa "Aguardando" e qual é a "Em Atendimento".
  const waitingByPipeline = new Map<string, string>()
  const inServiceByPipeline = new Map<string, string>()
  for (const s of stages) {
    if (s.name === WAITING_STAGE_NAME)
      waitingByPipeline.set(s.pipeline_id as string, s.id as string)
    else if (s.name === IN_SERVICE_STAGE_NAME)
      inServiceByPipeline.set(s.pipeline_id as string, s.id as string)
  }

  for (const d of deals) {
    const pid = d.pipeline_id as string
    const target = inServiceByPipeline.get(pid)
    if (!target) continue
    if (d.stage_id !== waitingByPipeline.get(pid)) continue // só sai de Aguardando
    await supabase
      .from('deals')
      .update({ stage_id: target, updated_at: new Date().toISOString() })
      .eq('id', d.id)
      .eq('account_id', accountId)
  }
}
