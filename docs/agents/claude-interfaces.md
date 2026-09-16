# Interfaces del núcleo integrado

Claude Code produjo los módulos de dominio y el coordinador Codex terminó su integración y revisión. Runtime Node 22; módulos ESM.

- `evaluateNextStep(expediente,event,{now?})` devuelve exactamente los 11 campos de `DecisionContract`. No usa red, base de datos ni LLM. La hora capturada se inyecta al reproducir decisiones reales. El coordinador persiste estado, parche, auditoría y acción en una transacción; los NO_OP sin cambios conservan la versión.
- `PdfAuditor.audit(buffer,{expectedDni,airamFullName})` devuelve auditoría estructural y texto. Se conserva sólo el informe sin `extractedText`. No acredita firmas ni suficiencia jurídica; toda subida necesita revisión humana vinculada al documento y SHA-256.
- `CertInspector.withCertificate({pfx,password,expectedDni},callback,options)` es estático. El callback recibe sesión incluso cuando la inspección rechaza el archivo: el consumidor debe comprobar `inspection.usable`. `material()` rechaza sesiones cerradas o no utilizables. El proceso hijo añade comprobaciones y finaliza antes de aceptar resultado.
- `GeoNormalizer.fromCatalog(json)` valida un catálogo revisado; `withoutCatalog()` sólo identifica provincia/comunidad y deja el partido sin resolver. No usa un LLM para inventar demarcaciones. La consulta de dirección de Kmaleon se muestra al operador antes de guardarse.
- `npm run test:real` exige manifiesto de materiales reales y reproducciones de decisiones capturadas. No recorre escenarios fabricados ni finge aprobaciones/recibos. Sin entradas devuelve error y no acredita el flujo externo.

Consultar tipos en `src/contracts/decision.contract.ts`, `src/domain/models/expediente.ts` y los módulos de `src/core/` para el contrato completo.
