-- 052_fix_whatsapp_channels_select_returning
--
-- CORREÇÃO: criar o PRIMEIRO canal de uma conta falhava com
-- "new row violates row-level security policy" (a rota exibia
-- "Não foi possível criar o canal").
--
-- Causa: a rota faz `INSERT ... RETURNING id` (supabase-js
-- `.insert().select()`). No Postgres, o RETURNING também é submetido à
-- policy de SELECT. A policy de SELECT (migration 048) era:
--
--     is_account_member(account_id) AND can_access_channel(id)
--
-- `can_access_channel` é STABLE e consulta a própria linha de
-- whatsapp_channels. Durante o INSERT ... RETURNING, o snapshot STABLE
-- é anterior à linha recém-inserida, então a função NÃO enxerga a linha
-- e retorna false → a policy de SELECT falha → o RETURNING é rejeitado.
-- (Canais criados ANTES da 048 não passavam por essa função, por isso o
-- problema só aparece ao criar o primeiro canal pós-048.)
--
-- Correção: içar o teste de admin para a própria policy. Para admin+
-- (quem cria canais) a condição vira verdadeira SEM depender de ler a
-- linha; agentes continuam caindo em can_access_channel (que, num SELECT
-- normal, já enxerga a linha). Semanticamente idêntico — admin vê todos
-- os canais da conta.
-- ============================================================

DROP POLICY IF EXISTS whatsapp_channels_select ON whatsapp_channels;
CREATE POLICY whatsapp_channels_select ON whatsapp_channels
  FOR SELECT USING (
    is_account_member(account_id)
    AND (
      is_account_member(account_id, 'admin')
      OR can_access_channel(id)
    )
  );
