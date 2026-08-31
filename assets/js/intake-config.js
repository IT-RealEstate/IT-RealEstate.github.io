// Intake client configuration boundary (Batch 6B).
//
// Deliberately the only place these two values live. Neither is a secret:
// endpointUrl is a public Web App URL, and requestToken is a nuisance
// filter visible to any visitor (see apps-script/README.md) — not
// authentication, not a Google credential.
//
// endpointUrl is the deployed Apps Script Web App URL supplied for MP-1
// closure. requestToken is intentionally still empty: it must be the
// exact REQUEST_TOKEN Script Property value set on that deployment
// (apps-script/README.md step 4/9), and that value has never been
// supplied to this repository. It is not invented here — inventing one
// would just produce a token that fails checkNuisanceToken_ silently.
//
// Consequence while requestToken is empty: intake.js sees a non-empty
// endpointUrl (see attemptPersist in intake.js) and DOES attempt a real
// network submission — it no longer shows the old dev-only placeholder
// status. That real request reaches the live endpoint with
// request_token: '', which the server rejects (code: invalid_token),
// surfacing the real controlled-failure UI (retry button, phone
// fallback) rather than a fabricated success. This is the intended,
// honest degrade: BLOCKED — owner must supply the REQUEST_TOKEN value
// from their Apps Script deployment's Script Properties before a real
// submission can succeed end to end.
// ---------------------------------------------------------------------
// BETA BUILD - LEAD PERSISTENCE DELIBERATELY DISABLED.
//
// endpointUrl is empty on purpose. intake.js checks it at the top of
// attemptPersist() and returns before issuing any fetch, so nothing a
// visitor types on /check/ ever leaves their browser - no name, phone,
// email or description reaches Google or any other service.
//
// The visitor sees the approved controlled-failure state with the phone
// fallback, which is the honest outcome for a build that cannot save a
// lead. Do NOT paste the live Apps Script URL back in here: this build is
// for visual review only. Lead capture is restored in the production
// repository, together with the REQUEST_TOKEN value.
// ---------------------------------------------------------------------
window.INTAKE_CONFIG = {
  endpointUrl: '',
  requestToken: ''
};
