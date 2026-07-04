-- 035_switch_account
--
-- FASE 3 (banco): RPC para o usuário trocar sua CONTA ATIVA
-- (profiles.account_id) entre as contas de que é membro. Valida a
-- associação em account_members e sincroniza o cache profiles.account_role
-- com o papel na conta escolhida — assim getCurrentAccount (server) e
-- use-auth (client), que leem o cache de profiles, continuam corretos sem
-- precisar mudar.
--
-- SECURITY DEFINER: escreve profiles.account_id/account_role do próprio
-- usuário só após confirmar que ele É membro do alvo (impede apontar a
-- conta ativa para uma conta onde não tem acesso).

CREATE OR REPLACE FUNCTION public.switch_account(
  p_account_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  v_role := member_role(auth.uid(), p_account_id);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this account' USING ERRCODE = '42501';
  END IF;

  UPDATE profiles
  SET account_id = p_account_id,
      account_role = v_role
  WHERE user_id = auth.uid();
END;
$$;

ALTER FUNCTION public.switch_account(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.switch_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.switch_account(UUID) TO authenticated;
