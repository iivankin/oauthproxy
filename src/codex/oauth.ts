import { z } from "zod";
import { CLIENT_ID } from "./profile.ts";
import { Transport, UpstreamError } from "./transport.ts";

const deviceSchema = z.object({
  device_auth_id: z.string().min(1), user_code: z.string().optional(), usercode: z.string().optional(),
  interval: z.coerce.number().int().nonnegative().default(5),
});
const codeSchema = z.object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) });

export type DeviceLogin = {
  deviceAuthId: string; userCode: string; verificationUrl: string; interval: number;
};

export async function startDeviceLogin(transport: Transport, signal: AbortSignal = AbortSignal.timeout(20_000)): Promise<DeviceLogin> {
  const base = `${transport.endpoints.issuer}/api/accounts/deviceauth`;
  const device = deviceSchema.parse(await transport.request(`${base}/usercode`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }), signal,
  }));
  const userCode = device.user_code ?? device.usercode;
  if (!userCode) throw new Error("Device login response has no user code");
  return { deviceAuthId: device.device_auth_id, userCode,
    verificationUrl: `${transport.endpoints.issuer}/codex/device`, interval: Math.max(1, device.interval) };
}

export async function finishDeviceLogin(transport: Transport, device: DeviceLogin,
  signal: AbortSignal = AbortSignal.timeout(15 * 60_000)) {
  const url = `${transport.endpoints.issuer}/api/accounts/deviceauth/token`;
  for (;;) {
    signal.throwIfAborted();
    let code: z.infer<typeof codeSchema> | undefined;
    try {
      code = codeSchema.parse(await transport.request(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      }));
    } catch (error) {
      // Only these poll statuses mean pending in codex-rs. Other failures are not retried.
      if (!(error instanceof UpstreamError) || ![403, 404].includes(error.status)) throw error;
    }
    // A failed one-time code exchange must never restart polling or be replayed.
    if (code) return transport.exchange(code.authorization_code, code.code_verifier);
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, device.interval * 1000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export async function deviceLogin(transport: Transport,
  prompt: (url: string, code: string) => void = (url, code) => console.log(`Open ${url}\nEnter code: ${code}\nWaiting for approval (15 minutes)…`),
  signal = AbortSignal.timeout(15 * 60_000)) {
  const device = await startDeviceLogin(transport, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
  prompt(device.verificationUrl, device.userCode);
  return finishDeviceLogin(transport, device, signal);
}
