# Patrones de los otros bots

Se consultó código de RECLAMACION-BOT y la copia local FACTURACION-BOT-main en modo de solo lectura. No se copiaron claves, cuentas, documentos ni datos de clientes; no se modificaron esos proyectos.

| Referencia local | Patrón aplicado en APOD |
| --- | --- |
| `/Users/litigiosmacmini/Downloads/FACTURACION-BOT-main/src/config/env.ts` y `src/config/service.ts` | Selección explícita de archivo de entorno, prioridad de variables exportadas y validación estricta al arrancar |
| `/Users/litigiosmacmini/Downloads/FACTURACION-BOT-main/src/app/executor.ts` | Efectos simulados claramente identificados, sin afirmación de entrega externa |
| `/Users/litigiosmacmini/Downloads/FACTURACION-BOT-main/scripts/smoke.ts` | Prueba con servidor HTTP real y datos de negocio artificiales |
| `/Users/litigiosmacmini/RECLAMACION-BOT/src/contracts/sandbox.ts` | Política compartida e inmutable, rechazo de banderas contradictorias e identidad separada de los recursos de prueba |
| `/Users/litigiosmacmini/RECLAMACION-BOT/src/sandbox/kmaleon-recorder.ts` | Registro de efectos simulados, referencias identificables y deduplicación |
| `/Users/litigiosmacmini/RECLAMACION-BOT/src/config.ts` | Rutas de configuración/materiales/almacenamiento resueltas desde la ubicación del entorno |

APOD conserva su propia base PostgreSQL, Redis, colas, almacenamiento y puertos. La prueba crea un esquema, prefijo de colas y carpeta por ejecución; ejercita el motor real mediante implementaciones offline de los puertos públicos de los proveedores. La configuración de correo de los proyectos de referencia no se incorpora.
