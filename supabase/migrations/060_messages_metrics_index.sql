-- Índice para as métricas do painel ("Mensagens Enviadas Hoje").
--
-- O card mostrava 0 mesmo com centenas de mensagens no dia. A conta não
-- estava errada: a consulta simplesmente não terminava a tempo. Contar
-- `messages` por sender_type + created_at obrigava um seq scan em toda a
-- tabela e, para CADA linha varrida, a RLS de messages roda um EXISTS em
-- conversations + can_access_channel. Medido em produção: 2,6s (hoje) e
-- 4,3s (ontem) rodando sozinho — em paralelo com as outras cinco consultas
-- do painel isso estoura o statement_timeout de 8s da role `authenticated`.
-- O supabase-js não lança nesse caso: devolve `count: null`, que o painel
-- lê como 0. Daí os dois cards zerados e o "Sem alteração vs. ontem"
-- (0 - 0 = 0), que era o sintoma mais enganoso.
--
-- Com o índice a varredura passa a tocar só as mensagens do agente no
-- período, e a RLS roda em dezenas de linhas em vez de dezenas de milhares.
CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON public.messages (sender_type, created_at DESC);
