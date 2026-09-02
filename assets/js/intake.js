(function () {
  'use strict';

  // Fail open (accessibility spec §30): the fallback block in the HTML is
  // visible by default. We only reveal the real form — and only hide the
  // fallback — after every step below has completed without throwing. If
  // JS is disabled, this file never runs and the fallback simply stays.
  try {
    var fallback = document.querySelector('[data-intake-fallback]');
    var app = document.querySelector('[data-intake-app]');
    var form = document.querySelector('[data-intake-form]');
    if (!form) {
      throw new Error('intake form not found');
    }

    var TOTAL_STEPS = 1;   // Batch 3.14 — one screen before the save.
    // v2: the v5 field contract dropped four fields and renamed two. A stale
    // v1 draft would restore values for inputs that no longer exist, so the
    // key is bumped rather than migrated — a half-filled draft is not worth
    // a migration path.
    var STORAGE_KEY = 'intake_draft_v2';
    var LEAD_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I/L

    // Single client-side source of truth for the currently-active legal
    // release (docs/legal/LEGAL_PAGE_IMPLEMENTATION_SPEC_v1.0.md
    // LEGAL_RELEASE, I5). Both notice_version and policy_version below
    // derive from this one constant rather than being tracked separately,
    // so a wording fix to the on-page notice and a policy re-publication
    // stay independently traceable while never drifting from each other by
    // accident (Legal Spec §3.2 point 1). The server whitelists exactly
    // this value for both fields and rejects anything else — Batch 6B.1.
    var LEGAL_RELEASE = '2026-09-01.2';

    var SUBMIT_TIMEOUT_MS = 10000;
    var RETRY_DELAY_MS = 2000;
    // Dry-run only: long enough for the sending state to be seen and
    // reviewed, short enough not to feel broken. Never used in 'live'.
    var DRYRUN_DELAY_MS = 700;

    // Batch 3.14 — lead-first. Two required fields and one optional, asked
    // before anything else, so the lead exists before qualification does.
    // damage_type, case_state and property_city are no longer asked here;
    // they stay in the schema and can arrive later through enrichment or
    // through the conversation.
    var RADIO_GROUPS = [];
    // Must match FIELD_MAX_LENGTHS.short_description in apps-script/Code.gs.
    var SHORT_DESCRIPTION_MAX = 1000;
    var TEXT_FIELDS = ['full_name', 'phone_raw'];
    var OPTIONAL_TEXT_FIELDS = ['email', 'short_description'];

    var state = {
      lead_id: '',
      step: 1,
      damage_type: '',
      case_state: '',
      full_name: '',
      phone_raw: '',
      email: '',
      property_city: '',
      short_description: '',
      // Persisted (not reset on refresh) so a legitimate user who reloads
      // mid-flow and then submits isn't mistaken for a <3s bot fill.
      form_started_at: ''
    };

    var persistInFlight = false;
    var failureCount = 0;

    // ---- lead id (Handoff spec §3.1) — generated and stored locally,
    // never transmitted anywhere in this batch. ----
    function newLeadId() {
      var bytes = new Uint8Array(5);
      crypto.getRandomValues(bytes);
      var body = '';
      for (var i = 0; i < bytes.length; i++) {
        body += LEAD_ID_ALPHABET[bytes[i] % LEAD_ID_ALPHABET.length];
      }
      return 'LD-' + body;
    }

    // ---- draft persistence — sessionStorage only, no PII in URL/console ----
    function saveState() {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        // storage unavailable (private mode, quota, etc.) — draft just
        // won't survive a refresh; the flow itself still works.
      }
    }

    function loadState() {
      try {
        var raw = sessionStorage.getItem(STORAGE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          for (var key in state) {
            if (Object.prototype.hasOwnProperty.call(parsed, key)) {
              state[key] = parsed[key];
            }
          }
        }
      } catch (e) {
        // corrupt/unavailable storage — start clean
      }
    }

    // ---- phone validation — accepts common Israeli mobile entry forms.
    // This is a shape check only; server-side E.164 normalization is a
    // Batch 6B concern (Handoff spec §7.3). ----
    function isValidIsraeliPhone(raw) {
      var digits = (raw || '').replace(/[\s\-()]/g, '');
      return /^05\d{8}$/.test(digits) ||
             /^\+9725\d{8}$/.test(digits) ||
             /^9725\d{8}$/.test(digits);
    }

    // Metadata only — never the raw user agent (Handoff spec §11.3 / Batch
    // 6B instructions). The in-app pattern matches the Handoff spec's own
    // documented WhatsApp/Meta in-app-browser detection (§6.4); no
    // WhatsApp branch behavior is implemented from it in this batch.
    function detectBrowserContext() {
      var ua = navigator.userAgent || '';
      if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|musical_ly|Snapchat/i.test(ua)) {
        return 'in_app_browser';
      }
      var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || coarsePointer;
      return isMobile ? 'mobile_browser' : 'desktop_browser';
    }

    // Content Spec §8.10.5 — exact approved strings. Missing and invalid are
    // separate messages for phone and email, which is why validateTextField
    // below distinguishes the two cases instead of emitting one message.
    var MESSAGES = {
      full_name:      { missing: 'צריך שם מלא כדי שנדע למי לפנות.' },
      phone_raw:      { missing: 'צריך מספר טלפון כדי שנוכל לחזור אליך.',
                        invalid: 'המספר לא נראה שלם. כדאי לבדוק שוב.' },
      email:          { missing: 'צריך כתובת אימייל.',
                        invalid: 'כתובת האימייל לא נראית תקינה. כדאי לבדוק שוב.' },
      property_city:  { missing: 'צריך להזין את יישוב הנכס.' },
      damage_type:    { missing: 'צריך לבחור סוג נזק.' },
      case_state:     { missing: 'צריך לבחור את המצב שהכי קרוב.' },
      // The only optional field, so it has no "missing" case — only a
      // too-long one (§8.10.5, Batch 3.3-R2).
      short_description: { tooLong: 'ניתן להזין עד 1,000 תווים.' }
    };

    // Unicode-aware length. String.length counts UTF-16 units, so an astral
    // character would otherwise cost two of the user's 1,000. Mirrors
    // codePointLength_ in apps-script/Code.gs.
    function codePointLength(value) {
      return typeof value === 'string' ? Array.from(value).length : 0;
    }

    // Optional field: empty is valid. Over-limit is invalid and BLOCKS submit,
    // but the text the user wrote is left completely untouched so they can
    // shorten it themselves — never truncated here or on the server.
    function validateShortDescription() {
      var input = form.querySelector('#short_description');
      if (!input) return true;
      var errorEl = document.getElementById('short_description-error');
      var ok = codePointLength(input.value) <= SHORT_DESCRIPTION_MAX;
      input.setAttribute('aria-invalid', ok ? 'false' : 'true');
      if (errorEl) errorEl.textContent = ok ? '' : MESSAGES.short_description.tooLong;
      return ok;
    }

    function isHidden(el) {
      var node = el;
      while (node && node !== form) {
        if (node.hidden) return true;
        node = node.parentElement;
      }
      return false;
    }

    function validateGroup(name) {
      var errorEl = document.getElementById(name + '-error');
      var checked = form.querySelector('input[name="' + name + '"]:checked');
      var ok = !!checked;
      if (errorEl) errorEl.textContent = ok ? '' : MESSAGES[name].missing;
      return ok;
    }

    function validateTextField(input) {
      var errorEl = document.getElementById(input.id + '-error');
      var value = input.value.trim();
      var msgs = MESSAGES[input.id];
      var ok = true;
      var message = '';

      // Batch 3.14 — email is optional. Empty passes; a typo does not,
      // because storing a malformed address is worse than storing none.
      if (value === '' && OPTIONAL_TEXT_FIELDS.indexOf(input.id) !== -1) {
        ok = true;
      } else if (value === '') {
        ok = false;
        message = msgs.missing;
      } else if (input.id === 'phone_raw' && !isValidIsraeliPhone(value)) {
        ok = false;
        message = msgs.invalid;
      } else if (input.id === 'email' && !input.checkValidity()) {
        ok = false;
        message = msgs.invalid;
      }

      input.setAttribute('aria-invalid', ok ? 'false' : 'true');
      if (errorEl) errorEl.textContent = message;
      return ok;
    }

    function validateStep() {
      var stepEl = form.querySelector('.intake-step[data-step="contact"]');
      var firstInvalid = null;

      RADIO_GROUPS.forEach(function (name) {
        var fieldset = stepEl.querySelector('[data-group="' + name + '"]');
        if (!fieldset || isHidden(fieldset)) return;
        var ok = validateGroup(name);
        if (!ok && !firstInvalid) {
          firstInvalid = fieldset.querySelector('input[name="' + name + '"]');
        }
      });

      // Required fields, then the optional ones. An optional field still has
      // to be well formed when it is filled in — Batch 3.14: leaving the
      // email out is fine, mistyping it is not, and catching that here is
      // what keeps the visitor from meeting a generic server rejection with
      // no idea which field was wrong.
      TEXT_FIELDS.concat(OPTIONAL_TEXT_FIELDS).forEach(function (name) {
        var input = stepEl.querySelector('#' + name);
        if (!input || isHidden(input)) return;
        var ok = validateTextField(input);
        if (!ok && !firstInvalid) {
          firstInvalid = input;
        }
      });

      if (firstInvalid) {
        firstInvalid.focus();
        return false;
      }
      return true;
    }

    function bindEvents() {
      // Single delegated listener: sync state, react to relationship
      // changes, and re-validate a field only if it already has an
      // existing error (a11y spec §20 — validate on Next/submit/correction,
      // never proactively on every keystroke).
      form.addEventListener('change', function (e) {
        var t = e.target;
        // The honeypot is never tracked in state/sessionStorage — read
        // fresh from the DOM only at submit time.
        if (!t.name || t.name === 'website') return;

        if (t.type === 'radio') {
          if (t.checked) state[t.name] = t.value;
          var errorEl = document.getElementById(t.name + '-error');
          if (errorEl && errorEl.textContent) validateGroup(t.name);
        } else {
          state[t.name] = t.value;
          if (t.getAttribute('aria-invalid') === 'true') {
            if (t.id === 'short_description') validateShortDescription();
            else validateTextField(t);
          }
        }

        saveState();
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!validateStep()) return;
        attemptPersist();
      });

      form.querySelectorAll('[data-action="retry-submit"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          // Fields stay editable while the error state is shown, so a
          // manual retry re-validates rather than resubmitting stale/
          // corrected-and-forgotten data blindly.
          if (!validateStep()) return;
          attemptPersist();
        });
      });
    }

    // Post-save state — Batch 3.14. The lead exists: the server said so, and
    // nothing here is reached on any other path. The form is replaced in
    // place, in the same component and viewport — no navigation, no reload —
    // so exactly one <h1> is ever exposed.
    //
    // None of the three continuations is required. The visitor who closes the
    // tab here has still left us a lead, which is the whole point of saving
    // before asking.
    function showSuccessState() {
      var success = document.querySelector('[data-intake-success]');
      var wa = success.querySelector('[data-continue-whatsapp]');
      if (wa && window.TAVIV_CONTACT) {
        // Generic by default. A server-issued public code would arrive in the
        // save response and flow through the same call — never a
        // client-invented token, and never the internal lead_id.
        wa.setAttribute('href', window.TAVIV_CONTACT.continuationUrl(state.public_handoff_code));
        wa.setAttribute('target', '_blank');
      }
      form.hidden = true;
      success.hidden = false;
      success.focus();
    }

    // ---- continuation choices -------------------------------------------
    function bindSuccessActions() {
      var success = document.querySelector('[data-intake-success]');
      if (!success) return;

      var wa = success.querySelector('[data-continue-whatsapp]');
      if (wa) {
        wa.addEventListener('click', function () {
          // A CTA event, not a lead: the lead was created at save time and
          // opening WhatsApp neither creates nor completes one.
          // UI channel, not service_log: the lead already exists and this
          // is a continuation choice, not interest in a service.
          if (window.ATTRIBUTION && typeof window.ATTRIBUTION.recordUiEvent === 'function') {
            window.ATTRIBUTION.recordUiEvent('whatsapp_click', 'post_save', 'check');
          }
        });
      }

      var callback = success.querySelector('[data-continue-callback]');
      var note = success.querySelector('[data-callback-note]');
      if (callback && note) {
        callback.addEventListener('click', function () {
          // Nothing to send: the phone number is already on the lead. This
          // only tells the visitor what will happen, so the screen does not
          // end on an unanswered question.
          callback.hidden = true;
          note.hidden = false;
          note.focus && note.focus();
          if (window.ATTRIBUTION && typeof window.ATTRIBUTION.recordUiEvent === 'function') {
            window.ATTRIBUTION.recordUiEvent('callback_request', 'post_save', 'check');
          }
        });
      }

      var toggle = success.querySelector('[data-details-toggle]');
      var details = success.querySelector('[data-details]');
      if (toggle && details) {
        toggle.addEventListener('click', function () {
          details.hidden = false;
          toggle.setAttribute('aria-expanded', 'true');
          toggle.hidden = true;
          var field = details.querySelector('#short_description');
          if (field) field.focus();
        });
      }

      var save = success.querySelector('[data-details-save]');
      if (save && details) {
        save.addEventListener('click', function () { sendEnrichment(save, details); });
      }
    }

    // Enrichment updates the lead that already exists — same lead_id, same
    // row. It can never create a second one: the server's enrich path refuses
    // a lead_id it cannot find rather than inserting.
    var enrichInFlight = false;

    function sendEnrichment(button, details) {
      if (enrichInFlight) return;
      var field = details.querySelector('#short_description');
      var status = details.querySelector('[data-details-status]');
      var value = (field && field.value.trim()) || '';
      if (!value) return;

      if (codePointLength(value) > SHORT_DESCRIPTION_MAX) {
        status.hidden = false;
        status.textContent = MESSAGES.short_description.tooLong;
        return;
      }

      var config = window.INTAKE_CONFIG || {};
      enrichInFlight = true;
      button.disabled = true;
      status.hidden = false;
      status.textContent = 'שומרים…';

      var done = function (ok) {
        enrichInFlight = false;
        button.disabled = false;
        // The lead is already saved either way, so a failed enrichment is
        // never presented as losing the enquiry — and never as a success.
        status.textContent = ok
          ? 'התיאור נשמר.'
          : 'לא הצלחנו לשמור את התיאור, אבל הפרטים שלכם כבר אצלנו. אפשר לספר לנו בשיחה.';
        if (ok) { field.readOnly = true; button.hidden = true; }
      };

      if (config.mode === 'dryrun' || config.mode === 'prelaunch') {
        window.setTimeout(function () { done(true); }, DRYRUN_DELAY_MS);
        return;
      }
      if (!config.endpointUrl) { done(false); return; }

      fetch(config.endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          op: 'enrich',
          lead_id: state.lead_id,
          client_marker: config.clientMarker || '',
          short_description: value,
          form_started_at: state.form_started_at
        }),
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS)
      })
        .then(function (res) { return res.json(); })
        .then(function (json) { done(!!(json && json.ok)); })
        .catch(function () { done(false); });
    }

    function setSubmitDisabled(disabled) {
      form.querySelectorAll('button[type="submit"], [data-action="retry-submit"]').forEach(function (btn) {
        btn.disabled = disabled;
      });
    }

    function showSendingStatus(visible) {
      form.querySelector('[data-sending-status]').hidden = !visible;
    }

    function hideSubmitError() {
      form.querySelector('[data-submit-error]').hidden = true;
    }

    function buildPayload() {
      var honeypotInput = document.getElementById('website');
      // Attribution (MP-1 §6). Values come from attribution.js, which
      // records only what actually arrived on the URL/referrer.
      //
      // `source` is '' when nothing was captured — deliberately NOT
      // 'direct'. The server contract (schema v4) also leaves an empty
      // source as '' rather than coercing it to 'direct' — "we don't know"
      // and "they typed the URL" stay distinct facts end to end.
      //
      // utm_source/medium/campaign/content/term, referrer and
      // landing_route are read from the raw attribution record (not the
      // derived source()/ctaLocation() helpers) and sent as-is — the
      // server (schema v4, ALLOWED_FIELDS) now accepts and persists them.
      // A missing field reads as undefined here; JSON.stringify below
      // renders it as "" via the `|| ''` fallback, matching every other
      // optional field in this payload.
      var attribution = window.ATTRIBUTION;
      var attributionRecord = attribution ? attribution.get() : {};

      return {
        lead_id: state.lead_id,
        source: attribution ? attribution.source() : '',
        cta_location: attribution ? attribution.ctaLocation() : '',
        // Measurement only. Not form fields, not shown back to the visitor,
        // and never treated as an order — the suitable service is still
        // decided in the call.
        service_interest: attribution ? attribution.serviceInterest() : '',
        service_price_revealed: attribution ? attribution.servicePriceRevealed() : '',
        service_log: attribution ? attribution.serviceLog() : '',
        browser_context: detectBrowserContext(),
        damage_type: state.damage_type,
        case_state: state.case_state,
        full_name: state.full_name,
        phone_raw: state.phone_raw,
        email: state.email,
        property_city: state.property_city,
        short_description: state.short_description,
        notice_version: LEGAL_RELEASE,
        policy_version: LEGAL_RELEASE,
        // Public protocol/version marker, not a credential. See
        // intake-config.js and checkClientMarker_ in apps-script/Code.gs.
        client_marker: window.INTAKE_CONFIG ? window.INTAKE_CONFIG.clientMarker : '',
        honeypot: honeypotInput ? honeypotInput.value : '',
        form_started_at: state.form_started_at,
        utm_source: attributionRecord.utm_source || '',
        utm_medium: attributionRecord.utm_medium || '',
        utm_campaign: attributionRecord.utm_campaign || '',
        utm_content: attributionRecord.utm_content || '',
        utm_term: attributionRecord.utm_term || '',
        fbclid: attributionRecord.fbclid || '',
        referrer: attributionRecord.referrer || '',
        landing_route: attributionRecord.landing_route || '',
        source_page: attributionRecord.source_page || ''
      };
    }

    // Simple request only (Handoff spec §2.1) — text/plain, no headers
    // that would trigger a CORS preflight against the Apps Script Web App.
    function sendLead() {
      var endpointUrl = window.INTAKE_CONFIG && window.INTAKE_CONFIG.endpointUrl;
      return fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(buildPayload()),
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS)
      }).then(function (res) {
        return res.json();
      });
    }

    function attemptPersist() {
      if (persistInFlight) return;

      var config = window.INTAKE_CONFIG || {};

      // Dry run — the public beta. NOT a hostname guess: an explicit flag,
      // because a hostname heuristic quietly becomes "live" the day the beta
      // moves. Nothing is sent, nothing is stored, and the flow still
      // completes so the whole UI can be reviewed. The beta build also
      // rewrites the success copy, so this state never claims a lead was
      // received. Production ships mode:'live' and never reaches this.
      if (config.mode === 'dryrun') {
        persistInFlight = true;
        setSubmitDisabled(true);
        hideSubmitError();
        showSendingStatus(true);
        window.setTimeout(function () {
          onPersistSuccess();
        }, DRYRUN_DELAY_MS);
        return;
      }

      // No endpoint configured => the lead cannot be saved. The capability
      // guard at init should have kept the form off the page entirely, so
      // reaching here means the configuration changed under us. Still a
      // failure, and still the approved generic failure state (§8.10.5) —
      // never a success message for something that was never sent.
      var endpointUrl = config.endpointUrl;
      if (!endpointUrl) {
        onPersistFailure();
        return;
      }

      persistInFlight = true;
      setSubmitDisabled(true);
      hideSubmitError();
      showSendingStatus(true);

      sendLead()
        .then(function (json) {
          if (json && json.ok) {
            onPersistSuccess();
          } else {
            return retryOnce();
          }
        })
        .catch(function () {
          return retryOnce();
        });
    }

    // Exactly one automatic retry, same lead_id, after a 2s wait — on
    // network error, timeout, or a response that isn't a valid ok:true.
    function retryOnce() {
      return new Promise(function (resolve) {
        setTimeout(resolve, RETRY_DELAY_MS);
      })
        .then(sendLead)
        .then(function (json) {
          if (json && json.ok) {
            onPersistSuccess();
          } else {
            onPersistFailure();
          }
        })
        .catch(function () {
          onPersistFailure();
        });
    }

    function onPersistSuccess() {
      persistInFlight = false;
      failureCount = 0;
      showSendingStatus(false);
      setSubmitDisabled(false);
      // The draft has served its purpose; leaving it would repopulate the
      // form if the user returns to /check/ in the same tab.
      try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
      showSuccessState();
    }

    function onPersistFailure() {
      persistInFlight = false;
      failureCount += 1;
      showSendingStatus(false);
      setSubmitDisabled(false);

      var errorEl = form.querySelector('[data-submit-error]');
      errorEl.hidden = false;
      form.querySelector('[data-submit-fallback]').hidden = failureCount < 2;
      errorEl.focus();
    }

    function restoreUIFromState() {
      RADIO_GROUPS.forEach(function (name) {
        if (!state[name]) return;
        var input = form.querySelector('input[name="' + name + '"][value="' + state[name] + '"]');
        if (input) input.checked = true;
      });
      TEXT_FIELDS.concat(OPTIONAL_TEXT_FIELDS).forEach(function (name) {
        var input = form.querySelector('#' + name);
        if (input && state[name]) input.value = state[name];
      });
    }

    loadState();
    if (!state.lead_id) state.lead_id = newLeadId();
    if (!state.form_started_at) state.form_started_at = new Date().toISOString();
    restoreUIFromState();
    bindEvents();
    bindSuccessActions();
    saveState();

    // ---- capability guard — Batch 3.14 -----------------------------------
    //
    // A form that takes a name and a phone number is a promise to do
    // something with them. If nothing can be saved — no endpoint, or the
    // build is prelaunch, or persistence was switched off — that promise
    // cannot be kept, and showing the form anyway would collect details only
    // to drop them. So the form is not offered at all: the fallback already
    // on the page becomes the answer, with WhatsApp first and the phone
    // second, both of which reach a human immediately.
    //
    // This is deliberately a capability check, not a mode check. It keeps
    // working after the production endpoint is activated: switch
    // leadPersistence to 'off' during an incident and the site degrades to
    // contact-only instead of silently failing on submit.
    var contact = window.TAVIV_CONTACT;
    var canPersist = !contact || contact.leadPersistenceAvailable();

    if (contact) {
      var waFallback = fallback.querySelector('[data-fallback-whatsapp]');
      if (waFallback) { waFallback.setAttribute('href', contact.whatsappUrl()); }
    }

    if (!canPersist) {
      // Same fallback element, honest heading: nothing failed to load, we
      // simply are not taking details right now.
      var title = fallback.querySelector('.intake-fallback__title');
      var body = fallback.querySelector('.intake-fallback__body');
      if (title) { title.textContent = 'אפשר ליצור קשר ישירות'; }
      if (body) { body.textContent = 'הטופס אינו פעיל כרגע. אפשר לכתוב בוואטסאפ או להתקשר, ונמשיך משם.'; }
      fallback.hidden = false;
      app.hidden = true;
      return;
    }

    // Everything above succeeded — reveal the real form, hide the fallback.
    fallback.hidden = true;
    app.hidden = false;
  } catch (err) {
    // Fail open: leave the accessible phone fallback visible. No PII in
    // this log — just the failure itself.
    console.error('Intake failed to initialize:', err);
  }
})();
