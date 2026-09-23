import { z } from "zod";
import { CLIENT_ID } from "./profile.ts";
import { Transport, UpstreamError } from "./transport.ts";

const deviceSchema = z.object({
  device_auth_id: z.string().min(1), user_code: z.string().optional(), usercode: z.string().optional(),
  interval: z.coerce.number().int().nonnegative().default(5),
});
const codeSchema = z.object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) });

export async function deviceLogin(transport: Transport,
  prompt: (url: string, code: string) => void = (url, code) => console.log(`Open ${url}\nEnter code: ${code}\nWaiting for approval (15 minutes)…`),
  signal = AbortSignal.timeout(15 * 60_000)) {
  const base = `${transport.endpoints.issuer}/api/accounts/deviceauth`;
  const post = (path: string, body: unknown) => transport.request(`${base}/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const device = deviceSchema.parse(await post("usercode", { client_id: CLIENT_ID }));
  const userCode = device.user_code ?? device.usercode;
  if (!userCode) throw new Error("Device login response has no user code");
  prompt(`${transport.endpoints.issuer}/codex/device`, userCode);
  for (;;) {
    signal.throwIfAborted();
    let code: z.infer<typeof codeSchema> | undefined;
    try {
      code = codeSchema.parse(await post("token", { device_auth_id: device.device_auth_id, user_code: userCode }));
    } catch (error) {
      // Only these poll statuses mean pending in codex-rs. Other failures are not retried.
      if (!(error instanceof UpstreamError) || ![403, 404].includes(error.status)) throw error;
    }
    // A failed one-time code exchange must never restart polling or be replayed.
    if (code) return transport.exchange(code.authorization_code, code.code_verifier);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.max(1, device.interval) * 1000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
