// Sætter tema før første tegning, så siden ikke blinker hvidt i mørkt tema.
(function () {
  try {
    var t = localStorage.getItem('theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) {}
})();
