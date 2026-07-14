-- Atribuição automática do responsável ao entrar em "Em Atendimento".
--
-- Regra pedida: o PRIMEIRO agente que move um lead para "Em Atendimento" vira o
-- responsável; a partir daí a conversa é dele e some para os outros agentes
-- (owner/admin continuam vendo tudo — ver 058_deals_pool_visibility). Só atua
-- quando quem move é AGENTE (owner/admin não "pegam" o lead) e o deal ainda está
-- sem responsável.
--
-- Cobre todos os caminhos de movimentação (drag & drop, seletor no card,
-- avanço automático em advanceDealOnAgentReply) por ser um trigger de banco.

CREATE OR REPLACE FUNCTION public.assign_deal_on_em_atendimento()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_stage_name text;
  v_profile uuid;
BEGIN
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id AND NEW.assigned_to IS NULL THEN
    SELECT name INTO v_stage_name FROM public.pipeline_stages WHERE id = NEW.stage_id;
    IF v_stage_name = 'Em Atendimento'
       AND EXISTS (
         SELECT 1 FROM public.account_members m
         WHERE m.account_id = NEW.account_id
           AND m.user_id = auth.uid()
           AND m.role = 'agent'::account_role_enum
       )
    THEN
      SELECT id INTO v_profile FROM public.profiles WHERE user_id = auth.uid() LIMIT 1;
      IF v_profile IS NOT NULL THEN
        NEW.assigned_to := v_profile;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_assign_deal_on_em_atendimento ON public.deals;
CREATE TRIGGER trg_assign_deal_on_em_atendimento
  BEFORE UPDATE OF stage_id ON public.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_deal_on_em_atendimento();
