-- ============================================================
-- 047 — Renomeia a etapa final do follow-up:
--       "Follow-up Manual" → "Sem Resposta Follow-up AT"
--
-- A conta Vila Real já tinha renomeado a etapa pela UI, e o cron
-- (/api/cron/followups) casava a etapa por nome exato — então a fase B
-- nunca escalava lá. Esta migration alinha as contas restantes ao nome
-- novo; o cron passa a aceitar os dois nomes.
--
-- Só o `name` muda. `deals.stage_id` continua apontando para a mesma
-- linha, logo nenhum negócio troca de etapa.
--
-- Idempotente: re-rodar não faz nada. Não renomeia num funil que já
-- tenha o nome novo (evita colisão de duas etapas homônimas).
-- ============================================================

UPDATE pipeline_stages s
SET name = 'Sem Resposta Follow-up AT'
WHERE s.name = 'Follow-up Manual'
  AND NOT EXISTS (
    SELECT 1
    FROM pipeline_stages other
    WHERE other.pipeline_id = s.pipeline_id
      AND other.name = 'Sem Resposta Follow-up AT'
  );
