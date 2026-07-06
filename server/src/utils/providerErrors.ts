export type ProviderFailureType =
  | 'tls_certificate_error'
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'billing_required'
  | 'rate_limited'
  | 'provider_down'
  | 'no_results'
  | 'invalid_query'
  | 'no_pricing_available';

export function classifyProviderError(error: unknown, status?: number): ProviderFailureType {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/certificate|first certificate|unable to verify|self-signed|UNABLE_TO_VERIFY/i.test(message)) return 'tls_certificate_error';
  if (/missing.*api|api key.*missing|team.*missing/i.test(message)) return 'missing_api_key';
  if (status === 401 || /invalid.*api|unauthorized|forbidden/i.test(message)) return 'invalid_api_key';
  if (status === 402 || /billing|payment|required|credits|overage/i.test(message)) return 'billing_required';
  if (status === 429 || /rate limit|too many requests/i.test(message)) return 'rate_limited';
  if (status === 400 || /invalid query|bad request/i.test(message)) return 'invalid_query';
  if (status === 404 || /not found|no results/i.test(message)) return 'no_results';
  if (status && status >= 500) return 'provider_down';
  return 'provider_down';
}
