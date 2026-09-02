(function () {
  'use strict';

  // Mark JS as running. Reveal-hiding CSS lives only under .js-ready
  // (see base.css) so a script failure leaves all content visible —
  // accessibility spec §16.1, "reveal system must fail open."
  document.documentElement.classList.add('js-ready');

  // Persistent sticky header — full -> compact after ~80px scroll.
  // The header never hides; only its size/secondary-line state changes.
  var header = document.querySelector('[data-header]');
  if (header) {
    var ticking = false;

    var updateHeader = function () {
      header.classList.toggle('is-compact', window.scrollY > 80);
      ticking = false;
    };

    updateHeader();

    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(updateHeader);
        ticking = true;
      }
    }, { passive: true });
  }

  // Which page an interaction happened on, as a short stable slug. Never a
  // full URL: a query string can carry things a log should not.
  function pageSlug() {
    var path = location.pathname.replace(/\/index\.html$/, '/');
    if (path === '/' || path === '') { return 'home'; }
    return path.replace(/^\/|\/$/g, '').replace(/[^a-z0-9/_-]/gi, '').toLowerCase();
  }

  // FAQ — Batch 3.14 FAQ addendum.
  //
  // <details> already gives the whole component its behaviour: the summary is
  // a real button, keyboard operable, with correct expanded state exposed to
  // assistive tech, and the answer text is in the DOM whether it is open or
  // not. Nothing here creates or replaces any of that — it only records which
  // answers people open, so the copy can be judged on what it does.
  //
  // No answer text and no personal data leave the page: an event name, the
  // stable question id from content/faq.json, and the page slug.
  Array.prototype.forEach.call(document.querySelectorAll('[data-faq-item]'), function (item) {
    item.addEventListener('toggle', function () {
      if (!window.ATTRIBUTION || typeof window.ATTRIBUTION.recordUiEvent !== 'function') { return; }
      window.ATTRIBUTION.recordUiEvent(item.open ? 'faq_open' : 'faq_close',
        item.getAttribute('data-faq-id') || '', pageSlug());
    });
  });

  // The FAQ closing CTA. Its lead attribution rides the existing
  // data-cta-location mechanism; this only adds the finer-grained record of
  // where the click came from, which the lead enum has no value for.
  Array.prototype.forEach.call(document.querySelectorAll('[data-ui-location]:not([data-wa-link])'), function (el) {
    el.addEventListener('click', function () {
      if (window.ATTRIBUTION && typeof window.ATTRIBUTION.recordUiEvent === 'function') {
        window.ATTRIBUTION.recordUiEvent('cta_click', el.getAttribute('data-ui-location'), pageSlug());
      }
    });
  });

  // WhatsApp links — Batch 3.14.
  //
  // Every wa.me link on the site is written from the one central config, so
  // the number and the prepared message live in a single place and a future
  // App-generated handoff replaces them without touching any button. The
  // markup ships with a working generic href, so the link is correct even if
  // this script never runs.
  //
  // The URL never carries a name, a phone number, a form value or a lead id:
  // it is visible in the address bar, in browsing history, and to anything
  // that logs a navigation.
  var contact = window.TAVIV_CONTACT;
  if (contact) {
    var waUrl = contact.whatsappUrl();
    Array.prototype.forEach.call(document.querySelectorAll('[data-wa-link]'), function (link) {
      link.setAttribute('href', waUrl);
      link.addEventListener('click', function () {
        // A CTA event, never a lead: opening WhatsApp creates nothing. It
        // goes to the UI channel rather than service_log — that column is
        // part of the lead record and means "which service was looked at".
        if (window.ATTRIBUTION && typeof window.ATTRIBUTION.recordUiEvent === 'function') {
          var where = link.getAttribute('data-ui-location') || 'header';
          window.ATTRIBUTION.recordUiEvent('whatsapp_click', where, pageSlug());
        }
      });
    });
  }

  // Navigation menu — Batch 3.7 / OD-3.7-02.
  // No dependency, no library, no animation. The panel's visibility is the
  // `hidden` attribute and nothing else, so with JS off the menu is simply
  // absent rather than stuck open over the page — the same fail-safe
  // direction as the reveal system above, applied to a control instead of
  // to content. Every destination in the panel is also reachable without
  // the menu (they are ordinary links to / , /damage/ and /check/).
  var menuBtn = document.querySelector('[data-menu-toggle]');
  var menuPanel = document.querySelector('[data-menu]');

  if (menuBtn && menuPanel) {
    // Same defensive posture the reveal system below uses: an engine
    // without Element.closest must not throw here and strand the panel.
    var withinHeader = function (node) {
      while (node && node.nodeType === 1) {
        if (node.classList && node.classList.contains('site-header')) { return true; }
        node = node.parentNode;
      }
      return false;
    };

    var setMenu = function (open, returnFocus) {
      menuPanel.hidden = !open;
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      // Background must not scroll while the panel is open.
      document.body.classList.toggle('menu-open', open);
      if (open) {
        // Move focus into the panel so the keyboard path is unambiguous:
        // Tab continues through the menu items, Escape comes back out.
        var first = menuPanel.querySelector('a');
        if (first) { first.focus(); }
      } else if (returnFocus) {
        // Focus returns to the button that opened it — never to the top of
        // the document.
        menuBtn.focus();
      }
    };

    menuBtn.addEventListener('click', function () {
      setMenu(menuBtn.getAttribute('aria-expanded') !== 'true', true);
    });

    // Escape closes from anywhere, including from inside the panel.
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && !menuPanel.hidden) {
        setMenu(false, true);
      }
    });

    // Clicking a link navigates; close first so a same-page anchor jump
    // doesn't land under an open panel with the background still locked.
    // No focus return here — the destination takes focus.
    menuPanel.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== menuPanel) {
        if (node.tagName === 'A') { setMenu(false, false); return; }
        node = node.parentNode;
      }
    });

    // A click outside the header dismisses it, matching what a pointer user
    // expects from a dropdown.
    document.addEventListener('click', function (e) {
      if (!menuPanel.hidden && !withinHeader(e.target)) {
        setMenu(false, false);
      }
    });

    // Focus leaving the header entirely (Tab past the last item) closes it,
    // so the panel can never sit open behind an unrelated focused control.
    document.addEventListener('focusin', function (e) {
      if (!menuPanel.hidden && !withinHeader(e.target)) {
        setMenu(false, false);
      }
    });
  }

  // Reveal-on-scroll — v2.1 §28, the single motion system for the site.
  // Applied via [data-reveal] on headings / major statements / major
  // image-text groups. Not used by the Hero (visible on load).
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReducedMotion && 'IntersectionObserver' in window) {
    var revealTargets = document.querySelectorAll('[data-reveal]');
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.25 });

    // Array.prototype.forEach.call, not NodeList.prototype.forEach: the
    // latter is absent in the same older engines this file already guards
    // for, and a throw here would strand every [data-reveal] element at
    // opacity:0 (.js-ready is set at line 7, before this runs). Same
    // defensive pattern attribution.js already uses.
    Array.prototype.forEach.call(revealTargets, function (el) {
      observer.observe(el);
    });
  } else {
    // Reduced motion (or no IntersectionObserver support): reveal
    // everything immediately rather than leaving it opacity:0 forever.
    // This is the fail-open path accessibility spec §16.1 requires, so it
    // must not itself depend on an API the no-IntersectionObserver
    // engines lack — see the note above.
    Array.prototype.forEach.call(
      document.querySelectorAll('[data-reveal]'),
      function (el) {
        el.classList.add('is-revealed');
      }
    );
  }

  // Services — guided routing + progressive disclosure.
  // Batch 3.9 / Content Spec §0.6, routed in Batch 3.11 / §0.8.
  //
  // Two layers, deliberately separate:
  //
  //   ROUTER    state -> outcome -> the one route that matches. Answering a
  //             question shows a route; it never reveals a price and never
  //             records a service interest.
  //   DISCLOSURE  per route: content open -> price revealed, each on the
  //             visitor's own click. Only the CTA link leaves the page.
  //
  // A price therefore needs four deliberate acts: identify the situation,
  // choose the outcome, open the content, ask for the price.
  //
  // No network request fires for any of it (§0.8). Everything goes into
  // sessionStorage — routing answers alongside the disclosure state, under
  // the one key svc_ui_v1, rather than a second competing mechanism.
  var serviceCards = document.querySelectorAll('[data-service]');
  var router = document.querySelector('[data-router]');

  if (serviceCards.length || router) {
    var SVC_KEY = 'svc_ui_v1';
    var attribution = window.ATTRIBUTION;

    // Batch 3.13C — disclosure is ONE-WAY. Opening content is progress the
    // visitor asked for; a control that undoes it turns an answer back into a
    // question, and a hide-the-price label is one this UI must never produce.
    // So the control that was used is removed, and the content it revealed
    // stays. There is no reverse control and no label to swap.
    //
    // Removing the control drops focus to <body>, which is exactly the
    // surprise §0.6 forbids — so focus moves to what was just revealed
    // instead. tabindex is set here rather than in the markup: it exists only
    // to receive this one programmatic focus, never to add a tab stop.
    var focusRevealed = function (el) {
      if (!el) { return; }
      if (!el.hasAttribute('tabindex')) { el.setAttribute('tabindex', '-1'); }
      try { el.focus({ preventScroll: false }); } catch (e) { el.focus(); }
    };

    // UI state, not attribution: it lives under its own key and never joins
    // the record that travels with a lead. §0.8 — "מצב החשיפה נשמר לאורך
    // ה-session", and coming back from /check/ must not reset the route.
    var loadSvcState = function () {
      var parsed = null;
      try {
        var raw = sessionStorage.getItem(SVC_KEY);
        parsed = raw ? JSON.parse(raw) : null;
      } catch (e) {
        parsed = null;
      }
      var arr = function (v) {
        return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
      };
      var str = function (v) { return typeof v === 'string' ? v : ''; };
      return {
        body: arr(parsed && parsed.body),
        price: arr(parsed && parsed.price),
        // Added in 3.11. An older record simply has no answers, which is
        // exactly the initial state, so nothing needs migrating.
        q1: str(parsed && parsed.q1),
        q2: str(parsed && parsed.q2)
      };
    };

    var svcState = loadSvcState();

    var saveSvcState = function () {
      try {
        sessionStorage.setItem(SVC_KEY, JSON.stringify(svcState));
      } catch (e) {
        // Private mode / quota: the router and the panels still work, they
        // just will not be restored on the next page. Never a reason to
        // block the control.
      }
    };

    var setMember = function (list, id, on) {
      var i = list.indexOf(id);
      if (on && i === -1) { list.push(id); }
      if (!on && i !== -1) { list.splice(i, 1); }
    };

    var logSvc = function (eventName, id) {
      if (attribution && typeof attribution.recordServiceEvent === 'function') {
        attribution.recordServiceEvent(eventName, id);
      }
    };

    // Per-service handles, so the router can drive a card it does not own.
    var cards = {};

    Array.prototype.forEach.call(serviceCards, function (card) {
      var id = card.getAttribute('data-service');
      var toggle = card.querySelector('[data-svc-toggle]');
      var body = card.querySelector('[data-svc-body]');
      var reveal = card.querySelector('[data-svc-reveal]');
      var price = card.querySelector('[data-svc-price]');
      var cta = card.querySelector('[data-service-interest]');
      if (!id || !body) { return; }

      // `record` is false while restoring: replaying a saved state is not a
      // new interaction, so it logs nothing and never steals focus. A
      // consumed control stays consumed across the session either way.
      var openBody = function (record) {
        body.hidden = false;
        if (toggle) {
          toggle.setAttribute('aria-expanded', 'true');
          toggle.hidden = true;
        }
        setMember(svcState.body, id, true);
        saveSvcState();
        if (record) {
          logSvc('service_details_open', id);
          focusRevealed(body);
        }
      };

      var openPrice = function (record) {
        // remote_feasibility has neither control nor price box since Batch
        // 3.13C, so this is a no-op for it and no price event can fire.
        if (!reveal || !price) { return; }
        price.hidden = false;
        reveal.setAttribute('aria-expanded', 'true');
        reveal.hidden = true;
        setMember(svcState.price, id, true);
        saveSvcState();
        if (record) {
          logSvc('service_price_reveal', id);
          focusRevealed(price);
        }
      };

      if (toggle) {
        toggle.addEventListener('click', function () { openBody(true); });
      }

      if (reveal && price) {
        reveal.addEventListener('click', function () { openPrice(true); });
      }

      // The CTA is an ordinary link to /check/. attribution.js records
      // cta_location + service_interest on the same click; this only adds
      // the event to the interaction log. Nothing here cancels the
      // navigation, and nothing here presents the click as a purchase.
      if (cta) {
        cta.addEventListener('click', function () {
          logSvc('service_cta_click', id);
        });
      }

      cards[id] = { openBody: openBody, openPrice: openPrice, hasToggle: !!toggle };

      // Restore. The price panel lives inside the body panel, so a restored
      // price implies a restored body — otherwise the saved state would be
      // unreachable. Restoring also re-hides the consumed controls, so coming
      // back to the section never puts a used button in front of the visitor
      // again.
      if (svcState.price.indexOf(id) !== -1) {
        if (toggle) { openBody(false); }
        openPrice(false);
      } else if (toggle && svcState.body.indexOf(id) !== -1) {
        openBody(false);
      }
    });

    // ---- Router --------------------------------------------------------
    if (router) {
      var qBlocks = {};
      Array.prototype.forEach.call(router.querySelectorAll('[data-router-q]'), function (el) {
        qBlocks[el.getAttribute('data-router-q')] = el;
      });
      var routeBlocks = router.querySelectorAll('[data-route]');
      var intro = router.querySelectorAll('[data-router-intro]');
      var answered = router.querySelector('[data-router-answered]');
      var summary = router.querySelector('[data-router-summary]');
      var resetBtn = router.querySelector('[data-router-reset]');
      var feasToggle = router.querySelector('[data-feas-toggle]');
      var feasPanel = router.querySelector('[data-feas]');
      // Lives in the section's closing block, outside the router, so it is
      // found from the document rather than from `router`.
      var closeCta = document.querySelector('[data-close-cta]');

      // The summary reuses each option's own approved label rather than
      // inventing a sentence for it — no new copy, and it always matches
      // what the visitor actually read when they chose.
      var labelFor = function (name, value) {
        var input = router.querySelector('input[name="' + name + '"][value="' + value + '"]');
        var label = input && input.parentNode.querySelector('.rt__opt-label');
        return label ? label.textContent.trim() : '';
      };

      var routeFor = function () {
        if (svcState.q1 === 'yes') { return 'insurer_gap'; }
        if (svcState.q1 === 'no' && svcState.q2) { return svcState.q2; }
        return '';
      };

      var render = function () {
        var active = routeFor();
        var showQ2 = svcState.q1 === 'no' && !svcState.q2;
        var anyAnswer = !!svcState.q1;

        qBlocks.q1.hidden = anyAnswer;
        if (qBlocks.q2) { qBlocks.q2.hidden = !showQ2; }

        Array.prototype.forEach.call(intro, function (el) { el.hidden = anyAnswer; });

        Array.prototype.forEach.call(routeBlocks, function (el) {
          el.hidden = el.getAttribute('data-route') !== active;
        });

        // Batch 3.13C — the "unsure" route already opens with an entry-check
        // button carrying this exact label, so showing the section's summary
        // CTA below it repeated the same call to action on one screen. Hidden
        // for that route only; every other route still ends on it.
        if (closeCta) { closeCta.hidden = active === 'unsure'; }

        if (answered && summary) {
          answered.hidden = !anyAnswer;
          var parts = [];
          if (svcState.q1) { parts.push(labelFor('rt-q1', svcState.q1)); }
          if (svcState.q2) { parts.push(labelFor('rt-q2', svcState.q2)); }
          summary.textContent = parts.join(' · ');
        }
      };

      Array.prototype.forEach.call(router.querySelectorAll('[data-router-input]'), function (input) {
        input.addEventListener('change', function () {
          if (!input.checked) { return; }
          if (input.name === 'rt-q1') {
            svcState.q1 = input.value;
            svcState.q2 = '';
            // Clear the other group so a reset-and-reanswer cannot leave a
            // stale radio checked underneath a hidden fieldset.
            Array.prototype.forEach.call(
              router.querySelectorAll('input[name="rt-q2"]'),
              function (o) { o.checked = false; }
            );
          } else {
            svcState.q2 = input.value;
          }
          saveSvcState();
          render();
          // Choosing an answer records nothing about a service. §0.8:
          // service_interest must never become remote_feasibility just
          // because someone said they were not sure.
        });
      });

      if (resetBtn) {
        resetBtn.addEventListener('click', function () {
          svcState.q1 = '';
          svcState.q2 = '';
          Array.prototype.forEach.call(
            router.querySelectorAll('[data-router-input]'),
            function (o) { o.checked = false; }
          );
          saveSvcState();
          render();
          // The button the visitor pressed is now hidden, so focus would
          // fall to <body>. Send it to the question that replaced it —
          // the expected destination, not a surprise.
          var first = qBlocks.q1.querySelector('input');
          if (first) { first.focus(); }
          // Disclosure state is deliberately NOT cleared: §0.8 says a price
          // already revealed in this session stays revealed.
        });
      }

      // "What does a feasibility check include?" — the explicit interaction
      // that §0.8 requires before remote_feasibility may be shown at all,
      // and the only thing that records interest in it.
      if (feasToggle && feasPanel) {
        // One-way, like every other disclosure control: it opens the
        // explanation, then removes itself. There is no price behind it to
        // reveal — remote_feasibility has carried no public figure since
        // Batch 3.13C — so this is the last step in that route, and the
        // visitor's next move is the entry-check button above.
        var openFeas = function (record) {
          feasPanel.hidden = false;
          feasToggle.setAttribute('aria-expanded', 'true');
          feasToggle.hidden = true;
          setMember(svcState.body, 'remote_feasibility', true);
          saveSvcState();
          if (record) {
            logSvc('service_details_open', 'remote_feasibility');
            focusRevealed(feasPanel);
          }
        };

        feasToggle.addEventListener('click', function () { openFeas(true); });

        if (svcState.body.indexOf('remote_feasibility') !== -1 ||
            svcState.price.indexOf('remote_feasibility') !== -1) {
          openFeas(false);
        }
      }

      render();
    }
  }

  // Accordions — Batch 3.7 / OD-3.7-04, amended after the 31.08 QA pass.
  //
  // They now ship closed at EVERY width, so no JavaScript runs here at all
  // and this block is gone. Previously main.js expanded them at >=768px;
  // measured on /damage/ at 1363px that made the FAQ section 948px tall
  // with all five answers open at once, which is exactly the "long and
  // sparse, hard to scan" problem the same pass flagged elsewhere.
  //
  // Closed is also the safer default in both directions: <details> needs
  // no script to open, its panel content stays in the DOM either way, so
  // nothing is unreachable to a reader, to find-in-page, or to a crawler.
  // The owner decision only ever required "closed by default on mobile";
  // desktop-open was an implementation choice, and it is withdrawn.
})();
