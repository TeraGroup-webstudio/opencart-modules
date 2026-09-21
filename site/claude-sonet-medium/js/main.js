"use strict";

document.addEventListener("DOMContentLoaded", () => {
  initBurgerMenu();
  initModals();
  initPhoneMask();
  initAOS();
  initCounters();
  initTimeline();
  initFormatCards();
  initAccordion();
  initAjaxForms();
  initSmoothAnchors();
});

/* ==========================================================================
   БУРГЕР-МЕНЮ (мобільна навігація)
   ========================================================================== */
function initBurgerMenu() {
  const burger = document.querySelector(".js-burger");
  const nav = document.querySelector(".header__nav");
  if (!burger || !nav) return;

  burger.addEventListener("click", () => {
    const isOpen = burger.classList.toggle("is-active");
    burger.setAttribute("aria-expanded", String(isOpen));
    nav.classList.toggle("is-open", isOpen);
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      burger.classList.remove("is-active");
      burger.setAttribute("aria-expanded", "false");
      nav.classList.remove("is-open");
    });
  });
}

/* ==========================================================================
   МОДАЛЬНІ ВІКНА (у стилі Bootstrap: backdrop + фокус + Esc)
   ========================================================================== */
function initModals() {
  const openers = document.querySelectorAll(".js-open-modal");
  const modals = document.querySelectorAll(".js-modal");
  let lastFocusedEl = null;

  function openModal(modal) {
    if (!modal) return;
    lastFocusedEl = document.activeElement;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("no-scroll");

    const video = modal.querySelector(".js-modal-video");
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {});
    }

    const firstField = modal.querySelector("input, textarea, button");
    if (firstField) firstField.focus();
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("no-scroll");

    const video = modal.querySelector(".js-modal-video");
    if (video) video.pause();

    if (lastFocusedEl) lastFocusedEl.focus();
  }

  openers.forEach((btn) => {
    btn.addEventListener("click", () => {
      const modal = document.getElementById(btn.dataset.modal);
      openModal(modal);
      const analyticsName = btn.dataset.analyticsOpen;
      if (analyticsName) pushAnalyticsEvent(analyticsName);
    });
  });

  modals.forEach((modal) => {
    modal.querySelectorAll(".js-close-modal").forEach((closeBtn) => {
      closeBtn.addEventListener("click", () => closeModal(modal));
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const openModalEl = document.querySelector(".js-modal.is-open");
      if (openModalEl) closeModal(openModalEl);
    }
  });

  window.__closeModal = closeModal;
}

/* ==========================================================================
   МАСКА ТЕЛЕФОНУ +38(999) 999-99-99
   ========================================================================== */
function initPhoneMask() {
  const inputs = document.querySelectorAll(".js-phone-mask");

  inputs.forEach((input) => {
    input.addEventListener("focus", () => {
      if (!input.value) input.value = "+38(";
    });

    input.addEventListener("input", () => {
      let digits = input.value.replace(/\D/g, "");
      if (digits.startsWith("380")) digits = digits.slice(2);
      else if (digits.startsWith("38")) digits = digits.slice(2);
      digits = digits.slice(0, 10); // 0999999999 -> 10 цифр з нулем

      let formatted = "+38(";
      if (digits.length > 0) formatted += digits.slice(0, 3);
      if (digits.length >= 3) formatted += ") " + digits.slice(3, 6);
      if (digits.length >= 6) formatted += "-" + digits.slice(6, 8);
      if (digits.length >= 8) formatted += "-" + digits.slice(8, 10);

      input.value = formatted;
      validatePhone(input);
    });

    input.addEventListener("blur", () => validatePhone(input));
  });
}

function validatePhone(input) {
  const digits = input.value.replace(/\D/g, "");
  const isValid = digits.length === 12 || digits.length === 10; // 38XXXXXXXXXX або XXXXXXXXXX
  const errorEl = input.closest(".form-row")?.querySelector(".field-error");
  const hasValue = digits.length > 2;

  if (hasValue && !isValid) {
    input.classList.add("field--invalid");
    if (errorEl) errorEl.classList.add("is-visible");
  } else {
    input.classList.remove("field--invalid");
    if (errorEl) errorEl.classList.remove("is-visible");
  }
  return isValid;
}

/* ==========================================================================
   AOS — ініціалізація + перемикач "1 раз / постійно"
   ========================================================================== */
function initAOS() {
  if (typeof AOS === "undefined") return;

  const savedMode = localStorage.getItem("aosMode") || "once";
  const select = document.getElementById("aos-mode-select");
  if (select) select.value = savedMode;

  AOS.init({
    duration: 700,
    easing: "ease-out-cubic",
    once: savedMode === "once",
    offset: 40,
    anchorPlacement: "top-bottom", // анімація стартує, щойно секція зʼявляється знизу екрана
  });

  if (select) {
    select.addEventListener("change", () => {
      localStorage.setItem("aosMode", select.value);
      AOS.init({
        duration: 700,
        easing: "ease-out-cubic",
        once: select.value === "once",
        offset: 40,
        anchorPlacement: "top-bottom",
      });
      AOS.refreshHard();
    });
  }
}

/* ==========================================================================
   ЛІЧИЛЬНИКИ (анімація чисел при потраплянні в зону видимості)
   ========================================================================== */
function initCounters() {
  const counters = document.querySelectorAll("[data-counter]");
  if (!counters.length) return;

  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        animateCounter(entry.target);
        obs.unobserve(entry.target);
      });
    },
    { threshold: 0.4 }
  );

  counters.forEach((el) => observer.observe(el));
}

function animateCounter(el) {
  const target = parseInt(el.dataset.counterTarget || "0", 10);
  const suffix = el.dataset.counterSuffix || "";
  const duration = 1400;
  const start = performance.now();

  function step(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = Math.round(target * eased);
    el.textContent = value.toLocaleString("uk-UA") + suffix;
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ==========================================================================
   TIMELINE — покроковий індикатор (адаптовано з development_stages.txt)
   Десктоп: горизонтально, мобілка: вертикально (керується CSS)
   ========================================================================== */
function initTimeline() {
  const form = document.querySelector(".js-timeline");
  if (!form) return;

  const loop = form.dataset.loop === "true";
  const stepsEls = Array.from(form.querySelectorAll(".timeline__step"));
  const totalSteps = stepsEls.length;
  let currentStep = 0;
  let interval = null;
  let hasRunOnce = false;

  function displayStep(targetStep) {
    form.querySelectorAll(".timeline__connector").forEach((c) => c.classList.remove("timeline__connector--active"));

    stepsEls.forEach((stepEl, i) => {
      stepEl.classList.remove("timeline__step--current", "timeline__step--done");
      if (i < targetStep) stepEl.classList.add("timeline__step--done");
      else if (i === targetStep) stepEl.classList.add("timeline__step--current");
    });

    // активуємо конектор перед поточним кроком (він вже "пройдений")
    stepsEls.forEach((stepEl, i) => {
      if (i < targetStep) {
        const connector = stepEl.nextElementSibling;
        if (connector && connector.classList.contains("timeline__connector")) {
          connector.classList.add("timeline__connector--active");
        }
      }
    });

    if (targetStep === totalSteps - 1) {
      const lastConnector = stepsEls[targetStep].nextElementSibling;
      setTimeout(() => {
        if (lastConnector && lastConnector.classList.contains("timeline__connector")) {
          lastConnector.classList.add("timeline__connector--active");
        }
      }, 600);
    }
  }

  function next() {
    if (currentStep < totalSteps - 1) {
      currentStep++;
      displayStep(currentStep);
    } else if (loop) {
      currentStep = 0;
      displayStep(currentStep);
    } else {
      stopAuto();
      hasRunOnce = true;
    }
  }

  function startAuto() {
    if (interval) return;
    interval = setInterval(next, 1200);
  }
  function stopAuto() {
    clearInterval(interval);
    interval = null;
  }

  displayStep(0);

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          if (loop || !hasRunOnce) startAuto();
        } else {
          stopAuto();
        }
      });
    },
    { threshold: 0.5 }
  );
  observer.observe(form);
}

/* ==========================================================================
   КАРТКИ ФОРМАТІВ — автопрогравання відео / керування Play
   ========================================================================== */
function initFormatCards() {
  const cards = document.querySelectorAll(".js-format-card");
  if (!cards.length) return;

  cards.forEach((card) => {
    const video = card.querySelector(".js-format-video");
    const playBtn = card.querySelector(".js-format-play");
    if (!video) return;

    function play() {
      video.play().catch(() => {});
      playBtn?.classList.add("is-hidden");
    }
    function pause() {
      video.pause();
      playBtn?.classList.remove("is-hidden");
    }

    playBtn?.addEventListener("click", () => {
      if (video.paused) play();
      else pause();
    });

    video.addEventListener("click", () => {
      if (!video.paused) pause();
    });

    // автопрогравання по черзі, коли картка у зоні видимості
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) play();
          else pause();
        });
      },
      { threshold: 0.5 }
    );
    observer.observe(card);
  });
}

/* ==========================================================================
   АКОРДЕОН "Чим доповнити?" — перший таб відкритий, keрування "закривати інші"
   ========================================================================== */
function initAccordion() {
  const accordions = document.querySelectorAll(".js-accordion");

  accordions.forEach((accordion) => {
    const closeOthers = accordion.dataset.closeOthers !== "false"; // за замовчуванням true
    const items = Array.from(accordion.querySelectorAll(".accordion__item"));

    function setPanelHeight(item, open) {
      const panel = item.querySelector(".accordion__panel");
      if (!panel) return;
      if (open) {
        panel.style.maxHeight = panel.scrollHeight + "px";
      } else {
        panel.style.maxHeight = "0px";
      }
    }

    items.forEach((item) => {
      const header = item.querySelector(".accordion__header");
      const isOpen = item.classList.contains("is-open");
      setPanelHeight(item, isOpen);
      header?.setAttribute("aria-expanded", String(isOpen));

      header?.addEventListener("click", () => {
        const willOpen = !item.classList.contains("is-open");

        if (closeOthers) {
          items.forEach((other) => {
            if (other !== item) {
              other.classList.remove("is-open");
              other.querySelector(".accordion__header")?.setAttribute("aria-expanded", "false");
              setPanelHeight(other, false);
            }
          });
        }

        item.classList.toggle("is-open", willOpen);
        header.setAttribute("aria-expanded", String(willOpen));
        setPanelHeight(item, willOpen);
      });
    });

    window.addEventListener("resize", () => {
      items.forEach((item) => {
        if (item.classList.contains("is-open")) setPanelHeight(item, true);
      });
    });
  });
}

/* ==========================================================================
   ВІДПРАВКА ФОРМ (AJAX) + ПОДІЇ АНАЛІТИКИ
   Хостинг ukraine.com.ua — заміни action форм / URL нижче на реальний
   обробник пошти вашого хостингу (наприклад /mail-handler.php).
   ========================================================================== */
function initAjaxForms() {
  const forms = document.querySelectorAll(".js-ajax-form");

  forms.forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();

      const phoneInput = form.querySelector(".js-phone-mask");
      if (phoneInput && !validatePhone(phoneInput)) {
        phoneInput.focus();
        return;
      }

      const requiredFields = form.querySelectorAll("[required]");
      let isValid = true;
      requiredFields.forEach((field) => {
        if (!field.value.trim()) {
          isValid = false;
          field.classList.add("field--invalid");
        } else {
          field.classList.remove("field--invalid");
        }
      });
      if (!isValid) return;

      const analyticsEvent = form.dataset.analyticsEvent;
      if (analyticsEvent) pushAnalyticsEvent(analyticsEvent, formToObject(form));

      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      fetch(form.action, {
        method: form.method || "POST",
        body: new FormData(form),
      })
        .then(() => handleFormSuccess(form))
        .catch(() => handleFormSuccess(form)) // офлайн-заглушка: показуємо успіх, поки немає бекенду
        .finally(() => {
          if (submitBtn) submitBtn.disabled = false;
        });
    });
  });
}

function handleFormSuccess(form) {
  form.reset();
  const modalWrap = form.closest(".js-modal-form-wrap");
  const modal = form.closest(".js-modal");

  if (modal) {
    const successEl = modal.querySelector(".js-modal-success");
    if (modalWrap && successEl) {
      modalWrap.style.display = "none";
      successEl.classList.add("is-visible");
      setTimeout(() => window.__closeModal?.(modal), 2500);
    }
  } else {
    form.insertAdjacentHTML(
      "beforeend",
      '<p class="form-consent" style="color:#2ecc71;margin-top:0.75rem">Дякуємо! Заявку надіслано.</p>'
    );
  }
}

function formToObject(form) {
  const data = {};
  new FormData(form).forEach((value, key) => (data[key] = value));
  return data;
}

/* ==========================================================================
   АНАЛІТИКА (dataLayer / gtag) — центральна функція подій форм
   ========================================================================== */
function pushAnalyticsEvent(eventName, payload) {
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event: eventName, formData: payload || null });
  if (typeof window.gtag === "function") {
    window.gtag("event", eventName, payload || {});
  }
  // eslint-disable-next-line no-console
  console.log("[analytics]", eventName, payload || "");
}

/* ==========================================================================
   ПЛАВНИЙ СКРОЛ ДО ЯКОРІВ
   ========================================================================== */
function initSmoothAnchors() {
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      const id = link.getAttribute("href");
      if (id.length <= 1) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}
