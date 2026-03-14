import * as crypto from 'crypto';
import config from './config';

export const verifyWebhookSignature = (
    payload: string,
    signature: string
): boolean => {
    if (!signature || !payload) return false;

    try {
        const expectedSignature = crypto
            .createHmac('sha256', config.razorpayWebhookSecret)
            .update(payload)
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(expectedSignature),
            Buffer.from(signature)
        );
    } catch (error) {
        return false;
    }
};
