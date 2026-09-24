# Conversation brain and training loop

Branch `ai-brain` (from `humanized-conversation`). Written 2026-09-23.

## Why

The manager's test of 23 Sep ("WhatsApp UI Emulator con comentarios") showed the bot answering
by keyword: it repeated the same four messages, read "prefiero hacerlo yo" as a refusal, asked
"¿móvil u ordenador?" after the client said "ordenador", and never handed over when the client
asked for assistance. About 60 hand-written branches answered before any model read the message.

## How a turn works now

```
client message
  → safety gates in code (delivered secret, injection, bare stop request, offered SMS/PIN code)
  → the brain: one model call reads
       the playbook (config/brain/playbook.md), the firm's roster (agent package),
       the whole recent conversation (up to 40 messages), the case state and memory,
       and the workflow steps reachable from this state with the exact message each would send
  → it decides: RESPONDER (its own words) | SILENCIO | a workflow step (+ optional short lead)
                | traspaso (HUMANO, FALTA_DATO, PAGO, DESCONFIANZA)
  → every draft is checked in code (src/core/conversation-brain.ts, checkReply):
       approved links and amounts only, no SMS/PIN/bank requests, no echoed secret,
       no completion claims, one question, not a near-repeat of the last 8 bot messages,
       no repeated claims e-mail; a rejected draft goes back to the model with the reason
  → the state machine applies the step and sends its approved message
```

The old rule branches are still there, only as the fallback when the model cannot be reached.
`CONVERSATION_BRAIN=off` switches back to them entirely.

What the brain understood and where it thinks the client is are stored with every turn in the
audit log (`brainUnderstanding`, `brainProgress`), so the team can see why it answered as it did.

## Teaching it something

Edit `config/brain/playbook.md` in plain Spanish and restart. It is read at startup. Facts go in
section 2 ("hechos aprobados"): anything not there, the bot must not state.

## Training loop

```bash
scripts/training/restart-stack.sh                                   # build + restart on latest code
ENV_FILE=.env.wce npx tsx scripts/training/train.ts --round=r8 --corpus=8 --seed=8
ENV_FILE=.env.wce npx tsx scripts/training/replay.ts [file]         # word-for-word replay (default: manager 23 Sep)
```

- The bot runs on `AI_MODEL` from `.env` (`gpt-6-luna` since 23 Sep; before that `gpt-5.6-luna`).
- Simulated clients (`gpt-5.5`, a different model from the bot) play 36 situations in
  `scripts/training/personas.ts` plus N personas built from real client messages in the imported
  WhatsApp corpus. Each talks to the live stack: signed webhook → queue → worker → brain → state
  machine → Postgres → emulator.
- They run on eight training lines (34600000101–108, half DNI, half NIE). `setup-wce` allowlists
  them; the emulator bridge never shows them on the demo screen.
- A judge (`gpt-5.5`) reviews each conversation as the manager would, with the playbook as the
  standard. Output: `evidence/training/round-<N>.md` (failures first, with the bot's reasoning per
  turn) and `.json`. `evidence/` is gitignored: it holds client-derived text.

## Results (2026-09-23)

| Round | Approved | Main fixes after it |
|---|---|---|
| 1 | 14/24 (58%) | decimal-amount bug, lead sentence before steps, firm's certificate options |
| 2 | 8/11 | messages on a held case stalled forever (pre-existing bug) |
| 3 | 28/34 (82%) | fewer handoffs for small unknowns, partner choice hands over |
| 4 | 37/42 (88%) | stop word inside a question, repeated e-mail, third-party privacy |
| 5 | 41/44 (93%) | AutoFirma free, no Cl@ve signs, injection mixed with real question |
| 6 | 40/44 (91%) | one-time takeover offer when stuck; unsolicited code ≠ password |
| 7 | 41/46 (89%) | side question answered before any workflow step; iPhone app wording |
| 7b (the 8 hardest, rerun) | 6/8 | — |
| 8 — bot on `gpt-6-luna` (same clients as round 7) | 44/46 (95.7%) | model switch only (`AI_MODEL` in `.env`) |
| 9 — clients tap buttons, send bursts, 1 in 4 openings refused | 43/48 (89.6%) | stated facts kept on the case; bursts read whole except secrets |
| 10 — same, 13 button taps | 44/48 (91.7%) | help buttons answered by the brain; "no me comprendes" → person |

### First live WhatsApp test (23 Sep) and what it changed
The live report (`../REPORT-live-whatsapp-test-2026-09-23.md`) found failures the text-only training
could not reach: button taps missing from the chat, "no computer" not moving the case, old buttons
accepted, no PDF guide from the phone steps, a refused opening still counted as said, bursts split
into two replies, and a mixed handover message. All are fixed and checked live by
`scripts/training/replay-live-findings.ts` (13 checks, including bursts with a stop word or a trick
inside, and the help button), plus `scripts/test-live-findings-23sep.ts`. The training loop now
simulates what those testers did: button taps (sometimes on an older message), bursts, and
openings refused by Meta.

Single-message coverage on real client messages (`eval-hard-cases`, no conversation history):
70% → 76.7% on both seed 11 and seed 7 after the stuck-offer rule; the rule-based bot scored 80.8% on the same test,
which it had been tuned against. The brain is weakest there on `confusion` messages seen with no
context, which is not how they arrive live.

## Open points for the owner

1. The team's certificate options include "activar Cl@ve PIN en la Agencia Tributaria". The bot
   leaves it out because Cl@ve cannot sign the apud acta; confirm.
2. AutoFirma basic checks (close browser, other browser, reinstall) were added to the playbook as
   common practice, not from a firm document; confirm or replace.
3. The 12-step Sede guide is the official PDF's text. If the Sede asks for data the guide does not
   cover (e.g. a professional's NIF), the bot hands over as FALTA_DATO.
