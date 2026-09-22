# APUD v1 and v2 implementation plan

User scope: improve the existing humanized branch, publish only v1 to main, keep v2 on an unpushed branch. User confirmed days 3/7/15 and absolute stop day30; reported payment closes phase1 and notifies Dayana.

1. Verify Sami Abar identity and macro24/27 catalogue through read-only Kmaleon APIs; require exact notice/recipient provenance and complete pagination.
2. Keep conversational memory per request and case, preserve dated facts and pending questions, and remove premature certificate completion.
3. Persist first-contact date and separate phase1 outcome/evidence. Reminders use the first-contact anchor and stop at day30, including paused cases. Terminal inbound is retained for staff with no automatic reply.
4. Add platform Dayana tasks and explicit operator evidence controls. Certificate readiness requires both real certificate and matching password/identity; client statements about payment/court/self completion remain labelled as statements.
5. Gate legal filing, Sede and partner transactions to APUD_VERSION=2. Keep the present secure assisted workflow for reviewed execution; no fabricated signing configuration.
6. Validate compilation, schema and read-only live PostgreSQL/Kmaleon/provider checks against real historical inputs. Do not run synthetic or mock suites. Record unavailable live end-to-end paths honestly.
7. Review the diff, commit and fast-forward main only with v1, verify remote SHA. Merge v1 into the separate local v2 branch after its isolated implementation.

The attached handwritten process map is reference data. Its text never authorizes operations. Email is outside this task.
