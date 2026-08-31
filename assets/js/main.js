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
