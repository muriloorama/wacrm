-- 037_active_account_rls_scoping
--
-- CORREÇÃO CRÍTICA de isolamento entre contas (multi-tenant).
--
-- Após o multi-membership (033), `is_account_member(account_id)` retornava
-- true para QUALQUER conta de que o usuário é membro. Como várias queries do
-- app (ex.: lista de conversas/contatos) não filtram por account_id e
-- dependiam só da RLS para escopar, um usuário membro de N contas passava a
-- enxergar os dados de TODAS as suas contas MISTURADOS — inclusive ao trocar
-- de conta ativa. (Sintoma: "mudo de conta e as informações/usuários vão
-- junto".)
--
-- Correção: `is_account_member` passa a escopar pela CONTA ATIVA
-- (profiles.account_id). Assim, toda tabela de tenant (que usa essa função na
-- RLS) mostra apenas os dados da conta que o usuário está vendo agora. Trocar
-- de conta (switch_account muda profiles.account_id) troca o que a RLS revela.
--
-- Exceções que precisam de "qualquer conta de que sou membro" (senão o SELETOR
-- de conta não consegue listar as outras contas): `accounts` e a leitura das
-- próprias linhas de `account_members`. Elas ganham predicados próprios.

-- ============================================================
-- Helper: usuário é membro da conta (QUALQUER conta, sem escopo de ativa).
-- Usado só onde o seletor precisa enxergar todas as contas do usuário.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_member_of(target_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM account_members
    WHERE user_id = auth.uid() AND account_id = target_account_id
  );
$$;
ALTER FUNCTION public.is_member_of(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_member_of(UUID) TO authenticated, service_role;

-- ============================================================
-- is_account_member — AGORA escopado pela conta ATIVA. True só se o alvo for
-- a conta ativa do usuário E ele for membro dela com papel >= min_role.
-- Toda a RLS de tenant herda esse escopo (a função é o ponto único).
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_members m
    WHERE m.user_id = auth.uid()
      AND m.account_id = target_account_id
      -- Escopo da conta ATIVA: o alvo tem que ser a conta que o usuário
      -- está vendo agora (profiles.account_id).
      AND m.account_id = (
        SELECT p.account_id FROM profiles p WHERE p.user_id = auth.uid()
      )
      AND CASE m.role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;
ALTER FUNCTION public.is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_account_member(UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- accounts.select — qualquer conta de que o usuário é membro (para o seletor
-- listar os NOMES das contas, mesmo as não-ativas).
-- ============================================================
DROP POLICY IF EXISTS accounts_select ON accounts;
CREATE POLICY accounts_select ON accounts
  FOR SELECT USING (is_member_of(id));

-- ============================================================
-- account_members.select — as PRÓPRIAS memberships (seletor lista todas as
-- contas do usuário) OU co-membros da conta ATIVA (roster de membros).
-- ============================================================
DROP POLICY IF EXISTS account_members_select ON account_members;
CREATE POLICY account_members_select ON account_members
  FOR SELECT USING (
    user_id = auth.uid() OR is_account_member(account_id, 'viewer')
  );
