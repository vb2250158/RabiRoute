# Retired knowledge-grant page migration

English | [简体中文](knowledge-grant-phone-ui.md)

Since 0.3.22, authenticated devices in the same RabiLink application can use knowledge tools and writes provided by their selected PC by default. The per-device role/tool/write grant editor is removed.

The retired page and grant APIs no longer save permissions. Current owners receive 410 `KNOWLEDGE_GRANTS_RETIRED`; cross-account requests remain 404. Historical grants remain as data but never decide access. Updated clients must use existing device authentication, PC selection and the [knowledge request API](aiui-knowledge-relay_en.md). This path remains for old-link migration. Remove it and the 410 compatibility responses once supported clients are upgraded and old calls reach zero.
