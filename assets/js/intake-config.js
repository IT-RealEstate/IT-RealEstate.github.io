// Intake client configuration boundary.
//
// NOTHING IN THIS FILE IS OR MAY EVER BE A SECRET. It is served to every
// visitor. Do not put a credential, an API key or a shared password here,
// and do not let any server-side check depend on one being here.
//
// endpointUrl  the deployed Apps Script Web App URL. Public by design — a
//              Web App URL is a write endpoint, not a credential. What
//              protects it is enforcement in apps-script/Code.gs: body-size
//              limit, field allow-listing, schema validation, the honeypot
//              and fill-time heuristic, idempotency and a global rate limit.
//
// clientMarker a public protocol/version string, echoed in the request body
//              and compared against CLIENT_MARKER in Code.gs. It turns away
//              a blind POST to a /exec URL scraped from a log. It is NOT
//              authentication and stops no determined attacker.
//
//              It replaces the old `requestToken`, which compared against a
//              REQUEST_TOKEN Script Property this repository could not see.
//              The two sides drifted — the shipped value was '' — so the
//              server rejected EVERY valid lead with invalid_token. Both
//              sides of the comparison now live in Git and deploy together.
//              Keep this value identical to CLIENT_MARKER in Code.gs.
//
// mode         'live'   — submissions are sent to endpointUrl.
//              'dryrun' — intake.js issues NO network request at all and
//                         completes the flow locally, so the full UI can be
//                         reviewed without a lead being created. The public
//                         beta build sets this; production must not.
//
//              An explicit flag, deliberately not a hostname guess: a
//              hostname heuristic silently turns into "live" the moment the
//              beta moves to another host.
// ---------------------------------------------------------------------
// BETA BUILD - LEAD SUBMISSION DELIBERATELY DISABLED, TWICE.
//
// mode:'dryrun'   intake.js returns before issuing any fetch and completes
//                 the flow locally, so the success screen can be reviewed.
// endpointUrl ''  and there is no URL to post to even if that flag is lost.
//
// Nothing a visitor types on /check/ leaves their browser. Do NOT paste the
// live Apps Script URL back in: this build is for visual review only.
// ---------------------------------------------------------------------
window.INTAKE_CONFIG = {
  endpointUrl: '',
  clientMarker: 'taviv-web-1',
  mode: 'dryrun'
};
