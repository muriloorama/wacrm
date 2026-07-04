-- 033_multi_account_membership
--
-- FASE 1 (fundação) da mudança de "1 conta por usuário" para
-- "N contas por usuário". Esta migration é DELIBERADAMENTE
-- não-disruptiva: depois dela, cada usuário existente tem exatamente
-- UMA linha em `account_members` (espelhando seu `profiles.account_id`
-- atual), então `is_account_member` devolve o mesmo resultado de antes
-- e NENHUM comportamento da app muda. As fases seguintes (convites
-- aditivos, trigger de signup, troca de conta, super admin) vêm em
-- migrations/PRs próprios.
--
-- Desacoplamento central:
--   • `account_members` = fonte de verdade de "quem pertence a qual conta".
--   • `profiles.account_id` = deixa de ser "a conta" e vira "conta ATIVA"
--     (a que o usuário está vendo agora); passa a ser NULLABLE porque um
--     login pode existir sem nenhum workspace (0 contas) até ser atrelado.

-- ============================================================
-- 1) Tabela de membros (N:N) — fonte de verdade da associação.
-- ============================================================
CREATE TABLE IF NOT EXISTS account_members (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       account_role_enum NOT NULL DEFAULT 'agent',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

-- "Em quais contas o usuário X está?" — lookup do account switcher.
CREATE INDEX IF NOT EXISTS idx_account_members_user
  ON account_members(user_id);

-- ============================================================
-- 2) Backfill a partir do modelo antigo (profiles.account_id +
--    account_role). Idempotente: rodar de novo não duplica.
-- ============================================================
INSERT INTO account_members (account_id, user_id, role)
SELECT account_id, user_id, account_role
FROM profiles
WHERE account_id IS NOT NULL
ON CONFLICT (account_id, user_id) DO NOTHING;

-- ============================================================
-- 3) `profiles.account_id`/`account_role` viram "conta ativa" e
--    passam a aceitar NULL (usuário sem workspace). Continuam sendo
--    o cache da conta atual lido pelo hook de auth e por
--    getCurrentAccount — apenas a fonte de verdade de MEMBRO mudou.
-- ============================================================
ALTER TABLE profiles ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE profiles ALTER COLUMN account_role DROP NOT NULL;

-- ============================================================
-- 4) is_account_member passa a consultar a junção. Como TODA a RLS de
--    tenant chama esta função (SECURITY DEFINER), a mudança propaga
--    para todas as políticas sem reescrever política por política.
--    Continua SECURITY DEFINER (lê account_members sem RLS recursiva).
-- ============================================================
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM account_members m
    WHERE m.user_id = auth.uid()
      AND m.account_id = target_account_id
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

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION is_account_member(UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- 5) Derruba o índice que travava "1 conta por dono" — o próprio
--    comentário da migration 017 já previa esta remoção ao relaxar
--    para many-to-many.
-- ============================================================
DROP INDEX IF EXISTS idx_accounts_one_per_owner;

-- ============================================================
-- 6) RLS da própria account_members. is_account_member é SECURITY
--    DEFINER e lê account_members SEM RLS, então referenciá-la aqui
--    NÃO causa recursão. Escritas do dia a dia passam pelas RPCs
--    SECURITY DEFINER e pelo super admin (service-role), que ignoram
--    RLS; estas políticas são a rede de segurança para acesso direto.
-- ============================================================
ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;

-- Membros de uma conta enxergam a lista de membros dela.
CREATE POLICY account_members_select ON account_members
  FOR SELECT USING (is_account_member(account_id, 'viewer'));

-- Admin+ da conta gerencia membros (adicionar/trocar papel/remover).
CREATE POLICY account_members_insert ON account_members
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

CREATE POLICY account_members_update ON account_members
  FOR UPDATE USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

CREATE POLICY account_members_delete ON account_members
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 7) handle_new_user: além de criar a conta pessoal + profile (como
--    antes), passa a inserir a linha correspondente em account_members.
--    Sem isso, um signup ocorrido entre esta fase e a Fase 2 criaria um
--    profile sem membership e o usuário ficaria trancado fora da própria
--    conta (is_account_member agora lê account_members, não profiles).
--    A criação da conta pessoal ainda acontece aqui — é a Fase 2 (signup
--    fechado) que remove esse bootstrap.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  INSERT INTO public.account_members (account_id, user_id, role)
  VALUES (v_account_id, NEW.id, 'owner')
  ON CONFLICT (account_id, user_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
