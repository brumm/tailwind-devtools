chrome.devtools.panels.elements.createSidebarPane('Tailwind', (pane) => {
  let win = null;
  pane.setPage('panel.html');
  pane.onShown.addListener((w) => {
    win = w;
    if (win.twShown) win.twShown(true);
  });
  pane.onHidden.addListener(() => {
    if (win && win.twShown) win.twShown(false);
  });
});
