export const dashboardScript = `(() => {
  const root = document.querySelector("main[data-api-key]");
  const token = root?.dataset.apiKey || "";
  let busy = false;
  let claudeFlow = null;
  let codexFlow = null;
  let codexTimer = null;
  let chatgptFlow = null;

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

  const modelsButton = byId("models-toggle");
  const modelsList = byId("models-list");
  let modelsLoaded = false;
  modelsButton.addEventListener("click", async () => {
    if (!modelsList.hidden) {
      modelsList.hidden = true;
      modelsButton.textContent = "Show models";
      return;
    }
    modelsList.hidden = false;
    modelsButton.textContent = "Hide models";
    if (modelsLoaded) return;
    modelsButton.disabled = true;
    modelsList.textContent = "Loading…";
    const providers = [
      ["Claude", "/claude/v1/models"],
      ["Codex", "/codex/v1/models"],
      ["ChatGPT plan", "/chatgpt/v1/models"],
    ];
    const results = await Promise.allSettled(providers.map(([, path]) => request(path)));
    modelsList.replaceChildren();
    for (let index = 0; index < providers.length; index++) {
      const section = document.createElement("section");
      section.className = "model-group";
      const heading = document.createElement("h3");
      heading.textContent = providers[index][0];
      section.append(heading);
      const result = results[index];
      if (result.status === "rejected") {
        const message = document.createElement("small");
        message.textContent = result.reason?.message || "Models unavailable";
        section.append(message);
      } else {
        const raw = result.value?.data || result.value?.models || [];
        const models = raw.filter(model => model && (index !== 2 || model.visibility === "list"));
        if (!models.length) {
          const message = document.createElement("small");
          message.textContent = "No available models";
          section.append(message);
        }
        for (const model of models) {
          const label = document.createElement("code");
          label.textContent = model.slug || model.id;
          section.append(label);
        }
      }
      modelsList.append(section);
    }
    modelsLoaded = true;
    modelsButton.disabled = false;
  });

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

  byId("chatgpt-oauth-start").addEventListener("click", async () => {
    busy = true;
    status("chatgpt", "Starting…");
    try {
      chatgptFlow = await post("/admin/chatgpt/oauth/start", { name: byId("chatgpt-account-name").value.trim() || undefined });
      const link = byId("chatgpt-oauth-link");
      link.href = chatgptFlow.authorizationUrl;
      link.hidden = false;
      byId("chatgpt-oauth-complete").disabled = false;
      status("chatgpt", "Sign-in ready");
    } catch (error) { status("chatgpt", error.message, true); }
  });
  byId("chatgpt-oauth-complete").addEventListener("click", async () => {
    if (!chatgptFlow) return;
    status("chatgpt", "Completing…");
    try {
      const data = await post("/admin/chatgpt/oauth/complete", {
        flowId: chatgptFlow.flowId, callbackUrl: byId("chatgpt-callback-url").value.trim(),
      });
      chatgptFlow = null;
      status("chatgpt", accountLabel(data));
      setTimeout(() => location.reload(), 700);
    } catch (error) { status("chatgpt", error.message, true); }
  });

  if (!token) {
    busy = true;
    for (const button of document.querySelectorAll(".oauth button")) button.disabled = true;
    status("claude", "PROXY_API_KEY is not configured", true);
    status("codex", "PROXY_API_KEY is not configured", true);
    status("chatgpt", "PROXY_API_KEY is not configured", true);
  }
  setTimeout(() => { if (!busy) location.reload(); }, 30000);
})();`;
