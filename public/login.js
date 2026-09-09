// Login-side: viser opsætning (første gang) eller login, og sender til dashboardet.
(function () {
  const $ = (id) => document.getElementById(id);
  const formLogin = $('form-login');
  const formSetup = $('form-setup');
  const loading = $('login-loading');

  function nextUrl() {
    const next = new URLSearchParams(location.search).get('next') || '/';
    return next.startsWith('/') && !next.startsWith('//') ? next : '/';
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Fejl ${res.status}`);
      err.status = res.status;
      err.retryAfter = Number(res.headers.get('retry-after')) || (data && data.retryAfter) || 0;
      throw err;
    }
    return data;
  }

  function show(form) {
    loading.classList.add('hidden');
    formLogin.classList.toggle('hidden', form !== formLogin);
    formSetup.classList.toggle('hidden', form !== formSetup);
    const first = form.querySelector('input');
    if (first) first.focus();
  }

  function setBusy(button, busy, label) {
    button.disabled = busy;
    if (label) button.textContent = busy ? 'Vent…' : label;
  }

  async function init() {
    try {
      const status = await api('/api/auth/status');
      if (status.authenticated) return location.replace(nextUrl());
      show(status.setupRequired ? formSetup : formLogin);
    } catch (err) {
      loading.textContent = 'Kunne ikke kontakte serveren. Prøv at genindlæse siden.';
    }
  }

  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const error = $('login-error');
    const button = $('login-submit');
    error.textContent = '';
    const password = $('login-password').value;
    if (!password) { error.textContent = 'Skriv din adgangskode.'; return; }
    setBusy(button, true, 'Log ind');
    try {
      await api('/api/auth/login', { password, remember: $('login-remember').checked });
      location.replace(nextUrl());
    } catch (err) {
      error.textContent = err.message;
      $('login-password').select();
      if (err.status === 429 && err.retryAfter) startCountdown(button, err.retryAfter);
    } finally {
      if (!countdownTimer) setBusy(button, false, 'Log ind');
    }
  });

  let countdownTimer = null;
  function startCountdown(button, seconds) {
    clearInterval(countdownTimer);
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        setBusy(button, false, 'Log ind');
        $('login-error').textContent = '';
        return;
      }
      button.disabled = true;
      const m = Math.floor(left / 60);
      const s = left % 60;
      button.textContent = `Prøv igen om ${m ? `${m} min ` : ''}${s} sek.`;
      left--;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  // Advarsel når siden åbnes ukrypteret uden for localhost
  (function httpWarning() {
    const h = location.hostname;
    const local = h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local') || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    if (location.protocol === 'http:' && !local) {
      const p = document.createElement('p');
      p.className = 'form-error';
      p.style.marginTop = '12px';
      p.textContent = 'Forbindelsen er ikke krypteret. Kør dashboardet bag HTTPS (f.eks. Caddy eller Nginx), før du åbner det udefra.';
      document.querySelector('.login-card').appendChild(p);
    }
  })();

  formSetup.addEventListener('submit', async (e) => {
    e.preventDefault();
    const error = $('setup-error');
    const button = $('setup-submit');
    error.textContent = '';
    const password = $('setup-password').value;
    const confirm = $('setup-confirm').value;
    if (password.length < 8) { error.textContent = 'Adgangskoden skal være mindst 8 tegn.'; return; }
    if (password !== confirm) { error.textContent = 'De to adgangskoder er ikke ens.'; return; }
    setBusy(button, true, 'Opret og gå til dashboard');
    try {
      await api('/api/auth/setup', { password, confirm });
      location.replace('/');
    } catch (err) {
      error.textContent = err.message;
      if (err.status === 409) setTimeout(init, 800);
    } finally {
      setBusy(button, false, 'Opret og gå til dashboard');
    }
  });

  document.querySelectorAll('[data-toggle-pw]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.togglePw);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
      input.focus();
    });
  });

  init();
})();
