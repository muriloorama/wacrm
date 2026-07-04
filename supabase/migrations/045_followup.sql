-- ============================================================
-- 045 — Follow-up automático (mirror do CRM antigo)
--
-- Rotina (cron /api/cron/followups), só em horário comercial:
--  FASE A: negócio em "Orçamento Enviado" cuja ÚLTIMA mensagem foi nossa
--          (agent) e passou followup_hours sem o cliente responder → envia
--          a mensagem de follow-up, marca followup_count=1 e move para
--          "Follow-up Automático".
--  FASE B: negócio em "Follow-up Automático" há followup_hours → se o
--          cliente respondeu (última msg = customer) vai para "Respondeu
--          Follow-up"; senão vai para "Follow-up Manual".
-- ============================================================

-- Config por conta.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS followup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS followup_message text,
  ADD COLUMN IF NOT EXISTS followup_hours integer NOT NULL DEFAULT 24;

COMMENT ON COLUMN accounts.followup_enabled IS 'Liga o follow-up automático desta conta.';
COMMENT ON COLUMN accounts.followup_message IS 'Texto enviado no follow-up (NULL = usa padrão do código).';
COMMENT ON COLUMN accounts.followup_hours IS 'Horas sem resposta antes de enviar/escalar (default 24).';

-- Estado por negócio.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS followup_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_followup_at timestamptz,
  ADD COLUMN IF NOT EXISTS followup_opt_out boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN deals.followup_count IS 'Quantos follow-ups automáticos já foram enviados (máx 1).';
COMMENT ON COLUMN deals.last_followup_at IS 'Quando o último follow-up foi enviado (arma a escalada da fase B).';
COMMENT ON COLUMN deals.followup_opt_out IS 'Se true, este negócio nunca recebe follow-up automático.';
