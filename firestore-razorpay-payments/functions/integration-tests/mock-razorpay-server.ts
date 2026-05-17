/**
 * Mock Razorpay API Server for Integration Tests
 *
 * A lightweight HTTP server that mimics Razorpay's REST API.
 * Uses Node's built-in `http` module — no additional dependencies.
 *
 * Usage:
 *   const mock = new MockRazorpayServer(3636);
 *   await mock.start();
 *   mock.register('subscriptions', 'sub_123', { id: 'sub_123', status: 'active', ... });
 *   // ... run tests ...
 *   await mock.stop();
 */

import * as http from 'http';

export interface MockEntity {
    [key: string]: any;
}

export class MockRazorpayServer {
    private server: http.Server | null = null;
    private port: number;

    /**
     * In-memory entity registry.
     * Key format: `${resourceType}/${entityId}` e.g. `subscriptions/sub_123`
     */
    private entities: Map<string, MockEntity> = new Map();

    /**
     * Auto-increment counter for generated IDs.
     */
    private idCounter = 0;

    constructor(port = 3636) {
        this.port = port;
    }

    // ── Entity Registration ─────────────────────────────────────────

    /**
     * Register a mock entity that will be returned by GET /v1/{resource}/{id}
     */
    register(resource: string, id: string, entity: MockEntity): void {
        this.entities.set(`${resource}/${id}`, { id, ...entity });
    }

    /**
     * Clear all registered entities.
     */
    clearAll(): void {
        this.entities.clear();
        this.idCounter = 0;
    }

    /**
     * Remove a specific entity.
     */
    remove(resource: string, id: string): void {
        this.entities.delete(`${resource}/${id}`);
    }

    // ── Server Lifecycle ────────────────────────────────────────────

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res));
            this.server.on('error', reject);
            this.server.listen(this.port, '127.0.0.1', () => {
                console.log(`[MockRazorpay] Listening on http://127.0.0.1:${this.port}`);
                resolve();
            });
        });
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log(`[MockRazorpay] Server stopped.`);
                    this.server = null;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    // ── Request Router ──────────────────────────────────────────────

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const url = req.url || '';
        const method = req.method || 'GET';
        console.log(`[MockRazorpay] Request: ${method} ${url}`);

        // Parse the URL: /v1/{resource}/{id} or /v1/{resource}/{id}/{action}
        const match = url.match(/^\/v1\/(\w+)(?:\/([^/]+))?(?:\/(\w+))?/);

        if (!match) {
            this.sendJson(res, 404, { error: { description: 'Not found' } });
            return;
        }

        const resource = match[1]; // e.g. 'subscriptions', 'payments', 'orders', 'customers'
        const id = match[2];       // e.g. 'sub_123'
        const action = match[3];   // e.g. 'cancel'

        // Collect body for POST/PUT
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
            let parsedBody: any = {};
            try {
                if (body) parsedBody = JSON.parse(body);
            } catch { /* ignore parse errors */ }

            try {
                if (method === 'GET' && id) {
                    this.handleGet(res, resource, id);
                } else if (method === 'POST' && id && action) {
                    this.handleAction(res, resource, id, action, parsedBody);
                } else if (method === 'POST' && !id) {
                    this.handleCreate(res, resource, parsedBody);
                } else if (method === 'GET' && !id) {
                    this.handleList(res, resource);
                } else {
                    this.sendJson(res, 404, { error: { description: 'Route not found' } });
                }
            } catch (err: any) {
                console.error(`[MockRazorpay] Error handling ${method} ${url}:`, err);
                this.sendJson(res, 500, { error: { description: err.message } });
            }
        });
    }

    // ── Handlers ────────────────────────────────────────────────────

    /**
     * GET /v1/{resource}/{id} — Fetch a single entity
     */
    private handleGet(res: http.ServerResponse, resource: string, id: string): void {
        const entity = this.entities.get(`${resource}/${id}`);
        if (entity) {
            this.sendJson(res, 200, entity);
        } else {
            this.sendJson(res, 404, {
                error: {
                    code: 'BAD_REQUEST_ERROR',
                    description: `${resource} with id ${id} not found`,
                },
            });
        }
    }

    /**
     * GET /v1/{resource} — List entities of a type
     */
    private handleList(res: http.ServerResponse, resource: string): void {
        const items: MockEntity[] = [];
        for (const [key, val] of this.entities) {
            if (key.startsWith(`${resource}/`)) {
                items.push(val);
            }
        }
        this.sendJson(res, 200, { entity: resource, count: items.length, items });
    }

    /**
     * POST /v1/{resource} — Create a new entity
     */
    private handleCreate(res: http.ServerResponse, resource: string, body: any): void {
        this.idCounter++;
        const prefix = this.getPrefix(resource);
        const id = `${prefix}_mock_${this.idCounter}`;

        const entity: MockEntity = {
            id,
            ...body,
            created_at: Math.floor(Date.now() / 1000),
        };

        // Set sensible defaults based on resource type
        switch (resource) {
            case 'customers':
                entity.name = body.name || 'Test Customer';
                entity.email = body.email || 'test@example.com';
                entity.contact = body.contact || '';
                break;
            case 'orders':
                entity.status = 'created';
                entity.amount = body.amount || 0;
                entity.currency = body.currency || 'INR';
                entity.receipt = body.receipt || `receipt_${this.idCounter}`;
                break;
            case 'subscriptions':
                entity.status = 'created';
                entity.plan_id = body.plan_id || '';
                entity.total_count = body.total_count || 6;
                break;
            case 'plans':
                entity.period = body.period || 'monthly';
                entity.interval = body.interval || 1;
                entity.item = body.item || {};
                break;
        }

        this.entities.set(`${resource}/${id}`, entity);
        this.sendJson(res, 200, entity);
    }

    /**
     * POST /v1/{resource}/{id}/{action} — Perform action on entity
     * e.g. POST /v1/subscriptions/sub_123/cancel
     */
    private handleAction(
        res: http.ServerResponse,
        resource: string,
        id: string,
        action: string,
        body: any
    ): void {
        const entity = this.entities.get(`${resource}/${id}`);
        if (!entity) {
            this.sendJson(res, 404, {
                error: { description: `${resource} ${id} not found` },
            });
            return;
        }

        switch (action) {
            case 'cancel':
                entity.status = 'cancelled';
                entity.cancelled_at = Math.floor(Date.now() / 1000);
                break;
            case 'pause':
                entity.status = 'paused';
                entity.paused_at = Math.floor(Date.now() / 1000);
                break;
            case 'resume':
                entity.status = 'active';
                break;
            case 'capture':
                entity.status = 'captured';
                break;
            default:
                // For unknown actions, just merge body into entity
                Object.assign(entity, body);
        }

        this.entities.set(`${resource}/${id}`, entity);
        this.sendJson(res, 200, entity);
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    private getPrefix(resource: string): string {
        const prefixes: Record<string, string> = {
            customers: 'cust',
            orders: 'order',
            payments: 'pay',
            subscriptions: 'sub',
            plans: 'plan',
            refunds: 'rfnd',
            invoices: 'inv',
        };
        return prefixes[resource] || 'item';
    }
}
