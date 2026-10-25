import type { Config } from '../types.ts';
import type { Cdm } from './protected-media.ts';
import { fetchResponse } from '../providers/common.ts';

function wvApiBase(config: Config): string {
  return config.wvApiUrl.endsWith('/') ? config.wvApiUrl : `${config.wvApiUrl}/`;
}

async function wvApiRequest(config: Config, path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  const response = await fetchResponse(new URL(path, wvApiBase(config)), signal, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`WV API HTTP ${response.status} on /${path}`);
  return response.json();
}

/** Production `Cdm` adapter backed by `WV.API`: `generateLicenseRequest` for the challenge, `extractLicenseKeys` for the keys. */
export function wvApiCdm(config: Config): Cdm {
  return {
    async challenge(pssh, signal) {
      const data = (await wvApiRequest(config, 'generate', { pssh }, signal)) as { id?: string; request?: string };
      if (!data.id || !data.request) throw new Error('WV API returned an invalid license request');
      return { session: data.id, challenge: Uint8Array.fromBase64(data.request) };
    },
    async keys(session, licenseResponse, signal) {
      const data = (await wvApiRequest(
        config,
        'extract',
        {
          id: session,
          response: licenseResponse.toBase64(),
        },
        signal,
      )) as { keys?: Array<{ type: string; kid: string; key: string }> };
      return (data.keys ?? []).filter(key => key.type === 'CONTENT');
    },
  };
}
