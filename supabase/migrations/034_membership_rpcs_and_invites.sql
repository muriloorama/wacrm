-- 034_membership_rpcs_and_invites
--
-- FASE 2 (banco) do multi-account. Reescreve os RPCs de membro/convite
-- para operarem sobre `account_members` (fonte de verdade pós-033) em vez
-- de `profiles`, e torna os convites ADITIVOS (entrar numa conta não
-- destrói mais a conta atual do usuário). Também fecha o bootstrap de
-- conta pessoal no signup (entrada agora é só por convite/super admin).
--
-- Convenção mantida: `profiles.account_id` = conta ATIVA (a que o usuário
-- vê agora) e `profiles.account_role` = cache do papel NA conta ativa.
-- A associação real (todas as contas + papel em cada) vive em
-- account_members. Os RPCs abaixo mantêm o cache de profiles em sincronia
-- com a conta ativa quando relevante.
--
-- "Conta do caller" nos RPCs de gestão = sua conta ATIVA (profiles.account_id).
-- No mundo multi-conta isso é o correto: o admin gerencia os membros da
-- conta que está visualizando (o switcher troca a conta ativa).
--
-- Idempotente — CREATE OR REPLACE em tudo.

-- ============================================================
-- Helper: papel do usuário numa conta (lido de account_members).
-- Usado pelos RPCs para checar autoridade do caller sem depender do
-- cache de profiles.account_role.
-- ============================================================
CREATE OR REPLACE FUNCTION public.member_role(
  p_user_id UUID,
  p_account_id UUID
) RETURNS account_role_enum
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM account_members
  WHERE user_id = p_user_id AND account_id = p_account_id;
$$;
ALTER FUNCTION public.member_role(UUID, UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.member_role(UUID, UUID) TO authenticated, service_role;

-- ============================================================
-- redeem_invitation — AGORA ADITIVO.
-- Adiciona o caller como membro da conta do convite (sem destruir a
-- conta atual dele) e torna essa a conta ativa. Sem checagem de "tem
-- dados"/"já está em conta compartilhada" — multi-conta é permitido.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed' USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Adiciona (ou atualiza o papel de) o membro. Se já for membro, o
  -- convite apenas o leva de volta à conta (idempotente).
  INSERT INTO account_members (account_id, user_id, role)
  VALUES (v_inv.account_id, v_caller_id, v_inv.role)
  ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role;

  -- Torna a conta do convite a conta ativa + atualiza o cache de papel.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  RETURN v_inv.account_id;
END;
$$;
ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ============================================================
-- set_member_role — opera em account_members da conta ATIVA do caller.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no active account' USING ERRCODE = '42501';
  END IF;

  v_caller_role := member_role(auth.uid(), v_account_id);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  v_target_role := member_role(p_user_id, v_account_id);
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' OR p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to change owner' USING ERRCODE = '22023';
  END IF;

  UPDATE account_members
  SET role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_account_id;

  -- Sincroniza o cache de profiles SE esta for a conta ativa do alvo.
  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id AND account_id = v_account_id;
END;
$$;
ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;

-- ============================================================
-- remove_account_member — remove o alvo da conta ATIVA do caller.
-- Agora só deleta a linha de membership (não cria conta pessoal). Se a
-- conta removida era a ativa do alvo, reaponta para outra membership
-- que ele tenha, ou NULL (sem workspace) se não sobrar nenhuma.
-- ============================================================
-- Tipo de retorno mudou (UUID -> VOID): precisa dropar a versão antiga.
DROP FUNCTION IF EXISTS public.remove_account_member(UUID);
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no active account' USING ERRCODE = '42501';
  END IF;

  v_caller_role := member_role(auth.uid(), v_account_id);
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher' USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave instead' USING ERRCODE = '22023';
  END IF;

  v_target_role := member_role(p_user_id, v_account_id);
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;
  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first' USING ERRCODE = '22023';
  END IF;

  DELETE FROM account_members
  WHERE user_id = p_user_id AND account_id = v_account_id;

  -- Se era a conta ativa do alvo, reaponta para outra membership dele.
  UPDATE profiles p
  SET account_id = nm.account_id, account_role = nm.role
  FROM (
    SELECT account_id, role FROM account_members
    WHERE user_id = p_user_id ORDER BY created_at LIMIT 1
  ) nm
  WHERE p.user_id = p_user_id AND p.account_id = v_account_id;

  -- Não sobrou nenhuma: fica sem workspace (conta ativa NULL).
  UPDATE profiles
  SET account_id = NULL, account_role = NULL
  WHERE user_id = p_user_id AND account_id = v_account_id
    AND NOT EXISTS (SELECT 1 FROM account_members WHERE user_id = p_user_id);
END;
$$;
ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;

-- ============================================================
-- transfer_account_ownership — dentro da conta ATIVA do caller.
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no active account' USING ERRCODE = '42501';
  END IF;

  v_caller_role := member_role(auth.uid(), v_account_id);
  IF v_caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership' USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  v_target_role := member_role(p_new_owner_user_id, v_account_id);
  IF v_target_role IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of your account' USING ERRCODE = '42501';
  END IF;

  UPDATE account_members SET role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_account_id;
  UPDATE account_members SET role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_account_id;
  UPDATE accounts SET owner_user_id = p_new_owner_user_id WHERE id = v_account_id;

  -- Sincroniza os caches de profiles quando esta é a conta ativa deles.
  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = v_account_id;
  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = v_account_id;
END;
$$;
ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;

-- ============================================================
-- handle_new_user — signup FECHADO: não cria mais conta pessoal.
-- Um novo login nasce SEM workspace (account_id NULL). Só passa a ter
-- acesso quando é adicionado a uma conta (convite/super admin) — ou,
-- no futuro, via checkout que provisiona a conta.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, NULL, NULL)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
