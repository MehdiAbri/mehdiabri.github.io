/**
 * A small progressive-enhancement layer for the Minakari academic site.
 * All pages and links remain usable when JavaScript is unavailable.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const menuButton = document.getElementById('menu-toggle');
  const navigation = document.getElementById('primary-navigation');

  if (menuButton && navigation) {
    const focusableSelector = 'a[href], button, input, select, textarea, [tabindex]';
    const originalTabIndices = new Map();
    // Scope this preference to the website, including GitHub Pages project sites.
    const homeLink = navigation.querySelector('a[href]');
    const sitePath = new URL(homeLink?.href || window.location.href).pathname.replace(/[^/]*$/u, '');
    const menuStorageKey = 'minakari:menu:' + sitePath;
    let isOpen = false;

    const readMenuState = () => {
      try {
        return window.sessionStorage.getItem(menuStorageKey) === 'open';
      } catch {
        // Storage can be disabled; the menu must still work on the current page.
        return null;
      }
    };

    navigation.querySelectorAll(focusableSelector).forEach((element) => {
      originalTabIndices.set(element, element.getAttribute('tabindex'));
    });

    const setMenuState = (open, { restoreFocus = false, persist = true } = {}) => {
      isOpen = Boolean(open);
      // Move focus before hiding a focused descendant from the accessibility tree.
      if (!isOpen && restoreFocus) {
        menuButton.focus({ preventScroll: true });
      }
      menuButton.setAttribute('aria-expanded', String(isOpen));
      menuButton.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
      navigation.inert = !isOpen;
      navigation.setAttribute('aria-hidden', String(!isOpen));
      navigation.classList.toggle('is-open', isOpen);
      navigation.dataset.state = isOpen ? 'open' : 'closed';

      // Tab-index handling also supports browsers without native inert support.
      originalTabIndices.forEach((originalValue, element) => {
        if (!isOpen) {
          element.setAttribute('tabindex', '-1');
        } else if (originalValue === null) {
          element.removeAttribute('tabindex');
        } else {
          element.setAttribute('tabindex', originalValue);
        }
      });

      if (persist) {
        try {
          window.sessionStorage.setItem(menuStorageKey, isOpen ? 'open' : 'closed');
        } catch {
          // Navigation remains usable even when session storage is unavailable.
        }
      }
    };

    // Restore before enabling the visual treatment so page navigation does not
    // replay the closed-to-open animation or dismiss an already open menu.
    setMenuState(readMenuState(), { persist: false });
    root.classList.add('js');

    // A cached history entry may predate a preference changed on another page.
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      const savedState = readMenuState();
      if (savedState !== null) {
        setMenuState(savedState, {
          persist: false,
          restoreFocus: !savedState && navigation.contains(document.activeElement)
        });
      }
    });

    menuButton.addEventListener('click', () => setMenuState(!isOpen));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        setMenuState(false, { restoreFocus: true });
      }
    });

    document.addEventListener('pointerdown', (event) => {
      if (!isOpen || navigation.contains(event.target) || menuButton.contains(event.target)) return;
      setMenuState(false);
    });

    navigation.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link || !navigation.contains(link)) return;

      // Re-selecting the active page keeps the menu open without a needless reload.
      // Modified clicks retain their normal new-tab/window browser behavior.
      if (
        link.getAttribute('aria-current') === 'page' &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
        event.button === 0
      ) {
        event.preventDefault();
      }
    });
  }

  const fallbackCopy = (value) => {
    if (typeof document.execCommand !== 'function') return false;

    const previouslyFocused = document.activeElement;
    const selection = window.getSelection();
    const previousRanges = [];
    if (selection) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        previousRanges.push(selection.getRangeAt(index).cloneRange());
      }
    }

    const field = document.createElement('textarea');
    field.className = 'clipboard-helper';
    field.value = value;
    field.readOnly = true;
    field.tabIndex = -1;
    field.setAttribute('aria-hidden', 'true');
    document.body.append(field);

    let copied = false;
    try {
      field.focus({ preventScroll: true });
      field.select();
      field.setSelectionRange(0, field.value.length);
      copied = document.execCommand('copy') === true;
    } catch {
      copied = false;
    } finally {
      field.remove();
      if (selection) {
        selection.removeAllRanges();
        previousRanges.forEach((range) => selection.addRange(range));
      }
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    }
    return copied;
  };

  document.querySelectorAll('[data-copy-email]').forEach((control) => {
    const address = (control.dataset.copyEmail || '').trim();
    const isValidAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address);
    const statusId = control.dataset.copyStatus;
    const status = (statusId && document.getElementById(statusId)) ||
      control.closest('.contact-row')?.querySelector('.copy-status') ||
      document.querySelector('.copy-status');

    if (!isValidAddress) {
      control.setAttribute('aria-disabled', 'true');
      control.removeAttribute('href');
      return;
    }

    // With no script this is an ordinary mailto link. Once enhanced, the visible
    // email itself becomes the copy control, with matching keyboard semantics.
    control.setAttribute('role', 'button');
    control.setAttribute('aria-label', 'Copy email address: ' + address);
    control.setAttribute('title', 'Click to copy email address');
    control.addEventListener('keydown', (event) => {
      if (event.key === ' ') {
        event.preventDefault();
        control.click();
      }
    });

    let isCopying = false;
    control.addEventListener('click', async (event) => {
      // Retain native modified-click behavior for anyone opening the mailto URI.
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.button > 0) return;
      event.preventDefault();
      if (isCopying) return;
      isCopying = true;
      control.setAttribute('aria-busy', 'true');
      if (status) {
        status.textContent = 'Copying email address…';
        delete status.dataset.kind;
      }

      let copied = false;
      try {
        if (window.isSecureContext && navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(address);
            copied = true;
          } catch {
            copied = fallbackCopy(address);
          }
        } else {
          copied = fallbackCopy(address);
        }
      } catch {
        copied = false;
      } finally {
        isCopying = false;
        control.removeAttribute('aria-busy');
      }

      if (status) {
        status.textContent = copied
          ? 'Email address copied.'
          : 'Could not copy. Select the email address and copy it manually.';
        status.dataset.kind = copied ? 'success' : 'error';
      }
    });
  });

  const backToTop = document.querySelector('[data-back-to-top]');
  if (backToTop) {
    let framePending = false;
    const updateBackToTop = () => {
      backToTop.hidden = window.scrollY <= 600;
      framePending = false;
    };

    window.addEventListener('scroll', () => {
      if (!framePending) {
        framePending = true;
        window.requestAnimationFrame(updateBackToTop);
      }
    }, { passive: true });
    window.addEventListener('pageshow', updateBackToTop);
    updateBackToTop();

    backToTop.addEventListener('click', () => {
      document.getElementById('main')?.focus({ preventScroll: true });
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }
})();
