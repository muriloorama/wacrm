-- ============================================================
-- 052 — Coluna "Formulário" no funil único.
--
-- A reunião de 09/07 descartou o kanban separado de formulário, mas o
-- lead ainda precisa de uma coluna de entrada própria: sem ela, ele cai
-- em "Aguardando Atendimento" misturado com quem chegou pelo WhatsApp.
--
-- Entra na POSIÇÃO 0, empurrando as demais. O lead nasce antes de
-- "Aguardando Atendimento", e um humano o move dali.
--
-- Consequência: a automação `Aguardando Atendimento → Em Atendimento`
-- (disparada quando o atendente responde) NÃO age sobre um card parado
-- em "Formulário". É o comportamento desejado — o lead de formulário
-- ainda não tem conversa.
--
-- Idempotente: não recria se já existir, e só desloca as posições quando
-- de fato insere.
-- ============================================================

DO $$
DECLARE
  p RECORD;
BEGIN
  -- Escopado à Vila Real, que é quem vai rodar a campanha de formulário.
  -- Nas outras contas o lead continua caindo na primeira etapa do funil
  -- (`resolveLeadStage` faz esse fallback). Para estender, basta remover
  -- o filtro por conta.
  FOR p IN
    SELECT pi.id
      FROM pipelines pi
      JOIN accounts a ON a.id = pi.account_id
     WHERE pi.name = 'Funil de Vendas'
       AND a.name = 'Vila Real'
  LOOP
    IF EXISTS (
      SELECT 1 FROM pipeline_stages
      WHERE pipeline_id = p.id AND name = 'Formulário'
    ) THEN
      CONTINUE;
    END IF;

    -- Abre espaço na posição 0.
    UPDATE pipeline_stages
       SET position = position + 1
     WHERE pipeline_id = p.id;

    INSERT INTO pipeline_stages (pipeline_id, name, position, color)
    VALUES (p.id, 'Formulário', 0, '#ec4899');
  END LOOP;
END $$;
