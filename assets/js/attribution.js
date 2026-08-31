// Shared B2C attribution capture (MP-1).
//
// Loaded by every public B2C route (`/`, later `/damage/`) and by `/check/`.
// Its only job is to capture inbound attribution once, keep it for the
// session, and hand it to the intake payload builder. It never writes to
// the network and never touches PII.
//
// Rules this file implements literally (MP-1 §6):
//   1. Never invent attribution. Only values actually present are recorded.
//   2. A missing value stays ABSENT. Nothing is defaulted to "direct" here.
//   3. Attribution captured on `/` must survive navigation into `/check/`.
//   4. The same mechanism must work for `/damage/` -> `/check/` later with
//      no rewrite: nothing below is keyed to a specific route name.
//
// Storage is sessionStorage, matching the intake draft's existing choice:
// same-tab lifetime, cleared when the tab closes, never sent to a third
// party. A private-mode/quota failure degrades to "no attribution", which
// is the correct fallback under rule 2 — never a fabricated value.
(function () {
  'use strict';

  var KEY = 'attribution_v1';
  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  // fbclid is captured first-touch exactly like the UTMs (Content Spec
  // §17.1): it is a campaign identifier that arrives on the landing URL and
  // must not be overwritten by later internal navigation.
  var CAMPAIGN_KEYS = UTM_KEYS.concat(['fbclid']);
  var MAX_VALUE = 200;
  var MAX_REFERRER = 300;
  // Must stay in step with FIELD_MAX_LENGTHS in apps-script/Code.gs. The
  // server re-checks both independently — this side exists so a malformed
  // value is never stored or sent in the first place, not as the authority.
  var MAX_SOURCE_PAGE = 256;
  var MAX_FBCLID = 512;

  // Unicode-aware length: String.length counts UTF-16 units, so an astral
  // character would otherwise count as two. Mirrors codePointLength_ server-side.
  function codePointLength(value) {
    return typeof value === 'string' ? Array.from(value).length : 0;
  }

  // fbclid is an OPAQUE click identifier — Meta owns its format and may widen
  // it, so no character whitelist is enforced: guessing the alphabet would
  // silently discard valid identifiers. Never parsed, decoded or normalised.
  // Two structural rejections only — over-length, and whitespace/control
  // characters (which cannot appear in a real URL query value). A rejected
  // value is dropped, never truncated, and never blocks the lead.
  // Mirrors sanitizeFbclid_ in apps-script/Code.gs.
  function cleanFbclid(value) {
    if (typeof value !== 'string') return '';
    var v = value.trim();
    if (!v || codePointLength(v) > MAX_FBCLID) return '';
    if (/\s/.test(v)) return '';
    if (/[\u0000-\u001F\u007F-\u009F]/.test(v)) return '';
    return v;
  }

  // source_page must be an internal pathname: no query, no fragment, no
  // control characters, no protocol-relative form. Dropped if it isn't one.
  function cleanSourcePage(value) {
    if (typeof value !== 'string') return '';
    var v = value.trim();
    if (!v || v.charAt(0) !== '/' || v.charAt(1) === '/') return '';
    if (codePointLength(v) > MAX_SOURCE_PAGE) return '';
    if (v.indexOf('?') !== -1 || v.indexOf('#') !== -1) return '';
    if (/[\u0000-\u001F\u007F]/.test(v)) return '';
    return /^[A-Za-z0-9\/._~%-]+$/.test(v) ? v : '';
  }

  function load() {
    try {
      var raw = sessionStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function save(record) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(record));
    } catch (e) {
      // Storage unavailable — attribution simply won't survive navigation.
      // Correct per rule 2: absent, not invented.
    }
  }

  function clean(value, max) {
    if (typeof value !== 'string') return '';
    var trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.slice(0, max);
  }

  // First-touch wins. Once a campaign has been recorded, later internal
  // navigation must not overwrite it — otherwise moving from `/` to
  // `/check/` would erase the campaign that produced the visit.
  function capture() {
    var record = load() || {};

    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      params = null;
    }

    var sawCampaign = false;
    if (params) {
      for (var i = 0; i < CAMPAIGN_KEYS.length; i++) {
        var key = CAMPAIGN_KEYS[i];
        if (record[key]) continue;               // first touch already held
        var value = key === 'fbclid'
          ? cleanFbclid(params.get(key))
          : clean(params.get(key), MAX_VALUE);
        if (value) {
          record[key] = value;
          sawCampaign = true;
        }
      }
    }

    // The route the visitor actually landed on first. Route-agnostic by
    // construction, so `/damage/` needs no change here.
    if (!record.landing_route) {
      record.landing_route = window.location.pathname || '/';
    }

    // Only an EXTERNAL referrer is attribution. An internal hop (`/` ->
    // `/check/`) describes our own navigation, not traffic source.
    if (!record.referrer) {
      var ref = clean(document.referrer, MAX_REFERRER);
      if (ref && ref.indexOf(window.location.origin) !== 0) {
        record.referrer = ref;
      }
    }

    if (sawCampaign || Object.keys(record).length) {
      save(record);
    }
    return record;
  }

  // Maps a captured utm_source onto the closed `source` enum the persistence
  // contract already accepts (facebook | google | direct | whatsapp | other).
  // Returns '' when nothing was captured — deliberately NOT 'direct', because
  // "we don't know" and "the user typed the URL" are different facts.
  function derivedSource(record) {
    var raw = (record && record.utm_source ? record.utm_source : '').toLowerCase();
    if (!raw) return '';
    if (/facebook|^fb$|instagram|^ig$|meta/.test(raw)) return 'facebook';
    if (/google|adwords|gads/.test(raw)) return 'google';
    if (/whatsapp|^wa$/.test(raw)) return 'whatsapp';
    return 'other';
  }

  // CTA provenance. Recorded at click time on whichever page the CTA lives,
  // so the intake can report which CTA produced the session. Only values in
  // the persistence contract's closed enum are stored.
  // 'pricing' added in Batch 3.8 (OD-3.8-04) for the per-route CTAs in the
  // /damage/ pricing area. MUST stay in step with CTA_LOCATION_VALUES in
  // apps-script/Code.gs: that server REJECTS THE WHOLE LEAD on an unknown
  // cta_location, so a value added here and not there loses leads.
  var CTA_LOCATIONS = ['hero', 'mid', 'closing', 'sticky', 'pricing'];

  // Which priced service prompted the interaction. A MEASUREMENT and
  // conversation signal only: never shown back to the visitor, never
  // presented as a purchase or a booking, and there is deliberately no
  // service-selection field in the form. The suitable service is still
  // decided in the qualification call (MODEL §10).
  // Batch 3.9 (model v2): the single execution service split in two, so
  // full_damage_case -> appraisal_only + appraisal_managed, and
  // insurer_gap_review -> insurer_gap. Must stay in step with
  // SERVICE_INTEREST_VALUES in apps-script/Code.gs.
  var SERVICE_INTERESTS = ['appraisal_only', 'appraisal_managed', 'remote_feasibility', 'insurer_gap'];

  // Interaction log for the services section. Kept in the SAME sessionStorage
  // record the rest of attribution uses — no new store, no new library, and
  // deliberately NO network request when a panel opens or a price is
  // revealed. It travels with the lead only when the form is submitted.
  var SERVICE_EVENTS = ['service_details_open', 'service_price_reveal', 'service_cta_click'];

  function recordServiceEvent(eventName, serviceId) {
    if (SERVICE_EVENTS.indexOf(eventName) === -1) return;
    if (SERVICE_INTERESTS.indexOf(serviceId) === -1) return;
    var record = load() || {};
    var log = typeof record.service_log === 'string' && record.service_log
      ? record.service_log.split(',')
      : [];
    // Order is the signal, so append rather than de-duplicate; cap the list
    // so a visitor toggling panels cannot grow the record without bound.
    if (log.length < 40) {
      log.push(eventName.replace('service_', '') + ':' + serviceId);
      record.service_log = log.join(',');
    }
    if (eventName === 'service_price_reveal') {
      var revealed = typeof record.service_price_revealed === 'string' && record.service_price_revealed
        ? record.service_price_revealed.split(',')
        : [];
      if (revealed.indexOf(serviceId) === -1 && revealed.length < 8) {
        revealed.push(serviceId);
        record.service_price_revealed = revealed.join(',');
      }
    }
    save(record);
  }

  // source_page is the pathname of the page the CTA was actually clicked on
  // (Content Spec §17.1), captured at click time and stored BEFORE the
  // browser leaves for /check/ — which is the only moment it is knowable.
  // Deliberately distinct from landing_route: a visitor can land on `/`,
  // navigate to `/damage/` and convert there, and the two values then differ.
  // Unlike the campaign keys this is last-touch, not first-touch: it answers
  // "which page produced this lead", so a later CTA click overwrites it.
  function recordCtaLocation(value, serviceInterest) {
    if (CTA_LOCATIONS.indexOf(value) === -1) return;
    var record = load() || {};
    record.cta_location = value;
    // Written only when the CTA actually carries one, and cleared otherwise,
    // so a later click from a non-pricing CTA cannot leave a stale route
    // attached to the lead.
    if (serviceInterest && SERVICE_INTERESTS.indexOf(serviceInterest) !== -1) {
      record.service_interest = serviceInterest;
    } else {
      delete record.service_interest;
    }
    var sourcePage = cleanSourcePage(window.location.pathname || '/');
    if (sourcePage) {
      record.source_page = sourcePage;
    } else {
      delete record.source_page;   // absent beats wrong
    }
    save(record);
  }

  function bindCtaLinks() {
    var nodes = document.querySelectorAll('[data-cta-location]');
    Array.prototype.forEach.call(nodes, function (el) {
      el.addEventListener('click', function () {
        recordCtaLocation(el.getAttribute('data-cta-location'), el.getAttribute('data-service-interest'));
      });
    });
  }

  var record = capture();
  bindCtaLinks();

  window.ATTRIBUTION = {
    get: function () { return load() || {}; },
    source: function () { return derivedSource(load() || record); },
    ctaLocation: function () {
      var r = load() || {};
      return CTA_LOCATIONS.indexOf(r.cta_location) === -1 ? '' : r.cta_location;
    },
    serviceInterest: function () {
      var r = load() || {};
      return SERVICE_INTERESTS.indexOf(r.service_interest) === -1 ? '' : r.service_interest;
    },
    // Was the price of the service the visitor acted on actually revealed?
    // Lets the call start from what they already know, instead of quoting a
    // number at someone who never asked to see one.
    servicePriceRevealed: function () {
      var r = load() || {};
      var interest = SERVICE_INTERESTS.indexOf(r.service_interest) === -1 ? '' : r.service_interest;
      if (!interest) return '';
      var revealed = (r.service_price_revealed || '').split(',');
      return revealed.indexOf(interest) === -1 ? 'false' : 'true';
    },
    serviceLog: function () {
      var r = load() || {};
      return typeof r.service_log === 'string' ? r.service_log : '';
    },
    recordServiceEvent: recordServiceEvent,
    recordCtaLocation: recordCtaLocation
  };
})();
