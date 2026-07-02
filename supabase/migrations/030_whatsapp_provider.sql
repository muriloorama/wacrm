-- 030_whatsapp_provider
--
-- Suporte a provedor de WhatsApp alternativo (uazapi) além do Meta
-- Cloud API. A escolha do provedor pode ser global (env WHATSAPP_PROVIDER)
-- mas é persistida por conta ao conectar, para o roteamento de envio.
--
-- O servidor uazapi + admintoken ficam em env (ADMIN-ONLY); aqui só
-- guardamos, por conta, o token da instância (número conectado),
-- ENCRIPTADO como o access_token da Meta.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta',
  ADD COLUMN IF NOT EXISTS uazapi_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS uazapi_instance_token TEXT;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;

ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'uazapi'));
