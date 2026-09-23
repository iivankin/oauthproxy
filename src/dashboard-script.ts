export const dashboardScript = `(() => {
  const root = document.querySelector("main[data-api-key]");
  const token = root?.dataset.apiKey || "";
  let busy = false;
  let claudeFlow = null;
  let codexFlow = null;
  let codexTimer = null;

  const byId = id => document.getElementById(id);
  const status = (provider, message, error = false) => {
    const output = byId(provider + "-oauth-status");
    output.textContent = message;
    output.classList.toggle("error", error);
  };
  const request = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: { Authorization: "Bearer " + token, ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || "Request failed (" + response.status + ")");
    return data;
  };
  const post = (path, body) => request(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const accountLabel = data => data?.account?.email || data?.account?.name || "Account connected";

  byId("claude-oauth-start").addEventListener("click", async () => {
    busy = true;
    status("claude", "Starting…");
    try {
      claudeFlow = await post("/admin/claude/oauth/start", { name: byId("claude-account-name").value.trim() || undefined });
      const link = byId("claude-oauth-link");
      link.href = claudeFlow.authorizationUrl;
      link.hidden = false;
      byId("claude-oauth-complete").disabled = false;
      status("claude", "Sign-in ready");
    } catch (error) {
      busy = false;
      status("claude", error.message, true);
    }
  });

  byId("claude-oauth-complete").addEventListener("click", async () => {
    if (!claudeFlow) return;
    status("claude", "Completing…");
    try {
      const data = await post("/admin/claude/oauth/complete", {
        flowId: claudeFlow.flowId, code: byId("claude-oauth-code").value.trim(),
      });
      claudeFlow = null;
      status("claude", accountLabel(data));
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      status("claude", error.message, true);
    }
  });

  const checkCodex = async () => {
    if (!codexFlow) return;
    try {
      const data = await request("/admin/oauth/" + encodeURIComponent(codexFlow.flowId));
      if (data.status === "pending") {
        status("codex", "Waiting for sign-in…");
        return;
      }
      clearInterval(codexTimer);
      codexTimer = null;
      codexFlow = null;
      if (data.status === "completed") {
        status("codex", accountLabel(data));
        setTimeout(() => location.reload(), 700);
      } else status("codex", data.error || "OAuth failed", true);
    } catch (error) {
      status("codex", error.message, true);
    }
  };

  byId("codex-oauth-start").addEventListener("click", async () => {
    busy = true;
    status("codex", "Starting…");
    try {
      codexFlow = await post("/admin/codex/oauth/start", { name: byId("codex-account-name").value.trim() || undefined });
      const link = byId("codex-oauth-link");
      link.href = codexFlow.verificationUrl;
      link.hidden = false;
      byId("codex-user-code").textContent = codexFlow.userCode;
      byId("codex-oauth-complete").disabled = false;
      status("codex", "Waiting for sign-in…");
      codexTimer = setInterval(checkCodex, 2000);
    } catch (error) {
      busy = false;
      status("codex", error.message, true);
    }
  });
  byId("codex-oauth-complete").addEventListener("click", checkCodex);

  if (!token) {
    busy = true;
    for (const button of document.querySelectorAll(".oauth button")) button.disabled = true;
    status("claude", "PROXY_API_KEY is not configured", true);
    status("codex", "PROXY_API_KEY is not configured", true);
  }
  setTimeout(() => { if (!busy) location.reload(); }, 30000);
})();`;
