// Test stub: fakes chrome.devtools against a hidden iframe running test.html
(() => {
  const q = new URLSearchParams(location.search);
  const frame = document.createElement('iframe');
  frame.src = 'harness/test.html';
  frame.style.cssText = 'position:fixed;left:-3000px;top:0;width:1000px;height:800px;visibility:hidden';
  let loaded = false;
  frame.onload = () => { loaded = true; };
  document.body.append(frame);
  window.chrome = { devtools: {
    panels: { themeName: q.get('theme') || 'dark', elements: { onSelectionChanged: { addListener() {} } } },
    network: { onNavigated: { addListener() {} } },
    inspectedWindow: { eval(expr, cb) {
      const go = () => {
        if (!loaded) return setTimeout(go, 50);
        const w = frame.contentWindow;
        w.$0 = w.document.querySelector(q.get('sel') || '#target');
        try { cb(w.eval(expr)); } catch (e) { cb(undefined, { isException: true, value: String(e) }); }
      };
      go();
    } },
  } };
})();
