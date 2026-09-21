# Coverage on real client messages

`npm run eval:hard-cases` samples genuinely difficult turns from the imported WhatsApp corpus
(real, redacted client messages), replays each one through the real agent, policy, FSM and model
across four plausible case states, applies rule checks (no leak, no invented fact, one question per
reply) and scores usefulness with a GPT judge. A message counts as handled at 4/5 or better.

The judge disagrees with itself on borderline replies, so each case is now judged three times and
the **median** is taken; without that, the same build measured anywhere between 83% and 95%.

## Where it stands (2026-09-21)

| Run | seed 7 | seed 11 | combined (120 real messages) |
|-----|--------|---------|------------------------------|
| 1 | 98.3% | 90.0% | **94.2%** |
| 2 | 96.7% | 86.7% | 91.7% |
| 3 | 95.0% | 85.0% | 90.0% |
| 4 | 91.7% | 86.7% | 89.2% |

Mean ≈ **91%**, best run 94.2%. Starting point for this phase was 42.5%.

By category (run 4): pregunta 17/18, queja 17/17, personal 15/16, dinero 15/18,
problema_tecnico 15/17, confusion 14/18, desconfianza 14/16.

## What changed

- `src/core/topic-routing.ts` — decides whether a message is about this procedure at all. Claim
  amounts, ASNEF, lawsuits, invoices, lenders, missing documents and scope questions go to the
  claims team with the subject named, instead of being answered with the certificate step.
- `src/core/compound-reply.ts` — completes a reply when the client asked two things at once
  (cost *and* timing, purpose *and* "send it to me by e-mail"), and keeps our own next step
  visible when the answer hands the subject to someone else.
- `src/core/conversation-agent.ts` — deterministic branches for what real clients actually write:
  health and bereavement, identity checks, callbacks, lost certificate password, "I already sent
  it", "nobody answered me", availability, paying the lender, signing on paper, Cl@ve, court
  instructions, and blockers in a lender's own portal.

## What is still missed

The remaining failures are not dead ends: every one routes or answers correctly and loses a point
for not covering a second element of a multi-part message (e.g. answering the payment question but
not confirming the client's proposed time). No failure in any run was a leak, an invented fact, a
loop or a missing reply.

## Stuck-case fix found by the live test (2026-09-21)

Sending one real message through the live stack exposed a production defect. While the emulator
bridge was down, the outbound send failed and the action was left `UNCERTAIN`. The inbox loop
refuses to consume another client turn while a send is `PENDING`/`RUNNING`/`UNCERTAIN`, and the
dispatcher only re-queued `PENDING` actions — so the case stopped answering **permanently** after
one transport blip, with no error surfaced.

`src/queue/workers.ts` now re-queues `UNCERTAIN` sends that still have retries left and have been
untouched for a minute, into the same reconcile path that checks what actually reached the client.
Verified live: the frozen demo case recovered by itself and answered the queued message.
