// Central CTA and intake configuration — Batch 3.14.
//
// Everything the public site needs to know about where a lead goes and how a
// visitor can reach us lives here, in one file, so a destination can change
// without touching a button. Nothing here is a secret: see the note on
// endpointUrl below.
//
// FIELDS
//
// endpointUrl   the deployed Apps Script Web App URL. Public by design — a
//               write-only append endpoint that accepts one shape of JSON and
//               returns a typed code. Anyone who finds it can add a row and
//               read nothing. It is not a credential and must never be
//               described as one. Empty string = no persistence configured.
//
// clientMarker  a protocol version tag the server whitelists. NOT
//               authentication. Do not put a credential, an API key or a
//               shared password in this file; it ships to every visitor.
//
// mode          'live'      submissions are sent to endpointUrl.
//               'dryrun'    the review beta: nothing is sent, the flow still
//                           completes, and the build rewrites the success copy
//                           so it never claims a lead was received.
//               'prelaunch' the published-but-not-launched build: nothing is
//                           sent and the form is not offered at all.
//
// leadPersistence
//               'auto'  availability follows mode + endpointUrl (the normal
//                       setting).
//               'off'   force the WhatsApp-first fallback even if an endpoint
//                       is configured — for an incident, or while the backend
//                       is being redeployed.
//               There is deliberately no 'on': a build cannot assert that a
//               backend works. Availability is derived, never declared.
//
// whatsappNumber / whatsappMessage
//               the fast path. The prepared message carries no personal data,
//               no form values and no lead id, because a wa.me URL is visible
//               in the address bar, in history and to anything that logs it.
//
// handoffUrlTemplate
//               reserved for the future App-generated secure handoff. When a
//               server-issued public code exists, put a template containing
//               {code} here and every post-save WhatsApp button follows it
//               without any of them being rewritten. Empty = use the generic
//               prepared message.
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
  mode: 'dryrun',
  leadPersistence: 'auto',
  whatsappNumber: '972552617625',
  whatsappMessage: 'שלום, הגעתי מאתר טביב שמאות ואני רוצה לבדוק מקרה נזק.',
  handoffUrlTemplate: ''
};

// Derived helpers, so every caller asks the same question the same way.
window.TAVIV_CONTACT = (function () {
  var cfg = window.INTAKE_CONFIG || {};

  // Can a lead actually be saved right now? Three things have to hold, and a
  // build can only ever answer "no" with confidence — a successful save is
  // proved by the server's response, never by configuration.
  function leadPersistenceAvailable() {
    if (cfg.leadPersistence === 'off') { return false; }
    if (cfg.mode === 'prelaunch') { return false; }
    if (cfg.mode === 'dryrun') { return true; }   // the beta completes the flow on purpose
    return typeof cfg.endpointUrl === 'string' && cfg.endpointUrl !== '';
  }

  // The generic fast path. No personal data, no form values, no lead id.
  function whatsappUrl() {
    var n = cfg.whatsappNumber || '';
    var m = cfg.whatsappMessage || '';
    return 'https://wa.me/' + n + (m ? '?text=' + encodeURIComponent(m) : '');
  }

  // The post-save button. Falls back to the generic link until a
  // server-issued public code exists, and never invents one client-side.
  function continuationUrl(publicCode) {
    var t = cfg.handoffUrlTemplate;
    if (t && publicCode) { return t.replace('{code}', encodeURIComponent(publicCode)); }
    return whatsappUrl();
  }

  return {
    leadPersistenceAvailable: leadPersistenceAvailable,
    whatsappUrl: whatsappUrl,
    continuationUrl: continuationUrl,
    telUrl: 'tel:+972552617625'
  };
})();
