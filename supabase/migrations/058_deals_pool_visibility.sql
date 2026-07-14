-- Visibilidade do "pool" de leads de formulário para agentes.
--
-- Contexto: a policy 056_deals_channel_gate esconde de agent/viewer todo deal
-- sem caixa (channel_id IS NULL) — só owner/admin veem. Leads que chegam pelo
-- FORMULÁRIO ainda não têm WhatsApp, logo não têm conversa nem channel_id, e
-- caem no stage "Formulário". Resultado: o agente NÃO via o lead de formulário
-- que ainda não tem responsável, mesmo devendo poder pegá-lo.
--
-- Esta migration torna deals_select ADITIVO (ninguém perde acesso). O agente
-- passa a ver também:
--   (a) POOL: deals no stage "Formulário" ainda sem responsável (assigned_to NULL);
--   (b) OS SEUS: deals cujo assigned_to é um profile do próprio usuário.
-- Owner/admin continuam vendo tudo; a visibilidade por caixa (channel_members)
-- é mantida intacta.
--
-- Helpers SECURITY DEFINER (mesma abordagem de can_access_channel/is_account_member)
-- para evitar depender do RLS das tabelas consultadas dentro da policy.

CREATE OR REPLACE FUNCTION public.deal_stage_name(p_stage_id uuid)
RETURNS text
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT name FROM public.pipeline_stages WHERE id = p_stage_id
$$;

CREATE OR REPLACE FUNCTION public.current_profile_ids()
RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public
AS $$
  SELECT id FROM public.profiles WHERE user_id = auth.uid()
$$;

DROP POLICY IF EXISTS "deals_select" ON public.deals;
CREATE POLICY "deals_select" ON public.deals
  FOR SELECT USING (
    is_account_member(account_id) AND (
      is_account_member(account_id, 'admin'::account_role_enum)          -- owner/admin: tudo
      OR (channel_id IS NOT NULL AND can_access_channel(channel_id))      -- agente: caixas atribuídas (mantido)
      OR (assigned_to IS NULL AND public.deal_stage_name(stage_id) = 'Formulário')  -- pool de formulário
      OR (assigned_to IN (SELECT public.current_profile_ids()))           -- os deals do próprio agente
    )
  );
