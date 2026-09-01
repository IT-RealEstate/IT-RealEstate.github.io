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
    var HINT_CLOSED = 'לחצו להצגת תוכן השירות';
    var HINT_OPEN = 'לחצו לסגירת תוכן השירות';
    var PRICE_SHOW = 'להציג את המחיר';
    var PRICE_HIDE = 'להסתיר את המחיר';
    var attribution = window.ATTRIBUTION;

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
      var hint = card.querySelector('.svc__hint');
      var cta = card.querySelector('[data-service-interest]');
      if (!id || !body) { return; }

      // `record` is false while restoring: replaying a saved state is not a
      // new interaction and must not inflate the event log.
      var setBody = function (open, record) {
        body.hidden = !open;
        if (toggle) {
          toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        if (hint) { hint.textContent = open ? HINT_OPEN : HINT_CLOSED; }
        setMember(svcState.body, id, open);
        saveSvcState();
        if (open && record) { logSvc('service_details_open', id); }
      };

      var setPrice = function (open, record) {
        if (!reveal || !price) { return; }
        price.hidden = !open;
        reveal.setAttribute('aria-expanded', open ? 'true' : 'false');
        // The control stays put and becomes its own opposite. Hiding it
        // instead would drop focus to <body> for anyone who pressed it with
        // a keyboard, and §0.6 forbids a surprising focus change.
        reveal.textContent = open ? PRICE_HIDE : PRICE_SHOW;
        setMember(svcState.price, id, open);
        saveSvcState();
        if (open && record) { logSvc('service_price_reveal', id); }
      };

      if (toggle) {
        toggle.addEventListener('click', function () {
          setBody(toggle.getAttribute('aria-expanded') !== 'true', true);
        });
      }

      if (reveal && price) {
        reveal.addEventListener('click', function () {
          setPrice(reveal.getAttribute('aria-expanded') !== 'true', true);
        });
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

      cards[id] = { setBody: setBody, setPrice: setPrice, hasToggle: !!toggle };

      // Restore. The price panel lives inside the body panel, so a restored
      // price implies a restored body — otherwise the saved state would be
      // unreachable.
      if (svcState.price.indexOf(id) !== -1) {
        if (toggle) { setBody(true, false); }
        setPrice(true, false);
      } else if (toggle && svcState.body.indexOf(id) !== -1) {
        setBody(true, false);
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
        feasToggle.addEventListener('click', function () {
          var open = feasToggle.getAttribute('aria-expanded') !== 'true';
          feasPanel.hidden = !open;
          feasToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
          setMember(svcState.body, 'remote_feasibility', open);
          saveSvcState();
          if (open) { logSvc('service_details_open', 'remote_feasibility'); }
        });

        if (svcState.body.indexOf('remote_feasibility') !== -1 ||
            svcState.price.indexOf('remote_feasibility') !== -1) {
          feasPanel.hidden = false;
          feasToggle.setAttribute('aria-expanded', 'true');
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
