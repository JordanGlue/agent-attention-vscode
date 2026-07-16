(() => {
  const VERSION = "0.3.0";
  const MARKER_CLASS = "codex-attention-waiting";

  if (window.__codexAttentionRenderer?.version === VERSION) {
    window.__codexAttentionRenderer.sync();
    return;
  }

  window.__codexAttentionRenderer?.destroy?.();

  const subscriptions = new Map();
  let animationFrame = 0;

  function paneForWrapper(wrapper) {
    return wrapper.closest(".terminal-split-pane, .editor-instance");
  }

  function clearPane(pane) {
    pane?.classList.remove(MARKER_CLASS);
    pane?.removeAttribute("data-codex-attention");
  }

  function markPane(pane) {
    if (!pane || pane.querySelector(".xterm.focus")) {
      clearPane(pane);
      return;
    }

    pane.classList.add(MARKER_CLASS);
    pane.setAttribute("data-codex-attention", "Codex turn finished");
  }

  function sync() {
    animationFrame = 0;
    const currentWrappers = new Set(
      document.querySelectorAll(".terminal-wrapper")
    );

    for (const [wrapper, subscription] of subscriptions) {
      if (!currentWrappers.has(wrapper)) {
        subscription.dispose();
        subscriptions.delete(wrapper);
      }
    }

    for (const wrapper of currentWrappers) {
      if (!subscriptions.has(wrapper) && typeof wrapper.xterm?.onBell === "function") {
        subscriptions.set(
          wrapper,
          wrapper.xterm.onBell(() => markPane(paneForWrapper(wrapper)))
        );
      }
    }

    for (const pane of document.querySelectorAll(`.${MARKER_CLASS}`)) {
      if (pane.querySelector(".xterm.focus")) clearPane(pane);
    }
  }

  function scheduleSync() {
    if (!animationFrame) animationFrame = requestAnimationFrame(sync);
  }

  function handleFocus(event) {
    clearPane(event.target.closest?.(".terminal-split-pane, .editor-instance"));
    scheduleSync();
  }

  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"]
  });
  document.addEventListener("focusin", handleFocus, true);
  const reconciliationTimer = setInterval(sync, 1000);

  function destroy() {
    observer.disconnect();
    document.removeEventListener("focusin", handleFocus, true);
    clearInterval(reconciliationTimer);
    if (animationFrame) cancelAnimationFrame(animationFrame);
    for (const subscription of subscriptions.values()) subscription.dispose();
    subscriptions.clear();
    for (const pane of document.querySelectorAll(`.${MARKER_CLASS}`)) clearPane(pane);
    delete window.__codexAttentionRenderer;
  }

  window.__codexAttentionRenderer = { version: VERSION, sync, destroy };
  sync();
})();
