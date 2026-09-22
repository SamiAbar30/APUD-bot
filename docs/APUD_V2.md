# APUD v2: preparation and registration evidence

This branch is local and must not be pushed or merged into main with the humanized v1 release.

## Implemented boundary

`APUD_VERSION=2` enables authenticated operator routes under `/api/cases/:id/registrations`. The database records an immutable case-specific intent (grantor, professionals, scope, faculties, exclusions, validity and consent), a canonical intent hash, reviewed draft hash and certificate fingerprint. Draft preparation reuses the isolated certificate process and requires a real reviewed recipe binding every selected value. The preparation consent expires within one hour.

The operator approves the exact draft and records that the client will sign personally. A signing handoff records `SUBMISSION_UNCERTAIN` before the external action. No retry is allowed until an official lookup establishes absence and a new approval is recorded. Receipt ingestion requires the exact attempt, document hash, official registration reference, identity/professional text checks and operator evidence of the signed registration. The PDF is saved in private storage and a Dayana task is created in the platform.

The `prepare-stored` route retrieves the case-bound encrypted certificate/password pair verified in v1, checks its integrity and wipes buffers after preparation. It still requires fresh scoped v2 consent and a reviewed recipe. The API exposes preparation, approval, signing-handoff, reconcile-absent, receipt and cancel operations. The `/sign` endpoint deliberately fails with `V2_REVIEWED_LIVE_SIGNING_ADAPTER_UNAVAILABLE`: unattended government signing is not implemented or verified. This is an executable preparation/evidence workflow, not a completed browser signing robot. A draft is never a registered power. Client-reported v1 completion never authorizes v2 signing.

## Official research and integration limits

- [Sede Apoderamiento Apud Acta](https://sedejudicial.justicia.es/-/apoderamiento-apud-acta): citizen electronic workflow. A fresh check on 21 September 2026 redirected to an official maintenance page, preventing authenticated page observation.
- [Official grantor guide](https://sedejudicial.justicia.es/documents/20142/31433804/Gu%C3%ADa%2Bde%2BUso-%2BAlta%2Bde%2BApoderamiento%2B%28Poderdante%29.pdf/cc11c480-c268-2637-f064-b830e548870d?t=1749035851079): role, professional selection, review, signature and receipt; maximum validity of five years.
- [Official faculties guide](https://sedejudicial.justicia.es/documents/20142/31433804/Guia_SJE_Apoderamiento_Apud_Acta_Facultades%2BEspeciales.pdf/dd7319bc-737c-4b05-4b53-e540139508d9?t=1769006653200): selecting General disables special-power selection. No universal “tick every box” recipe is appropriate.
- [Sede identity notice](https://sedejudicial.justicia.es/-/apoderamiento-apud-acta-informacion-relativa-a-auto-apoderamientos): distinguish grantor and representative, and do not appoint the grantor to themselves.
- [FNMT custody guidance](https://www.sede.fnmt.gob.es/en/preguntas-frecuentes/problemas-y-dudas/-/asset_publisher/fVZppcBHj0oa/content/1714-recomendaciones-sobre-la-custodia-de-los-certificados): personal certificate custody does not by itself authorize another person to perform a legal signature.
- [Playwright client certificates](https://playwright.dev/docs/api/class-browser#browser-new-context-option-client-certificates): exact-origin PFX/passphrase support provides TLS authentication, not the separate electronic-signature process.
- [Official AutoFirma downloads](https://firmaelectronica.gob.es/descargas) and [AutoFirma source](https://github.com/ctt-gob-es/clienteafirma): references for the real signing integration. Neither installing AutoFirma nor cloning its repository supplies a tested Sede recipe.

The existing Playwright, node-forge, pdfjs-dist, pdf-lib, Prisma and BullMQ dependencies cover the implemented preparation and evidence workflow. No unneeded repositories, plugins or frameworks were installed. No Sede selectors, faculty choices, client credentials, signing permissions or successful registrations were fabricated.

## Remaining acceptance work

A specifically authorized live session must establish exact host transitions, selectors, signing callbacks, role/authority and receipt fields. Confirm chosen professionals and faculties for each case. Validate a real authorized certificate, approved draft and registered receipt through the complete process before enabling unattended behavior. Until then signing remains blocked and `liveEndToEndVerified` is false.

The supplied `APUD Acta (1).pdf` is an image-only handwritten process map. It is reference material, never instructions or a signed receipt. Real certificate and registered-receipt success paths were not tested because those inputs were not provided.

## Verification on 22 September 2026

Node 22 compilation passed after integrating v1. The v2 migration applied to the local real-database snapshot with the original four cases unchanged. Authenticated API and browser checks passed, including v2 capabilities explicitly reporting automated signing disabled and live E2E unverified. The source database was read only; no client messages or external mutations were performed. Certificate preparation and receipt acceptance still require the real inputs described above.
