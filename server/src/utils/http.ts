import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { globalCache } from './cache.js';
import { sleep } from './async.js';

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function requestJson<T>(
  url: string,
  config: AxiosRequestConfig = {},
  opts: { cacheKey?: string; ttlMs?: number; retries?: number } = {}
): Promise<T> {
  const response = await requestJsonWithMeta<T>(url, config, opts);
  return response.data;
}

export async function requestJsonWithMeta<T>(
  url: string,
  config: AxiosRequestConfig = {},
  opts: { cacheKey?: string; ttlMs?: number; retries?: number } = {}
): Promise<{ data: T; status: number; url: string }> {
  const cached = opts.cacheKey ? globalCache.get<T>(opts.cacheKey) : null;
  if (cached) {
    return {
      data: cached,
      status: 200,
      url
    };
  }

  const retries = opts.retries ?? 2;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.request<T>({
        timeout: config.timeout ?? 8000,
        responseType: 'json',
        ...config,
        url
      });
      if (opts.cacheKey && opts.ttlMs) {
        globalCache.set(opts.cacheKey, response.data, opts.ttlMs);
      }
      return {
        data: response.data,
        status: response.status,
        url
      };
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (attempt === retries || (status !== undefined && !RETRY_STATUS.has(status))) {
        if (error instanceof AxiosError) {
          throw new Error(status === 429 ? 'Card data provider rate limit hit. Please try again shortly.' : error.message);
        }
        throw error;
      }
      await sleep(250 * (attempt + 1));
    }
  }

  throw new Error(`Request failed for ${url}`);
}
