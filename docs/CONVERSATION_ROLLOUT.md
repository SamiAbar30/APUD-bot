# Conversation rollout

The bot now has an explicit `CONVERSATION_PHASE` setting with three rollout levels. It defaults to phase 3 so the approved APOD workflow remains available in the current setup. Change it to `1` while testing the small-talk envelope, or to `2` while reviewing anonymized historical conversations.

Phase 1 uses short, reviewed onboarding replies. It can greet the client, ask at most two light questions, acknowledge a small amount of context, and explain that full workflows are still being learned. It does not collect certificate, identity, payment, or document data.

Phase 2 supplies a future provider with the phase instruction and keeps the role limited to context acknowledgement and tone. It does not authorize a workflow transition. Every workflow decision continues through the deterministic state machine.

Phase 3 delegates the approved workflow to the state machine. The optional Luna-compatible provider may propose only one allowed option for the current state. It cannot choose a state, message template, macro, worker, URL, credential, or irreversible action. Ambiguous text, sensitive free text, requests for a person, and prompt-injection attempts remain human-review cases. Prompt-injection and button-only cases are rejected locally before a provider call.

An isolated greeting such as «hola» or «hi» receives a short Spanish introduction from Dayana and leaves the expediente stage unchanged. If the expediente is already escalated, the human hold remains in force until an operator recovers it; workflow requests are never resumed by a greeting.

The one cross-phase exception is a reviewed security explanation for questions such as «¿por qué necesitan mi contraseña?». The bot explains the authorized purpose, tells the client not to send a password in chat, and leaves the workflow state unchanged. It never accepts, stores, or forwards the password.

The WhatsApp export can be prepared for later human labeling without committing the source file:

```bash
node scripts/prepare-conversation-dataset.mjs \
  "/path/to/Chat de WhatsApp con +34 626 14 88 64.txt" \
  .runtime/conversations/whatsapp-anonymized.jsonl
```

The importer stores only role, turn number, anonymized text, and `UNREVIEWED` label status. It removes phone numbers, identity numbers, URLs, the observed company name, and names found in this sample. The generated file is local and ignored by Git. Human review must label the current workflow state, intent, approved response, allowed variables, and escalation rule before any model training or fine-tuning.

The attached sample is useful as a conversation pattern: the client reports having Cl@ve but no DNIe, receives the approved certificate routes, chooses one route, and postpones the action. That pattern still needs a reviewed mapping to the current FSM before it can advance a case automatically.

To activate the Luna-compatible adapter, set `CONVERSATION_AI_PROVIDER=openai-compatible` plus `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in `.env`. Leave the provider set to `none` during local WCE demonstrations unless a reviewed provider endpoint is available. Model support replies are parsed as structured JSON, checked for unsafe content and PII, then sent through the same outbox; model workflow proposals still become approved APOD templates only after option validation.
