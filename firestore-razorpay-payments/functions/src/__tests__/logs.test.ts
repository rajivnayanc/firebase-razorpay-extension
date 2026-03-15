import { logs } from '../logs';
import { logger } from 'firebase-functions';

jest.mock('firebase-functions', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    }
}));

describe('Logging Utilities', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('Behavior: obfuscateKey should hide most of the key', () => {
        expect(logs.obfuscateKey('1234567890')).toBe('...7890');
        expect(logs.obfuscateKey('')).toBe('');
    });

    it('Behavior: init should log initialization', () => {
        logs.init();
        expect(logger.info).toHaveBeenCalledWith('Initializing extension with configuration');
    });

    it('Behavior: info should log a message', () => {
        logs.info('test message');
        expect(logger.info).toHaveBeenCalledWith('test message');
    });

    it('Behavior: startWebhook should log event type', () => {
        logs.startWebhook('payment.captured');
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('payment.captured'));
    });

    it('Behavior: webhookProcessed should log event type and ID', () => {
        logs.webhookProcessed('payment.captured', 'pay_123');
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('payment.captured'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('pay_123'));
    });

    it('Behavior: invalidSignature should log error', () => {
        logs.invalidSignature();
        expect(logger.error).toHaveBeenCalledWith('Webhook failed signature verification');
    });

    it('Behavior: orderCreated should log order ID and path', () => {
        logs.orderCreated('order_123', 'path/to/doc');
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('order_123'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('path/to/doc'));
    });

    it('Behavior: subscriptionCreated should log subscription ID and path', () => {
        logs.subscriptionCreated('sub_123', 'path/to/doc');
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('sub_123'));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('path/to/doc'));
    });

    it('Behavior: error should log message and optional error details', () => {
        logs.error('simple error');
        expect(logger.error).toHaveBeenCalledWith('simple error');

        const errDetail = new Error('detail');
        logs.error('context', errDetail);
        expect(logger.error).toHaveBeenCalledWith('context', errDetail);
    });
});
