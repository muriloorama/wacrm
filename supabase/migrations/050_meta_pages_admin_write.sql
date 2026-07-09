-- ============================================================
-- 050 — Admin da conta pode desconectar uma página do Meta.
--
-- A 049 só criou a policy de SELECT: gravação era exclusiva do webhook
-- e do callback de OAuth, ambos service-role. Com a UI de conexão, o
-- admin precisa poder remover a página que ele mesmo ligou.
--
-- INSERT continua fora: quem grava é o callback de OAuth, que valida a
-- posse da página no Meta antes. Deixar um INSERT pela UI permitiria
-- apontar `page_id` arbitrário para a própria conta e sequestrar os
-- leads de uma página alheia.
-- ============================================================

DROP POLICY IF EXISTS meta_pages_delete ON meta_pages;
CREATE POLICY meta_pages_delete ON meta_pages
  FOR DELETE USING (is_account_member(account_id, 'admin'));
