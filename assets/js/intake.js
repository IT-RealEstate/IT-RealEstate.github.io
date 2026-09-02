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
    // Batch 3.14C — the silent save. Two seconds of inactivity after the last
    // change to a field that matters, never a save per keystroke.
    var AUTOSAVE_DELAY_MS = 2000;
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

    // ---- Batch 3.14C — silent-save engine state ----
    // saveSeq rises with every attempt. A response carries the seq it was
    // issued for, so a reply that arrives after the values moved on can be
    // recognised and refused the right to call those newer values saved.
    var autosaveTimer = null;
    var saveSeq = 0;
    var inFlightSeq = 0;
    var leadCreated = false;          // the server confirmed a row exists
    var savedSnapshot = null;         // the exact values that row was created from
    var userInteracted = false;       // a real edit, not an autofill-on-load
    var enrichSeq = 0;
    var enrichInFlightFor = '';       // which question is being saved right now
    var phase = 'contact';            // contact -> damage_type -> case_state -> done

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

    // Batch 3.14C — the four states of the automatic save, in order. There is
    // deliberately no message before the details are eligible: promising a
    // save we are not about to perform is the one thing this area must never
    // do, and the line above the fields already says when it happens.
    var AUTOSAVE_MESSAGES = {
      pending:   'הפרטים יישמרו אוטומטית',
      saving:    'שומר את הפרטים…',
      saved:     'בגרסת הבדיקה הפרטים נשמרים זמנית בדפדפן בלבד ואינם נשלחים.',
      failed:    'לא הצלחנו לשמור כרגע. הפרטים נשארו כאן ואפשר לנסות שוב.'
    };
    var QUESTION_SAVING = 'שומר…';
    var QUESTION_FAILED = 'לא הצלחנו לשמור את התשובה. אפשר לנסות שוב.';

    // The order the questions are asked in, and the labels their collapsed
    // summaries carry. Codes are the canonical enum values the server already
    // accepts — no new value is introduced by this batch.
    var QUESTIONS = ['damage_type', 'case_state'];
    var QUESTION_TITLES = { damage_type: 'סוג הנזק', case_state: 'מצב המקרה' };

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


    // ======================================================================
    // Batch 3.14C — silent save and one-tap qualification
    // ======================================================================

    function ui(event, id) {
      if (window.ATTRIBUTION && typeof window.ATTRIBUTION.recordUiEvent === 'function') {
        window.ATTRIBUTION.recordUiEvent(event, id, 'check');
      }
    }

    function setAutosaveStatus(key) {
      var el = form.querySelector('[data-autosave-status]');
      if (!el) return;
      if (!key) { el.hidden = true; el.textContent = ''; el.removeAttribute('data-state'); return; }
      el.hidden = false;
      el.textContent = AUTOSAVE_MESSAGES[key];
      // The state is exposed as an attribute rather than a class so the
      // success tick can be styled on confirmation alone — there is no
      // selector that can draw it before the server has answered.
      el.setAttribute('data-state', key);
    }

    // The two fields the lead cannot exist without. Read from the DOM, not
    // from state, so an autofill that never fired a change event still counts.
    function contactValues() {
      var name = form.querySelector('#full_name');
      var phone = form.querySelector('#phone_raw');
      var email = form.querySelector('#email');
      return {
        full_name: name ? name.value.trim() : '',
        phone_raw: phone ? phone.value.trim() : '',
        email: email ? email.value.trim() : ''
      };
    }

    function emailIsSendable(value) {
      var input = form.querySelector('#email');
      // An empty address is not an error and is simply not sent. A partial
      // one is never transmitted: checkValidity() is the same test the field
      // itself applies, so what we refuse to send is what the field marks bad.
      if (value === '') return false;
      return !!input && input.checkValidity();
    }

    // Eligibility, in the order the owner defined it. Any legally required
    // acknowledgement is part of this gate: the notice on this screen is a
    // statement rather than a checkbox today, so there is nothing to tick —
    // but the check lives here so adding one later is a one-line change and
    // cannot be forgotten.
    function acknowledgementSatisfied() {
      var box = form.querySelector('[data-legal-ack]');
      return !box || box.checked;
    }

    function autosaveEligible() {
      if (!userInteracted) return false;
      if (!acknowledgementSatisfied()) return false;
      var v = contactValues();
      if (v.full_name === '') return false;
      if (!isValidIsraeliPhone(v.phone_raw)) return false;
      return true;
    }

    // A change to a field that matters restarts the clock. Anything typed
    // during the two seconds cancels the pending save rather than racing it.
    function scheduleAutosave() {
      if (autosaveTimer) { window.clearTimeout(autosaveTimer); autosaveTimer = null; }

      if (!autosaveEligible()) {
        // Not eligible: no promise, no success message left standing from an
        // earlier state. An already-created lead keeps its confirmation.
        if (!leadCreated) setAutosaveStatus(null);
        return;
      }

      if (!leadCreated) {
        ui('contact_autosave_eligible', 'contact');
        setAutosaveStatus('pending');
      } else if (!emailChangedSinceSave() && !contactChangedSinceSave()) {
        return;   // nothing new to send
      }

      autosaveTimer = window.setTimeout(function () {
        autosaveTimer = null;
        runAutosave();
      }, AUTOSAVE_DELAY_MS);
    }

    function emailChangedSinceSave() {
      if (!savedSnapshot) return false;
      var v = contactValues();
      return v.email !== savedSnapshot.email && emailIsSendable(v.email);
    }

    function contactChangedSinceSave() {
      if (!savedSnapshot) return false;
      var v = contactValues();
      return v.full_name !== savedSnapshot.full_name || v.phone_raw !== savedSnapshot.phone_raw;
    }

    function runAutosave() {
      if (!autosaveEligible()) return;

      // An immutable snapshot: everything downstream compares against this,
      // never against the live fields, so a value that moves while the
      // request is open cannot be quietly claimed as saved.
      var snapshot = contactValues();
      saveSeq += 1;
      var seq = saveSeq;

      if (leadCreated) {
        sendContactUpdate(snapshot, seq);
        return;
      }

      if (persistInFlight) return;
      persistInFlight = true;
      inFlightSeq = seq;
      setAutosaveStatus('saving');
      hideSubmitError();
      ui('contact_autosave_started', 'contact');

      persistSnapshot(snapshot, seq);
    }

    // The create call. lead_id is the idempotency key: it is generated once,
    // survives a reload in sessionStorage, and the server answers
    // duplicate:true for one it already holds rather than inserting again.
    function persistSnapshot(snapshot, seq) {
      var config = window.INTAKE_CONFIG || {};

      var finish = function (ok) {
        persistInFlight = false;
        if (ok) onAutosaveSuccess(snapshot, seq);
        else onAutosaveFailure();
      };

      if (config.mode === 'dryrun') {
        window.setTimeout(function () { finish(true); }, DRYRUN_DELAY_MS);
        return;
      }
      if (!config.endpointUrl) { finish(false); return; }

      sendLead()
        .then(function (json) {
          if (json && json.ok) { finish(true); return; }
          return new Promise(function (r) { setTimeout(r, RETRY_DELAY_MS); })
            .then(sendLead)
            .then(function (j2) { finish(!!(j2 && j2.ok)); })
            .catch(function () { finish(false); });
        })
        .catch(function () {
          return new Promise(function (r) { setTimeout(r, RETRY_DELAY_MS); })
            .then(sendLead)
            .then(function (j2) { finish(!!(j2 && j2.ok)); })
            .catch(function () { finish(false); });
        });
    }

    function onAutosaveSuccess(snapshot, seq) {
      // The row exists either way — record that first, so no later path can
      // create a second one.
      leadCreated = true;
      failureCount = 0;
      try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}

      var current = contactValues();
      var stale = seq !== saveSeq ||
                  current.full_name !== snapshot.full_name ||
                  current.phone_raw !== snapshot.phone_raw;

      savedSnapshot = snapshot;

      if (stale) {
        // A reply for values the visitor has already moved past. It may not
        // claim the newer ones are saved, and it may not open the questions
        // on them. The corrected values go up as an update to the same row.
        setAutosaveStatus('pending');
        scheduleAutosave();
        return;
      }

      ui('contact_autosave_succeeded', 'contact');
      setAutosaveStatus('saved');
      revealQuestion('damage_type');

      // An address typed while the first save was in flight belongs on the
      // same row, and needs no further interaction to get there.
      if (emailChangedSinceSave()) scheduleAutosave();
    }

    function onAutosaveFailure() {
      failureCount += 1;
      ui('contact_autosave_failed', 'contact');
      setAutosaveStatus('failed');
      var errorEl = form.querySelector('[data-submit-error]');
      if (errorEl) {
        errorEl.hidden = false;
        var fb = form.querySelector('[data-submit-fallback]');
        if (fb) fb.hidden = failureCount < 2;
      }
    }

    // A later contact change updates the row that already exists. Never a
    // second lead: same lead_id, op:'enrich'.
    function sendContactUpdate(snapshot, seq) {
      var payload = { lead_id: state.lead_id };
      if (snapshot.email !== (savedSnapshot ? savedSnapshot.email : '') &&
          emailIsSendable(snapshot.email)) {
        payload.email = snapshot.email;
      }
      if (savedSnapshot && snapshot.full_name !== savedSnapshot.full_name) {
        payload.full_name = snapshot.full_name;
      }
      if (savedSnapshot && snapshot.phone_raw !== savedSnapshot.phone_raw) {
        payload.phone_raw = snapshot.phone_raw;
      }
      var keys = Object.keys(payload).filter(function (k) { return k !== 'lead_id'; });
      if (!keys.length) return;

      sendEnrichPayload(payload).then(function (result) {
        // Same staleness rule: a reply for superseded values may not mark
        // what is on screen now as saved.
        if (seq !== saveSeq) return;
        if (result.ok) {
          savedSnapshot = snapshot;
          if (phase === 'contact') setAutosaveStatus('saved');
        }
      });
    }

    // One transport for every update to an existing lead. Resolves
    // {ok, enriched} and never throws, so callers branch on data rather than
    // on exceptions.
    function sendEnrichPayload(payload) {
      var config = window.INTAKE_CONFIG || {};
      var body = Object.assign({
        op: 'enrich',
        client_marker: config.clientMarker || ''
      }, payload);

      if (config.mode === 'dryrun') {
        return new Promise(function (resolve) {
          window.setTimeout(function () {
            resolve({ ok: true, enriched: Object.keys(payload).filter(function (k) {
              return k !== 'lead_id';
            }) });
          }, DRYRUN_DELAY_MS);
        });
      }
      if (!config.endpointUrl) return Promise.resolve({ ok: false, enriched: [] });

      return fetch(config.endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS)
      })
        .then(function (res) { return res.json(); })
        .then(function (json) {
          return { ok: !!(json && json.ok), enriched: (json && json.enriched) || [] };
        })
        .catch(function () { return { ok: false, enriched: [] }; });
    }

    // ---- the two questions ----

    function questionSection(name) {
      return form.querySelector('.intake-q[data-step="' + name + '"]');
    }

    function revealQuestion(name) {
      var section = questionSection(name);
      if (!section) return;
      phase = name;
      section.hidden = false;
      // Focus the question itself, not its first option: a screen reader then
      // hears what is being asked before it hears the choices.
      var legend = section.querySelector('.intake-q__legend');
      if (legend) legend.focus();
    }

    function setQuestionStatus(name, text) {
      var el = form.querySelector('[data-q-status="' + name + '"]');
      if (!el) return;
      el.hidden = !text;
      el.textContent = text || '';
    }

    function setQuestionRetry(name, visible) {
      var btn = form.querySelector('[data-q-retry="' + name + '"]');
      if (btn) btn.hidden = !visible;
    }

    // Saving an answer. The selection stays visible whatever happens; the
    // flow advances only once the server confirms the field was written.
    function saveAnswer(name, value, isRevision) {
      if (enrichInFlightFor === name) return;
      enrichInFlightFor = name;
      enrichSeq += 1;
      var seq = enrichSeq;

      state[name] = value;
      setQuestionRetry(name, false);
      setQuestionStatus(name, QUESTION_SAVING);

      var payload = { lead_id: state.lead_id };
      payload[name] = value;

      sendEnrichPayload(payload).then(function (result) {
        if (seq !== enrichSeq) return;          // a newer choice supersedes this
        enrichInFlightFor = '';

        // ok:true alone is not confirmation. The server answers ok:true for a
        // write it skipped, so the field has to appear in `enriched` before
        // this counts as saved — otherwise a revision would advance the flow
        // while the sheet still held the previous answer.
        var confirmed = result.ok && result.enriched.indexOf(name) !== -1;
        if (!confirmed) {
          setQuestionStatus(name, QUESTION_FAILED);
          setQuestionRetry(name, true);
          // One automatic retry before asking the visitor to do anything.
          if (!isRevision) {
            window.setTimeout(function () {
              if (state[name] === value && phase === name) saveAnswer(name, value, true);
            }, RETRY_DELAY_MS);
          }
          return;
        }

        setQuestionStatus(name, '');
        setQuestionRetry(name, false);
        ui(name === 'damage_type' ? 'damage_type_saved' : 'case_status_saved', value.toLowerCase());
        collapseQuestion(name, value);

        var next = QUESTIONS[QUESTIONS.indexOf(name) + 1];
        if (next && !state[next]) {
          revealQuestion(next);
        } else if (!next) {
          ui('qualification_completed', 'check');
          showCompletion();
        } else {
          // Revising an earlier answer when the later one is already given:
          // go back to where the visitor was rather than asking again.
          if (state.case_state) showCompletion();
          else revealQuestion(next);
        }
      });
    }

    // An answered question becomes a one-line summary with a change control.
    function collapseQuestion(name, value) {
      var section = questionSection(name);
      if (section) section.hidden = true;

      var list = document.querySelector('[data-answers]');
      if (!list) return;
      list.hidden = false;

      var id = 'answer-' + name;
      var item = list.querySelector('#' + id);
      if (!item) {
        item = document.createElement('li');
        item.className = 'intake-answer';
        item.id = id;
        list.appendChild(item);
      }
      var label = form.querySelector('#' + name + '_' + value + ' ~ .intake-option__label');
      item.textContent = '';

      var title = document.createElement('span');
      title.className = 'intake-answer__title';
      title.textContent = QUESTION_TITLES[name] + ': ';
      var chosen = document.createElement('span');
      chosen.className = 'intake-answer__value';
      chosen.textContent = label ? label.textContent : value;
      var change = document.createElement('button');
      change.type = 'button';
      change.className = 'intake-link-btn intake-answer__change';
      change.textContent = 'שינוי';
      change.setAttribute('aria-label', 'שינוי ' + QUESTION_TITLES[name]);
      change.addEventListener('click', function () {
        var completion = document.querySelector('[data-intake-success]');
        if (completion) completion.hidden = true;
        form.hidden = false;
        item.remove();
        if (!list.querySelector('.intake-answer')) list.hidden = true;
        revealQuestion(name);
      });

      item.appendChild(title);
      item.appendChild(chosen);
      item.appendChild(document.createTextNode(' '));
      item.appendChild(change);
    }

    function bindQuestions() {
      QUESTIONS.forEach(function (name) {
        var section = questionSection(name);
        if (!section) return;
        section.addEventListener('change', function (e) {
          var t = e.target;
          if (t.name !== name || !t.checked) return;
          saveAnswer(name, t.value, !!state[name] && state[name] !== t.value);
        });
        var retry = form.querySelector('[data-q-retry="' + name + '"]');
        if (retry) {
          retry.addEventListener('click', function () {
            var checked = section.querySelector('input[name="' + name + '"]:checked');
            if (checked) saveAnswer(name, checked.value, true);
          });
        }
      });
    }

    function showCompletion() {
      phase = 'done';
      form.hidden = true;
      showSuccessState();
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
        // Autofill delivers values through 'change' without a keystroke, and
        // must reach the same validation and the same two-second clock.
        if (t.type !== 'radio') { userInteracted = true; scheduleAutosave(); }
      });

      // Batch 3.14C — the save is driven by typing, not by a button. 'input'
      // rather than 'change' so the two-second clock starts from the last
      // keystroke; autofill fires 'change' and is caught by the handler above,
      // which calls the same scheduler.
      form.addEventListener('input', function (e) {
        var t = e.target;
        if (!t.name || t.name === 'website') return;
        if (t.type === 'radio') return;
        state[t.name] = t.value;
        userInteracted = true;
        if (t.getAttribute('aria-invalid') === 'true') {
          if (t.id === 'short_description') validateShortDescription();
          else validateTextField(t);
        }
        saveState();
        scheduleAutosave();
      });

      // The form has no submit button in the normal flow. This exists only so
      // that Enter in a text field cannot navigate away mid-save.
      form.addEventListener('submit', function (e) {
        e.preventDefault();
      });

      // Manual retry — reachable only from the error state, never part of the
      // successful flow.
      form.querySelectorAll('[data-action="retry-submit"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          hideSubmitError();
          if (!validateStep()) return;
          runAutosave();
        });
      });

      bindQuestions();

      // /check/ does not load main.js, so the generic WhatsApp links on this
      // page are wired here. The URL is the bare number plus the prepared
      // message — never a name, a phone number, an address or a lead id.
      if (window.TAVIV_CONTACT && typeof window.TAVIV_CONTACT.whatsappUrl === 'function') {
        var waUrl = window.TAVIV_CONTACT.whatsappUrl();
        document.querySelectorAll('[data-wa-link]').forEach(function (a) {
          a.setAttribute('href', waUrl);
          a.addEventListener('click', function () { ui('whatsapp_click', 'escape'); });
        });
      }
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
            window.ATTRIBUTION.recordUiEvent('post_save_whatsapp_clicked', 'check', 'check');
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

    function hideSubmitError() {
      var el = form.querySelector('[data-submit-error]');
      if (el) el.hidden = true;
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

    // Batch 3.14C — the old submit-driven persistence path (attemptPersist,
    // retryOnce, onPersistSuccess, onPersistFailure) is gone with the button
    // that drove it. Creation now runs through runAutosave/persistSnapshot,
    // and every later write through sendEnrichPayload.

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
