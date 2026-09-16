# MASTER ARCHITECTURAL IMPLEMENTATION PROMPT FOR OPENAI CODEX
## PROJECT: APODERAMIENTOS-BOT (PRODUCTION WORKFLOW AUTOMATION)

---

### INSTRUCTIONS FOR CODEX:
You are the **Principal Systems Architect & Lead Software Engineer** at **Litigios Judiciales S.L.** (a high-volume consumer law firm in Spain).
Your mission is to construct the complete, battle-tested, production-ready microservice: `apoderamiento-bot`.

This service automates the complex legal procedure of obtaining, validating, and filing judicial powers of attorney (*apoderamientos judiciales apud acta*) for microloan (*micropréstamos*) clients. It connects **WhatsApp messaging**, **Kmaleon ERP/CRM**, **Sede Judicial del Ministerio de Justicia**, the **Apudata.gov** partner platform, and internal legal team handoffs.

You MUST write clean, modular, highly typed **TypeScript 5.7+ / Node.js 22 LTS** code following strict software engineering principles. No pseudocode. No hand-wavy `// TODO: implement later` comments. Implement every layer completely.

---

## 1. BUSINESS DOMAIN & OPERATIONAL SPECIFICATION

### 1.1 The Operational Context
In Spain, a law firm cannot file a lawsuit against a microloan lender (Vivus, MoneyMan, Loaney, MyKredit, etc.) without a valid judicial power of attorney granted by the client to the firm's lawyers and court procurators (*procuradores*).
The current manual workflow (conducted by Gestora Dayana) is the primary bottleneck of the firm. Dayana triages clients via WhatsApp, determines if they have a digital certificate (*Certificado Digital FNMT/DNIe*), guides them to execute the power on the Ministry of Justice web portal (*sede.justicia.gob.es*), assists clients who lack tech skills, validates the resulting PDF documents, files them in Kmaleon CRM, and notifies **Carmen** in the Reclamaciones department.

### 1.2 The Core Operational Paths
1. **Branch A (Client has Digital Certificate):**
   - **Sub-branch A.1 (Certificate on Mobile via FNMT App):**
     - If client has PC: Guide export via WhatsApp Web to PC.
     - If client has NO PC or cannot install: Request explicit consent. Client sends `.pfx`/`.p12` certificate file + password to the bot's secure WhatsApp.
     - The bot automatically pulls client address/empadronamiento from Kmaleon, uses AI to normalize the Judicial District (Partido Judicial), connects to Sede Judicial, generates the power, sends draft to client for review, audits the PDF, attaches to Kmaleon, and notifies Carmen.
   - **Sub-branch A.2 (Certificate on PC / Computer):**
     - Bot sends step-by-step PDF tutorial + list of firm lawyers/procurators (Mandatory: Procurator **Airam**).
     - Client self-serves on Sede Judicial and sends the resulting PDF via WhatsApp.
2. **Branch B (Client has NO Digital Certificate):**
   - **Step B.1 (Certificate Acquisition Guidance):**
     - Bot detects DNI vs NIE. Sends official links: DNI video-ID (paid) or DNIe PIN (free at police station kiosk); NIE (appointment at Town Hall / Ayuntamiento).
     - If acquired &rarr; transitions to Branch A.
   - **Fallback B.2 (In-Person Court Apud Acta - *Juzgado*):**
     - Used when client cannot get certificate.
     - **Critical Risk:** Courts frequently omit required litigation powers.
     - **Mitigation:** Bot generates and sends a personalized "Court Power Checklist" for the client to hand directly to the court clerk (*Letrado de la Administración de Justicia*).
   - **Fallback B.3 (Paid Video-ID Service - Apudata 35€):**
     - Last resort for urgent clients.
     - **Financial Gate:** Bot MUST consult partner API to confirm eligibility BEFORE revealing the 35€ bank account details.
     - Dayana/Bot registers client in Apudata &rarr; Client completes video ID on phone &rarr; Apudata emails signed power &rarr; Attached to Kmaleon.
3. **Stage 2: Document Audit & Revocation Safeguards:**
   - **The 5-Page Mandate:** A compliant power covering all general and special powers must have exactly **5 pages**.
   - **Airam Procurator Rule:** Lead Procurator **Airam** must be included.
   - **Provisional Viabilization Track:** If `< 5 pages` but **Airam** is present, upload provisionally to Kmaleon to keep the legal team moving without bottlenecks (*viabilizar el proceso*).
   - **Compulsory Revocation Loop:** Sede Judicial prohibits duplicate active powers. The bot sends screenshot instructions guiding the client to **REVOKE** (*Revocar*) the defective power and re-issue the 5-page document.
4. **Stage 3: Kmaleon Filing & Team Handoff:**
   - Attach PDF to client file in Kmaleon (*Seguimiento / Documentos*).
   - Create tracking notice (*Aviso*).
   - Send formal notification to **Carmen** (Reclamaciones).
   - Send completion confirmation to client.

---

## 2. HARD LESSONS LEARNED & MANDATORY DEFENSES (ZERO-TOLERANCE ANTI-PATTERNS)

From our production post-mortems on `reclamacion-bot` and `facturacion-bot` (failures `F-001` through `F-027`), you MUST embed the following architectural defenses:

1. **Defeat Kmaleon Desync & Dropped Writes (`F-016`, `F-024`):**
   - *Problem:* Kmaleon API is a legacy SOAP/RPC service with unpredictable response times (1s to 90s auth handshake) and occasional silent write failures.
   - *Requirement:* Implement a **Verified Write-Read Loop**. Never assume a write succeeded. After calling `uploadDocumentoSeguimiento`, the bot must immediately call `documents/viewDocument` or `projects/getProject` to verify the document exists in Kmaleon's index. If not found within 3 retry attempts, the operation must fail-closed and alert the dead-letter queue.
2. **Deterministic State Machine vs. Rogue AI (`F-003`, `F-021`):**
   - *Problem:* Previous bots allowed the LLM to decide the "next step", causing hallucinated transitions, skipping mandatory steps, and deadlocks.
   - *Requirement:* **The LLM NEVER decides the next action.** All transitions are governed by an immutable, deterministic Finite State Machine (FSM) implementing an 11-field decision contract (`src/core/decision-engine.ts`). The LLM is restricted *strictly* to OCR correction, NLP entity extraction, and geographical district normalization.
3. **Strict Ban on Mocks for Verification (`Rule 2 - NEVER DO A MOCK TEST`):**
   - *Problem:* Mocks produced false confidence while real PDFs from Sede Judicial broke in production.
   - *Requirement:* Every PDF auditor, PKCS#12 certificate parser, and regex validator must run against real, sanitized PDF files located in `test/fixtures/`.
4. **Distributed Idempotency & Webhook De-duplication (`F-013`):**
   - *Problem:* WhatsApp retries and multi-part messages triggered concurrent state executions and infinite echo loops.
   - *Requirement:* Redis-backed distributed locks (Redlock) keyed by `lock:apod:${clientId}`. Inbound messages are debounced for 4 seconds to aggregate multi-part messages (e.g. text + document) into a single event before evaluating state transitions.
5. **Zero-Disk In-Memory PKCS#12 Security:**
   - *Problem:* Client digital certificates and passwords could leak if persisted on disk or in database logs.
   - *Requirement:* Certificate files (`.pfx`/`.p12`) and passwords must be stored purely in volatile RAM buffers. Once processed, the buffer must be immediately zeroed using `crypto.randomFillSync()`. No plaintext passwords in PostgreSQL or Pino logs.
6. **Apudata 35€ Financial Guardrail:**
   - *Problem:* Clients paying for services before eligibility check, causing refund disputes.
   - *Requirement:* Structural code block. The method `sendPaymentDetails()` throws a `FinancialSafetyError` if `expediente.apudataPreApproved !== true`.

---

## 3. FULL TECHNOLOGY STACK & LIBRARIES

You must configure and use the following libraries in `package.json`:

```json
{
  "name": "apoderamiento-bot",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "test": "vitest run",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.1",
    "@fastify/sensible": "^6.0.1",
    "@prisma/client": "^6.1.0",
    "bullmq": "^5.34.0",
    "dotenv": "^16.4.7",
    "fastify": "^5.2.0",
    "ioredis": "^5.4.2",
    "node-forge": "^1.3.3",
    "openai": "^4.77.0",
    "pdf-lib": "^1.17.1",
    "pdfjs-dist": "^4.10.38",
    "pino": "^9.6.0",
    "pino-pretty": "^13.0.0",
    "playwright": "^1.49.1",
    "redlock": "^5.0.0-beta.2",
    "undici": "^7.1.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/node-forge": "^1.3.11",
    "prisma": "^6.1.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

---

## 4. SYSTEM ARCHITECTURE & FOLDER STRUCTURE

Organize the repository cleanly as follows:

```
src/
├── main.ts                       # Application entrypoint & Fastify server boot
├── config/                       # Strongly typed environment configuration (Zod)
│   └── env.ts
├── contracts/                    # Immutable schemas & system contracts
│   ├── decision.contract.ts      # 11-field deterministic decision engine contract
│   ├── kmaleon.contract.ts       # Kmaleon RPC request/response schemas
│   ├── whatsapp.contract.ts      # WhatsApp Cloud webhook contracts
│   └── apudata.contract.ts       # Apudata API contracts
├── domain/                       # Core domain entities & FSM logic
│   ├── fsm/
│   │   ├── states.ts             # 18 FSM States Enum & Event definitions
│   │   ├── state-machine.ts      # Transition table & guard validation
│   │   └── actions.ts            # Typed side-effect definitions
│   ├── models/                   # Domain entities (Expediente, Documento, AuditLog)
│   └── errors/                   # Typed domain error classes
├── core/                         # Pure business logic engines
│   ├── decision-engine.ts        # The central brain: evaluateNextStep()
│   ├── pdf-auditor.ts            # PDF analyzer: 5-page rule, Airam, Art 25 LEC
│   ├── cert-inspector.ts         # In-memory PKCS#12 validator & ephemeral wiper
│   ├── geo-normalizer.ts         # CA/Province/Locality to INE & Sede codes
│   └── debounce-buffer.ts        # Redis debouncing for multi-part WhatsApp messages
├── adapters/                     # External infrastructure integrations
│   ├── kmaleon/
│   │   ├── kmaleon-client.ts     # Low-level RPC client (auth handshake, undici agent)
│   │   └── kmaleon-gateway.ts    # High-level Verified Write-Read operations
│   ├── whatsapp/
│   │   ├── whatsapp-client.ts    # Meta Cloud API client (text, buttons, templates, media)
│   │   └── webhook-router.ts     # Webhook signature validation & event dispatcher
│   ├── apudata/
│   │   ├── apudata-client.ts     # Partner API client (pre-approval, order create)
│   │   └── apudata-gateway.ts    # Financial gate enforcement
│   └── sede-judicial/
│       └── sede-playwright.ts    # Headless automation for assisted Sede filing
├── queue/                        # BullMQ asynchronous workers
│   ├── queues.ts                 # Queue definitions & dead-letter configuration
│   ├── workers/
│   │   ├── message-worker.ts     # Inbound message processing worker
│   │   ├── audit-worker.ts       # PDF & Certificate audit worker
│   │   ├── kmaleon-sync-worker.ts# Kmaleon write & verification worker
│   │   └── notification-worker.ts# Carmen & client notification worker
├── infrastructure/
│   ├── db/prisma.ts              # Prisma client singleton
│   └── redis/redis-client.ts     # Redis & Redlock instances
└── api/
    ├── routes/
    │   ├── whatsapp.routes.ts    # Webhook GET (verification) & POST (events)
    │   ├── apudata.routes.ts     # Status callback webhooks
    │   └── health.routes.ts      # Liveness & readiness probes
    └── middlewares/
```

---

## 5. COMPLETE DATABASE SCHEMA (PostgreSQL via Prisma)

File: `prisma/schema.prisma`
```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum ApodState {
  INITIAL_TRIAGE
  WAITING_CERT_RESPONSE
  MOBILE_TRIAGE_PC_CHECK
  MOBILE_EXPORT_GUIDE_SENT
  MOBILE_ASSIST_CONSENT_REQUESTED
  MOBILE_ASSIST_PROCESSING
  PC_TUTORIAL_SENT
  WAITING_PDF_SUBMISSION
  AUDITING_DOCUMENT
  PROVISIONAL_VIABILIZED
  REVOCATION_GUIDE_SENT
  WAITING_REVOCATION_REISSUE
  CERT_ACQUISITION_LINKS_SENT
  COURT_FALLBACK_GUIDE_SENT
  APUDATA_PENDING_PREAPPROVAL
  APUDATA_WAITING_PAYMENT
  APUDATA_VIDEO_IN_PROGRESS
  KMALEON_FILING
  HANDOFF_CARMEN
  COMPLETED
  ESCALATED_HUMAN
}

enum AuditResult {
  VALID_FULL_5_PAGES
  DEFECTIVE_WITH_AIRAM
  DEFECTIVE_NO_AIRAM
  UNREADABLE_OR_CORRUPT
}

model BotApodExpediente {
  id                    String        @id @default(uuid())
  dni                   String        @unique
  nombre                String
  telefono              String        @index
  email                 String?
  kmaleonExpedienteId   String?       @index
  currentState          ApodState     @default(INITIAL_TRIAGE)
  hasDigitalCert        Boolean?
  certDevice            String?       // "MOBILE" | "PC" | "NONE"
  procuradorDesignated  String?       @default("AIRAM")
  auditStatus           AuditResult?
  pageCount             Int?
  isProvisionalFiled    Boolean       @default(false)
  apudataOrderId        String?
  apudataPreApproved    Boolean       @default(false)
  
  // Geographic data for Sede Judicial
  direccion             String?
  codigoPostal          String?
  provincia             String?
  localidad             String?
  comunidadAutonoma     String?
  partidoJudicial       String?

  createdAt             DateTime      @default(now())
  updatedAt             DateTime      @updatedAt

  actions               BotApodAccion[]
  auditLogs             BotApodAuditLog[]
  documents             BotApodDocumento[]

  @@map("bot_apod_expedientes")
}

model BotApodAccion {
  id              String        @id @default(uuid())
  expedienteId    String
  actionType      String        // e.g. "SEND_WHATSAPP", "KMALEON_UPLOAD", "NOTIFY_CARMEN"
  status          String        // "PENDING", "EXECUTED", "FAILED"
  payload         Json
  retryCount      Int           @default(0)
  maxRetries      Int           @default(3)
  lastError       String?
  executedAt      DateTime?
  createdAt       DateTime      @default(now())

  expediente      BotApodExpediente @relation(fields: [expedienteId], references: [id], onDelete: Cascade)

  @@map("bot_apod_acciones")
}

model BotApodDocumento {
  id              String        @id @default(uuid())
  expedienteId    String
  documentType    String        // "APODERAMIENTO_FINAL", "APODERAMIENTO_PROVISIONAL", "ACTA_JUZGADO"
  s3OrLocalPath   String
  sha256Hash      String
  pageCount       Int
  hasAiram        Boolean
  hasPowersArt25  Boolean
  rawAuditJson    Json
  uploadedKmaleon Boolean       @default(false)
  createdAt       DateTime      @default(now())

  expediente      BotApodExpediente @relation(fields: [expedienteId], references: [id], onDelete: Cascade)

  @@map("bot_apod_documentos")
}

model BotApodAuditLog {
  id              String        @id @default(uuid())
  expedienteId    String
  event           String
  fromState       ApodState?
  toState         ApodState?
  metadata        Json?
  operator        String        @default("SYSTEM_BOT")
  createdAt       DateTime      @default(now())

  expediente      BotApodExpediente @relation(fields: [expedienteId], references: [id], onDelete: Cascade)

  @@map("bot_apod_audit_logs")
}
```

---

## 6. THE 11-FIELD DECISION ENGINE CONTRACT

File: `src/contracts/decision.contract.ts`
```typescript
import { z } from 'zod';
import { ApodState } from '@prisma/client';

export const DecisionContractSchema = z.object({
  decisionId: z.string().uuid(),
  expedienteId: z.string().uuid(),
  currentStep: z.nativeEnum(ApodState),
  nextStep: z.nativeEnum(ApodState),
  actionRequired: z.enum([
    'SEND_WHATSAPP_MESSAGE',
    'SEND_WHATSAPP_BUTTONS',
    'SEND_WHATSAPP_MEDIA',
    'UPLOAD_KMALEON_DOCUMENT',
    'CREATE_KMALEON_AVISO',
    'TRIGGER_SEDE_AUTOMATION',
    'CALL_APUDATA_PREAPPROVAL',
    'NOTIFY_CARMEN_RECLAMACIONES',
    'ESCALATE_HUMAN',
    'NO_OP'
  ]),
  actionPayload: z.record(z.unknown()),
  blockingConditions: z.array(z.string()),
  isViabilizable: z.boolean(),
  requiresClientRevocation: z.boolean(),
  evidenceRequired: z.string(),
  auditTrailSummary: z.string(),
});

export type DecisionContract = z.infer<typeof DecisionContractSchema>;
```

File: `src/core/decision-engine.ts`
Implements `evaluateNextStep(expediente, event, payload)`:
- **Zero LLM branching:** Uses a strict state-transition lookup matrix.
- Validates all preconditions before returning a `DecisionContract`.
- If an unknown event arrives in a state, transitions safely to `ESCALATED_HUMAN` and alerts the operator.

---

## 7. CRITICAL SUBSYSTEM IMPLEMENTATIONS

### 7.1 PDF Audit Engine (`src/core/pdf-auditor.ts`)
Must perform deterministic inspection using `pdf-lib` and `pdfjs-dist`:
```typescript
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface AuditReport {
  isValid: boolean;
  pageCount: number;
  hasAiram: boolean;
  missingPowers: string[];
  canViabilize: boolean;
  extractedText: string;
}

export class PdfAuditor {
  public static async audit(pdfBuffer: Buffer): Promise<AuditReport> {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pageCount = pdfDoc.getPageCount();

    // Extract text from all pages using pdfjs
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
    const pdf = await loadingTask.promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      fullText += ` ${pageText}`;
    }

    // 1. Procurator Airam Check
    const hasAiram = /AIRAM\s+[A-ZÁÉÍÓÚÑ]+/i.test(fullText) || /AIRAM/i.test(fullText);

    // 2. Powers Check (Art. 25.1 & 25.2 LEC)
    const missingPowers: string[] = [];
    if (!/pleitos/i.test(fullText)) missingPowers.push('PODER_GENERAL_PLEITOS');
    if (!/allan/i.test(fullText)) missingPowers.push('ALLANAMIENTO');
    if (!/desist/i.test(fullText)) missingPowers.push('DESISTIMIENTO');
    if (!/transig/i.test(fullText) && !/transacc/i.test(fullText)) missingPowers.push('TRANSACCION');
    if (!/renunc/i.test(fullText)) missingPowers.push('RENUNCIA');
    if (!/cobro/i.test(fullText) && !/percibir/i.test(fullText) && !/mandamiento/i.test(fullText)) {
      missingPowers.push('COBRO_MANDAMIENTOS_PAGO');
    }

    // 3. The 5-Page Rule
    const isFivePages = pageCount === 5;
    const isValid = isFivePages && hasAiram && missingPowers.length === 0;
    
    // Viabilization: Can keep legal flow moving provisionally if Airam is present
    const canViabilize = !isValid && hasAiram;

    return {
      isValid,
      pageCount,
      hasAiram,
      missingPowers,
      canViabilize,
      extractedText: fullText.substring(0, 500)
    };
  }
}
```

### 7.2 The Resilient Kmaleon Gateway (`src/adapters/kmaleon/kmaleon-gateway.ts`)
Must implement the **Verified Write-Read Loop**:
```typescript
export class KmaleonGateway {
  constructor(
    private readonly client: KmaleonClient,
    private readonly logger: pino.Logger
  ) {}

  /**
   * Uploads an apoderamiento to Kmaleon's Seguimiento and immediately
   * verifies that the file exists in Kmaleon's document index.
   */
  public async uploadAndVerifyDocument(params: {
    projectId: string;
    fileBuffer: Buffer;
    fileName: string;
    docTitle: string;
  }): Promise<{ verified: boolean; documentId: string }> {
    // Step 1: Execute write (CREATE_ANNOTATION / newAnnotation)
    const writeResult = await this.client.invokeMethod('calendar/annotations/newAnnotation', {
      idProyecto: params.projectId,
      tipoAnotacion: 'SEGUIMIENTO',
      titulo: params.docTitle,
      archivoNombre: params.fileName,
      archivoBase64: params.fileBuffer.toString('base64')
    }, 'write');

    // Step 2: Verified Read Loop (retry up to 3 times with backoff)
    let verified = false;
    let docId = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      const docs = await this.client.invokeMethod('projects/getProject', {
        idProyecto: params.projectId
      }, 'read');

      const found = docs?.anotaciones?.find((a: any) => 
        a.titulo === params.docTitle || a.archivoNombre === params.fileName
      );

      if (found) {
        verified = true;
        docId = found.id;
        break;
      }
    }

    if (!verified) {
      throw new KmaleonVerificationError(
        `Verified Read Loop FAILED: Document ${params.fileName} not found in Kmaleon project ${params.projectId} after write.`
      );
    }

    return { verified: true, documentId: docId };
  }

  /**
   * Notifies Carmen in Reclamaciones by creating a high-priority task/annotation in Kmaleon
   */
  public async notifyCarmenReclamaciones(params: {
    projectId: string;
    clientName: string;
    dni: string;
    isProvisional: boolean;
  }): Promise<void> {
    const title = params.isProvisional
      ? `⚠️ APODERAMIENTO PROVISIONAL EN FICHA - ${params.clientName} (${params.dni})`
      : `✅ APODERAMIENTO LISTO EN FICHA - ${params.clientName} (${params.dni})`;

    const description = params.isProvisional
      ? `El cliente tiene apoderamiento con Procurador Airam pero faltan poderes específicos. Incorporado a ficha para viabilizar demanda mientras el cliente revoca y reemite.`
      : `Apoderamiento completo (5 páginas) verificado e incorporado en ficha. Disponible para el departamento jurídico.`;

    await this.client.invokeMethod('calendar/annotations/newAnnotation', {
      idProyecto: params.projectId,
      tipoAnotacion: 'AVISO',
      destinatario: 'CARMEN_RECLAMACIONES',
      titulo: title,
      texto: description,
      urgente: true
    }, 'write');
  }
}
```

### 7.3 WhatsApp Ingestion & Debouncing (`src/core/debounce-buffer.ts`)
Buffers multi-part client uploads (text message followed by PDF or certificate within 4 seconds):
```typescript
export class DebounceBuffer {
  constructor(
    private readonly redis: Redis,
    private readonly queue: Queue
  ) {}

  public async ingestMessage(clientId: string, rawMessage: WhatsAppInboundMessage): Promise<void> {
    const key = `debounce:wa:${clientId}`;
    await this.redis.rpush(key, JSON.stringify(rawMessage));
    await this.redis.expire(key, 10); // 10s TTL safety

    // Schedule BullMQ job with 4000ms delay. Job ID is keyed to prevent duplicates.
    await this.queue.add(
      'PROCESS_BATCHED_MESSAGES',
      { clientId },
      { jobId: `debounce_job_${clientId}`, delay: 4000, removeOnComplete: true }
    );
  }
}
```

### 7.4 In-Memory PKCS#12 Certificate Inspector (`src/core/cert-inspector.ts`)
```typescript
import forge from 'node-forge';
import crypto from 'node:crypto';

export class CertInspector {
  public static inspectAndWipe(
    pfxBuffer: Buffer,
    password: string,
    expectedDni: string
  ): { isValid: boolean; commonName: string; expiresAt: Date } {
    try {
      const p12Asn1 = forge.asn1.fromDer(pfxBuffer.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);

      let commonName = '';
      let expiresAt = new Date(0);

      for (const safeContent of p12.safeContents) {
        for (const safeBag of safeContent.safeBags) {
          if (safeBag.cert) {
            const cert = safeBag.cert;
            expiresAt = cert.validity.notAfter;
            for (const attr of cert.subject.attributes) {
              if (attr.name === 'commonName') {
                commonName = attr.value;
              }
            }
          }
        }
      }

      const isValid = expiresAt > new Date() && commonName.includes(expectedDni.toUpperCase());

      return { isValid, commonName, expiresAt };
    } finally {
      // MANDATORY SECURITY INVARIANT: Wipe buffer from memory
      crypto.randomFillSync(pfxBuffer);
    }
  }
}
```

### 7.5 Apudata 35€ Financial Safety Gate (`src/adapters/apudata/apudata-gateway.ts`)
```typescript
export class ApudataGateway {
  constructor(
    private readonly client: ApudataClient,
    private readonly logger: pino.Logger
  ) {}

  public async requestPaymentDetails(expediente: BotApodExpediente): Promise<string> {
    // STRICT FINANCIAL GUARDRAIL:
    if (!expediente.apudataPreApproved) {
      throw new FinancialSafetyError(
        `CRITICAL SAFETY VIOLATION: Cannot provide bank details to ${expediente.dni}. Partner pre-approval is FALSE.`
      );
    }

    return "Para tramitar su apoderamiento urgente vía Apudata, realice el ingreso de 35,00€ en la cuenta ES12 3456... indicando su DNI en el concepto.";
  }

  public async checkEligibilityAndPreApprove(expediente: BotApodExpediente): Promise<boolean> {
    const isEligible = await this.client.verifyClientEligibility({
      dni: expediente.dni,
      nombre: expediente.nombre
    });
    return isEligible;
  }
}
```

---

## 8. REAL TEST HARNESS (NO MOCKS FOR PARSERS)

File: `test/core/pdf-auditor.spec.ts`
```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PdfAuditor } from '../../src/core/pdf-auditor.js';

describe('PdfAuditor (Real PDF Fixtures)', () => {
  const fixturesDir = path.join(__dirname, '../fixtures');

  it('validates a complete 5-page real Apud Acta with Procurator Airam and all powers', async () => {
    const pdfBuffer = fs.readFileSync(path.join(fixturesDir, 'real-apud-5pages-valid.pdf'));
    const report = await PdfAuditor.audit(pdfBuffer);

    expect(report.pageCount).toBe(5);
    expect(report.hasAiram).toBe(true);
    expect(report.missingPowers).toHaveLength(0);
    expect(report.isValid).toBe(true);
    expect(report.canViabilize).toBe(false); // Valid, so no need for provisional viabilization
  });

  it('detects a defective 3-page Apud Acta but allows provisional viabilization because Airam is present', async () => {
    const pdfBuffer = fs.readFileSync(path.join(fixturesDir, 'real-apud-3pages-with-airam.pdf'));
    const report = await PdfAuditor.audit(pdfBuffer);

    expect(report.pageCount).toBe(3);
    expect(report.hasAiram).toBe(true);
    expect(report.isValid).toBe(false);
    expect(report.canViabilize).toBe(true); // VIABILIZATION TRACK ENGAGED
  });

  it('rejects an Apud Acta that completely omits Procurator Airam', async () => {
    const pdfBuffer = fs.readFileSync(path.join(fixturesDir, 'real-apud-no-airam.pdf'));
    const report = await PdfAuditor.audit(pdfBuffer);

    expect(report.hasAiram).toBe(false);
    expect(report.isValid).toBe(false);
    expect(report.canViabilize).toBe(false); // CANNOT VIABILIZE WITHOUT AIRAM
  });
});
```

---

## 9. STEP-BY-STEP EXECUTION ROADMAP FOR CODEX

When building this project:
1. **Initialize Project & Config:** Generate `package.json`, `tsconfig.json`, `.env.example`, and `src/config/env.ts` using Zod.
2. **Prisma Setup:** Write `prisma/schema.prisma` with models for `BotApodExpediente`, `BotApodAccion`, `BotApodDocumento`, and `BotApodAuditLog`.
3. **Core Domain & Decision Engine:** Implement the 18-state FSM and the 11-field `evaluateNextStep()` in `src/core/decision-engine.ts`.
4. **Parsers & Security:** Implement `PdfAuditor` (with 5-page and Airam checks) and `CertInspector` (with memory wipe).
5. **Adapters:**
   - Implement `KmaleonClient` (OAuth2 handshake, undici agent) and `KmaleonGateway` (Verified Write-Read Loop).
   - Implement `WhatsAppClient` and `WebhookRouter` with HMAC signature validation.
   - Implement `ApudataGateway` with the 35€ financial gatekeeper.
   - Implement `SedePlaywright` for headless Sede filing.
6. **BullMQ Queues & Workers:** Set up Redis queues for `inbound-messages`, `pdf-audit`, `kmaleon-sync`, and `notifications`.
7. **Fastify Webhook Endpoints:** Build the webhook listener in `src/api/routes/whatsapp.routes.ts`.
8. **Test Suite:** Create `test/fixtures/` and complete integration test suites with zero mocks for parsers.
9. **Containerization:** Create `docker-compose.yml` defining PostgreSQL 16 and Redis 7.

Produce clean, production-ready code ready to run immediately.
