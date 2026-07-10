-- 054_automation_trigger_queue
--
-- Faz os gatilhos `tag_added` e `conversation_assigned` DISPARAREM.
--
-- Antes, `runAutomationsForTrigger` só era chamado pelos webhooks (que
-- despacham new_message_received/keyword_match/new_contact_created/
-- first_inbound_message). Etiquetar um contato ou atribuir uma conversa
-- acontece 100% no cliente (RLS, em vários componentes), sem nenhum
-- ponto no servidor para disparar — então automações com esses gatilhos
-- nunca rodavam.
--
-- Solução: triggers no banco enfileiram um evento; o cron de automações
-- (/api/automations/cron) drena a fila e chama runAutomationsForTrigger.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_trigger_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL,
  trigger_type TEXT NOT NULL,            -- 'tag_added' | 'conversation_assigned'
  contact_id   UUID,
  tag_id       UUID,
  agent_id     UUID,
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automation_trigger_queue_pending
  ON automation_trigger_queue (created_at)
  WHERE status = 'pending';

-- Só o service-role (cron) toca nesta fila. RLS ligada sem policies =
-- nega a clientes; o service-role ignora RLS.
ALTER TABLE automation_trigger_queue ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- Enfileirar em contact_tags INSERT → tag_added.
-- SECURITY DEFINER (dono = postgres) para inserir na fila apesar da RLS.
-- Guarda anti-loop: inserts feitos pelo próprio engine (service_role,
-- ex.: ação add_tag) NÃO re-disparam, evitando cascata infinita.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_tag_added()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
DECLARE
  v_account UUID;
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  SELECT account_id INTO v_account FROM contacts WHERE id = NEW.contact_id;
  IF v_account IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO automation_trigger_queue (account_id, trigger_type, contact_id, tag_id)
  VALUES (v_account, 'tag_added', NEW.contact_id, NEW.tag_id);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enqueue_tag_added() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_enqueue_tag_added ON contact_tags;
CREATE TRIGGER trg_enqueue_tag_added
  AFTER INSERT ON contact_tags
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_tag_added();

-- ------------------------------------------------------------
-- Enfileirar em conversations UPDATE (atribuição) → conversation_assigned.
-- WHEN limita a execução às mudanças reais de assigned_agent_id (a tabela
-- é atualizada com muita frequência — unread/last_message).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth
AS $$
BEGIN
  IF NEW.assigned_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO automation_trigger_queue (account_id, trigger_type, contact_id, agent_id)
  VALUES (NEW.account_id, 'conversation_assigned', NEW.contact_id, NEW.assigned_agent_id);
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enqueue_conversation_assigned() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_enqueue_conversation_assigned ON conversations;
CREATE TRIGGER trg_enqueue_conversation_assigned
  AFTER UPDATE ON conversations
  FOR EACH ROW
  WHEN (NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id)
  EXECUTE FUNCTION public.enqueue_conversation_assigned();
