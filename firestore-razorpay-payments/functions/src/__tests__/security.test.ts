import { verifyWebhookSignature } from '../security';
import * as crypto from 'crypto';

describe('Security Utilities: Webhook Signature Verification', () => {
    const secret = 'test_webhook_secret';

    it('Behavior: should return true for a valid signature', () => {
        const payload = JSON.stringify({ event: 'payment.captured' });
        const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');

        expect(verifyWebhookSignature(payload, signature)).toBe(true);
    });

    it('Behavior: should return false for an invalid signature', () => {
        const payload = JSON.stringify({ event: 'payment.captured' });
        const wrongSignature = crypto.createHmac('sha256', 'wrong_secret').update(payload).digest('hex');

        expect(verifyWebhookSignature(payload, wrongSignature)).toBe(false);
    });

    it('Behavior: should return false if signature or payload is missing', () => {
        expect(verifyWebhookSignature('', 'signature')).toBe(false);
        expect(verifyWebhookSignature('payload', '')).toBe(false);
    });
});
