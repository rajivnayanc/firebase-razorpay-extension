import { logs } from '@/logs';

/**
 * Retry a fetch function with exponential backoff on 429 (Rate Limited) responses.
 * Shared across payment and subscription webhook handlers.
 */
export async function fetchWithBackoff<T>(fetchFn: () => Promise<T>, retries = 3, backoffMs = 500): Promise<T> {
    let attempt = 0;
    while (attempt < retries) {
        try {
            return await fetchFn();
        } catch (err: any) {
            attempt++;
            if (err.statusCode === 429 && attempt < retries) {
                logs.info(`Rate limited (429). Retrying in ${backoffMs}ms (Attempt ${attempt} of ${retries})`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                backoffMs *= 2; // Exponential backoff
            } else {
                throw err;
            }
        }
    }
    throw new Error('Max retries reached');
}

/**
 * Determine if an error is transient/retryable (e.g. rate limit, server error, network drop).
 */
export function isTransientError(err: any): boolean {
    if (!err) return false;
    const statusCode = err.statusCode;
    if (statusCode) {
        return statusCode >= 500 || statusCode === 429;
    }
    // No status code — check for network, timeout, or connection errors
    const message = (err.message || '').toLowerCase();
    const code = err.code;
    return (
        code === 'DEADLINE_EXCEEDED' ||
        code === 'UNAVAILABLE' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('fetch')
    );
}
