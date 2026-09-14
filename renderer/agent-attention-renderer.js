(() => {
  const VERSION = "0.6.0";
  const MARKER_CLASS = "agent-attention-waiting";

  if (window.__agentAttentionRenderer?.version === VERSION) {
    window.__agentAttentionRenderer.sync();
    return;
  }

  window.__agentAttentionRenderer?.destroy?.();

  const subscriptions = new Map();

  function paneForWrapper(wrapper) {
    return wrapper.closest(".terminal-split-pane, .editor-instance");
  }

  function clearPane(pane) {
    pane?.classList.remove(MARKER_CLASS);
    pane?.removeAttribute("data-agent-attention");
  }

  function markPane(pane) {
    if (!pane || pane.querySelector(".xterm.focus")) {
      clearPane(pane);
      return;
    }

    pane.classList.add(MARKER_CLASS);
    pane.setAttribute("data-agent-attention", "Agent turn finished");
  }

  function sync() {
    const currentWrappers = new Set(
      document.querySelectorAll(".terminal-wrapper")
    );

    for (const [wrapper, subscription] of subscriptions) {
      if (!currentWrappers.has(wrapper) || wrapper.xterm !== subscription.xterm) {
        subscription.disposable.dispose();
        subscriptions.delete(wrapper);
      }
    }

    for (const wrapper of currentWrappers) {
      if (!subscriptions.has(wrapper) && typeof wrapper.xterm?.onBell === "function") {
        subscriptions.set(
          wrapper,
          {
            xterm: wrapper.xterm,
            disposable: wrapper.xterm.onBell(() => markPane(paneForWrapper(wrapper)))
          }
        );
      }
    }

    for (const pane of document.querySelectorAll(`.${MARKER_CLASS}`)) {
      if (pane.querySelector(".xterm.focus")) clearPane(pane);
    }
  }

  function handleFocus(event) {
    clearPane(event.target.closest?.(".terminal-split-pane, .editor-instance"));
  }

  // Terminal output changes the DOM constantly. Discover wrappers at a fixed
  // rate; bells and focus still update existing panes immediately.
  document.addEventListener("focusin", handleFocus, true);
  const reconciliationTimer = setInterval(sync, 1000);

  function destroy() {
    document.removeEventListener("focusin", handleFocus, true);
    clearInterval(reconciliationTimer);
    for (const subscription of subscriptions.values()) subscription.disposable.dispose();
    subscriptions.clear();
    for (const pane of document.querySelectorAll(`.${MARKER_CLASS}`)) clearPane(pane);
    delete window.__agentAttentionRenderer;
  }

  window.__agentAttentionRenderer = { version: VERSION, sync, destroy };
  sync();
})();
