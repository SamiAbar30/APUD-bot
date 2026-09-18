# Conversation timing and continuity

Text turns wait for 60 seconds of quiet after the latest text. `CONVERSATION_QUIET_MS` can adjust this (1–120 seconds); one minute is the normal default chosen for the requested experience, not a claim about average human response speed. A new text resets pending text deadlines. Duplicate webhook deliveries do not. Buttons and attachments retain their shorter processing delay; an explicit opt-out pauses the case immediately.

The durable inbox joins consecutive related text sharing the same quiet-period deadline, with a 4,000-character limit. Older unanswered messages resumed together can also be grouped. The local topic policy distinguishes apoderamiento/certificate/identity, pricing, claim progress, and appointments. Short corrections and help requests attach to the current subject; explicit topic changes and unknown substantial subjects remain separate. This is conservative topic matching, not an unrestricted semantic classifier. Security-sensitive inputs, attachments and consent buttons stay separate.

If another message arrives during reply generation, the worker discards the incomplete draft and leaves all inputs pending. A shared database row lock makes the final arrival check and decision commit atomic. Delivery of one reply precedes consuming the next topic. Restarting the worker preserves pending input and deadlines.

“Solo quiero salir de esto” and “I wanna finish this process” continue practical guidance. Frustration alone does not transfer or pause the case. Short acknowledgments and deferrals yield the floor, preserving the workflow without another question. Specific human requests, consent and document verification gates remain in force. The existing reminder schedule is unchanged.

Related DNI/NIE corrections inform guidance without changing the verified identity used to audit a legal document. The current group and recent client history determine this guidance context. Replies retain short paragraphs. Tone patterns were checked locally against the 40 supplied Bot exports: short acknowledgments, concrete next steps, and room for clients who are working or returning later. Historical payment instructions and client details are not copied.

The simulator shows a countdown/progress line while collecting messages, animated dots while preparing/sending, and explicit paused, blocked or disconnected states. Its bridge reads authenticated, minimized backend telemetry; the browser never receives the operator token or case details. Reconnecting restores the current activity state.

Validation: `test:conversation-pacing` covers the reported phrases, acknowledgment vs. real answers, topic boundaries and paragraphs. `test:conversation-inbox` uses an isolated PostgreSQL schema and Redis locks with artificial cases to verify deadlines, duplicate delivery, grouping, separate replies, the concurrent-arrival race, restart and status reporting. No external AI or business-provider calls are made by those tests.
