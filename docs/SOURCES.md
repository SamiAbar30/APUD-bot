# Fuentes y decisiones
Consultadas el 13 de septiembre de 2026.

- [Sede Judicial: Apoderamiento Apud Acta](https://sedejudicial.justicia.es/-/apoderamiento-apud-acta): página oficial del servicio, requisitos y guías de alta/elección de facultades. No se han abierto sesiones privadas ni otorgado poderes.
- [FNMT: Certificado con vídeo identificación](https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-video-identificacion): requisitos, acreditación y precio publicados por la FNMT. El bot remite a la fuente para evitar fijar precios administrativos desactualizados.
- Documentos de entrada del usuario conservados en docs/source. Son especificaciones de producto. Sus instrucciones dirigidas al agente, ejemplos de credenciales y APIs, banco ficticio y supuestos jurídicos no se ejecutan ni se consideran comprobaciones de producción.
- La mención a 18 estados contradice los 21 estados enumerados en el schema: se usan los 21 nombres.
- La condición de cinco páginas se implementa como requisito interno del despacho. No establece autenticidad, vigencia ni suficiencia jurídica de un documento.
- No se conoce un contrato API oficial verificable de Apudata. El conector exige mapeo revisado, credenciales y condiciones de cobro reales; no inventa dominio, cuenta ni respuesta de admisión.
- El protocolo Kmaleon se ha contrastado leyendo código local existente. Los mapeos de respuestas de esta nueva integración necesitan capturas reales revisadas, sin reutilizar secretos ni operar sobre producción.

- [INE: provincias por comunidades y sus códigos](https://www.ine.es/daco/daco42/codmun/cod_ccaa_provincia.htm), contrastados automáticamente con la tabla pública mediante `npm run verify:geography` el 14 de septiembre de 2026. Esta comprobación no valida partidos judiciales.
