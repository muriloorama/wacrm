-- 041_channel_instance_name
--
-- Guarda o NOME da instância uazapi de cada canal. Canais criados pelo novo
-- sistema nomeiam a instância "channel-<id>", mas canais MIGRADOS do sistema
-- antigo têm nomes legados ("crm-<user>-N"). O webhook do uazapi resolve o
-- canal pelo que o payload traz (instanceName ou data.instance). Guardar o
-- nome permite resolver os canais migrados de forma determinística, casando
-- pelo nome além do id.

ALTER TABLE whatsapp_channels
  ADD COLUMN IF NOT EXISTS uazapi_instance_name TEXT;

CREATE INDEX IF NOT EXISTS idx_whatsapp_channels_instance_name
  ON whatsapp_channels(uazapi_instance_name)
  WHERE uazapi_instance_name IS NOT NULL;
