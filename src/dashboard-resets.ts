export const dashboardResetsScript = `
  for (const details of document.querySelectorAll(".reset-credits")) {
    const summary = details.querySelector("summary");
    const select = details.querySelector("select");
    const button = details.querySelector("button");
    const output = details.querySelector("output");
    const path = "/admin/codex/accounts/" + encodeURIComponent(details.dataset.accountId) + "/reset-credits";
    let loaded = false;
    let loading = false;
    details.addEventListener("toggle", async () => {
      if (!details.open || loaded || loading || !token || details.dataset.disabled) return;
      busy = true;
      loading = true;
      output.textContent = "Loading…";
      try {
        const data = await request(path);
        summary.textContent = "Usage resets: " + data.available_count;
        select.replaceChildren();
        for (const credit of data.credits.filter(credit => credit.status === "available")) {
          const option = document.createElement("option");
          option.value = credit.id;
          option.textContent = credit.title || credit.reset_type;
          if (credit.expires_at) option.textContent += " · expires " + credit.expires_at;
          option.title = credit.description || "";
          select.append(option);
        }
        select.hidden = !select.options.length;
        button.disabled = !select.options.length;
        output.textContent = select.options.length ? "" : "No available resets";
        loaded = true;
      } catch (error) { output.textContent = error.message; }
      finally { loading = false; }
    });
    button.addEventListener("click", async () => {
      if (button.disabled || !select.value) return;
      if (!confirm("Use " + select.selectedOptions[0].textContent + " for " + details.dataset.accountLabel + "?")) return;
      button.disabled = true;
      output.textContent = "Applying…";
      try {
        // Keep the idempotency key after an ambiguous failure, including across page reloads.
        const key = "codex-reset:" + details.dataset.accountId + ":" + select.value;
        let requestId = sessionStorage.getItem(key);
        if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(key, requestId); }
        const result = await post(path + "/consume", { credit_id: select.value, redeem_request_id: requestId });
        const messages = {
          reset: "Usage reset applied (" + result.windows_reset + " windows)",
          nothing_to_reset: "Nothing to reset",
          no_credit: "No reset credit available",
          already_redeemed: "Reset credit already redeemed",
        };
        if (!messages[result.code]) throw new Error("Unknown reset result; retry with the same request ID");
        sessionStorage.removeItem(key);
        output.textContent = messages[result.code];
        setTimeout(() => location.reload(), 1800);
      } catch (error) {
        output.textContent = error.message;
        button.disabled = false;
      }
    });
  }
`;
