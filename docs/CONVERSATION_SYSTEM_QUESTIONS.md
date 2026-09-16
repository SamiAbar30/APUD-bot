# Preguntas de diseño para la conversación APOD

Este documento convierte el objetivo de automatizar aproximadamente el 95 % del proceso en decisiones comprobables. Las preguntas pueden responderse por bloques; no hace falta detener la construcción del setup para contestarlas.

## 1. Objetivo y límites del 95 %

1. ¿Qué significa exactamente «95 % automatizado»: expedientes completados, mensajes sin intervención, tiempo de trabajo o pasos del procedimiento?
2. ¿Qué cinco por ciento debe quedar siempre en manos de una persona aunque el modelo tenga mucha confianza?
3. ¿Qué resultado marca el final de la conversación: certificado elegido, PDF recibido, PDF aprobado, documento incorporado a Kmaleon, aviso a Reclamaciones o todo el circuito?
4. ¿Qué decisiones nunca puede tomar el bot por sí solo: consentimiento, uso de certificado, suficiencia jurídica, pago, presentación, revocación o cierre?
5. ¿Qué idiomas y variantes de español deben cubrirse desde el primer día?
6. ¿Qué horario, plazo de respuesta y número máximo de recordatorios se permite?
7. ¿Qué fase debe estar activa ahora mismo en producción: 1 (onboarding), 2 (contexto) o 3 (workflow)?
8. ¿Qué evidencia debe existir para pasar de una fase a la siguiente: número de conversaciones revisadas, tasa de escalado, tasa de error o aprobación del despacho?
9. ¿Cuántos turnos de conversación ligera se permiten antes de iniciar el workflow seleccionado en Kmaleon?
10. ¿Qué temas de conversación ligera están permitidos y cuáles deben derivarse inmediatamente a una persona?
11. ¿Qué respuestas de seguridad, como la pregunta sobre la contraseña, deben estar aprobadas en todas las fases?
12. ¿Quién revisa y firma el conjunto anonimizado antes de usarlo para entrenamiento o ajuste del modelo?

## 2. Cómo se inicia un expediente

13. ¿El único disparador inicial será la selección humana en Kmaleon o también habrá macros/avisos de Kmaleon que creen el trabajo automáticamente?
14. Si una macro de Kmaleon dispara el bot, ¿qué identificador único, empresa y tipo de trámite aporta?
15. ¿Qué debe hacer el bot si un gestor selecciona el mismo expediente dos veces?
16. ¿Puede un cliente tener varios expedientes Kmaleon activos con el mismo DNI o teléfono? Si sí, ¿cómo se elige la conversación correcta y cómo se evita enviar el mensaje al expediente equivocado?
17. ¿Qué campos son obligatorios para permitir «Añadir»: DNI/NIE válido, nombre, teléfono, empresa, número de expediente y responsable?
18. ¿Qué hacemos si Kmaleon no devuelve empresa, número de expediente, teléfono o una identidad consistente?
19. ¿Debe el primer mensaje salir inmediatamente, quedar en cola para revisión o depender de un horario autorizado?
20. ¿Qué texto exacto y qué botones debe tener el primer mensaje?

## 3. Inventario de macros y mensajes

21. ¿Cuántas macros existen hoy en Kmaleon y dónde está su listado exportable?
22. ¿Qué macro corresponde a cada etapa: inicio, certificado, dispositivo, ordenador, asistencia, juzgado, Apudata, PDF, corrección, revocación, reemisión, cierre y aviso a Reclamaciones?
23. ¿Cada macro tiene una versión, propietario, fecha de aprobación y condiciones de uso?
24. ¿Qué variables puede rellenar el bot y cuáles deben proceder literalmente de Kmaleon o de una plantilla aprobada?
25. ¿Qué mensajes deben ser texto libre aprobado y cuáles botones/listas obligatorias?
26. ¿Qué mensaje responde a preguntas previsibles como «¿por qué necesitan mi contraseña?» sin revelar instrucciones internas?
27. ¿Qué mensaje responde a «no quiero seguir», «borrar mis datos», «hablar con una persona» o «esto es una estafa»?
28. ¿Qué mensaje se envía cuando el cliente responde fuera de contexto?
29. ¿Cuántos intentos se permiten antes de escalar una respuesta no entendida?
30. ¿Qué mensajes se pueden repetir y cuáles solo una vez?
31. ¿Quién aprueba cambios de texto y cómo se retira una macro defectuosa sin perder trazabilidad?

## 4. Mapa detallado del workflow

32. ¿Cuál es la tabla completa «estado actual + respuesta del cliente → siguiente estado + mensaje»?
33. En la pregunta del certificado, ¿qué respuestas equivalen a sí, no, no sé o necesito ayuda?
34. Para certificado móvil, ¿qué diferencia hay entre «tengo ordenador», «puedo exportarlo» y «necesito asistencia»?
35. Para certificado en ordenador, ¿cuándo se envía tutorial y cuándo se espera directamente el PDF?
36. Si el cliente no tiene certificado, ¿qué opciones exactas se ofrecen para DNI y para NIE?
37. ¿En qué orden se ofrecen juzgado y Apudata, y qué condición convierte Apudata en una opción visible?
38. ¿Qué datos y evidencias son necesarios antes de mostrar cualquier información de pago?
39. ¿Qué respuestas permiten recibir un PDF y cuáles exigen detener el flujo?
40. ¿Qué reglas determinan documento válido, provisional, incompleto, sin Airam, identidad incorrecta o archivo ilegible?
41. ¿Qué ocurre después de un documento provisional: aviso, revocación, nuevo documento y nueva auditoría?
42. ¿Qué evento exacto permite pasar a Kmaleon, avisar a Carmen y notificar al cliente?
43. ¿Qué significa «respuesta final» y cómo se transforma en una macro o trabajo para otro equipo?
44. ¿Qué estados deben ser visibles al gestor en lenguaje sencillo y qué estados técnicos deben quedar internos?

## 5. Papel del modelo de IA

45. ¿El modelo solo clasificará la intención y elegirá una opción aprobada, o también redactará explicaciones dentro de límites de plantillas?
46. ¿Qué proveedor se aprobará: Gemini, Claude u otro? ¿Qué modelo y qué región de procesamiento?
47. ¿Se permitirá que el modelo vea el historial completo, un resumen estructurado o únicamente el último mensaje y el estado?
48. ¿Qué datos nunca puede recibir el modelo: contraseña, certificado, documento completo, credenciales, datos de otros clientes o instrucciones internas?
49. ¿Qué salida estructurada exacta debe devolver: opción, confianza, motivo seguro, idioma y necesidad de persona?
50. ¿Qué umbral de confianza y qué reglas de ambigüedad provocan escalado?
51. ¿Cómo se detectan prompt injection, suplantación del gestor, solicitudes de secretos, enlaces externos, instrucciones de sistema y cambios de contexto?
52. ¿Puede el modelo llamar herramientas? Si sí, ¿cuáles son de solo lectura y qué validación independiente tienen?
53. ¿Qué debe ocurrir si el proveedor no responde, responde con JSON inválido o propone una opción no permitida?
54. ¿Se permite aprendizaje continuo automático o toda modificación requiere revisión y publicación humana?
55. ¿Qué conjunto real de conversaciones se etiquetará para entrenamiento: estado, mensaje, intención, opción correcta, respuesta aprobada y motivo de escalado?
56. ¿Cuántos ejemplos reales hacen falta por opción, idioma, empresa y caso raro antes de considerar el modelo apto?
57. ¿Qué parte se resolverá con reglas, qué parte con recuperación de documentos aprobados y qué parte, si alguna, con fine-tuning?
58. ¿Cómo se medirán precisión, cobertura, falsos avances, escalados innecesarios y respuestas peligrosas antes de activar el modelo?

## 6. Seguridad de la conversación

59. ¿Qué identidad se verifica antes del primer mensaje y qué evidencia permite asociar el teléfono al expediente?
60. ¿Cómo se trata un teléfono compartido por familiares, un número cambiado o un cliente que escribe desde otro número?
61. ¿Se guardará el texto completo, un resumen, un hash o solo la clasificación? ¿Durante cuánto tiempo?
62. ¿Qué cifrado, control de acceso, separación por despacho y auditoría se requiere para conversaciones y documentos?
63. ¿Qué datos deben quedar fuera de logs, métricas, trazas, colas y mensajes de error?
64. ¿Cómo se ejercen derechos de acceso, rectificación, supresión y limitación sin romper la evidencia legal necesaria?
65. ¿Qué kill switch detiene todos los mensajes salientes y qué persona puede activarlo?
66. ¿Cómo se evita que una macro, un modelo o un trabajador envíe mensajes fuera del expediente seleccionado?

## 7. Almacenamiento y modelo de datos

67. ¿Qué se guarda en `BotApodExpediente`: empresa, número, DNI, nombre, teléfono, estado, versión, responsable y referencias externas?
68. ¿Qué se guarda por mensaje: proveedor, ID externo, timestamp, dirección, estado de entrega, hash, opción y evidencia?
69. ¿Qué datos deben ser relacionales y cuáles JSON versionado?
70. ¿Qué índices e idempotency keys se necesitan para evitar duplicados de Kmaleon, WhatsApp y macros?
71. ¿Qué retención tienen mensajes, auditorías, documentos, hashes y decisiones del modelo?
72. ¿Qué copia de seguridad y recuperación se exige para PostgreSQL, Redis, almacenamiento de documentos y configuración de macros?
73. ¿Cómo se conserva la procedencia: versión de macro, versión de modelo, prompt aprobado, respuesta estructurada y operador que intervino?

## 8. Intervención humana

74. ¿Qué casos requieren siempre una persona: identidad, consentimiento, contraseña/certificado, pago, documento, revocación, presentación, queja, opt-out o cierre?
75. ¿Qué pantalla o cola recibe cada tipo de revisión?
76. ¿Qué evidencia debe introducir el gestor para resolver una revisión y reanudar el workflow?
77. ¿Puede un gestor corregir una clasificación sin cambiar el mensaje original?
78. ¿Qué SLA tiene cada revisión y qué recordatorio se envía internamente?
79. ¿Qué sucede si dos gestores intentan resolver el mismo expediente simultáneamente?
80. ¿Cuándo se permite que una persona envíe un mensaje manual y cómo se registra su plantilla y motivo?

## 9. Casos raros y límites operativos

81. ¿Cuántos casos históricos hay por cada rareza conocida y cuántos esperamos al mes?
82. ¿Qué hacemos con DNI/NIE inválido, nombre duplicado, empresa ausente o número Kmaleon cambiado?
83. ¿Qué hacemos con varios mensajes seguidos, audio, imagen, documento, mensaje editado o mensaje borrado?
84. ¿Cómo se responde a una pregunta que no está en el workflow pero es legítima?
85. ¿Qué ocurre ante idioma desconocido, insultos, amenaza, fraude, suplantación o solicitud de datos de otro cliente?
86. ¿Qué ocurre si el cliente responde después de 24 horas, después del cierre o mientras hay una acción incierta?
87. ¿Cómo se recupera un webhook duplicado, fuera de orden, retrasado o con estado de entrega contradictorio?
88. ¿Qué pasa si Kmaleon cambia el teléfono, la empresa, el número o los participantes después de seleccionar el expediente?
89. ¿Qué volumen máximo de conversaciones simultáneas, mensajes por minuto y documentos por día debe soportarse?

## 10. Macros y workers posteriores

90. ¿Qué macro se crea para cada resultado final y qué trabajador la consume?
91. ¿Qué equipos reciben cada handoff: Reclamaciones, Carmen, jurídico, soporte, Apudata u otro?
92. ¿Qué payload mínimo y qué evidencia debe acompañar cada handoff?
93. ¿Qué acciones son reintentables, cuáles requieren reconciliación y cuáles deben quedar bloqueadas?
94. ¿Qué respuesta debe ver el gestor cuando el worker termina, falla o queda incierto?
95. ¿Cómo se evita procesar dos veces una macro o entregar dos veces el mismo aviso?
96. ¿Qué condición marca que el expediente está realmente completado?

## 11. Evaluación, despliegue y control

97. ¿Qué conjunto de conversaciones reales, anonimizadas y revisadas será la evaluación de referencia?
98. ¿Qué pruebas de seguridad se ejecutarán contra prompt injection, fuga de datos, cross-case leakage y tool abuse?
99. ¿Qué pruebas deben usar documentos y respuestas reales autorizadas antes de aceptar una integración?
100. ¿Qué métricas se observan diariamente: automatización, precisión, escalado, tiempo, entregas, errores y quejas?
101. ¿Qué límites hacen que el sistema vuelva automáticamente a modo humano?
102. ¿Cómo se hará el piloto: una empresa, un gestor, un número de WhatsApp y un porcentaje pequeño de expedientes?
103. ¿Qué evidencia necesita el despacho para pasar de piloto a producción completa?
104. ¿Quién es responsable de aprobar el modelo, las macros, los workflows, los secretos y el apagado de emergencia?

## 12. Respuestas prioritarias para el siguiente diseño

Para avanzar sin bloquear el setup, las primeras decisiones útiles son: (a) listado de macros y workflows existentes, (b) regla para varios expedientes con el mismo teléfono, (c) campos y retención de conversación, (d) tabla de revisiones humanas obligatorias, (e) proveedor/modelo de IA y dataset real disponible, y (f) definición medible del 95 %.
