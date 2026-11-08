export const dashboardResetsScript = `
  for (const details of document.querySelectorAll(".reset-credits")) {
    const summary = details.querySelector("summary");
    const select = details.querySelector("select");
    const button = details.querySelector("button");
    const output = details.querySelector("output");
    const provider = details.dataset.provider;
    const path = "/admin/" + provider + "/accounts/" + encodeURIComponent(details.dataset.accountId) + "/reset-credits";
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
        for (const credit of data.credits.filter(credit => provider === "claude" || credit.status === "available")) {
          const option = document.createElement("option");
          option.value = credit.id;
          option.textContent = credit.title || credit.reset_type;
          if (credit.count > 1) option.textContent += " · " + credit.count + " left";
          if (credit.expires_at) option.textContent += " · expires " + localTime(credit.expires_at);
          if (credit.available_at) option.textContent += " · available " + localTime(credit.available_at);
          option.disabled = credit.status !== "available";
          if (option.disabled && credit.description) option.textContent += " · " + credit.description;
          option.title = credit.description || "";
          select.append(option);
        }
        select.hidden = !select.options.length;
        const available = data.credits.find(credit => credit.status === "available");
        if (available) select.value = available.id;
        button.disabled = !data.credits.some(credit => credit.status === "available");
        output.textContent = button.disabled ? "No available resets" : "";
        loaded = true;
      } catch (error) { output.textContent = error.message; }
      finally { loading = false; }
    });
    select.addEventListener("change", () => {
      output.textContent = select.selectedOptions[0]?.title || "";
    });
    button.addEventListener("click", async () => {
      if (button.disabled || !select.value || select.selectedOptions[0]?.disabled) return;
      const chosen = select.selectedOptions[0];
      if (!confirm("Use " + chosen.textContent + " for " + details.dataset.accountLabel + "?" + (chosen.title ? "\\n" + chosen.title : ""))) return;
      button.disabled = true;
      output.textContent = "Applying…";
      try {
        // Keep the idempotency key after an ambiguous failure, including across page reloads.
        const key = provider + "-reset:" + details.dataset.accountId + ":" + select.value;
        let requestId = sessionStorage.getItem(key);
        if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem(key, requestId); }
        const result = await post(path + "/consume", { credit_id: select.value, redeem_request_id: requestId });
        const messages = {
          reset: "Usage reset applied" + (result.windows_reset ? " (" + result.windows_reset + " windows)" : ""),
          nothing_to_reset: "Nothing to reset",
          no_credit: "No reset credit available",
          already_redeemed: "Reset credit already redeemed",
          already_used: "Reset already used",
          not_limited: "Limit has already cleared; no reset used",
          cooldown: "Another reset is still processing",
          ineligible: "Reset is no longer offered",
          unavailable: "Reset unconfirmed; retry with the same request ID",
        };
        if (!messages[result.code]) throw new Error("Unknown reset result; retry with the same request ID");
        output.textContent = messages[result.code];
        if (result.cooldown_until) output.textContent += " · " + localTime(result.cooldown_until);
        if (result.next_available_at) output.textContent += " · available " + localTime(result.next_available_at);
        if (result.code === "unavailable") { button.disabled = false; return; }
        if (result.code !== "cooldown") sessionStorage.removeItem(key);
        setTimeout(() => location.reload(), 1800);
      } catch (error) {
        output.textContent = error.message;
        button.disabled = false;
      }
    });
  }
`;
